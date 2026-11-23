-- ============================================================
--  MSPgram v22 — настоящий Web Push (миграция БД, безопасно запускать повторно)
--  Supabase → SQL Editor → New query → вставить ВЕСЬ файл → Run
--  ⚠️ schema.sql повторно НЕ запускать (он стирает таблицы).
--
--  Что делает:
--   1. таблица push_subscriptions — подписки устройств (по одной на браузер/APK)
--   2. функции register_push / unregister_push — приложение вызывает их при входе/выходе
--   3. таблица push_settings — адрес Edge Function и секрет (читает только сервер)
--   4. триггер на messages: после каждого нового сообщения будит Edge Function send-push
-- ============================================================

create extension if not exists pg_net with schema extensions;

-- 1. Подписки устройств ----------------------------------------------------
create table if not exists public.push_subscriptions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
drop policy if exists "push own read" on public.push_subscriptions;
create policy "push own read" on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
-- вставка/удаление — только через функции ниже (security definer)
revoke all on public.push_subscriptions from anon, authenticated;
grant select on public.push_subscriptions to authenticated;

-- 2. Регистрация / отмена подписки -----------------------------------------
-- Если на этом устройстве раньше был другой аккаунт — подписка переходит к текущему.
create or replace function public.register_push(p_endpoint text, p_p256dh text, p_auth text, p_ua text default '')
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if coalesce(p_endpoint, '') = '' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'bad subscription';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(coalesce(p_ua, ''), 200))
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent, updated_at = now();
end $$;

create or replace function public.unregister_push(p_endpoint text)
returns void
language sql security definer set search_path = public
as $$ delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid(); $$;

revoke all on function public.register_push(text, text, text, text) from public, anon;
revoke all on function public.unregister_push(text) from public, anon;
grant execute on function public.register_push(text, text, text, text) to authenticated;
grant execute on function public.unregister_push(text) to authenticated;

-- 3. Настройки отправки (доступны только серверу, клиентам — нет) ---------------
create table if not exists public.push_settings (
  key   text primary key,
  value text not null
);
alter table public.push_settings enable row level security;   -- политик нет → клиенты ничего не видят
revoke all on public.push_settings from anon, authenticated;

-- 4. Триггер: новое сообщение → Edge Function send-push -----------------------
create or replace function public.notify_push_on_message()
returns trigger
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_url text;
  v_secret text;
begin
  select value into v_url    from public.push_settings where key = 'function_url';
  select value into v_secret from public.push_settings where key = 'webhook_secret';
  if v_url is null or v_secret is null then return new; end if;   -- push ещё не настроен

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret),
    body := jsonb_build_object('type', 'message', 'message_id', new.id),
    timeout_milliseconds := 5000
  );
  return new;
exception when others then
  return new;   -- ошибка push никогда не должна ломать отправку сообщения
end $$;

drop trigger if exists trg_push_on_message on public.messages;
create trigger trg_push_on_message
  after insert on public.messages
  for each row execute function public.notify_push_on_message();

-- ============================================================
--  ШАГ ПОСЛЕ МИГРАЦИИ (один раз): впиши адрес функции и свой секрет.
--  Секрет — любая длинная случайная строка; такая же строка должна быть в
--  секретах Edge Function под именем PUSH_WEBHOOK_SECRET.
--  Страница-помощник из архива обновления сама подставляет секрет в этот запрос.
-- ============================================================
-- insert into public.push_settings (key, value) values
--   ('function_url',  'https://xqjtycvfjamnqtkznyio.supabase.co/functions/v1/send-push'),
--   ('webhook_secret', 'ВАШ_СЕКРЕТ')
-- on conflict (key) do update set value = excluded.value;

-- ============================================================
--  Миграция 13: FCM push для НАТИВНОГО Android-приложения
--  Безопасно запускать повторно. Применяется workflow «setup-fcm»
--  или через Supabase-коннектор.
--
--  1. Таблица fcm_tokens — FCM-токены устройств (по одному на телефон)
--  2. register_fcm / unregister_fcm — приложение вызывает при входе
--  3. Триггер на messages: новое сообщение → будит Edge Function send-fcm
-- ============================================================

create table if not exists public.fcm_tokens (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  token      text not null unique,
  user_agent text not null default '',
  updated_at timestamptz not null default now()
);
create index if not exists fcm_tokens_user_idx on public.fcm_tokens (user_id);

alter table public.fcm_tokens enable row level security;
drop policy if exists "fcm own read" on public.fcm_tokens;
create policy "fcm own read" on public.fcm_tokens for select to authenticated
  using (user_id = auth.uid());
-- вставка/удаление — только через security definer функции
revoke all on public.fcm_tokens from anon, authenticated;
grant select on public.fcm_tokens to authenticated;

create or replace function public.register_fcm(p_token text, p_ua text default '')
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if coalesce(p_token, '') = '' then raise exception 'bad token'; end if;
  insert into public.fcm_tokens (user_id, token, user_agent)
  values (auth.uid(), p_token, left(coalesce(p_ua, ''), 200))
  on conflict (token) do update
    set user_id = excluded.user_id, user_agent = excluded.user_agent, updated_at = now();
end $$;

create or replace function public.unregister_fcm(p_token text)
returns void
language sql security definer set search_path = public
as $$ delete from public.fcm_tokens where token = p_token and user_id = auth.uid(); $$;

revoke all on function public.register_fcm(text, text) from public, anon;
revoke all on function public.unregister_fcm(text) from public, anon;
grant execute on function public.register_fcm(text, text) to authenticated;
grant execute on function public.unregister_fcm(text) to authenticated;

-- Триггер: новое сообщение → POST на send-fcm (как в migration-11 для web-push)
create or replace function public.notify_fcm_on_message()
returns trigger
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_url text;
  v_secret text;
begin
  select value into v_url    from public.push_settings where key = 'fcm_function_url';
  select value into v_secret from public.push_settings where key = 'fcm_webhook_secret';
  if v_url is null or v_secret is null then return new; end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret),
    body := jsonb_build_object('type', 'message', 'message_id', new.id),
    timeout_milliseconds := 5000
  );
  return new;
exception when others then
  return new;  -- push никогда не ломает отправку сообщения
end $$;

drop trigger if exists trg_fcm_on_message on public.messages;
create trigger trg_fcm_on_message
  after insert on public.messages
  for each row execute function public.notify_fcm_on_message();

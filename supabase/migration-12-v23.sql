-- ============================================================
--  MSPgram v23 «Always On» — миграция БД (безопасно запускать повторно)
--  Supabase → SQL Editor → New query → вставить ВЕСЬ файл → Run
--  Требует, чтобы migration-11-webpush.sql уже была применена.
--  ⚠️ schema.sql повторно НЕ запускать (он стирает таблицы).
--
--  Что делает:
--   1. admin_set_username — админ меняет юзернейм/имя игрока (с проверками и понятными ошибками)
--   2. push_diag — статус push для окна «Диагностика push» в приложении
-- ============================================================

-- 1. Смена юзернейма / имени администратором ---------------------------------
create or replace function public.admin_set_username(p_user uuid, p_nickname text default null, p_display text default null)
returns public.profiles
language plpgsql security definer set search_path = public
as $$
declare
  v_nick text := lower(trim(coalesce(p_nickname, '')));
  v_disp text := left(trim(coalesce(p_display, '')), 40);
  r public.profiles;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Менять юзернеймы может только администратор';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'Пользователь не найден';
  end if;

  if v_nick <> '' then
    if char_length(v_nick) < 3 or char_length(v_nick) > 20 then
      raise exception 'Юзернейм: от 3 до 20 символов';
    end if;
    if v_nick !~ '^[a-z0-9_]+$' then
      raise exception 'Юзернейм: только латиница, цифры и _';
    end if;
    if exists (select 1 from public.profiles where lower(nickname) = v_nick and id <> p_user) then
      raise exception 'Юзернейм @% уже занят', v_nick;
    end if;
    update public.profiles set nickname = v_nick where id = p_user;
  end if;

  if v_disp <> '' then
    update public.profiles set display_name = v_disp where id = p_user;
  end if;

  select * into r from public.profiles where id = p_user;
  return r;
end $$;

revoke all on function public.admin_set_username(uuid, text, text) from public, anon;
grant execute on function public.admin_set_username(uuid, text, text) to authenticated;

-- 2. Диагностика push -----------------------------------------------------------
create or replace function public.push_diag()
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_url text;
  v_sec text;
  v_res jsonb;
  v_calls jsonb;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;

  select value into v_url from public.push_settings where key = 'function_url';
  select value into v_sec from public.push_settings where key = 'webhook_secret';

  v_res := jsonb_build_object(
    'url_set',   v_url is not null,
    'secret_set', v_sec is not null,
    'trigger',   exists (select 1 from pg_trigger where tgname = 'trg_push_on_message' and not tgisinternal),
    'pg_net',    exists (select 1 from pg_extension where extname = 'pg_net'),
    'my_devices', (select count(*) from public.push_subscriptions where user_id = auth.uid())
  );

  -- последние ответы Edge Function на вызовы из триггера (видит только админ)
  if public.is_admin() then
    begin
      select coalesce(jsonb_agg(x), '[]'::jsonb) into v_calls from (
        select status_code, left(coalesce(error_msg, ''), 120) as error, created
        from net._http_response order by created desc limit 5
      ) x;
      v_res := v_res || jsonb_build_object('last_calls', v_calls);
    exception when others then
      null;
    end;
  end if;

  return v_res;
end $$;

revoke all on function public.push_diag() from public, anon;
grant execute on function public.push_diag() to authenticated;

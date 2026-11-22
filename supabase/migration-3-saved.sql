-- ============================================================
--  MSPgram — миграция №3: Избранное (чат с собой)
--
--  Кому нужна: если проект Supabase создан РАНЬШЕ и база уже работает.
--  Новые проекты запускают schema.sql целиком — там всё уже есть.
--
--  Куда вставлять: Supabase → SQL Editor → New query → весь файл → Run.
--  Запускать можно многократно: ошибок не будет, данные не трогаются.
-- ============================================================

-- 1. Флаг «Избранное» для чатов
alter table public.chats
  add column if not exists is_saved boolean not null default false;

-- 2. Личные диалоги больше не должны находить «Избранное»
drop function if exists public.get_or_create_direct_chat(uuid);
create or replace function public.get_or_create_direct_chat(other_user uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  me  uuid := auth.uid();
  cid uuid;
begin
  if me is null then raise exception 'Требуется вход'; end if;
  if other_user is null or other_user = me then raise exception 'Некорректный пользователь'; end if;
  if not exists (select 1 from public.profiles where id = other_user) then
    raise exception 'Пользователь не найден';
  end if;

  select c.id into cid
  from public.chats c
  join public.chat_members a on a.chat_id = c.id and a.user_id = me
  join public.chat_members b on b.chat_id = c.id and b.user_id = other_user
  where c.type = 'direct' and c.is_saved = false
  limit 1;
  if cid is not null then return cid; end if;

  insert into public.chats (type, created_by) values ('direct', me) returning id into cid;
  insert into public.chat_members (chat_id, user_id) values (cid, me), (cid, other_user);
  return cid;
end $$;

-- 3. Свой чат «Избранное» (участник — только ты)
create or replace function public.get_or_create_saved_chat()
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  me  uuid := auth.uid();
  cid uuid;
begin
  if me is null then raise exception 'Требуется вход'; end if;

  select c.id into cid
  from public.chats c
  join public.chat_members m on m.chat_id = c.id and m.user_id = me
  where c.is_saved = true
  limit 1;
  if cid is not null then return cid; end if;

  insert into public.chats (type, is_saved, title, created_by)
  values ('direct', true, 'Избранное', me) returning id into cid;
  insert into public.chat_members (chat_id, user_id, role) values (cid, me, 'owner');
  return cid;
end $$;

-- Готово! Обнови страницу мессенджера: кнопка 🔖 в шапке слева.

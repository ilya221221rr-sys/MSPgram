-- ============================================================
--  MSPgram — миграция №4: права (grants) и харденинг политик
--
--  Лечит ошибку «permission denied for table chats» (42501):
--  это отсутствующий GRANT роли authenticated. Права проверяются
--  ДО RLS-политик, поэтому без этого гранта всё падает сразу.
--
--  Также исправляет политику добавления участников: раньше её
--  подзапрос читал таблицу chats от имени пользователя — теперь
--  через security definer-функцию, и создание чатов работает
--  гарантированно.
--
--  Куда вставлять: Supabase → SQL Editor → New query → весь файл → Run.
--  Запускать можно многократно: ничего не удаляет, данные целы.
-- ============================================================

-- ============ 1. Гарантированные права на таблицы ============
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on table public.profiles     to authenticated;
grant select, insert, update, delete on table public.chats        to authenticated;
grant select, insert, update, delete on table public.chat_members to authenticated;
grant select, insert, update, delete on table public.messages     to authenticated;
grant select on table public.profiles to anon;

grant all privileges on all sequences in schema public to authenticated;

-- ============ 2. Права на функции (EXECUTE) ============
grant execute on all functions in schema public to anon, authenticated;

-- Владелец функций — postgres, тогда security definer работает без ограничений RLS
do $$
declare f record;
begin
  for f in
    select oid::regprocedure as fn
    from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('handle_new_user','is_chat_member','get_or_create_direct_chat',
                      'get_or_create_saved_chat','touch_last_seen','unread_counts',
                      'touch_chat_on_message','can_join_chat')
  loop
    begin
      execute format('alter function %s owner to postgres', f.fn);
    exception when others then null; -- если роль в проекте называется иначе — не падаем
    end;
  end loop;
end $$;

-- ============ 3. Хелпер: можно ли добавить участника в чат ============
-- security definer: смотрит на chats в обход RLS — политика больше не зависит
-- от прав пользователя на чтение chats
create or replace function public.can_join_chat(chat uuid, usr uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.chats c
    where c.id = chat
      and (c.created_by = usr
           or (c.type = 'group' and exists (
                 select 1 from public.chat_members m
                 where m.chat_id = chat and m.user_id = usr)))
  );
$$;

-- ============ 4. Политика участников: переписываем через хелпер ============
drop policy if exists "members insert" on public.chat_members;
create policy "members insert" on public.chat_members for insert to authenticated
  with check (public.can_join_chat(chat_id));

-- ============ 5. Функции напрямую (на случай если был частичный запуск) ============
grant execute on function public.can_join_chat(uuid, uuid) to anon, authenticated;
grant execute on function public.get_or_create_direct_chat(uuid) to anon, authenticated;
grant execute on function public.get_or_create_saved_chat() to anon, authenticated;
grant execute on function public.touch_last_seen() to anon, authenticated;
grant execute on function public.unread_counts() to anon, authenticated;
grant execute on function public.is_chat_member(uuid, uuid) to anon, authenticated;

-- Готово! Обнови страницу мессенджера.

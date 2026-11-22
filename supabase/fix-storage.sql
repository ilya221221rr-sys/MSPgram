-- ============================================================
--  MSPgram — доводка (если большой schema.sql падал с ошибкой
--  "policy already exists" при повторном запуске).
--
--  Этот скрипт МОЖНО запускать сколько угодно раз — он сначала
--  удаляет старые объекты, потом создаёт заново. Ошибок не будет.
--
--  Всё остальное (таблицы, функции, RLS) уже создано предыдущими
--  запусками — этот только гарантирует политики хранилища и
--  мгновенную доставку сообщений (realtime).
-- ============================================================

-- 1. Бакеты хранилища (настройки поверх существующих)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 5242880, array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do update set public = true, file_size_limit = 5242880;

insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-files', 'chat-files', true, 20971520)
on conflict (id) do update set public = true, file_size_limit = 20971520;

-- 2. Политики хранилища: удалить старые → создать заново
drop policy if exists "avatars upload" on storage.objects;
drop policy if exists "avatars update" on storage.objects;
drop policy if exists "avatars delete" on storage.objects;
drop policy if exists "chat-files upload" on storage.objects;
drop policy if exists "chat-files delete" on storage.objects;

create policy "avatars upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and owner_id = auth.uid()::text and name like (auth.uid()::text || '/%'));
create policy "avatars update" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and owner_id = auth.uid()::text and name like (auth.uid()::text || '/%'));
create policy "avatars delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and owner_id = auth.uid()::text and name like (auth.uid()::text || '/%'));

create policy "chat-files upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-files' and public.is_chat_member(((split_part(name, '/', 1))::uuid)));
create policy "chat-files delete" on storage.objects for delete to authenticated
  using (bucket_id = 'chat-files' and public.is_chat_member(((split_part(name, '/', 1))::uuid)));

-- 3. Realtime: таблицы в публикацию (защита от повтора)
do $$ begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.chats;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.chat_members;
exception when duplicate_object then null; end $$;

-- Готово. Проверка: Table Editor → должны быть таблицы
-- profiles, chats, chat_members, messages.

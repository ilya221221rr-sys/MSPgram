-- ============================================================
--  MSPgram — схема базы данных для Supabase
--  Куда вставлять: Supabase → SQL Editor → New query → сюда → Run
--  Можно запускать повторно (всё удаляется и создаётся заново).
--  ВНИМАНИЕ: повторный запуск удалит существующие данные!
-- ============================================================

-- ============ 1. Очистка (для повторного запуска) ============
drop table if exists public.messages cascade;
drop table if exists public.chat_members cascade;
drop table if exists public.chats cascade;
drop table if exists public.profiles cascade;

drop function if exists public.handle_new_user() cascade;
drop function if exists public.is_chat_member(uuid, uuid) cascade;
drop function if exists public.get_or_create_direct_chat(uuid) cascade;
drop function if exists public.get_or_create_saved_chat() cascade;
drop function if exists public.touch_last_seen() cascade;
drop function if exists public.unread_counts() cascade;
drop function if exists public.touch_chat_on_message() cascade;

-- ============ 2. Таблицы ============

-- Профили пользователей (расширение данных из auth.users)
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  nickname     text not null unique check (char_length(nickname) between 3 and 20 and nickname !~ '\s'),
  display_name text not null default '',
  bio          text not null default '',
  avatar_url   text not null default '',
  created_at   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);
comment on table public.profiles is 'Профили: ник, имя, аватар, онлайн';

-- Чаты (личные и группы)
create table public.chats (
  id                 uuid primary key default gen_random_uuid(),
  type               text not null check (type in ('direct', 'group')),
  title              text,                              -- название группы
  avatar_url         text not null default '',
  is_saved           boolean not null default false,    -- «Избранное» (чат с собой)
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  last_message_at    timestamptz not null default now(),
  last_message_text  text not null default '',
  last_message_sender uuid,
  pinned_message_id  uuid
);
create index chats_last_message_idx on public.chats (last_message_at desc);
comment on table public.chats is 'Чаты: direct = личный диалог, group = группа';

-- Участники чатов
create table public.chat_members (
  chat_id      uuid not null references public.chats(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  role         text not null default 'member',          -- owner | admin | member
  joined_at    timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);
create index chat_members_user_idx on public.chat_members (user_id);
comment on table public.chat_members is 'Участники чатов и время последнего прочтения';

-- Сообщения
create table public.messages (
  id               uuid primary key default gen_random_uuid(),
  chat_id          uuid not null references public.chats(id) on delete cascade,
  sender_id        uuid not null references public.profiles(id) on delete cascade,
  body             text not null default '',
  attachment_url   text not null default '',
  attachment_type  text not null default '',            -- 'image' | 'video' | 'voice' | 'file'
  attachment_name  text not null default '',
  attachment_size  bigint,
  duration_ms      integer,                              -- длительность голосовых/видео, мс
  reply_to         uuid references public.messages(id) on delete set null,
  channel_id       uuid references public.channels(id) on delete cascade,
  forwarded_from   text,
  created_at       timestamptz not null default now(),
  edited_at        timestamptz
);
create index messages_chat_idx on public.messages (chat_id, created_at desc);
create index messages_reply_idx on public.messages (reply_to);
comment on table public.messages is 'Сообщения и вложения (фото, видео, голосовые, файлы), ответы';

-- ============ 3. Функции и триггеры ============

-- Автоматическое создание профиля при регистрации
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  base text;
  nick text;
  i int := 0;
begin
  base := coalesce(nullif(new.raw_user_meta_data->>'nickname', ''),
                   split_part(coalesce(new.email, 'user'), '@', 1), 'user');
  base := regexp_replace(base, '\s+', '', 'g');
  base := left(base, 16);
  if base is null or char_length(base) < 3 then base := 'user'; end if;
  nick := base;
  while exists (select 1 from public.profiles p where lower(p.nickname) = lower(nick)) loop
    i := i + 1;
    nick := left(base, 14) || i::text;
  end loop;
  insert into public.profiles (id, nickname, display_name)
  values (new.id, nick,
          coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), nick));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Проверка "я участник чата?" (обходит RLS, чтобы не было рекурсии)
create or replace function public.is_chat_member(chat uuid, usr uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.chat_members m
    where m.chat_id = chat and m.user_id = usr
  );
$$;

-- Можно ли добавить участника в чат (обходит RLS: чаты создателя/группы)
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

-- Открыть личный чат с пользователем (найти или создать)
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

-- Свой чат «Избранное» (заметки, ссылки, файлы — видно только тебе)
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

-- Обновить "был(а) онлайн"
create or replace function public.touch_last_seen()
returns void
language sql security definer set search_path = public
as $$
  update public.profiles set last_seen = now() where id = auth.uid();
$$;

-- Непрочитанные сообщения по всем чатам (одним запросом)
create or replace function public.unread_counts()
returns table (chat_id uuid, cnt bigint)
language sql stable security definer set search_path = public
as $$
  select m.chat_id, count(*)
  from public.chat_members m
  join public.messages msg on msg.chat_id = m.chat_id
  where m.user_id = auth.uid()
    and msg.created_at > m.last_read_at
    and msg.sender_id <> auth.uid()
  group by m.chat_id;
$$;

-- Обновлять сводку последнего сообщения в чате
create or replace function public.touch_chat_on_message()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  update public.chats set
    last_message_at    = new.created_at,
    last_message_text  = case
                           when new.body <> '' then left(new.body, 120)
                           when new.attachment_type = 'image' then '📷 Фото'
                           when new.attachment_type = 'video' then '🎥 Видеосообщение'
                           when new.attachment_type = 'voice' then '🎤 Голосовое сообщение'
                           when new.attachment_type = 'file' then '📎 Файл'
                           else ''
                         end,
    last_message_sender = new.sender_id
  where id = new.chat_id;
  return new;
end $$;

create trigger on_message_inserted
  after insert on public.messages
  for each row execute function public.touch_chat_on_message();

-- ============ 4. Row Level Security ============
-- Правило: пользователь видит и может делать только то, что разрешено его чатам.

alter table public.profiles     enable row level security;
alter table public.chats        enable row level security;
alter table public.chat_members enable row level security;
alter table public.messages     enable row level security;

-- Профили: читать могут все вошедшие, менять — только владелец
create policy "profiles read"   on public.profiles for select to authenticated using (true);
create policy "profiles insert" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "profiles update" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Чаты: видны только участникам; удалить может создатель или (для личных) любой участник
create policy "chats read"   on public.chats for select to authenticated using (public.is_chat_member(id) or created_by = auth.uid());
create policy "chats insert" on public.chats for insert to authenticated with check (created_by = auth.uid());
create policy "chats update" on public.chats for update to authenticated using (public.is_chat_member(id) and (created_by = auth.uid() or type = 'direct'));
create policy "chats delete" on public.chats for delete to authenticated using (created_by = auth.uid() or (type = 'direct' and public.is_chat_member(id)));

-- Участники: читать могут участники чата; добавлять — создатель или участник группы
create policy "members read"   on public.chat_members for select to authenticated using (public.is_chat_member(chat_id));
create policy "members insert" on public.chat_members for insert to authenticated with check (
  public.can_join_chat(chat_id)
);
create policy "members update" on public.chat_members for update to authenticated using (user_id = auth.uid() and public.is_chat_member(chat_id));
create policy "members delete" on public.chat_members for delete to authenticated using (
  user_id = auth.uid()
  or exists (select 1 from public.chats c where c.id = chat_id and c.created_by = auth.uid())
);

-- Сообщения: читать — участникам чата; писать — участникам от своего имени
create policy "messages read"   on public.messages for select to authenticated using (public.is_chat_member(chat_id));
create policy "messages insert" on public.messages for insert to authenticated with check (sender_id = auth.uid() and public.is_chat_member(chat_id));
create policy "messages update" on public.messages for update to authenticated using (sender_id = auth.uid() and public.is_chat_member(chat_id));
create policy "messages delete" on public.messages for delete to authenticated using (sender_id = auth.uid());

-- ============ 5. Хранилище файлов (Storage) ============

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 5242880, array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do update set public = true, file_size_limit = 5242880;

insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-files', 'chat-files', true, 20971520)
on conflict (id) do update set public = true, file_size_limit = 20971520;

-- Если скрипт запускается повторно — сначала убираем старые политики
drop policy if exists "avatars upload" on storage.objects;
drop policy if exists "avatars update" on storage.objects;
drop policy if exists "avatars delete" on storage.objects;
drop policy if exists "chat-files upload" on storage.objects;
drop policy if exists "chat-files delete" on storage.objects;

-- Аватары: путь всегда "мой_id/файл" — менять могу только я, читать можно всем
create policy "avatars upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and owner_id = auth.uid()::text and name like (auth.uid()::text || '/%'));
create policy "avatars update" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and owner_id = auth.uid()::text and name like (auth.uid()::text || '/%'));
create policy "avatars delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and owner_id = auth.uid()::text and name like (auth.uid()::text || '/%'));

-- Файлы чатов: путь всегда "chat_id/файл" — загружать могут участники этого чата
create policy "chat-files upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-files' and public.is_chat_member(((split_part(name, '/', 1))::uuid)));
create policy "chat-files delete" on storage.objects for delete to authenticated
  using (bucket_id = 'chat-files' and public.is_chat_member(((split_part(name, '/', 1))::uuid)));

-- ============ 6. Realtime (мгновенная доставка) ============

do $$ begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.chats;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.chat_members;
exception when duplicate_object then null; end $$;

-- ============ Готово! ============
-- Проверка: в Table Editor должны появиться таблицы
-- profiles, chats, chat_members, messages.

-- 1. Каналы серверов
create table if not exists public.channels (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  name text not null default 'общий',
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists channels_chat_idx on public.channels (chat_id, position);
alter table public.channels enable row level security;
drop policy if exists "channels read" on public.channels;
create policy "channels read" on public.channels for select to authenticated using (public.is_chat_member(chat_id));
drop policy if exists "channels insert" on public.channels;
create policy "channels insert" on public.channels for insert to authenticated with check (
  exists (select 1 from public.chat_members m where m.chat_id = channels.chat_id and m.user_id = auth.uid() and m.role in ('owner','admin'))
);
drop policy if exists "channels delete" on public.channels;
create policy "channels delete" on public.channels for delete to authenticated using (
  exists (select 1 from public.chat_members m where m.chat_id = channels.chat_id and m.user_id = auth.uid() and m.role in ('owner','admin'))
);

-- 2. Сообщения: канал и «переслано от»; чат: закреплённое сообщение
alter table public.messages add column if not exists channel_id uuid references public.channels(id) on delete cascade;
alter table public.messages add column if not exists forwarded_from text;
alter table public.chats add column if not exists pinned_message_id uuid;
create index if not exists messages_channel_idx on public.messages (channel_id, created_at desc);

-- 3. Реакции на сообщения
create table if not exists public.reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
alter table public.reactions enable row level security;

create or replace function public.can_see_message(msg uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.messages m where m.id = msg and public.is_chat_member(m.chat_id));
$$;

drop policy if exists "reactions read" on public.reactions;
create policy "reactions read" on public.reactions for select to authenticated using (public.can_see_message(message_id));
drop policy if exists "reactions insert" on public.reactions;
create policy "reactions insert" on public.reactions for insert to authenticated with check (user_id = auth.uid() and public.can_see_message(message_id));
drop policy if exists "reactions delete" on public.reactions;
create policy "reactions delete" on public.reactions for delete to authenticated using (user_id = auth.uid());

create or replace function public.toggle_reaction(msg uuid, emo text) returns boolean
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Требуется вход'; end if;
  if not public.can_see_message(msg) then raise exception 'Нет доступа к сообщению'; end if;
  if exists (select 1 from public.reactions r where r.message_id = msg and r.user_id = me and r.emoji = emo) then
    delete from public.reactions where message_id = msg and user_id = me and emoji = emo;
    return false;
  else
    insert into public.reactions (message_id, user_id, emoji) values (msg, me, emo);
    return true;
  end if;
end $$;

-- 4. Ссылки-приглашения
create table if not exists public.invites (
  code text primary key,
  chat_id uuid not null references public.chats(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  max_uses integer,
  uses integer not null default 0,
  expires_at timestamptz
);
alter table public.invites enable row level security;
drop policy if exists "invites read" on public.invites;
create policy "invites read" on public.invites for select to authenticated using (public.is_chat_member(chat_id));

create or replace function public.create_invite(chat uuid, max_uses integer default null, hours integer default 168)
returns text
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); code text;
begin
  if me is null then raise exception 'Требуется вход'; end if;
  if not public.is_chat_member(chat) then raise exception 'Нет доступа к серверу'; end if;
  loop
    code := lower(substr(md5(random()::text || clock_timestamp()::text || chat::text), 1, 10));
    exit when not exists (select 1 from public.invites i where i.code = code);
  end loop;
  insert into public.invites (code, chat_id, created_by, max_uses, expires_at)
  values (code, chat, me, max_uses, case when hours is null then null else now() + (hours || ' hours')::interval end);
  return code;
end $$;

create or replace function public.join_by_invite(inv text) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); rec record;
begin
  if me is null then raise exception 'Требуется вход'; end if;
  select * into rec from public.invites i where i.code = lower(trim(inv)) limit 1;
  if rec is null then raise exception 'Приглашение не найдено'; end if;
  if rec.expires_at is not null and rec.expires_at < now() then raise exception 'Ссылка истекла'; end if;
  if rec.max_uses is not null and rec.uses >= rec.max_uses then raise exception 'Лимит ссылок исчерпан'; end if;
  if exists (select 1 from public.chat_members m where m.chat_id = rec.chat_id and m.user_id = me) then
    return rec.chat_id;
  end if;
  insert into public.chat_members (chat_id, user_id, role) values (rec.chat_id, me, 'member');
  update public.invites set uses = uses + 1 where code = rec.code;
  return rec.chat_id;
end $$;

-- 5. У каждого сервера есть канал «общий» (автоматически)
create or replace function public.make_default_channel() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.type = 'group' then
    insert into public.channels (chat_id, name) values (new.id, 'общий');
  end if;
  return new;
end $$;
drop trigger if exists on_chat_created on public.chats;
create trigger on_chat_created after insert on public.chats for each row execute function public.make_default_channel();

-- 6. Закреплять могут админы/владелец (в личных — любой участник)
drop policy if exists "chats update" on public.chats;
create policy "chats update" on public.chats for update to authenticated using (
  public.is_chat_member(id) and (
    type = 'direct'
    or exists (select 1 from public.chat_members m where m.chat_id = id and m.user_id = auth.uid() and m.role in ('owner','admin'))
  )
);

-- 7. Realtime
do $$ begin alter publication supabase_realtime add table public.channels; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.reactions; exception when duplicate_object then null; end $$;

-- 8. Права
grant select, insert, update, delete on table public.channels to authenticated;
grant select, insert, update, delete on table public.reactions to authenticated;
grant select on table public.invites to authenticated;
grant execute on function public.can_see_message(uuid) to anon, authenticated;
grant execute on function public.toggle_reaction(uuid, text) to anon, authenticated;
grant execute on function public.create_invite(uuid, integer, integer) to anon, authenticated;
grant execute on function public.join_by_invite(text) to anon, authenticated;

-- 9. Бэкфилл: канал «общий» для существующих серверов + привязка сообщений
insert into public.channels (chat_id, name)
select c.id, 'общий' from public.chats c
where c.type = 'group' and not exists (select 1 from public.channels ch where ch.chat_id = c.id);

update public.messages m
set channel_id = ch.id
from public.channels ch
join public.chats c on c.id = ch.chat_id
where m.chat_id = c.id and m.channel_id is null and ch.name = 'общий';

-- ============================================================
--  MSPgram v18 «Aurora» — миграция №9
--
--  Что делает:
--   1. 🔒 Закрывает дыру: раньше любой пользователь мог сам себе выставить
--      is_admin = true. Теперь защитные триггеры это запрещают.
--   2. Статусы присутствия (в сети / отошёл / не беспокоить / невидимка),
--      эмодзи-статус, настройки приватности.
--   3. Друзья (заявки, принятие, удаление).
--   4. Активные сессии (список устройств, завершение сессий).
--   5. Права в группах: «только админы пишут» (канал), запрет медиа,
--      роли участников (админ/участник) назначает владелец.
--   6. Статус «доставлено» для сообщений.
--   7. Роль «модератор» (видит жалобы, может банить).
--
--  Как применить: Supabase → SQL Editor → New query → вставить весь файл → Run.
--  Запускать можно много раз: ничего не удаляет, данные целы.
--  ⚠️ НЕ запускай supabase/schema.sql повторно — он стирает таблицы!
-- ============================================================

-- ============ 1. Новые поля профиля ============
alter table public.profiles add column if not exists presence_status  text not null default 'online';
alter table public.profiles add column if not exists status_emoji     text;
alter table public.profiles add column if not exists privacy_last_seen text not null default 'everyone';
alter table public.profiles add column if not exists privacy_messages  text not null default 'everyone';
alter table public.profiles add column if not exists privacy_profile   text not null default 'everyone';
alter table public.profiles add column if not exists is_moderator     boolean not null default false;

do $$ begin
  alter table public.profiles add constraint profiles_presence_chk
    check (presence_status in ('online','away','dnd','invisible'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.profiles add constraint profiles_priv_seen_chk
    check (privacy_last_seen in ('everyone','friends','nobody'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.profiles add constraint profiles_priv_msg_chk
    check (privacy_messages in ('everyone','friends'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.profiles add constraint profiles_priv_prof_chk
    check (privacy_profile in ('everyone','friends'));
exception when duplicate_object then null; end $$;

-- ============ 2. Хелперы ролей ============
create or replace function public.is_moderator()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce((select p.is_moderator or p.is_admin from public.profiles p where p.id = auth.uid()), false); $$;

-- ============ 3. 🔒 Защита профиля от самоповышения ============
create or replace function public.guard_profile_update()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  ban_keys text[] := array['is_banned','banned_until','ban_reason'];
begin
  -- SQL Editor / сервисная роль — без ограничений
  if uid is null then return new; end if;
  -- администратор может всё
  if coalesce((select p.is_admin from public.profiles p where p.id = uid), false) then return new; end if;

  -- роли менять нельзя никому, кроме админа
  if new.is_admin is distinct from old.is_admin
     or new.is_moderator is distinct from old.is_moderator then
    raise exception 'Недостаточно прав для смены роли';
  end if;

  if new.id = uid then
    -- свой профиль: баны менять нельзя
    if (new.is_banned, new.banned_until, new.ban_reason)
       is distinct from (old.is_banned, old.banned_until, old.ban_reason) then
      raise exception 'Нельзя менять собственный бан';
    end if;
  else
    -- чужой профиль может менять только модератор и только поля бана
    if not public.is_moderator() or old.is_admin then
      raise exception 'Недостаточно прав';
    end if;
    if (to_jsonb(new) - ban_keys) is distinct from (to_jsonb(old) - ban_keys) then
      raise exception 'Модератор может менять только блокировку';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists guard_profile_update on public.profiles;
create trigger guard_profile_update before update on public.profiles
  for each row execute function public.guard_profile_update();

drop policy if exists "profiles moderator ban" on public.profiles;
create policy "profiles moderator ban" on public.profiles for update to authenticated
  using (public.is_moderator()) with check (public.is_moderator());

-- модератор: жалобы
drop policy if exists "reports mod read" on public.reports;
create policy "reports mod read" on public.reports for select to authenticated using (public.is_moderator());
drop policy if exists "reports mod update" on public.reports;
create policy "reports mod update" on public.reports for update to authenticated using (public.is_moderator());

-- ============ 4. Друзья ============
create table if not exists public.friendships (
  id         uuid primary key default gen_random_uuid(),
  requester  uuid not null references public.profiles(id) on delete cascade,
  addressee  uuid not null references public.profiles(id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending','accepted')),
  created_at timestamptz not null default now(),
  unique (requester, addressee),
  check (requester <> addressee)
);
create index if not exists friendships_addressee_idx on public.friendships (addressee);
alter table public.friendships enable row level security;

drop policy if exists "friends read" on public.friendships;
create policy "friends read" on public.friendships for select to authenticated
  using (requester = auth.uid() or addressee = auth.uid());
drop policy if exists "friends delete" on public.friendships;
create policy "friends delete" on public.friendships for delete to authenticated
  using (requester = auth.uid() or addressee = auth.uid());
grant select, delete on public.friendships to authenticated;

-- отправить заявку (если встречная заявка уже есть — сразу дружба)
create or replace function public.friend_request(target uuid)
returns text language plpgsql security definer set search_path = public
as $$
declare me uuid := auth.uid(); rev uuid;
begin
  if me is null then raise exception 'Требуется вход'; end if;
  if target is null or target = me then raise exception 'Некорректный пользователь'; end if;
  if not exists (select 1 from public.profiles where id = target) then raise exception 'Пользователь не найден'; end if;
  if exists (select 1 from public.blocks b where (b.blocker = target and b.blocked = me) or (b.blocker = me and b.blocked = target)) then
    raise exception 'Нельзя отправить заявку: есть блокировка';
  end if;
  if exists (select 1 from public.friendships f where f.status = 'accepted'
             and ((f.requester = me and f.addressee = target) or (f.requester = target and f.addressee = me))) then
    return 'friends';
  end if;
  select id into rev from public.friendships where requester = target and addressee = me and status = 'pending';
  if rev is not null then
    update public.friendships set status = 'accepted' where id = rev;
    return 'friends';
  end if;
  insert into public.friendships (requester, addressee) values (me, target) on conflict do nothing;
  return 'pending';
end $$;

-- ответить на входящую заявку
create or replace function public.friend_respond(req uuid, accept boolean)
returns boolean language plpgsql security definer set search_path = public
as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Требуется вход'; end if;
  if not exists (select 1 from public.friendships where id = req and addressee = me and status = 'pending') then
    raise exception 'Заявка не найдена';
  end if;
  if accept then update public.friendships set status = 'accepted' where id = req;
  else delete from public.friendships where id = req; end if;
  return true;
end $$;

create or replace function public.are_friends(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.friendships f where f.status = 'accepted'
       and ((f.requester = a and f.addressee = b) or (f.requester = b and f.addressee = a))); $$;

-- ============ 5. Активные сессии ============
create table if not exists public.user_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  device      text,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_active timestamptz not null default now(),
  revoked     boolean not null default false
);
create index if not exists user_sessions_user_idx on public.user_sessions (user_id);
alter table public.user_sessions enable row level security;
drop policy if exists "sessions own" on public.user_sessions;
create policy "sessions own" on public.user_sessions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.user_sessions to authenticated;

-- ============ 6. Права в группах ============
alter table public.chats add column if not exists only_admins_post boolean not null default false;
alter table public.chats add column if not exists allow_media      boolean not null default true;
alter table public.chats add column if not exists description      text;

alter table public.chat_members add column if not exists last_delivered_at timestamptz;

create or replace function public.can_post_message(chat uuid, usr uuid, is_media boolean)
returns boolean language plpgsql stable security definer set search_path = public
as $$
declare c record; staff boolean;
begin
  select * into c from public.chats where id = chat;
  if not found then return false; end if;
  if c.type <> 'group' then return true; end if;
  staff := c.created_by = usr or exists (
    select 1 from public.chat_members m where m.chat_id = chat and m.user_id = usr and m.role in ('owner','admin'));
  if staff then return true; end if;
  if c.only_admins_post then return false; end if;
  if is_media and not c.allow_media then return false; end if;
  return true;
end $$;

-- приватность: в личный чат пишут только те, кого разрешил получатель
create or replace function public.can_direct_message(chat uuid, usr uuid)
returns boolean language plpgsql stable security definer set search_path = public
as $$
declare c record; other uuid; pm text;
begin
  select * into c from public.chats where id = chat;
  if not found or c.type <> 'direct' then return true; end if;
  select m.user_id into other from public.chat_members m where m.chat_id = chat and m.user_id <> usr limit 1;
  if other is null then return true; end if; -- «Избранное»
  select p.privacy_messages into pm from public.profiles p where p.id = other;
  if coalesce(pm, 'everyone') = 'friends' and not public.are_friends(usr, other) then return false; end if;
  return true;
end $$;

-- RESTRICTIVE-политики складываются с существующими через AND
drop policy if exists "messages post perms" on public.messages;
create policy "messages post perms" on public.messages as restrictive for insert to authenticated
  with check (
    public.can_post_message(chat_id, auth.uid(),
      coalesce(attachment_type, '') not in ('', 'sticker'))
    and public.can_direct_message(chat_id, auth.uid())
  );

-- роли участников: назначает только владелец чата
create or replace function public.guard_member_update()
returns trigger language plpgsql security definer set search_path = public
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then return new; end if;
  if new.role is distinct from old.role then
    if not public.is_admin()
       and not exists (select 1 from public.chats c where c.id = new.chat_id and c.created_by = uid)
       and not exists (select 1 from public.chat_members m where m.chat_id = new.chat_id and m.user_id = uid and m.role = 'owner') then
      raise exception 'Менять роли может только владелец';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_member_update on public.chat_members;
create trigger guard_member_update before update on public.chat_members
  for each row execute function public.guard_member_update();

drop policy if exists "members role by owner" on public.chat_members;
create policy "members role by owner" on public.chat_members for update to authenticated
  using (exists (select 1 from public.chats c where c.id = chat_id and c.created_by = auth.uid()));

-- поиск публичных сообществ по названию
create or replace function public.search_public_chats(q text)
returns table (id uuid, title text, avatar_url text, description text, members bigint)
language sql stable security definer set search_path = public
as $$
  select c.id, c.title, c.avatar_url, c.description,
         (select count(*) from public.chat_members m where m.chat_id = c.id)
  from public.chats c
  where c.is_public = true and c.type = 'group' and c.title ilike '%' || replace(replace(q, '%', ''), '_', '') || '%'
  order by c.last_message_at desc nulls last
  limit 20;
$$;

-- ============ 7. Права и realtime ============
grant execute on all functions in schema public to anon, authenticated;

do $$ begin alter publication supabase_realtime add table public.friendships;
exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.user_sessions;
exception when others then null; end $$;

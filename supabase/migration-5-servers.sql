-- ============================================================
--  MSPgram 2.0 — миграция №5: серверы с каналами, реакции,
--  ссылки-приглашения, пересылка, закрепы
--
--  Новые проекты: просто schema.sql (там всё есть).
--  Существующие проекты: Supabase → SQL Editor → весь файл → Run.
--  Безопасен при повторном запуске, данные не трогает.
-- ============================================================

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
  exists (select 1 from public.chat_members m where m.chat_id = chat_id and m.user_id = auth.uid() and m.role in ('owner','admin'))
);
drop policy if exists "channels delete" on public.channels;
create policy "channels delete" on public.channels for delete to authenticated using (
  exists (select 1 from public.chat_members m where m.chat_id = chat_id and m.user_id = auth.uid() and m.role in ('owner','admin'))
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

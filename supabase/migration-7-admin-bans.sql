-- ============================================================
-- Миграция 7: админ-панель и баны
-- Применена в БД 2026-11-23 через Supabase-коннектор (create_migration).
-- Хелперы public.is_admin() / public.is_banned_user() — SECURITY DEFINER.
-- Политики: profiles update (админ может менять юзернеймы),
-- messages insert (запрещён банненым), messages admin read/delete,
-- chats/members admin read (чтение переписки), members insert без бана.
-- Админ: первый аккаунт (msp69).
-- ============================================================

alter table public.profiles add column if not exists is_admin boolean not null default false;
alter table public.profiles add column if not exists is_banned boolean not null default false;
alter table public.profiles add column if not exists banned_until timestamptz;
alter table public.profiles add column if not exists ban_reason text;

update public.profiles
set is_admin = true
where nickname = 'msp69'
  and not exists (select 1 from public.profiles p2 where p2.is_admin);

create or replace function public.is_admin()
returns boolean language sql stable security definer
set search_path = 'public' as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

create or replace function public.is_banned_user()
returns boolean language sql stable security definer
set search_path = 'public' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.is_banned
      and (p.banned_until is null or p.banned_until > now())
  );
$$;

drop policy if exists "profiles update" on public.profiles;
create policy "profiles update" on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

drop policy if exists "messages insert" on public.messages;
create policy "messages insert" on public.messages for insert to authenticated
  with check ((sender_id = auth.uid()) and public.is_chat_member(chat_id) and not public.is_banned_user());

create policy "messages admin read" on public.messages for select to authenticated
  using (public.is_admin());

create policy "messages admin delete" on public.messages for delete to authenticated
  using (public.is_admin());

create policy "chats admin read" on public.chats for select to authenticated
  using (public.is_admin());

create policy "members admin read" on public.chat_members for select to authenticated
  using (public.is_admin());

drop policy if exists "members insert" on public.chat_members;
create policy "members insert" on public.chat_members for insert to authenticated
  with check (public.can_join_chat(chat_id) and not public.is_banned_user());

drop policy if exists "messages update" on public.messages;
create policy "messages update" on public.messages for update to authenticated
  using ((sender_id = auth.uid()) or public.is_admin())
  with check ((sender_id = auth.uid()) or public.is_admin());

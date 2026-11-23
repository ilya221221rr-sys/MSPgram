-- ============================================================
--  MSPgram v19 «Nova» — миграция БД (безопасно запускать повторно)
--  Supabase → SQL Editor → New query → вставить ВЕСЬ файл → Run
--  Требует, чтобы migration-9-v18.sql уже была применена.
--  ⚠️ schema.sql повторно НЕ запускать (он стирает таблицы).
-- ============================================================

-- 1. Объявления администрации (баннер у всех пользователей) ----------------
create table if not exists public.app_announcements (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(title) between 1 and 80),
  body        text not null default '' check (char_length(body) <= 500),
  level       text not null default 'info' check (level in ('info','warn','critical')),
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz
);
alter table public.app_announcements enable row level security;
drop policy if exists "ann read" on public.app_announcements;
create policy "ann read" on public.app_announcements for select to authenticated using (true);
drop policy if exists "ann admin write" on public.app_announcements;
create policy "ann admin write" on public.app_announcements for insert to authenticated with check (public.is_admin());
drop policy if exists "ann admin delete" on public.app_announcements;
create policy "ann admin delete" on public.app_announcements for delete to authenticated using (public.is_admin());

-- 2. Журнал действий персонала -------------------------------------------
create table if not exists public.admin_audit (
  id          bigint generated always as identity primary key,
  actor       uuid references public.profiles(id) on delete set null,
  actor_name  text,
  action      text not null,
  target      text not null default '',
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists admin_audit_created_idx on public.admin_audit (created_at desc);
alter table public.admin_audit enable row level security;
drop policy if exists "audit staff insert" on public.admin_audit;
create policy "audit staff insert" on public.admin_audit for insert to authenticated
  with check (public.is_moderator() and actor = auth.uid());
drop policy if exists "audit admin read" on public.admin_audit;
create policy "audit admin read" on public.admin_audit for select to authenticated using (public.is_admin());

-- 3. Заметки персонала о пользователях (НЕ видны самим пользователям) ------
create table if not exists public.admin_notes (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  note        text not null default '' check (char_length(note) <= 500),
  updated_by  uuid references public.profiles(id) on delete set null,
  updated_at  timestamptz not null default now()
);
alter table public.admin_notes enable row level security;
drop policy if exists "notes staff all" on public.admin_notes;
create policy "notes staff all" on public.admin_notes for all to authenticated
  using (public.is_moderator()) with check (public.is_moderator());

-- 4. Ошибки ИИ у пользователей (для вкладки «🩺 ИИ» в админке) -------------
create table if not exists public.ai_errors (
  id          bigint generated always as identity primary key,
  user_id     uuid references public.profiles(id) on delete cascade,
  url         text, model text, status int, message text, hint text, details text,
  created_at  timestamptz not null default now()
);
create index if not exists ai_errors_created_idx on public.ai_errors (created_at desc);
alter table public.ai_errors enable row level security;
drop policy if exists "ai_err insert own" on public.ai_errors;
create policy "ai_err insert own" on public.ai_errors for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "ai_err staff read" on public.ai_errors;
create policy "ai_err staff read" on public.ai_errors for select to authenticated using (public.is_moderator());
drop policy if exists "ai_err admin delete" on public.ai_errors;
create policy "ai_err admin delete" on public.ai_errors for delete to authenticated using (public.is_admin());
-- ограничение «связь профиля»: нужна для выборки profiles(...) из ai_errors
-- (внешний ключ user_id → profiles(id) создан выше)

-- 5. Админ может удалять сообщения любого пользователя (для «стереть всё») --
drop policy if exists "messages admin delete" on public.messages;
create policy "messages admin delete" on public.messages for delete to authenticated using (public.is_admin());

-- 6. Права и realtime ---------------------------------------------------
grant select, insert, delete on public.app_announcements to authenticated;
grant select, insert on public.admin_audit to authenticated;
grant select, insert, update, delete on public.admin_notes to authenticated;
grant select, insert, delete on public.ai_errors to authenticated;
do $$ begin alter publication supabase_realtime add table public.app_announcements;
exception when others then null; end $$;

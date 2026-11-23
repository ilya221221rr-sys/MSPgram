-- ============================================================
-- Миграция 6: фикс создания серверов (RLS)
-- Применена в БД 2026-11-22 через Supabase-коннектор.
--
-- Причина бага: политика "chats read" (is_chat_member) не пускала
-- только что созданный чат в INSERT ... RETURNING — создатель ещё
-- НЕ участник на момент вставки (участники добавляются следующим
-- запросом). PostgREST возвращает пустой результат => supabase-js
-- .single() кидает PGRST116 => «Сервер не создаётся».
--
-- Заодно: тавтология m.chat_id = m.chat_id в политиках channels
-- делала владельца ЛЮБОГО сервера хозяином каналов ЧУЖИХ серверов.
-- ============================================================

drop policy if exists "chats read" on public.chats;
create policy "chats read" on public.chats for select to authenticated
  using (public.is_chat_member(id) or created_by = auth.uid());

drop policy if exists "channels insert" on public.channels;
create policy "channels insert" on public.channels for insert to authenticated with check (
  exists (
    select 1 from public.chat_members m
    where m.chat_id = channels.chat_id
      and m.user_id = auth.uid()
      and m.role in ('owner','admin')
  )
);

drop policy if exists "channels delete" on public.channels;
create policy "channels delete" on public.channels for delete to authenticated using (
  exists (
    select 1 from public.chat_members m
    where m.chat_id = channels.chat_id
      and m.user_id = auth.uid()
      and m.role in ('owner','admin')
  )
);

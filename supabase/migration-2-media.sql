-- ============================================================
--  MSPgram — миграция №2: ответы, голосовые и видеосообщения
--
--  Кому нужна: если проект Supabase создан РАНЬШЕ (база уже работает).
--  Новые проекты просто запускают schema.sql целиком — там всё уже есть.
--
--  Куда вставлять: Supabase → SQL Editor → New query → весь файл → Run.
--  Запускать можно многократно, ошибок и потери данных не будет.
-- ============================================================

-- 1. Новые поля сообщений: ответ и длительность медиа
alter table public.messages
  add column if not exists reply_to uuid references public.messages(id) on delete set null;

alter table public.messages
  add column if not exists duration_ms integer;

create index if not exists messages_reply_idx on public.messages (reply_to);

-- 2. Превью последнего сообщения в списке чатов: голосовые и видео
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

-- Готово! После этого обнови страницу мессенджера.

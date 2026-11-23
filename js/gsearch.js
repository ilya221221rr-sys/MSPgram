// Глобальный поиск: сообщения по всем чатам + публичные сообщества
import { state, dbApi, chatTitleFor, otherMember, isSavedChat } from './api.js';
import { esc, el, bus, toast, avatarHTML, fmtListTime } from './utils.js';
import { jumpToMessage } from './chatview.js';

function snippet(body, q) {
  const text = (body || '').replace(/\s+/g, ' ');
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  const from = Math.max(0, i - 24);
  const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
  return (from > 0 ? '…' : '') + esc(text.slice(from, from + 90)).replace(re, (x) => `<mark>${x}</mark>`);
}

export async function appendGlobalResults(container, q, isStale) {
  if (q.length < 2) return;
  const [msgs, pubs] = await Promise.all([
    dbApi.searchMessages(q).catch(() => []),
    dbApi.searchPublicChats(q).catch(() => []),
  ]);
  if (isStale()) return;

  const mine = msgs.filter((m) => state.chats.has(m.chat_id) && m.body).slice(0, 12);
  if (mine.length) {
    container.appendChild(el('<div class="search-section">Сообщения</div>'));
    mine.forEach((m) => {
      const chat = state.chats.get(m.chat_id);
      const other = otherMember(chat);
      const title = isSavedChat(chat) ? 'Избранное' : chatTitleFor(chat);
      const av = chat.type === 'group' ? chat.avatar_url : other?.avatar_url;
      const row = el(`<div class="person-row msg-hit">
        ${avatarHTML(av, title, 'md', false)}
        <div class="chat-row-main">
          <div class="chat-row-top"><span class="chat-row-title">${esc(title)}</span><span class="chat-row-time">${esc(fmtListTime(m.created_at))}</span></div>
          <div class="chat-row-bottom"><span class="chat-row-preview hit-text">${snippet(m.body, q)}</span></div>
        </div></div>`);
      row.addEventListener('click', async () => {
        bus.emit('open-chat', m.chat_id);
        setTimeout(() => jumpToMessage(m.id), 450);
      });
      container.appendChild(row);
    });
  }

  const fresh = pubs.filter((c) => !state.chats.has(c.id)).slice(0, 8);
  if (fresh.length) {
    container.appendChild(el('<div class="search-section">Публичные сообщества</div>'));
    fresh.forEach((c) => {
      const row = el(`<div class="person-row">
        ${avatarHTML(c.avatar_url, c.title, 'md', false)}
        <div class="chat-row-main">
          <div class="chat-row-top"><span class="chat-row-title">${esc(c.title || 'Сообщество')}</span></div>
          <div class="chat-row-bottom"><span class="chat-row-preview">${c.members ? esc(c.members + ' участн.') : 'публичное'}${c.description ? ' · ' + esc(c.description) : ''}</span></div>
        </div><button class="btn primary sm">Вступить</button></div>`);
      row.querySelector('button').addEventListener('click', async (e) => {
        e.stopPropagation(); e.target.disabled = true;
        try {
          await dbApi.joinPublic(c.id);
          toast(`Ты в «${c.title}» 🎉`);
          bus.emit('open-chat', c.id);
          import('./chatlist.js').then((m) => m.renderChatList());
        } catch (err) { toast('Не удалось вступить: ' + err.message); e.target.disabled = false; }
      });
      container.appendChild(row);
    });
  }
}

// Окно чата 2.0: каналы серверов, реакции, закрепы, пересылка, поиск, черновики
import { state, dbApi, storeApi, getSb, otherMember, memberProfile, chatTitleFor, isSavedChat } from './api.js';
import {
  qs, qsa, esc, el, bus, toast, avatarHTML, fmtTime, fmtDaySep, sameDayKey,
  relLastSeen, fmtBytes, fmtDuration, confirmDialog, debounce, beep, getPrefs, setPrefs,
} from './utils.js';
import { recordVoice, recordVideo, canRecordVoice, canRecordVideo, extOf } from './media.js';
import { startCall, joinVoice, leaveVoice, inVoice, initCallsUI } from './calls.js';
import { initStickers, stickerEmojiOf, stickerAnimOf } from './stickers.js';
import { openProfile } from './profile.js';

let msgs = [];
let msgIds = new Set();
let hasMore = false;
let typingChan = null;
let lastTypingSent = 0;
let sending = false;
let replyState = null;
let editState = null;        // сообщение в режиме правки
let currentAudio = null;
let pendingBelow = 0;
let searchOpen = false;

// реакции: msgId -> Map(emoji -> Set(userId))
const reactions = new Map();

const MSG_LIMIT = 50;
const MEDIA_PREVIEW = {
  image: '📷 Фото', video: '🎥 Видеосообщение', voice: '🎤 Голосовое сообщение', file: '📎 Файл',
};
const QUICK_EMOJI = ['👍', '❤️', '🔥', '😂', '😮', '😢', '🎉'];

function previewOf(m) {
  return m.body || MEDIA_PREVIEW[m.attachment_type] || '';
}

// ================== ОТКРЫТИЕ / ЗАКРЫТИЕ ==================

export async function openChat(chatId, opts = {}) {
  const chat = state.chats.get(chatId);
  if (!chat) return;
  state.activeChatId = chatId;
  document.body.classList.add('chat-open');

  qs('#chat-empty').classList.add('hidden');
  qs('#chat-view').classList.remove('hidden');
  qsa('.chat-row').forEach((r) => r.classList.toggle('active', r.dataset.chat === chatId));

  msgs = [];
  msgIds = new Set();
  hasMore = false;
  reactions.clear();
  state.unread.delete(chatId);
  clearReply();
  setSearchOpen(false);
  import('./chatlist.js').then((m) => m.renderChatList());

  // каналы сервера
  if (dbApi.isServerChat(chat)) {
    try {
      await dbApi.loadChannels(chatId);
      if (!chat._channelId && chat._channels?.length) {
        chat._channelId = chat._channels[0].id;
      }
    } catch (e) { console.warn('channels:', e.message); }
  } else {
    chat._channels = null;
    chat._channelId = null;
  }

  renderHeader();
  renderPinnedBar();
  updateCallButtons();
  const box = qs('#messages');
  box.innerHTML = '<div class="loader">Загружаю…</div>';
  box.scrollTop = 0;
  restoreDraft();

  try {
    const loaded = await dbApi.loadMessages(chatId, MSG_LIMIT);
    if (state.activeChatId !== chatId) return;
    msgs = loaded;
    msgs.forEach((m) => msgIds.add(m.id));
    hasMore = msgs.length >= MSG_LIMIT;
    await loadReactionsFor(msgs.map((m) => m.id));
    renderMessages(true);
  } catch (e) {
    box.innerHTML = `<div class="list-empty">${esc(e.message)}</div>`;
    return;
  }

  joinTypingChannel(chatId);
  pendingBelow = 0;
  updateScrollBtn();
  if (document.hasFocus() && document.visibilityState === 'visible') {
    dbApi.markRead(chatId);
  }
  bus.emit('chat-opened', chatId);
}

export function closeChat() {
  saveDraft();
  state.activeChatId = null;
  document.body.classList.remove('chat-open');
  qs('#chat-view').classList.add('hidden');
  qs('#chat-empty').classList.remove('hidden');
  stopPlayback();
  leaveTypingChannel();
  clearReply();
}

// ================== ЗАГОЛОВОК: каналы + поиск ==================

function renderHeader() {
  const chat = state.chats.get(state.activeChatId);
  if (!chat) return;
  const other = otherMember(chat);
  const isTyping = typingText(chat.id);
  const saved = isSavedChat(chat);
  const online = !saved && chat.type === 'direct' && other && state.online.has(other.id);

  let sub;
  if (isTyping) sub = isTyping;
  else if (saved) sub = 'только для тебя';
  else if (chat.type === 'direct') {
    const nick = other ? `@${other.nickname}` : '';
    sub = nick ? `${nick} · ${relLastSeen(other?.last_seen, online)}` : relLastSeen(other?.last_seen, online);
  } else {
    sub = `${(chat.members || []).length} участник${plural((chat.members || []).length)}`;
  }

  const headAv = saved
    ? '<span class="avatar md saved-av">🔖</span>'
    : avatarHTML(chat.type === 'group' ? chat.avatar_url : other?.avatar_url, chatTitleFor(chat), 'md', false);

  const info = qs('#chat-head-info');
  const headProfile = (!saved && chat.type === 'direct' && other)
    ? ` data-profile="${esc(other.id)}" title="Открыть профиль"` : '';
  info.innerHTML = `
    ${headAv}
    <div class="chat-head-text clickable"${headProfile}>
      <div class="chat-head-title">${esc(chatTitleFor(chat))}</div>
      <div class="chat-head-sub ${online ? 'on' : ''}">${esc(sub)}</div>
    </div>`;

  // пилюля канала (для серверов)
  const pill = qs('#channel-pill');
  const isServer = dbApi.isServerChat(chat);
  pill.classList.toggle('hidden', !isServer);
  if (isServer) {
    const cur = (chat._channels || []).find((c) => c.id === chat._channelId);
    pill.innerHTML = `<span class="ch-hash">#</span>${esc(cur ? cur.name : 'общий')} <span class="ch-caret">▾</span>`;
  }
}

function plural(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'ь';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'я';
  return 'ей';
}

// ---------- выпадающий список каналов ----------
function toggleChannelMenu() {
  const chat = state.chats.get(state.activeChatId);
  if (!chat || !dbApi.isServerChat(chat)) return;
  const existing = qs('.channel-menu');
  if (existing) { existing.remove(); return; }
  const isAdmin = chat.created_by === state.me.id
    || (chat.members || []).some((x) => x.user_id === state.me.id && ['owner', 'admin'].includes(x.role));

  const menu = el(`
    <div class="channel-menu">
      <div class="channel-menu-title">Каналы</div>
      ${(chat._channels || []).map((c) => `
        <div class="channel-item ${c.id === chat._channelId ? 'cur' : ''}" data-ch="${c.id}">
          <span class="ch-hash">#</span>${esc(c.name)}
          ${isAdmin && c.name !== 'общий' ? `<button class="ch-del" data-delch="${c.id}" title="Удалить канал">✕</button>` : ''}
        </div>`).join('')}
      ${isAdmin ? '<div class="channel-item add"><span class="ch-hash">＋</span>Создать канал</div>' : ''}
    </div>`);
  qs('#chat-head').appendChild(menu);

  menu.addEventListener('click', async (e) => {
    const delBtn = e.target.closest('[data-delch]');
    if (delBtn) {
      e.stopPropagation();
      const ok = await confirmDialog({ title: 'Удалить канал?', text: 'Все его сообщения исчезнут.' });
      if (!ok) return;
      try {
        await dbApi.deleteChannel(delBtn.dataset.delch, chat.id);
        menu.remove();
        if (chat._channels?.length) {
          chat._channelId = chat._channels[0].id;
          openChat(chat.id);
        } else closeChat();
        toast('Канал удалён');
      } catch (err) { toast('Ошибка: ' + err.message); }
      return;
    }
    if (e.target.closest('.channel-item.add')) {
      menu.remove();
      const name = await promptModal('Новый канал', 'Например: флудилкa, мемы, музыка');
      if (!name) return;
      try {
        const ch = await dbApi.createChannel(chat.id, name);
        chat._channelId = ch.id;
        openChat(chat.id);
        toast(`Канал #${name} создан ✓`);
      } catch (err) { toast('Ошибка: ' + err.message); }
      return;
    }
    const item = e.target.closest('.channel-item[data-ch]');
    if (item) {
      menu.remove();
      if (item.dataset.ch !== chat._channelId) {
        chat._channelId = item.dataset.ch;
        saveDraft();
        openChat(chat.id);
      }
    }
  });
  setTimeout(() => document.addEventListener('click', closeChannelMenuOnce, { once: true }), 0);
}
function closeChannelMenuOnce(e) {
  if (e.target.closest('.channel-menu')) {
    document.addEventListener('click', closeChannelMenuOnce, { once: true });
    return;
  }
  document.querySelector('.channel-menu')?.remove();
}

// маленький ввод текста в модалке (для названия канала)
function promptModal(title, placeholder) {
  return new Promise((resolve) => {
    const m = el(`
      <div class="modal-overlay">
        <div class="modal confirm-modal">
          <h3>${esc(title)}</h3>
          <input id="pm-value" type="text" maxlength="30" placeholder="${esc(placeholder || '')}">
          <div class="modal-actions">
            <button class="btn ghost" data-act="no">Отмена</button>
            <button class="btn primary" data-act="yes">Создать</button>
          </div>
        </div>
      </div>`);
    document.querySelector('#modal-root').appendChild(m);
    const inp = m.querySelector('#pm-value');
    inp.focus();
    const close = (v) => { m.remove(); resolve(v); };
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-act=no]')) close(null);
      if (e.target.closest('[data-act=yes]')) close(inp.value.trim());
    });
    m.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(inp.value.trim());
      if (e.key === 'Escape') close(null);
    });
  });
}

// ================== ЗАКРЕПЛЁННОЕ СООБЩЕНИЕ ==================

function renderPinnedBar() {
  const chat = state.chats.get(state.activeChatId);
  const bar = qs('#pinned-bar');
  if (!bar) return;
  const pinnedId = chat?.pinned_message_id;
  const m = pinnedId ? msgs.find((x) => x.id === pinnedId) : null;
  if (!pinnedId || (!m && !msgs.length)) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  const sender = m ? memberProfile(chat, m.sender_id) : null;
  const name = sender ? (sender.display_name || `@${sender.nickname}`) : 'Сообщение';
  bar.innerHTML = `
    <div class="pinned-inner" data-jump="${esc(pinnedId)}">
      <span class="pinned-icon">📌</span>
      <div class="pinned-text">
        <div class="pinned-name">Закреплено · ${esc(name)}</div>
        <div class="pinned-preview">${m ? esc(previewOf(m)) : 'открой, чтобы увидеть'}</div>
      </div>
      <button class="pinned-close" title="Открепить">✕</button>
    </div>`;
  bar.classList.remove('hidden');

  bar.querySelector('.pinned-inner').addEventListener('click', async (e) => {
    if (e.target.closest('.pinned-close')) {
      try { await dbApi.unpinMessage(chat.id); renderPinnedBar(); toast('Откреплено'); } catch (err) { toast('Ошибка: ' + err.message); }
      return;
    }
    jumpToMessage(pinnedId);
  });
}

// ================== СООБЩЕНИЯ ==================

function linkify(escaped) {
  return escaped.replace(/(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

function barsHTML(seed) {
  let h = 0;
  for (const c of String(seed || '')) h = ((h * 31 + c.codePointAt(0)) >>> 0);
  let out = '';
  for (let i = 0; i < 24; i++) {
    h = ((h * 1103515245 + 12345) >>> 0);
    const v = 25 + ((h >>> 16) % 75);
    out += `<i style="height:${v}%"></i>`;
  }
  return out;
}

function reactionsHTML(m) {
  const r = reactions.get(m.id);
  if (!r || !r.size) return '';
  const chips = [...r.entries()].map(([emoji, users]) => `
    <button class="react-chip ${users.has(state.me.id) ? 'mine' : ''}" data-react="${esc(emoji)}" data-msg="${esc(m.id)}">
      ${esc(emoji)}<span>${users.size}</span>
    </button>`).join('');
  return `<div class="msg-reactions">${chips}</div>`;
}

function messageEl(m, chat, showDaySep) {
  const meId = state.me.id;
  const own = m.sender_id === meId;
  const sender = memberProfile(chat, m.sender_id);
  const name = sender ? (sender.display_name || `@${sender.nickname}`) : 'Участник';

  const parts = [];
  if (showDaySep) {
    parts.push(`<div class="day-sep"><span>${esc(fmtDaySep(m.created_at))}</span></div>`);
  }

  let quote = '';
  if (m.reply_to) {
    const orig = msgs.find((x) => x.id === m.reply_to);
    const origSender = orig ? memberProfile(chat, orig.sender_id) : null;
    const origName = origSender ? (origSender.display_name || `@${origSender.nickname}`) : 'Сообщение';
    quote = `
      <div class="msg-quote" data-target="${esc(m.reply_to)}">
        <div class="msg-quote-name">${esc(origName)}</div>
        <div class="msg-quote-text">${esc(orig ? previewOf(orig) : 'сообщение удалено')}</div>
      </div>`;
  }

  const fwd = m.forwarded_from
    ? `<div class="msg-fwd">↪ Переслано от <b>${esc(m.forwarded_from)}</b></div>` : '';

  let content = '';
  if (m.attachment_type === 'sticker' && m.attachment_name) {
    content += `<div class="sticker-msg ${stickerAnimOf(m)}" title="Стикер">${stickerEmojiOf(m)}</div>`;
  }
  if (m.attachment_type === 'image' && m.attachment_url) {
    content += `<img class="msg-img" src="${esc(m.attachment_url)}" alt="Фото" loading="lazy">`;
  }
  if (m.attachment_type === 'video' && m.attachment_url) {
    content += `<video class="msg-video" src="${esc(m.attachment_url)}" controls preload="metadata" playsinline></video>`;
  }
  if (m.attachment_type === 'voice' && m.attachment_url) {
    const dur = Math.round((m.duration_ms || 0) / 1000);
    content += `
      <div class="voice" data-url="${esc(m.attachment_url)}" data-dur="${dur}">
        <button class="voice-play" title="Прослушать">▶</button>
        <div class="voice-bars">${barsHTML(m.id)}</div>
        <span class="voice-time">${fmtDuration(dur)}</span>
      </div>`;
  }
  if (m.attachment_type === 'file' && m.attachment_url) {
    content += `
      <a class="msg-file" href="${esc(m.attachment_url)}" target="_blank" rel="noopener">
        <span class="msg-file-icon">📎</span>
        <span class="msg-file-info">
          <span class="msg-file-name">${esc(m.attachment_name || 'Файл')}</span>
          <span class="msg-file-size">${fmtBytes(m.attachment_size)}</span>
        </span>
      </a>`;
  }
  const bodyHTML = editState === m.id
    ? `<div class="msg-editing"><textarea id="edit-inline" rows="2" maxlength="4000">${esc(m.body)}</textarea>
       <div class="msg-editing-hint">Enter — сохранить · Esc — отмена</div></div>`
    : (m.body ? `<div class="msg-text">${linkify(esc(m.body)).replaceAll('\n', '<br>')}</div>` : '');

  let ticks = '';
  if (own) {
    const othersRead = (chat.members || [])
      .filter((x) => x.user_id !== meId && x.last_read_at)
      .some((x) => new Date(x.last_read_at) >= new Date(m.created_at));
    ticks = `<span class="msg-ticks${othersRead ? ' read' : ''}">${othersRead ? '✓✓' : '✓'}</span>`;
  }
  const edited = m.edited_at ? '<span class="msg-edited">изм.</span>' : '';

  // автор показывается у ВСЕХ входящих сообщений (и в личных чатах тоже);
  // клик по имени/аватарке открывает профиль
  const author = !own
    ? `<div class="msg-author clickable" data-profile="${esc(m.sender_id)}" title="Открыть профиль">${avatarHTML(sender?.avatar_url, name, 'xs')}${esc(name)}</div>` : '';

  parts.push(`
    <div class="msg-row${own ? ' own' : ''}" data-id="${m.id}">
      ${author}
      <div class="msg${own ? ' out' : ' in'}">
        ${quote}${fwd}${content}
        ${bodyHTML || (!content ? '<div class="msg-text muted">Пустое сообщение</div>' : '')}
        ${reactionsHTML(m)}
        <div class="msg-meta"><span class="msg-time">${fmtTime(m.created_at)}</span>${edited}${ticks}</div>
        <button class="msg-more" data-more="${esc(m.id)}" title="Ещё">⋯</button>
      </div>
    </div>`);
  return parts.join('');
}

function renderMessages(scrollToBottom = false) {
  const chat = state.chats.get(state.activeChatId);
  if (!chat) return;
  const box = qs('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;

  let html = '';
  if (hasMore) html += `<button class="load-earlier" id="load-earlier">Показать ещё</button>`;
  if (!msgs.length) {
    html += `<div class="list-empty chat-start">
      ${esc(chatTitleFor(chat))} — начало 🎉<br>Напиши текст, отправь фото, голосовое или видео!
    </div>`;
  }
  let lastDay = null;
  for (const m of msgs) {
    const day = sameDayKey(m.created_at);
    const showSep = day !== lastDay;
    lastDay = day;
    html += messageEl(m, chat, showSep);
  }
  html += `<div class="typing-row" id="typing-row"></div>`;
  box.innerHTML = html;

  const le = qs('#load-earlier', box);
  if (le) le.addEventListener('click', loadEarlier);

  renderTyping();
  renderPinnedBar();
  if (scrollToBottom || nearBottom) box.scrollTop = box.scrollHeight;
  updateScrollBtn();

  // режим правки: фокус и обработчики
  const ed = qs('#edit-inline', box);
  if (ed) {
    ed.focus();
    ed.setSelectionRange(ed.value.length, ed.value.length);
    ed.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        await commitInlineEdit(ed.value.trim());
      }
      if (e.key === 'Escape') { editState = null; renderMessages(false); }
    });
  }
}

async function commitInlineEdit(body) {
  const id = editState;
  editState = null;
  if (!body) { renderMessages(false); return; }
  try {
    const updated = await dbApi.editMessage(id, body);
    const idx = msgs.findIndex((x) => x.id === id);
    if (idx !== -1) msgs[idx] = updated;
    renderMessages(false);
    toast('Изменено ✓');
  } catch (e) { toast('Ошибка: ' + e.message); renderMessages(false); }
}

async function loadReactionsFor(ids) {
  try {
    const rows = await dbApi.loadReactions(ids);
    for (const r of rows) {
      if (!reactions.has(r.message_id)) reactions.set(r.message_id, new Map());
      const m = reactions.get(r.message_id);
      if (!m.has(r.emoji)) m.set(r.emoji, new Set());
      m.get(r.emoji).add(r.user_id);
    }
  } catch { /* реакции не критичны */ }
}

async function loadEarlier() {
  if (!msgs.length || !hasMore) return;
  const box = qs('#messages');
  const btn = qs('#load-earlier');
  if (btn) { btn.disabled = true; btn.textContent = 'Загружаю…'; }
  const firstVisible = findFirstVisibleMsgId(box);
  try {
    const earlier = await dbApi.loadEarlier(state.activeChatId, msgs[0].created_at);
    hasMore = earlier.length >= 30;
    const seen = new Set(msgs.map((m) => m.id));
    for (const m of earlier) if (!seen.has(m.id)) msgs.push(m);
    msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    await loadReactionsFor(earlier.map((m) => m.id));
    renderMessages(false);
    const anchor = firstVisible && qs(`.msg-row[data-id="${firstVisible}"]`, box);
    if (anchor) box.scrollTop = Math.max(0, anchor.offsetTop - 60);
  } catch (e) {
    toast('Ошибка: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Показать ещё'; }
  }
}

function findFirstVisibleMsgId(box) {
  const rows = qsa('.msg-row', box);
  for (const r of rows) {
    if (r.offsetTop + r.offsetHeight >= box.scrollTop) return r.dataset.id;
  }
  return null;
}

// ================== НОВОЕ СООБЩЕНИЕ / СОБЫТИЯ ==================

export function onNewMessage(m) {
  if (m.chat_id !== state.activeChatId) return;
  if (msgIds.has(m.id)) return;
  // в серверах показываем только сообщения текущего канала
  const chat = state.chats.get(state.activeChatId);
  if (chat && chat.type === 'group' && chat._channelId && m.channel_id && m.channel_id !== chat._channelId) return;
  msgIds.add(m.id);
  msgs.push(m);
  msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const box = qs('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  renderMessages(m.sender_id === state.me.id || m.body || m.attachment_type);
  if (m.sender_id !== state.me.id && document.hasFocus()) {
    dbApi.markRead(m.chat_id);
    beep();
  }
  if (m.sender_id !== state.me.id && !nearBottom) {
    pendingBelow += 1;
    updateScrollBtn();
  }
}

export function onMessageDeleted(id) {
  if (!msgIds.has(id)) return;
  msgIds.delete(id);
  msgs = msgs.filter((m) => m.id !== id);
  reactions.delete(id);
  renderMessages(false);
}

export function onMessageUpdated(m) {
  if (m.chat_id !== state.activeChatId) return;
  const idx = msgs.findIndex((x) => x.id === m.id);
  if (idx === -1) return;
  msgs[idx] = m;
  renderMessages(false);
}

// realtime реакции
export function onReactionChange(row, deleted = false) {
  const mid = deleted ? (row.old && row.old.message_id) : row.new && row.new.message_id;
  if (!mid || !msgs.some((x) => x.id === mid)) return;
  const uid = deleted ? row.old.user_id : row.new.user_id;
  const emo = deleted ? row.old.emoji : row.new.emoji;
  if (!reactions.has(mid)) reactions.set(mid, new Map());
  const m = reactions.get(mid);
  if (deleted) {
    m.get(emo)?.delete(uid);
    if (m.get(emo)?.size === 0) m.delete(emo);
  } else {
    if (!m.has(emo)) m.set(emo, new Set());
    m.get(emo).add(uid);
  }
  renderMessages(false);
}

// закреп через realtime
export function onChatUpdated(row) {
  const chat = state.chats.get(row.id);
  if (chat) chat.pinned_message_id = row.pinned_message_id;
  if (row.id === state.activeChatId) renderPinnedBar();
}

export function onMembersUpdated() {
  if (!state.activeChatId) return;
  renderMessages(false);
  renderHeader();
}

export function onPresenceChanged() {
  if (!state.activeChatId) return;
  renderHeader();
  import('./chatlist.js').then((m) => m.renderChatList());
}

// ================== КОНТЕКСТНОЕ МЕНЮ (вместо вечно висящих кнопок) ==================

function getMsg(id) { return msgs.find((m) => m.id === id); }

function closeMsgMenu() {
  document.querySelector('.msg-menu')?.remove();
}

function canModerate(chat) {
  return chat.created_by === state.me.id
    || (chat.members || []).some((x) => x.user_id === state.me.id && ['owner', 'admin'].includes(x.role));
}

function openMsgMenu(x, y, msgId) {
  closeMsgMenu();
  const m = getMsg(msgId);
  if (!m) return;
  const chat = state.chats.get(state.activeChatId);
  const own = m.sender_id === state.me.id;
  const mod = canModerate(chat);
  const pinned = chat.pinned_message_id === msgId;

  const menu = el(`
    <div class="msg-menu">
      <div class="msg-menu-reacts">${QUICK_EMOJI.map((e2) =>
        `<button class="react-btn" data-act="react:${esc(e2)}" title="Реакция ${e2}">${e2}</button>`).join('')}</div>
      <button data-act="reply">↩ Ответить</button>
      <button data-act="copy">⧉ Копировать</button>
      <button data-act="forward">➦ Переслать…</button>
      <button data-act="fav">🔖 В избранное</button>
      ${(mod || own) ? `<button data-act="pin">📌 ${pinned ? 'Открепить' : 'Закрепить'}</button>` : ''}
      ${own && !m.attachment_type ? '<button data-act="edit">✏️ Изменить</button>' : ''}
      ${own ? '<button class="danger" data-act="del">🗑 Удалить</button>' : ''}
    </div>`);
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';

  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    closeMsgMenu();
    if (act.startsWith('react:')) toggleReactionLocal(msgId, act.slice(6));
    else doAction(act, msgId);
  });
  setTimeout(() => document.addEventListener('click', closeMsgMenuOnce, { once: true }), 0);
}
function closeMsgMenuOnce(e) {
  if (e.target.closest('.msg-menu')) {
    document.addEventListener('click', closeMsgMenuOnce, { once: true });
    return;
  }
  closeMsgMenu();
}

async function toggleReactionLocal(msgId, emoji) {
  try {
    await dbApi.toggleReaction(msgId, emoji);
    // локально обновим мгновенно (realtime придёт и не дублирует, т.к. Set)
    if (!reactions.has(msgId)) reactions.set(msgId, new Map());
    const map = reactions.get(msgId);
    if (!map.has(emoji)) map.set(emoji, new Set());
    const set = map.get(emoji);
    if (set.has(state.me.id)) { set.delete(state.me.id); if (!set.size) map.delete(emoji); }
    else set.add(state.me.id);
    renderMessages(false);
  } catch (e) { toast('Ошибка: ' + e.message); }
}

// ================== ДЕЙСТВИЯ ==================

function setReply(m) {
  replyState = m;
  const bar = qs('#reply-bar');
  const chat = state.chats.get(state.activeChatId);
  const sender = m ? memberProfile(chat, m.sender_id) : null;
  const name = sender ? (sender.display_name || `@${sender.nickname}`) : '';
  bar.innerHTML = `
    <div class="reply-bar-inner">
      <div class="reply-bar-text">
        <div class="reply-bar-name">Ответ ${esc(name)}</div>
        <div class="reply-bar-preview">${esc(m ? previewOf(m) : '')}</div>
      </div>
      <button class="reply-bar-close" title="Отменить ответ">✕</button>
    </div>`;
  bar.classList.remove('hidden');
  bar.querySelector('.reply-bar-close').addEventListener('click', clearReply);
  qs('#msg-input').focus();
}

function clearReply() {
  replyState = null;
  const bar = qs('#reply-bar');
  if (bar) { bar.classList.add('hidden'); bar.innerHTML = ''; }
}

async function handleDelete(msgId) {
  const ok = await confirmDialog({ title: 'Удалить сообщение?', text: 'Оно исчезнет у всех участников.' });
  if (!ok) return;
  try {
    await dbApi.deleteMessage(msgId);
    msgIds.delete(msgId);
    msgs = msgs.filter((m) => m.id !== msgId);
    reactions.delete(msgId);
    renderMessages(false);
  } catch (e) {
    toast('Не удалось удалить: ' + e.message);
  }
}

function doAction(act, msgId) {
  const m = getMsg(msgId);
  if (!m) return;
  if (act === 'reply') setReply(m);
  if (act === 'copy') {
    const text = m.body || m.attachment_url || '';
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(() => toast('Скопировано ✓'))
      .catch(() => toast('Не удалось скопировать'));
  }
  if (act === 'fav') {
    dbApi.saveToFavorites(m)
      .then(() => toast('Сохранено в «Избранное» 🔖'))
      .catch((e) => toast('Ошибка: ' + e.message));
  }
  if (act === 'edit') {
    editState = msgId;
    renderMessages(false);
  }
  if (act === 'del') handleDelete(msgId);
  if (act === 'pin') togglePin(m);
}

async function togglePin(m) {
  const chat = state.chats.get(state.activeChatId);
  try {
    if (chat.pinned_message_id === m.id) {
      await dbApi.unpinMessage(chat.id);
      toast('Откреплено');
    } else {
      await dbApi.pinMessage(chat.id, m.id);
      toast('Закреплено 📌');
    }
    renderPinnedBar();
  } catch (e) { toast('Ошибка: ' + e.message); }
}

// ---------- пересылка ----------

function openForwardModal(src) {
  const chat = state.chats.get(state.activeChatId);
  const fromName = (() => {
    const s = memberProfile(chat, src.sender_id);
    return s ? (s.display_name || `@${s.nickname}`) : 'Неизвестно';
  })();

  const m = el(`
    <div class="modal-overlay">
      <div class="modal">
        <h3>Переслать сообщение</h3>
        <div class="field-hint">Выбери, куда отправить:</div>
        <div class="gr-members fw-list">
          ${[...state.chats.values()]
            .filter((c) => c.id !== state.activeChatId)
            .sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at))
            .map((c) => {
              const isSv = isSavedChat(c);
              const title = isSv ? '🔖 Избранное' : chatTitleFor(c);
              const av = isSv
                ? '<span class="avatar sm saved-av">🔖</span>'
                : avatarHTML(c.type === 'group' ? c.avatar_url : (otherMember(c)?.avatar_url), title, 'sm');
              return `
                <div class="person-row sm fw-row" data-chat="${c.id}" data-title="${esc(title)}">
                  ${av}
                  <div class="chat-row-main"><span class="chat-row-title">${esc(title)}</span></div>
                  <span class="person-add">➦</span>
                </div>`;
            }).join('') || '<div class="list-empty">Нет других чатов</div>'}
        </div>
        <div class="modal-actions">
          <button class="btn ghost" data-act="close">Отмена</button>
        </div>
      </div>
    </div>`);

  document.querySelector('#modal-root').appendChild(m);
  const close = () => m.remove();
  m.addEventListener('click', async (e) => {
    if (e.target === m || e.target.closest('[data-act=close]')) { close(); return; }
    const row = e.target.closest('.fw-row');
    if (row) {
      try {
        await dbApi.forwardMessage(row.dataset.chat, src, fromName);
        close();
        toast(`Переслано в «${row.dataset.title}» ✓`);
      } catch (err) { toast('Ошибка: ' + err.message); }
    }
  });
}

// ================== ПРЫЖОК К СООБЩЕНИЮ + ПОИСК ==================

async function jumpToMessage(msgId) {
  if (!msgs.some((x) => x.id === msgId)) {
    // не загружено — подгружаем историю до этого момента
    const target = getMsg(msgId) || await findMessageAnywhere(msgId);
    if (!target) { toast('Сообщение не найдено'); return; }
    const box = qs('#messages');
    box.innerHTML = '<div class="loader">Загружаю…</div>';
    try {
      // перезагружаем последние N до момента target (и его самого)
      const { data, error } = await getSb().from('messages')
        .select('*').eq('chat_id', state.activeChatId)
        .lte('created_at', target.created_at)
        .order('created_at', { ascending: false }).limit(MSG_LIMIT);
      if (error) throw error;
      msgs = (data || []).slice().reverse();
      msgIds = new Set(msgs.map((m) => m.id));
      hasMore = msgs.length >= MSG_LIMIT;
      await loadReactionsFor(msgs.map((m) => m.id));
      renderMessages(true);
    } catch (e) { toast('Ошибка: ' + e.message); return; }
  }
  const row = qs(`.msg-row[data-id="${msgId}"]`);
  if (row) {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1300);
  }
}

async function findMessageAnywhere(msgId) {
  const { data, error } = await getSb().from('messages')
    .select('*').eq('id', msgId).maybeSingle();
  return error ? null : data;
}

function setSearchOpen(open) {
  searchOpen = open;
  const row = qs('#search-row');
  row.classList.toggle('hidden', !open);
  if (open) qs('#chat-search').focus();
  else { qs('#chat-search').value = ''; qs('#chat-search-results').innerHTML = ''; qs('#chat-search-results').classList.add('hidden'); }
}

async function doChatSearch() {
  const q = qs('#chat-search').value.trim();
  const box = qs('#chat-search-results');
  if (!q) { box.innerHTML = ''; box.classList.add('hidden'); return; }
  try {
    const res = await dbApi.searchMessages(q, state.activeChatId);
    box.innerHTML = res.length
      ? res.map((r) => `
          <div class="search-hit" data-hit="${esc(r.id)}">
            <span class="search-hit-time">${fmtDaySep(r.created_at)}, ${fmtTime(r.created_at)}</span>
            <span class="search-hit-text">${esc(r.body.slice(0, 80))}</span>
          </div>`).join('')
      : '<div class="search-hit empty">Ничего не нашлось</div>';
    box.classList.remove('hidden');
  } catch (e) {
    box.innerHTML = `<div class="search-hit empty">${esc(e.message)}</div>`;
    box.classList.remove('hidden');
  }
}

// ================== ПЛЕЕР ГОЛОСОВЫХ ==================

function stopPlayback() {
  if (currentAudio) {
    currentAudio.pause();
    const v = currentAudio._uiEl;
    if (v) {
      v.classList.remove('playing');
      const b = v.querySelector('.voice-play');
      if (b) b.textContent = '▶';
      setVoiceProgress(v, 0);
    }
    currentAudio = null;
  }
}

function setVoiceProgress(v, p) {
  const bars = v.querySelectorAll('.voice-bars i');
  bars.forEach((b, i) => b.classList.toggle('on', i < p * bars.length));
}

function toggleVoice(v) {
  if (currentAudio && currentAudio._uiEl === v) {
    const b = v.querySelector('.voice-play');
    if (currentAudio.paused) {
      currentAudio.play().catch(() => {});
      b.textContent = '⏸';
    } else {
      currentAudio.pause();
      b.textContent = '▶';
    }
    return;
  }
  stopPlayback();
  const a = new Audio(v.dataset.url);
  currentAudio = a;
  a._uiEl = v;
  a.addEventListener('timeupdate', () => {
    const dur = a.duration || (+v.dataset.dur) || 1;
    setVoiceProgress(v, Math.min(1, a.currentTime / dur));
  });
  a.addEventListener('ended', stopPlayback);
  const b = v.querySelector('.voice-play');
  a.play()
    .then(() => { v.classList.add('playing'); b.textContent = '⏸'; })
    .catch(() => toast('Браузер не смог воспроизвести это аудио'));
}

// ================== «ПЕЧАТАЕТ…» ==================

function joinTypingChannel(chatId) {
  leaveTypingChannel();
  const sb = getSb();
  typingChan = sb.channel(`typing-${chatId}`);
  typingChan.on('broadcast', { event: 'typing' }, ({ payload }) => {
    if (!payload || payload.uid === state.me.id) return;
    if (!state.typing.has(chatId)) state.typing.set(chatId, new Map());
    state.typing.get(chatId).set(payload.uid, { name: payload.name, until: Date.now() + 3000 });
    renderTyping();
    renderHeader();
  }).subscribe();
}

function leaveTypingChannel() {
  if (typingChan) {
    getSb().removeChannel(typingChan).catch(() => {});
    typingChan = null;
  }
}

function typingText(chatId) {
  const t = state.typing.get(chatId);
  if (!t) return '';
  const now = Date.now();
  const names = [...t.entries()].filter(([, v]) => v.until > now).map(([, v]) => v.name);
  if (!names.length) return '';
  if (names.length === 1) return `${names[0]} печатает…`;
  if (names.length === 2) return `${names[0]} и ${names[1]} печатают…`;
  return 'несколько человек печатают…';
}

function renderTyping() {
  const row = qs('#typing-row');
  if (!row) return;
  const txt = typingText(state.activeChatId);
  row.innerHTML = txt ? `<div class="typing">${esc(txt)}<span class="dots"><i></i><i></i><i></i></span></div>` : '';
}

// ================== ИНФО О ЧАТЕ (+ инвайты серверов) ==================

async function openChatInfo() {
  const chat = state.chats.get(state.activeChatId);
  if (!chat) return;
  const meId = state.me.id;
  const isOwner = chat.created_by === meId;
  const mod = canModerate(chat);

  if (isSavedChat(chat)) {
    const m = el(`
      <div class="modal-overlay">
        <div class="modal center">
          <div class="avatar xl saved-av" style="font-size:38px">🔖</div>
          <h3>Избранное</h3>
          <p class="modal-text">Твой личный чат: заметки, ссылки, голосовые и файлы.<br>Виден только тебе — и синхронизируется между устройствами.</p>
          <div class="modal-actions center-actions">
            <button class="btn ghost" data-act="close">Закрыть</button>
          </div>
        </div>
      </div>`);
    document.querySelector('#modal-root').appendChild(m);
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-act=close]')) m.remove();
    });
    return;
  }

  if (chat.type === 'direct') {
    const other = otherMember(chat);
    const online = other && state.online.has(other.id);
    const m = el(`
      <div class="modal-overlay">
        <div class="modal center">
          ${avatarHTML(other?.avatar_url, other ? (other.display_name || other.nickname) : '?', 'xl', false)}
          <h3>${esc(other ? (other.display_name || other.nickname) : 'Пользователь')}</h3>
          <div class="info-nick">@${esc(other?.nickname || '')}</div>
          <div class="info-status ${online ? 'on' : ''}">${esc(relLastSeen(other?.last_seen, online))}</div>
          ${other?.bio ? `<p class="modal-text">${esc(other.bio)}</p>` : ''}
          <div class="modal-actions">
            <button class="btn danger" id="ci-delete">Удалить чат</button>
            <button class="btn ghost" data-act="close">Закрыть</button>
          </div>
          <div class="field-hint center-hint">Чат удалится у обоих участников.</div>
        </div>
      </div>`);
    document.querySelector('#modal-root').appendChild(m);
    m.addEventListener('click', async (e) => {
      if (e.target === m || e.target.closest('[data-act=close]')) m.remove();
      if (e.target.closest('#ci-delete')) {
        const ok = await confirmDialog({ title: 'Удалить чат?', text: 'История пропадёт у обоих. Это не удалит аккаунт собеседника.' });
        if (!ok) return;
        m.remove();
        await dbApi.deleteChat(chat.id);
        closeChat();
        renderChatListBadge();
        toast('Чат удалён');
      }
    });
    return;
  }

  // ---- сервер ----
  const members = (chat.members || []).slice();
  const canKick = (mm) => mod && mm.user_id !== meId && mm.role !== 'owner';
  const rows = members.map((mm) => {
    const p = mm.profiles || {};
    const online = state.online.has(mm.user_id);
    return `
      <div class="person-row sm" data-user="${mm.user_id}">
        ${avatarHTML(p.avatar_url, p.display_name || p.nickname, 'sm', false)}
        <div class="chat-row-main">
          <div class="chat-row-top"><span class="chat-row-title">${esc(p.display_name || p.nickname)}</span>
          <span class="person-status ${online ? 'on' : ''}">${online ? 'онлайн' : esc(relLastSeen(p.last_seen, false))}</span></div>
          <div class="chat-row-bottom"><span class="chat-row-preview">@${esc(p.nickname)}</span></div>
        </div>
        ${mm.role === 'owner' ? '<span class="role-badge">владелец</span>' : ''}
        ${mm.role === 'admin' ? '<span class="role-badge admin">админ</span>' : ''}
        ${isOwner && mm.role === 'member' ? `<button class="btn tiny ghost kick-up" data-up="${mm.user_id}" title="Сделать админом">↑</button>` : ''}
        ${canKick(mm) ? `<button class="btn tiny ghost kick" data-kick="${mm.user_id}">✕</button>` : ''}
      </div>`;
  }).join('');

  const m = el(`
    <div class="modal-overlay">
      <div class="modal">
        <h3>${esc(chat.title || 'Сервер')}</h3>
        <div class="field-hint">${members.length} ${plural(members.length)} · ${chat._channels?.length || 0} каналов</div>
        <div class="gr-members">${rows}</div>
        <label class="field">Пригласить по нику
          <input id="ci-search" type="text" placeholder="Поиск по нику">
        </label>
        <div id="ci-results" class="gr-results"></div>
        <div class="form-error" id="ci-error"></div>
        <div class="modal-actions">
          ${mod ? '<button class="btn primary" id="ci-invite">🔗 Ссылка-приглашение</button>' : ''}
          <button class="btn ghost" data-act="close">Закрыть</button>
          ${isOwner ? '<button class="btn danger" id="ci-delete">Удалить сервер</button>' : '<button class="btn danger" id="ci-leave">Покинуть</button>'}
        </div>
      </div>
    </div>`);

  document.querySelector('#modal-root').appendChild(m);
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-act=close]')) m.remove();
  });

  // ссылка-приглашение
  const inviteBtn = qs('#ci-invite', m);
  if (inviteBtn) inviteBtn.addEventListener('click', async () => {
    try {
      const code = await dbApi.createInvite(chat.id, null, 168);
      const link = `${location.origin}${location.pathname}?join=${code}`;
      inviteBtn.outerHTML = `
        <div class="invite-box">
          <div class="invite-link">${esc(link)}</div>
          <button class="btn primary sm" id="ci-copy">Скопировать</button>
          <div class="field-hint center-hint">Работает 7 дней, без лимита входов</div>
        </div>`;
      qs('#ci-copy', m).addEventListener('click', () => {
        navigator.clipboard.writeText(link)
          .then(() => toast('Ссылка скопирована ✓'))
          .catch(() => toast('Скопируй вручную'));
      });
    } catch (e) { qs('#ci-error', m).textContent = e.message; }
  });

  // повысить до админа
  m.addEventListener('click', async (e) => {
    const up = e.target.closest('.kick-up');
    if (up) {
      try {
        await getSb().from('chat_members')
          .update({ role: 'admin' })
          .eq('chat_id', chat.id).eq('user_id', up.dataset.up);
        await dbApi.loadChatRow(chat.id);
        m.remove();
        openChatInfo();
        toast('Назначен админом ✓');
      } catch (err) { toast('Ошибка: ' + err.message); }
    }
    const kickBtn = e.target.closest('.kick');
    if (kickBtn) {
      const uid = kickBtn.dataset.kick;
      const p = memberProfile(chat, uid);
      const ok = await confirmDialog({ title: `Исключить ${p ? (p.display_name || p.nickname) : 'участника'}?` });
      if (!ok) return;
      try {
        await getSb().from('chat_members').delete().eq('chat_id', chat.id).eq('user_id', uid);
        await dbApi.loadChatRow(chat.id);
        m.remove();
        openChatInfo();
        renderHeader();
        renderChatListBadge();
      } catch (err) { toast('Ошибка: ' + err.message); }
    }
  });

  // поиск и добавление по нику
  const searchInput = qs('#ci-search', m);
  const existing = new Set(members.map((x) => x.user_id));
  const doSearch = debounce(async () => {
    const q = searchInput.value.trim();
    const box = qs('#ci-results', m);
    if (!q) { box.innerHTML = ''; return; }
    try {
      const people = (await dbApi.searchUsers(q)).filter((p) => !existing.has(p.id));
      box.innerHTML = '';
      if (!people.length) { box.innerHTML = '<div class="list-empty">Не нашлось</div>'; return; }
      people.forEach((p) => {
        const row = el(`
          <div class="person-row sm">
            ${avatarHTML(p.avatar_url, p.display_name || p.nickname, 'sm', false)}
            <div class="chat-row-main">
              <span class="chat-row-title">${esc(p.display_name || p.nickname)}</span>
              <span class="chat-row-preview">@${esc(p.nickname)}</span>
            </div>
            <span class="person-add">＋</span>
          </div>`);
        row.addEventListener('click', async () => {
          try {
            await dbApi.addMembers(chat.id, [p.id]);
            toast('Добавлен(а) ✓');
            m.remove();
            openChatInfo();
            renderHeader();
          } catch (err) { qs('#ci-error', m).textContent = err.message; }
        });
        box.appendChild(row);
      });
    } catch (err) { box.innerHTML = `<div class="list-empty">${esc(err.message)}</div>`; }
  }, 250);
  searchInput.addEventListener('input', doSearch);

  const delBtn = qs('#ci-delete', m);
  if (delBtn) delBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Удалить сервер?', text: 'Сервер, каналы и история пропадут у всех участников.' });
    if (!ok) return;
    m.remove();
    await dbApi.deleteChat(chat.id);
    closeChat();
    renderChatListBadge();
    toast('Сервер удалён');
  });
  const leaveBtn = qs('#ci-leave', m);
  if (leaveBtn) leaveBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Покинуть сервер?', text: 'Вернуться можно по ссылке-приглашению.' });
    if (!ok) return;
    m.remove();
    await dbApi.leaveChat(chat.id);
    state.chats.delete(chat.id);
    closeChat();
    renderChatListBadge();
    toast('Ты покинул(а) сервер');
  });
}

function renderChatListBadge() {
  import('./chatlist.js').then((m) => m.renderChatList());
}

// ================== ЧЕРНОВИКИ ==================

function draftKey() {
  const chat = state.chats.get(state.activeChatId);
  if (!chat) return null;
  return chat.type === 'group' ? `draft:${chat.id}:${chat._channelId}` : `draft:${chat.id}`;
}
function saveDraft() {
  const k = draftKey();
  if (!k) return;
  const t = qs('#msg-input');
  if (t && t.value.trim()) localStorage.setItem(k, t.value);
  else localStorage.removeItem(k);
}
function restoreDraft() {
  const k = draftKey();
  const t = qs('#msg-input');
  if (!k || !t) return;
  t.value = localStorage.getItem(k) || '';
  autoResize();
}

// ================== ОТПРАВКА ==================

function autoResize() {
  const t = qs('#msg-input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 140) + 'px';
}

async function sendText() {
  const input = qs('#msg-input');
  const body = input.value.trim();
  if (!body || sending || !state.activeChatId) return;
  sending = true;
  input.value = '';
  autoResize();
  try {
    const m = await dbApi.sendMessage(state.activeChatId, {
      body, replyToId: replyState?.id, fromName: null,
    });
    onNewMessage(m);
    clearReply();
    localStorage.removeItem(draftKey());
  } catch (e) {
    input.value = body;
    toast('Не отправилось: ' + e.message);
  } finally {
    sending = false;
    updateComposerMode();
    input.focus();
  }
}

async function sendFiles(files) {
  if (!state.activeChatId || sending) return;
  for (const file of files) {
    sending = true;
    try {
      toast(`Загружаю ${file.name}…`);
      const attachment = await storeApi.uploadChatFile(state.activeChatId, file);
      const m = await dbApi.sendMessage(state.activeChatId, { attachment, replyToId: replyState?.id });
      onNewMessage(m);
      clearReply();
    } catch (e) {
      toast('Ошибка: ' + e.message);
    } finally {
      sending = false;
    }
  }
}

async function sendRecorded(kind, { blob, durationMs }) {
  if (!state.activeChatId || sending) return;
  sending = true;
  try {
    const file = new File([blob], `${kind}-${Date.now()}.${extOf(blob.type)}`, { type: blob.type });
    const attachment = await storeApi.uploadChatFile(state.activeChatId, file, { durationMs });
    attachment.attachment_type = kind;
    const m = await dbApi.sendMessage(state.activeChatId, { attachment, replyToId: replyState?.id });
    onNewMessage(m);
    clearReply();
  } catch (e) {
    toast('Ошибка: ' + e.message);
  } finally {
    sending = false;
  }
}

function updateComposerMode() {
  const input = qs('#msg-input');
  const hasText = input.value.trim().length > 0;
  qs('#mic-btn').classList.toggle('hidden', hasText || !canRecordVoice());
  qs('#video-btn').classList.toggle('hidden', hasText || !canRecordVideo());
}

// ================== КНОПКА «ВНИЗ» ==================

function isNearBottom() {
  const box = qs('#messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
}

function updateScrollBtn() {
  const btn = qs('#scroll-down');
  if (!btn) return;
  const far = !isNearBottom() || pendingBelow > 0;
  btn.classList.toggle('visible', far);
  const badge = btn.querySelector('.sd-badge');
  if (badge) {
    badge.textContent = pendingBelow > 99 ? '99+' : (pendingBelow || '');
    badge.classList.toggle('hidden', !pendingBelow);
  }
}

// ================== ИНИЦИАЛИЗАЦИЯ ==================

export function initChatViewUI() {
  qs('#back-btn').addEventListener('click', closeChat);
  qs('#chat-info-btn').addEventListener('click', openChatInfo);
  qs('#send-btn').addEventListener('click', sendText);

  // каналы + поиск + звонки
  qs('#channel-pill').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleChannelMenu();
  });
  qs('#call-audio').addEventListener('click', async () => {
    const chat = state.chats.get(state.activeChatId);
    if (chat) await startCall(chat, false);
  });
  qs('#call-video').addEventListener('click', async () => {
    const chat = state.chats.get(state.activeChatId);
    if (chat) await startCall(chat, true);
  });
  qs('#voice-btn').addEventListener('click', async () => {
    const chat = state.chats.get(state.activeChatId);
    if (!chat) return;
    if (inVoice()) { leaveVoice(); return; }
    await joinVoice(chat);
  });
  qs('#chat-search-btn').addEventListener('click', () => setSearchOpen(!searchOpen));
  qs('#search-close').addEventListener('click', () => setSearchOpen(false));
  qs('#chat-search').addEventListener('input', debounce(doChatSearch, 250));
  qs('#chat-search').addEventListener('keydown', (e) => { if (e.key === 'Escape') setSearchOpen(false); });
  qs('#chat-search-results').addEventListener('click', (e) => {
    const hit = e.target.closest('.search-hit[data-hit]');
    if (hit) { setSearchOpen(false); jumpToMessage(hit.dataset.hit); }
  });

  // кнопка вниз
  qs('#scroll-down').addEventListener('click', () => {
    qs('#messages').scrollTo({ top: qs('#messages').scrollHeight, behavior: 'smooth' });
    pendingBelow = 0;
    updateScrollBtn();
  });
  qs('#messages').addEventListener('scroll', updateScrollBtn, { passive: true });

  // клик по имени/аватарке автора сообщения → профиль
  qs('#messages').addEventListener('click', (e) => {
    const t = e.target.closest('[data-profile]');
    if (t) { e.stopPropagation(); openProfile(t.dataset.profile); }
  });
  // клик по имени/аватарке в шапке чата → профиль собеседника
  qs('#chat-head-info').addEventListener('click', (e) => {
    const t = e.target.closest('[data-profile]');
    if (t) openProfile(t.dataset.profile);
  });

  const input = qs('#msg-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
  });
  input.addEventListener('input', () => {
    autoResize();
    saveDraft();
    updateComposerMode();
    const now = Date.now();
    if (typingChan && state.activeChatId && now - lastTypingSent > 2000) {
      lastTypingSent = now;
      typingChan.send({
        type: 'broadcast',
        event: 'typing',
        payload: { uid: state.me.id, name: state.me.display_name || state.me.nickname },
      }).catch(() => {});
    }
  });
  updateComposerMode();

  qs('#mic-btn').addEventListener('click', async () => {
    if (sending) return;
    const res = await recordVoice();
    if (res) await sendRecorded('voice', res);
  });
  qs('#video-btn').addEventListener('click', async () => {
    if (sending) return;
    const res = await recordVideo();
    if (res) await sendRecorded('video', res);
  });

  const fileInput = qs('#file-input');
  qs('#attach-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    sendFiles([...fileInput.files]);
    fileInput.value = '';
  });

  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((i) => i.kind === 'file' && /^image\//.test(i.type))
      .map((i) => i.getAsFile())
      .filter(Boolean);
    if (files.length) {
      e.preventDefault();
      sendFiles(files);
    }
  });

  // --- клики в области сообщений ---
  const box = qs('#messages');
  box.addEventListener('click', (e) => {
    const more = e.target.closest('.msg-more');
    if (more) {
      const r = more.getBoundingClientRect();
      openMsgMenu(r.left, r.bottom + 4, more.dataset.more);
      return;
    }
    const chip = e.target.closest('.react-chip');
    if (chip) { toggleReactionLocal(chip.dataset.msg, chip.dataset.react); return; }
    const vp = e.target.closest('.voice-play');
    if (vp) { toggleVoice(vp.closest('.voice')); return; }
    const bar = e.target.closest('.voice-bars');
    if (bar) {
      const v = bar.closest('.voice');
      const r2 = bar.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (e.clientX - r2.left) / r2.width));
      if (currentAudio && currentAudio._uiEl === v) {
        currentAudio.currentTime = p * (currentAudio.duration || +v.dataset.dur || 0);
      } else toggleVoice(v);
      return;
    }
    const quote = e.target.closest('.msg-quote');
    if (quote) { jumpToMessage(quote.dataset.target); return; }
    const img = e.target.closest('.msg-img');
    if (img) openLightbox(img.src);
  });

  // правый клик / долгое нажатие → меню
  box.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.msg-row');
    if (row) { e.preventDefault(); openMsgMenu(e.clientX, e.clientY, row.dataset.id); }
  });
  let lpTimer = null;
  box.addEventListener('touchstart', (e) => {
    const row = e.target.closest('.msg-row');
    if (!row || e.target.closest('a, button, video')) return;
    lpTimer = setTimeout(() => {
      const t = e.touches[0];
      if (t) openMsgMenu(t.clientX, t.clientY, row.dataset.id);
    }, 450);
  }, { passive: true });
  ['touchend', 'touchmove', 'touchcancel'].forEach((ev) =>
    box.addEventListener(ev, () => clearTimeout(lpTimer), { passive: true }));

  // двойной клик — быстрый ответ
  box.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.msg-row');
    if (row && !e.target.closest('a, button, img, video, .voice')) {
      doAction('reply', row.dataset.id);
    }
  });

  window.addEventListener('focus', () => {
    if (state.activeChatId && document.visibilityState === 'visible') {
      dbApi.markRead(state.activeChatId);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.activeChatId) {
      dbApi.markRead(state.activeChatId);
    }
  });

  setInterval(() => { if (state.activeChatId) renderTyping(); }, 1500);

  initStickers();
}

// кнопки звонков/голосового показываем по типу чата
export function updateCallButtons() {
  const chat = state.chats.get(state.activeChatId);
  if (!chat) return;
  const saved = isSavedChat(chat);
  const direct = chat.type === 'direct' && !saved;
  const server = dbApi.isServerChat(chat);
  qs('#call-audio').classList.toggle('hidden', !direct);
  qs('#call-video').classList.toggle('hidden', !direct);
  qs('#voice-btn').classList.toggle('hidden', !server);
}

// ================== ЛАЙТБОКС ==================

function openLightbox(src) {
  const lb = qs('#lightbox');
  lb.innerHTML = `
    <div class="lb-inner">
      <img src="${esc(src)}" alt="Фото">
      <div class="lb-actions">
        <a class="btn ghost sm" href="${esc(src)}" target="_blank" rel="noopener">Открыть оригинал</a>
      </div>
    </div>`;
  lb.classList.remove('hidden');
}

export function initLightboxUI() {
  const lb = qs('#lightbox');
  lb.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    lb.classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { lb.classList.add('hidden'); closeMsgMenu(); }
  });
}

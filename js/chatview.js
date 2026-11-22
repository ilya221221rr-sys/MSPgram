// Окно чата: сообщения, медиа, ответы, голосовые и видеосообщения
import { state, dbApi, storeApi, getSb, otherMember, memberProfile, chatTitleFor } from './api.js';
import {
  qs, qsa, esc, el, bus, toast, avatarHTML, fmtTime, fmtDaySep, sameDayKey,
  relLastSeen, fmtBytes, fmtDuration, confirmDialog, debounce, beep,
} from './utils.js';
import { recordVoice, recordVideo, canRecordVoice, canRecordVideo, extOf } from './media.js';

let msgs = [];              // сообщения открытого чата
let msgIds = new Set();
let hasMore = false;
let typingChan = null;      // канал «печатает…»
let lastTypingSent = 0;
let sending = false;
let replyState = null;      // сообщение, на которое отвечаем
let currentAudio = null;    // единственное активное аудио

const MSG_LIMIT = 50;
const MEDIA_PREVIEW = {
  image: '📷 Фото', video: '🎥 Видеосообщение', voice: '🎤 Голосовое сообщение', file: '📎 Файл',
};
const TYPE_ICON = { image: '📷', video: '🎥', voice: '🎤', file: '📎' };

function previewOf(m) {
  return m.body || MEDIA_PREVIEW[m.attachment_type] || '';
}

// ================== ОТКРЫТИЕ / ЗАКРЫТИЕ ==================

export async function openChat(chatId) {
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
  state.unread.delete(chatId);
  clearReply();
  import('./chatlist.js').then((m) => m.renderChatList());

  renderHeader();
  const box = qs('#messages');
  box.innerHTML = '<div class="loader">Загружаю…</div>';
  box.scrollTop = 0;

  try {
    const loaded = await dbApi.loadMessages(chatId, MSG_LIMIT);
    if (state.activeChatId !== chatId) return;
    msgs = loaded;
    msgs.forEach((m) => msgIds.add(m.id));
    hasMore = msgs.length >= MSG_LIMIT;
    renderMessages(true);
  } catch (e) {
    box.innerHTML = `<div class="list-empty">${esc(e.message)}</div>`;
    return;
  }

  joinTypingChannel(chatId);
  if (document.hasFocus() && document.visibilityState === 'visible') {
    dbApi.markRead(chatId);
  }
  bus.emit('chat-opened', chatId);
}

export function closeChat() {
  state.activeChatId = null;
  document.body.classList.remove('chat-open');
  qs('#chat-view').classList.add('hidden');
  qs('#chat-empty').classList.remove('hidden');
  stopPlayback();
  leaveTypingChannel();
  clearReply();
}

function renderChatListBadge() {
  import('./chatlist.js').then((m) => m.renderChatList());
}

// ================== ЗАГОЛОВОК ЧАТА ==================

function renderHeader() {
  const chat = state.chats.get(state.activeChatId);
  if (!chat) return;
  const other = otherMember(chat);
  const isTyping = typingText(chat.id);
  const online = chat.type === 'direct' && other && state.online.has(other.id);

  let sub;
  if (isTyping) sub = isTyping;
  else if (chat.type === 'direct') sub = relLastSeen(other?.last_seen, online);
  else sub = `${(chat.members || []).length} участник${plural((chat.members || []).length)}`;

  const info = qs('#chat-head-info');
  info.innerHTML = `
    ${avatarHTML(chat.type === 'group' ? chat.avatar_url : other?.avatar_url, chatTitleFor(chat), 'md', false)}
    <div class="chat-head-text">
      <div class="chat-head-title">${esc(chatTitleFor(chat))}</div>
      <div class="chat-head-sub ${online ? 'on' : ''}">${esc(sub)}</div>
    </div>`;
}

function plural(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'ь';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'я';
  return 'ей';
}

// ================== СООБЩЕНИЯ ==================

function linkify(escaped) {
  return escaped.replace(/(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

function barsHTML(seed) {
  let h = 0;
  for (const c of String(seed || '')) h = ((h * 31 + c.codePointAt(0)) >>> 0);
  const n = 24;
  let out = '';
  for (let i = 0; i < n; i++) {
    h = ((h * 1103515245 + 12345) >>> 0);
    const v = 25 + ((h >>> 16) % 75);
    out += `<i style="height:${v}%"></i>`;
  }
  return out;
}

function messageEl(m, chat, showDaySep) {
  const meId = state.me.id;
  const own = m.sender_id === meId;
  const isGroup = chat.type === 'group';
  const sender = memberProfile(chat, m.sender_id);
  const name = sender ? (sender.display_name || `@${sender.nickname}`) : 'Участник';

  const parts = [];
  if (showDaySep) {
    parts.push(`<div class="day-sep"><span>${esc(fmtDaySep(m.created_at))}</span></div>`);
  }

  // цитата-ответ
  let quote = '';
  if (m.reply_to) {
    const orig = msgs.find((x) => x.id === m.reply_to);
    const origSender = orig ? memberProfile(chat, orig.sender_id) : null;
    const origName = origSender
      ? (origSender.display_name || `@${origSender.nickname}`)
      : 'Сообщение';
    quote = `
      <div class="msg-quote" data-target="${esc(m.reply_to)}">
        <div class="msg-quote-name">${esc(origName)}</div>
        <div class="msg-quote-text">${esc(orig ? previewOf(orig) : 'сообщение удалено')}</div>
      </div>`;
  }

  let content = '';
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
  if (m.body) {
    content += `<div class="msg-text">${linkify(esc(m.body)).replaceAll('\n', '<br>')}</div>`;
  }

  let ticks = '';
  if (own) {
    const othersRead = (chat.members || [])
      .filter((x) => x.user_id !== meId && x.last_read_at)
      .some((x) => new Date(x.last_read_at) >= new Date(m.created_at));
    ticks = `<span class="msg-ticks${othersRead ? ' read' : ''}">${othersRead ? '✓✓' : '✓'}</span>`;
  }

  const author = (!own && isGroup)
    ? `<div class="msg-author">${avatarHTML(sender?.avatar_url, name, 'xs')}${esc(name)}</div>` : '';

  const actions = `
    <div class="msg-actions">
      <button class="msg-act" data-act="reply" title="Ответить">↩</button>
      <button class="msg-act" data-act="copy" title="Копировать">⧉</button>
      ${own ? '<button class="msg-act danger" data-act="del" title="Удалить">🗑</button>' : ''}
    </div>`;

  parts.push(`
    <div class="msg-row${own ? ' own' : ''}" data-id="${m.id}">
      ${author}
      <div class="msg${own ? ' out' : ' in'}">
        ${quote}${content || '<div class="msg-text muted">Пустое сообщение</div>'}
        <div class="msg-meta"><span class="msg-time">${fmtTime(m.created_at)}</span>${ticks}</div>
        ${actions}
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
      ${esc(chatTitleFor(chat))} — чат создан 🎉<br>Напиши текст, отправь фото, голосовое или видео!
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
  if (scrollToBottom || nearBottom) box.scrollTop = box.scrollHeight;
}

async function loadEarlier() {
  if (!msgs.length || !hasMore) return;
  const box = qs('#messages');
  const btn = qs('#load-earlier');
  if (btn) { btn.disabled = true; btn.textContent = 'Загружаю…'; }

  // запоминаем первое видимое сообщение, чтобы после рендера остаться на нём
  const firstVisible = findFirstVisibleMsgId(box);
  try {
    const earlier = await dbApi.loadEarlier(state.activeChatId, msgs[0].created_at);
    hasMore = earlier.length >= 30;
    const seen = new Set(msgs.map((m) => m.id));
    for (const m of earlier) if (!seen.has(m.id)) msgs.push(m);
    msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
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
  msgIds.add(m.id);
  msgs.push(m);
  msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const chat = state.chats.get(state.activeChatId);
  renderMessages(m.sender_id === state.me.id || m.body || m.attachment_type);
  if (m.sender_id !== state.me.id && document.hasFocus()) {
    dbApi.markRead(m.chat_id);
    beep();
  }
}

export function onMessageDeleted(id) {
  if (!msgIds.has(id)) return;
  msgIds.delete(id);
  msgs = msgs.filter((m) => m.id !== id);
  renderMessages(false);
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

// ================== ДЕЙСТВИЯ: ОТВЕТ / КОПИЯ / УДАЛЕНИЕ ==================

function getMsg(id) { return msgs.find((m) => m.id === id); }

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
  if (act === 'del') handleDelete(msgId);
}

function openMsgMenu(x, y, msgId) {
  closeMsgMenu();
  const m = getMsg(msgId);
  if (!m) return;
  const own = m.sender_id === state.me.id;
  const menu = el(`
    <div class="msg-menu" style="left:0;top:0">
      <button data-act="reply">↩ Ответить</button>
      <button data-act="copy">⧉ Копировать</button>
      ${own ? '<button class="danger" data-act="del">🗑 Удалить</button>' : ''}
    </div>`);
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (b) doAction(b.dataset.act, msgId);
    closeMsgMenu();
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
function closeMsgMenu() {
  const mm = document.querySelector('.msg-menu');
  if (mm) mm.remove();
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
  const n = bars.length;
  bars.forEach((b, i) => b.classList.toggle('on', i < p * n));
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

// ================== ИНФО О ЧАТЕ ==================

async function openChatInfo() {
  const chat = state.chats.get(state.activeChatId);
  if (!chat) return;
  const meId = state.me.id;
  const isOwner = chat.created_by === meId;

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

  const members = (chat.members || []).slice();
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
        ${mm.role !== 'owner' && isOwner ? `<button class="btn tiny ghost kick" data-kick="${mm.user_id}">✕</button>` : ''}
      </div>`;
  }).join('');

  const m = el(`
    <div class="modal-overlay">
      <div class="modal">
        <h3>${esc(chat.title || 'Группа')}</h3>
        <div class="field-hint">${members.length} ${plural(members.length)} · создал(а) ${esc((members.find((x) => x.user_id === chat.created_by)?.profiles || {}).nickname || '—')}</div>
        <div class="gr-members">${rows}</div>
        <label class="field">Добавить участника
          <input id="ci-search" type="text" placeholder="Поиск по нику">
        </label>
        <div id="ci-results" class="gr-results"></div>
        <div class="form-error" id="ci-error"></div>
        <div class="modal-actions">
          <button class="btn ghost" data-act="close">Закрыть</button>
          ${isOwner ? '<button class="btn danger" id="ci-delete">Удалить группу</button>' : '<button class="btn danger" id="ci-leave">Покинуть группу</button>'}
        </div>
      </div>
    </div>`);

  document.querySelector('#modal-root').appendChild(m);
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-act=close]')) m.remove();
  });

  m.addEventListener('click', async (e) => {
    const kickBtn = e.target.closest('.kick');
    if (!kickBtn) return;
    const uid = kickBtn.dataset.kick;
    const p = memberProfile(chat, uid);
    const ok = await confirmDialog({ title: `Удалить ${p ? (p.display_name || p.nickname) : 'участника'} из группы?` });
    if (!ok) return;
    try {
      await getSb().from('chat_members').delete()
        .eq('chat_id', chat.id).eq('user_id', uid);
      await dbApi.loadChatRow(chat.id);
      m.remove();
      openChatInfo();
      renderHeader();
      renderChatListBadge();
    } catch (err) { toast('Ошибка: ' + err.message); }
  });

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
    const ok = await confirmDialog({ title: 'Удалить группу?', text: 'Группа и история пропадут у всех участников.' });
    if (!ok) return;
    m.remove();
    await dbApi.deleteChat(chat.id);
    closeChat();
    renderChatListBadge();
    toast('Группа удалена');
  });
  const leaveBtn = qs('#ci-leave', m);
  if (leaveBtn) leaveBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Покинуть группу?', text: 'Вернуться смогут только через приглашение владельца.' });
    if (!ok) return;
    m.remove();
    await dbApi.leaveChat(chat.id);
    state.chats.delete(chat.id);
    closeChat();
    renderChatListBadge();
    toast('Ты покинул(а) группу');
  });
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
    const m = await dbApi.sendMessage(state.activeChatId, { body, replyToId: replyState?.id });
    onNewMessage(m);
    clearReply();
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

// ================== ИНИЦИАЛИЗАЦИЯ ИНТЕРФЕЙСА ==================

export function initChatViewUI() {
  qs('#back-btn').addEventListener('click', closeChat);
  qs('#chat-info-btn').addEventListener('click', openChatInfo);
  qs('#send-btn').addEventListener('click', sendText);

  const input = qs('#msg-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendText();
    }
  });
  input.addEventListener('input', () => {
    autoResize();
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

  // --- запись голоса и видео ---
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

  // --- файлы ---
  const fileInput = qs('#file-input');
  qs('#attach-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    sendFiles([...fileInput.files]);
    fileInput.value = '';
  });

  // --- вставка картинки из буфера ---
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

  // --- клики внутри сообщений ---
  const box = qs('#messages');
  box.addEventListener('click', (e) => {
    const act = e.target.closest('.msg-act');
    if (act) {
      const row = act.closest('.msg-row');
      if (row) doAction(act.dataset.act, row.dataset.id);
      return;
    }
    const vp = e.target.closest('.voice-play');
    if (vp) { toggleVoice(vp.closest('.voice')); return; }
    const bar = e.target.closest('.voice-bars');
    if (bar) {
      const v = bar.closest('.voice');
      const r = bar.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      if (currentAudio && currentAudio._uiEl === v) {
        currentAudio.currentTime = p * (currentAudio.duration || +v.dataset.dur || 0);
      } else {
        toggleVoice(v);
      }
      return;
    }
    const quote = e.target.closest('.msg-quote');
    if (quote) {
      const t = qs(`.msg-row[data-id="${CSS.escape(quote.dataset.target)}"]`, box);
      if (t) {
        t.scrollIntoView({ behavior: 'smooth', block: 'center' });
        t.classList.add('flash');
        setTimeout(() => t.classList.remove('flash'), 1300);
      } else {
        toast('Исходное сообщение не загружено — нажми «Показать ещё»');
      }
      return;
    }
    const img = e.target.closest('.msg-img');
    if (img) openLightbox(img.src);
  });

  // --- контекстное меню (правый клик / долгое нажатие) ---
  box.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.msg-row');
    if (row) {
      e.preventDefault();
      openMsgMenu(e.clientX, e.clientY, row.dataset.id);
    }
  });
  let lpTimer = null;
  box.addEventListener('touchstart', (e) => {
    const row = e.target.closest('.msg-row');
    if (!row) return;
    lpTimer = setTimeout(() => {
      const t = e.touches[0];
      if (t) openMsgMenu(t.clientX, t.clientY, row.dataset.id);
    }, 500);
  }, { passive: true });
  ['touchend', 'touchmove', 'touchcancel'].forEach((ev) =>
    box.addEventListener(ev, () => clearTimeout(lpTimer), { passive: true }));

  // --- отметить прочитанным при возврате в окно ---
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

// Окно чата: сообщения, вложения, прочтения, «печатает…», инфо о чате
import { state, dbApi, storeApi, getSb, otherMember, memberProfile, chatTitleFor } from './api.js';
import {
  qs, qsa, esc, el, bus, toast, avatarHTML, fmtTime, fmtDaySep, sameDayKey,
  relLastSeen, fmtBytes, confirmDialog, debounce, beep,
} from './utils.js';

let msgs = [];              // сообщения открытого чата
let msgIds = new Set();
let hasMore = false;
let typingChan = null;      // канал "печатает…"
let lastTypingSent = 0;
let sending = false;
let cleanupTimer = null;

const MSG_LIMIT = 50;

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

  renderHeader();
  const box = qs('#messages');
  box.innerHTML = '<div class="loader">Загружаю…</div>';
  box.scrollTop = 0;

  try {
    const loaded = await dbApi.loadMessages(chatId, MSG_LIMIT);
    if (state.activeChatId !== chatId) return; // успели закрыть
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
  leaveTypingChannel();
  renderChatListBadge();
}

function renderChatListBadge() {
  // перерисовать список, чтобы сбросились бейджи
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
  // ссылки в тексте → <a> (текст уже экранирован)
  return escaped.replace(/(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
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

  let content = '';
  if (m.attachment_type === 'image' && m.attachment_url) {
    content += `<img class="msg-img" src="${esc(m.attachment_url)}" alt="Фото" loading="lazy">`;
  }
  if (m.attachment_type === 'file' && m.attachment_url) {
    content += `<a class="msg-file" href="${esc(m.attachment_url)}" target="_blank" rel="noopener">
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

  // галочки прочтения для своих сообщений
  let ticks = '';
  if (own) {
    const othersRead = (chat.members || [])
      .filter((x) => x.user_id !== meId && x.last_read_at)
      .some((x) => new Date(x.last_read_at) >= new Date(m.created_at));
    ticks = `<span class="msg-ticks${othersRead ? ' read' : ''}">${othersRead ? '✓✓' : '✓'}</span>`;
  }

  const author = (!own && isGroup)
    ? `<div class="msg-author">${avatarHTML(sender?.avatar_url, name, 'xs')}${esc(name)}</div>` : '';

  parts.push(`
    <div class="msg-row${own ? ' own' : ''}" data-id="${m.id}">
      ${author}
      <div class="msg${own ? ' out' : ' in'}">
        ${content || '<div class="msg-text muted">Пустое сообщение</div>'}
        <div class="msg-meta"><span class="msg-time">${fmtTime(m.created_at)}</span>${ticks}</div>
        ${own ? '<button class="msg-del" title="Удалить сообщение">✕</button>' : ''}
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
  if (hasMore) {
    html += `<button class="load-earlier" id="load-earlier">Показать ещё</button>`;
  }
  if (!msgs.length) {
    html += `<div class="list-empty chat-start">
      ${esc(chatTitleFor(chat))} — чат создан 🎉<br>Напиши первое сообщение!
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
  if (scrollToBottom || nearBottom) {
    box.scrollTop = box.scrollHeight;
  }
}

async function loadEarlier() {
  if (!msgs.length || !hasMore) return;
  const box = qs('#messages');
  const btn = qs('#load-earlier');
  if (btn) { btn.disabled = true; btn.textContent = 'Загружаю…'; }
  const prevHeight = box.scrollHeight;
  try {
    const earlier = await dbApi.loadEarlier(state.activeChatId, msgs[0].created_at);
    hasMore = earlier.length >= 30;
    const beforeLen = msgs.length;
    const seen = new Set(msgs.map((m) => m.id));
    for (const m of earlier) if (!seen.has(m.id)) msgs.push(m);
    msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    renderMessages(false);
    box.scrollTop = box.scrollHeight - prevHeight + (msgs.length > beforeLen ? 0 : 0) - 40;
  } catch (e) {
    toast('Ошибка: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Показать ещё'; }
  }
}

// добавление нового сообщения (из realtime или после отправки)
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
  // обновить список тоже
  import('./chatlist.js').then((m) => m.renderChatList());
}

// ================== УДАЛЕНИЕ СВОИХ СООБЩЕНИЙ ==================

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
        const ok = await confirmDialog({ title: 'Удалить чат?', text: 'История пропадёт у обоих. Это не отзовёт аккаунт собеседника.' });
        if (!ok) return;
        m.remove();
        await dbApi.deleteChat(chat.id);
        closeChat();
        import('./chatlist.js').then((mm) => mm.renderChatList());
        toast('Чат удалён');
      }
    });
    return;
  }

  // ---- группа ----
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
        ${isOwner || chat.type === 'group' ? `
          <label class="field">Добавить участника
            <input id="ci-search" type="text" placeholder="Поиск по нику">
          </label>
          <div id="ci-results" class="gr-results"></div>` : ''}
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

  // исключить участника (владелец)
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
      import('./chatlist.js').then((mm) => mm.renderChatList());
    } catch (err) { toast('Ошибка: ' + err.message); }
  });

  // поиск и добавление участников
  const searchInput = qs('#ci-search', m);
  if (searchInput) {
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
  }

  // удалить/покинуть группу
  const delBtn = qs('#ci-delete', m);
  if (delBtn) delBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Удалить группу?', text: 'Группа и история пропадут у всех участников.' });
    if (!ok) return;
    m.remove();
    await dbApi.deleteChat(chat.id);
    closeChat();
    import('./chatlist.js').then((mm) => mm.renderChatList());
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
    import('./chatlist.js').then((mm) => mm.renderChatList());
    toast('Ты покинул(а) группу');
  });
}

// ================== КОМПОЗЕР ==================

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
    const m = await dbApi.sendMessage(state.activeChatId, { body });
    onNewMessage(m);
  } catch (e) {
    input.value = body; // вернуть текст
    toast('Не отправилось: ' + e.message);
  } finally {
    sending = false;
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
      const m = await dbApi.sendMessage(state.activeChatId, { attachment });
      onNewMessage(m);
    } catch (e) {
      toast('Ошибка: ' + e.message);
    } finally {
      sending = false;
    }
  }
}

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
    // вещаем "печатает…" не чаще раза в 2 секунды
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

  const fileInput = qs('#file-input');
  qs('#attach-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    sendFiles([...fileInput.files]);
    fileInput.value = '';
  });

  // вставка картинки из буфера обмена
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

  // клики внутри сообщений: удалить / открыть картинку
  const box = qs('#messages');
  box.addEventListener('click', (e) => {
    const del = e.target.closest('.msg-del');
    if (del) {
      const row = del.closest('.msg-row');
      if (row) handleDelete(row.dataset.id);
      return;
    }
    const img = e.target.closest('.msg-img');
    if (img) openLightbox(img.src);
  });

  // возврат в чат при фокусе окна → отметить прочитанным
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

  // периодическая чистка "печатает…"
  cleanupTimer = setInterval(() => {
    if (state.activeChatId) {
      renderTyping();
    }
  }, 1500);
}

// ================== ЛАЙТБОКС (просмотр фото) ==================

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

function initLightbox() {
  const lb = qs('#lightbox');
  // клик по чему угодно, кроме ссылки «открыть оригинал», закрывает просмотр
  lb.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    lb.classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') lb.classList.add('hidden');
  });
}

export function initLightboxUI() { initLightbox(); }

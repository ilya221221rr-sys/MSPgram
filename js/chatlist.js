// Список чатов 2.0: разделы «Личные» и «Серверы», поиск людей
import { state, dbApi, otherMember, chatTitleFor, isSavedChat } from './api.js';
import {
  qs, esc, el, bus, toast, avatarHTML, fmtListTime,
  relLastSeen, lastSeenShort, debounce,
} from './utils.js';
import { openSettingsModal } from './settings.js';

let searchMode = false;
let searchResults = [];

export function initChatListUI() {
  const searchInput = qs('#search-input');
  searchInput.addEventListener('input', debounce(async () => {
    const q = searchInput.value.trim();
    if (q) {
      searchMode = true;
      try {
        searchResults = await dbApi.searchUsers(q);
      } catch (e) {
        searchResults = [];
        console.warn(e);
      }
    } else {
      searchMode = false;
      searchResults = [];
    }
    renderChatList();
  }, 250));

  qs('#profile-btn').addEventListener('click', openSettingsModal);
  qs('#settings-btn').addEventListener('click', openSettingsModal);
  qs('#saved-btn').addEventListener('click', async () => {
    try {
      const chatId = await dbApi.getOrCreateSavedChat();
      bus.emit('open-chat', chatId);
    } catch (e) {
      toast('Не получилось: ' + e.message);
    }
  });
  qs('#new-group-btn').addEventListener('click', openServerModal);
}

// ---------- рендер списка ----------
export function renderChatList() {
  if (!state.me) return;
  const list = qs('#chat-list');
  const results = qs('#search-results');
  const q = qs('#search-input').value.trim();

  if (searchMode) {
    list.classList.add('hidden');
    results.classList.remove('hidden');
    const matchedChats = [...state.chats.values()].filter((c) =>
      chatTitleFor(c).toLowerCase().includes(q.toLowerCase()));
    results.innerHTML = '';
    if (matchedChats.length) {
      results.appendChild(el('<div class="search-section">Чаты и серверы</div>'));
      matchedChats.forEach((c) => results.appendChild(chatRowEl(c, true)));
    }
    if (searchResults.length) {
      results.appendChild(el('<div class="search-section">Люди</div>'));
      searchResults.forEach((p) => results.appendChild(personRowEl(p)));
    }
    if (!matchedChats.length && !searchResults.length) {
      results.appendChild(el(`<div class="list-empty">
        Никого не нашлось по «${esc(q)}».<br><br>
        Есть ссылка-приглашение на сервер?<br>Открой её в браузере — вступишь автоматически.
      </div>`));
    }
    return;
  }

  searchMode = false;
  results.classList.add('hidden');
  list.classList.remove('hidden');
  list.innerHTML = '';

  const all = [...state.chats.values()]
    .sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
  const servers = all.filter((c) => c.type === 'group');
  const personal = all.filter((c) => c.type !== 'group');

  if (!all.length) {
    list.appendChild(el(`<div class="list-empty">
      Пока пусто 🙁<br><br>
      <b>Личное:</b> найди человека через поиск сверху.<br>
      <b>Серверы:</b> создай кнопкой ＋ или открой ссылку-приглашение.<br>
      Ещё есть 🔖 — твой личный чат «Избранное».
    </div>`));
    return;
  }

  if (personal.length) {
    list.appendChild(el('<div class="search-section">Личное</div>'));
    personal.forEach((c) => list.appendChild(chatRowEl(c, false)));
  }
  if (servers.length) {
    list.appendChild(el('<div class="search-section">Серверы</div>'));
    servers.forEach((c) => list.appendChild(chatRowEl(c, false)));
  }
  import('./chatlist.js').then((mm) => mm.renderServerRail());
}

function chatRowEl(chat, inSearch) {
  const meId = state.me ? state.me.id : null;
  const other = otherMember(chat, meId);
  const saved = isSavedChat(chat);
  const isServer = chat.type === 'group';
  const title = saved ? '🔖 Избранное' : chatTitleFor(chat, meId);
  const isOnline = !saved && !isServer && other && state.online.has(other.id);
  const unread = state.unread.get(chat.id) || 0;
  const mine = chat.last_message_sender === meId;
  let preview = chat.last_message_text || (isServer ? 'Сервер создан' : 'Напиши первое сообщение');
  if (mine && chat.last_message_text) preview = 'Вы: ' + preview;
  const active = state.activeChatId === chat.id ? ' active' : '';

  const av = saved
    ? '<span class="avatar md saved-av">🔖</span>'
    : isServer
      ? `<span class="avatar md server-av" style="background:${serverColor(chat.id)}">${esc((chat.title || 'S')[0].toUpperCase())}</span>`
      : avatarHTML(chat.type === 'group' ? chat.avatar_url : other?.avatar_url, title, 'md', false);

  // строка «кто это и когда был(а) в сети» — для личных чатов
  const metaLine = (!saved && !isServer && other)
    ? `<div class="chat-row-meta">
         <span class="crm-nick">@${esc(other.nickname)}</span>
         <span class="crm-status ${isOnline ? 'on' : ''}">${isOnline ? 'онлайн' : esc(lastSeenShort(other.last_seen, false))}</span>
       </div>`
    : '';

  const row = el(`
    <div class="chat-row${active}${isServer ? ' server-row' : ''}" data-chat="${chat.id}">
      ${av}
      <div class="chat-row-main">
        <div class="chat-row-top">
          <span class="chat-row-title">${esc(title)}</span>
          ${inSearch ? '' : `<span class="chat-row-time">${fmtListTime(chat.last_message_at)}</span>`}
        </div>
        <div class="chat-row-bottom">
          <span class="chat-row-preview">${esc(preview)}</span>
          ${unread ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
        </div>
        ${metaLine}
      </div>
      ${isOnline ? '<span class="row-online" title="онлайн"></span>' : ''}
    </div>`);
  row.addEventListener('click', () => bus.emit('open-chat', chat.id));
  return row;
}

function serverColor(id) {
  let h = 0;
  for (const ch of String(id || '')) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${h} 55% 42%), hsl(${(h + 40) % 360} 60% 35%))`;
}

function personRowEl(p) {
  const isOnline = state.online.has(p.id);
  const row = el(`
    <div class="person-row" data-user="${p.id}">
      ${avatarHTML(p.avatar_url, p.display_name || p.nickname, 'md', false)}
      <div class="chat-row-main">
        <div class="chat-row-top">
          <span class="chat-row-title">${esc(p.display_name || p.nickname)}</span>
          <span class="person-status ${isOnline ? 'on' : ''}">${isOnline ? 'онлайн' : esc(relLastSeen(p.last_seen, false))}</span>
        </div>
        <div class="chat-row-bottom"><span class="chat-row-preview">@${esc(p.nickname)}</span></div>
      </div>
    </div>`);
  row.addEventListener('click', async () => {
    try {
      const chatId = await dbApi.startDirect(p.id);
      qs('#search-input').value = '';
      searchMode = false;
      renderChatList();
      bus.emit('open-chat', chatId);
    } catch (e) {
      toast('Не получилось: ' + e.message);
    }
  });
  return row;
}

// ---------- модалка: новый сервер ----------
export function openServerModal() {
  const selected = new Map();
  const m = el(`
    <div class="modal-overlay">
      <div class="modal">
        <h3>Новый сервер</h3>
        <div class="field-hint">Сервер — это чат с каналами, ролями и ссылкой-приглашением. Как в Discord, только без VPN.</div>
        <label class="field">Название сервера
          <input id="gr-title" type="text" maxlength="50" placeholder="Например: Наша тусовка">
        </label>
        <label class="field">Пригласить участников
          <input id="gr-search" type="text" placeholder="Поиск по нику или имени">
        </label>
        <div id="gr-selected" class="chips"></div>
        <div id="gr-results" class="gr-results"></div>
        <div class="form-error" id="gr-error"></div>
        <div class="modal-actions">
          <button class="btn ghost" data-act="close">Отмена</button>
          <button class="btn primary" id="gr-create">Создать сервер</button>
        </div>
      </div>
    </div>`);

  document.querySelector('#modal-root').appendChild(m);
  const close = () => m.remove();
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-act=close]')) close(); });

  const renderChips = () => {
    const box = qs('#gr-selected', m);
    box.innerHTML = '';
    selected.forEach((p) => {
      const chip = el(`<span class="chip">${esc(p.display_name || p.nickname)} <b data-id="${p.id}">✕</b></span>`);
      chip.querySelector('b').addEventListener('click', () => { selected.delete(p.id); renderChips(); });
      box.appendChild(chip);
    });
  };

  const doSearch = debounce(async () => {
    const q = qs('#gr-search', m).value.trim();
    const box = qs('#gr-results', m);
    if (!q) { box.innerHTML = ''; return; }
    try {
      const people = (await dbApi.searchUsers(q)).filter((p) => !selected.has(p.id));
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
        row.addEventListener('click', () => {
          selected.set(p.id, p);
          renderChips();
          row.remove();
        });
        box.appendChild(row);
      });
    } catch (e) {
      box.innerHTML = `<div class="list-empty">${esc(e.message)}</div>`;
    }
  }, 250);
  qs('#gr-search', m).addEventListener('input', doSearch);

  qs('#gr-create', m).addEventListener('click', async () => {
    const title = qs('#gr-title', m).value.trim();
    if (!title) { qs('#gr-error', m).textContent = 'Придумай название сервера.'; return; }
    const btn = qs('#gr-create', m);
    btn.disabled = true;
    try {
      const chatId = await dbApi.createGroup(title, [...selected.keys()]);
      close();
      renderChatList();
      bus.emit('open-chat', chatId);
      toast(`Сервер «${title}» создан ✓ Канал #общий готов.`);
    } catch (e) {
      qs('#gr-error', m).textContent = e.message;
      btn.disabled = false;
    }
  });

  setTimeout(() => qs('#gr-title', m).focus(), 50);
}

// ---------- аватарка и имя в сайдбаре ----------
export function renderSidebarMe() {
  const btn = qs('#profile-btn');
  if (!btn || !state.me) return;
  btn.innerHTML = avatarHTML(state.me.avatar_url, state.me.display_name || state.me.nickname, 'md');
  btn.title = 'Настройки: @' + (state.me.nickname || '');
}

// ---------- рейка серверов слева (как в Discord) ----------
export function renderServerRail() {
  const rail = qs('#server-rail');
  if (!rail || !state.me) return;
  const servers = [...state.chats.values()].filter((c) => c.type === 'group')
    .sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
  const unread = (c) => state.unread.get(c.id) || 0;

  rail.innerHTML = `
    <button class="rail-btn home ${!state.activeChatId || state.chats.get(state.activeChatId)?.type !== 'group' ? 'active' : ''}"
      title="Личные чаты" id="rail-home">
      <span class="rail-logo">✦</span>
    </button>
    <div class="rail-sep"></div>
    ${servers.map((c) => `
      <button class="rail-btn ${state.activeChatId === c.id ? 'active' : ''}"
        title="${esc(chatTitleFor(c))}${unread(c) ? ` · ${unread(c)} новых` : ''}" data-rail="${c.id}">
        <span class="rail-letter">${esc((chatTitleFor(c) || 'S')[0].toUpperCase())}</span>
        ${unread(c) ? `<span class="rail-badge"></span>` : ''}
      </button>`).join('')}
    <button class="rail-btn add" id="rail-add" title="Создать сервер">＋</button>`;

  rail.querySelectorAll('[data-rail]').forEach((b) =>
    b.addEventListener('click', () => bus.emit('open-chat', b.dataset.rail)));
  qs('#rail-home', rail)?.addEventListener('click', () => {
    const first = [...state.chats.values()].find((c) => c.type !== 'group');
    if (first) bus.emit('open-chat', first.id);
  });
  qs('#rail-add', rail)?.addEventListener('click', openServerModal);
}

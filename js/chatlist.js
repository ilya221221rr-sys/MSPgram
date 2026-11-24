// Список чатов 2.0: разделы «Личные» и «Серверы», поиск людей
import { state, dbApi, otherMember, chatTitleFor, isSavedChat } from './api.js?v=26';
import {
  qs, esc, el, bus, toast, avatarHTML, fmtListTime,
  relLastSeen, lastSeenShort, debounce,
} from './utils.js';
import { openProfile } from './profile.js';
import { openSettingsModal } from './settings.js';
import { presenceLabel, presenceKind } from './api-v18.js';
import { appendGlobalResults } from './gsearch.js';
import { inFolder, folderChipsHTML, openFolderEditor, folderExists } from './folders.js';

let listFilter = 'all';          // all | direct | groups | unread
const FILTERS = [['all', 'Все'], ['unread', 'Непрочитанные'], ['direct', 'Личные'], ['groups', 'Группы']];
let searchToken = 0;

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
      searchMode = true; // пустой запрос = показать недавние
      searchResults = [];
    }
    renderChatList();
  }, 250));
  searchInput.addEventListener('focus', () => {
    if (!searchInput.value.trim()) { searchMode = true; searchResults = []; renderChatList(); }
  });

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
  updateUnreadIndicators();
  renderFilters();

    if (searchMode) {
    list.classList.add('hidden');
    results.classList.remove('hidden');
    const matchedChats = [...state.chats.values()].filter((c) =>
      chatTitleFor(c).toLowerCase().includes(q.toLowerCase()));
    results.innerHTML = '';
    if (!q) {
      // история поиска
      const hist = getSearchHistory();
      if (hist.length) {
        results.appendChild(el('<div class="search-section">Недавние запросы</div>'));
        const box = el('<div class="hist-box"></div>');
        hist.forEach((h) => {
          const chip = el(`<button class="chip hist-chip">🕘 ${esc(h)}</button>`);
          chip.addEventListener('click', () => {
            qs('#search-input').value = h;
            qs('#search-input').dispatchEvent(new Event('input'));
          });
          box.appendChild(chip);
        });
        results.appendChild(box);
        const clear = el('<button class="pm-link hist-clear">Очистить историю</button>');
        clear.addEventListener('click', () => { localStorage.removeItem('msp_search_hist'); renderChatList(); });
        results.appendChild(clear);
      } else {
        results.appendChild(el('<div class="list-empty">Начни печатать имя или @ник —<br>здесь появится история поиска.</div>'));
      }
      return;
    }
    if (matchedChats.length) {
      results.appendChild(el('<div class="search-section">Чаты и серверы</div>'));
      matchedChats.forEach((c) => results.appendChild(chatRowEl(c, true)));
    }
    if (searchResults.length) {
      results.appendChild(el('<div class="search-section">Люди</div>'));
      searchResults.forEach((p) => results.appendChild(personRowEl(p)));
    }
    const extra = el('<div class="search-extra"></div>');
    results.appendChild(extra);
    const token = ++searchToken;
    appendGlobalResults(extra, q, () => token !== searchToken || qs('#search-input').value.trim() !== q).then(() => {
      if (token === searchToken && !matchedChats.length && !searchResults.length && !extra.children.length) {
        results.appendChild(el(`<div class="list-empty">
          Ничего не нашлось по «${esc(q)}».<br><br>
          Есть ссылка-приглашение на сервер?<br>Открой её в браузере — вступишь автоматически.
        </div>`));
      }
    }).catch(() => {});
    return;
  }

  searchMode = false;
  results.classList.add('hidden');
  list.classList.remove('hidden');
  list.innerHTML = '';

  const all = [...state.chats.values()]
    .sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
  const passes = (c) => (listFilter === 'all')
    || (listFilter === 'unread' && (state.unread.get(c.id) || 0) > 0)
    || (listFilter === 'direct' && c.type !== 'group')
    || (listFilter === 'groups' && c.type === 'group')
    || (listFilter.startsWith('f:') && inFolder(listFilter, c));
  const active = all.filter((c) => !myFlags(c).archived && passes(c));
  const archived = all.filter((c) => myFlags(c).archived);
  const pinnedSet = new Set(active.filter((c) => myFlags(c).pinned).map((c) => c.id));
  const servers = active.filter((c) => c.type === 'group' && !pinnedSet.has(c.id));
  const personal = active.filter((c) => c.type !== 'group' && !pinnedSet.has(c.id));
  const pinnedChats = active.filter((c) => pinnedSet.has(c.id));

  if (all.length && !active.length && !archived.length) {
    list.appendChild(el('<div class="list-empty">В этом разделе пока пусто ✨</div>'));
  }
  if (!all.length) {
    list.appendChild(el(`<div class="list-empty">
      Пока пусто 🙁<br><br>
      <b>Личное:</b> найди человека через поиск сверху.<br>
      <b>Серверы:</b> создай кнопкой ＋ или открой ссылку-приглашение.<br>
      Ещё есть 🔖 — твой личный чат «Избранное».
    </div>`));
    return;
  }

  if (pinnedChats.length) {
    list.appendChild(el('<div class="search-section">📌 Закреплённые</div>'));
    pinnedChats.forEach((c) => list.appendChild(chatRowEl(c, false)));
  }
  if (personal.length) {
    list.appendChild(el('<div class="search-section">Личное</div>'));
    personal.forEach((c) => list.appendChild(chatRowEl(c, false)));
  }
  if (servers.length) {
    list.appendChild(el('<div class="search-section">Серверы</div>'));
    servers.forEach((c) => list.appendChild(chatRowEl(c, false)));
  }
  if (archived.length) {
    const head = el(`<div class="search-section archive-toggle">🗄 Архив (${archived.length}) <span class="arc-caret">▸</span></div>`);
    let archiveBox = null;
    head.addEventListener('click', () => {
      if (archiveBox) { archiveBox.remove(); archiveBox = null; head.querySelector('.arc-caret').textContent = '▸'; return; }
      archiveBox = el('<div></div>');
      archived.forEach((c) => archiveBox.appendChild(chatRowEl(c, false)));
      head.after(archiveBox);
      head.querySelector('.arc-caret').textContent = '▾';
    });
    list.appendChild(head);
  }
  import('./chatlist.js').then((mm) => mm.renderServerRail());
}

function chatRowEl(chat, inSearch) {
  const meId = state.me ? state.me.id : null;
  const other = otherMember(chat, meId);
  const saved = isSavedChat(chat);
  const isServer = chat.type === 'group';
  const title = saved ? 'Избранное' : (chatTitleFor(chat, meId) === 'Чат' && chat.last_message_sender && chat.last_message_sender !== meId ? 'Собеседник' : chatTitleFor(chat, meId));
  const kind = !saved && !isServer && other ? presenceKind(other) : null;
  const unread = state.unread.get(chat.id) || 0;
  const flags = myFlags(chat);
  const mine = chat.last_message_sender === meId;
  let preview = chat.last_message_text || (isServer ? 'Сервер создан' : saved ? 'Заметки, файлы, ссылки' : 'Напиши первое сообщение');
  const active = state.activeChatId === chat.id ? ' active' : '';

  const av = saved
    ? '<span class="avatar md saved-av">🔖</span>'
    : isServer
      ? (chat.avatar_url
        ? avatarHTML(chat.avatar_url, title, 'md', false)
        : `<span class="avatar md server-av" style="background:${serverColor(chat.id)}">${esc((chat.title || 'S')[0].toUpperCase())}</span>`)
      : avatarHTML(other?.avatar_url, other ? (other.display_name || other.nickname) : title, 'md', false);

  // вторая строка: ник собеседника + статус / число участников
  const n = (chat.members || []).length;
  const metaLine = isServer
    ? `<span class="crm-nick">${n} участник${pluralRows(n)}${chat.only_admins_post ? ' · канал' : ''}</span>`
    : (!saved && other)
      ? `<span class="crm-nick">@${esc(other.nickname)}</span><span class="crm-status ${kind ? 'on' : ''}">${esc(presenceLabel(other, lastSeenShort))}</span>`
      : '';
  const statusEmoji = !saved && !isServer && other?.status_emoji ? ` <span class="row-emoji">${esc(other.status_emoji)}</span>` : '';

  const row = el(`
    <div class="chat-row${active}${isServer ? ' server-row' : ''}${unread ? ' has-unread' : ''}" data-chat="${chat.id}">
      <div class="row-av">${av}${kind ? `<span class="row-online st-${kind}" title="${kind === 'online' ? 'онлайн' : kind === 'away' ? 'отошёл' : 'не беспокоить'}"></span>` : ''}</div>
      <div class="chat-row-main">
        <div class="chat-row-top">
          <span class="chat-row-title">${esc(title)}${statusEmoji}${flags.pinned ? ' <span class="row-pin">📌</span>' : ''}</span>
          ${inSearch ? '' : `<span class="chat-row-time${unread ? ' hot' : ''}">${fmtListTime(chat.last_message_at)}</span>`}
        </div>
        <div class="chat-row-bottom">
          <span class="chat-row-preview">${mine && chat.last_message_text ? '<span class="you">Вы:</span> ' : ''}${esc(preview)}</span>
          ${flags.muted ? '<span class="row-muted" title="Без звука">🔕</span>' : ''}
          ${unread ? `<span class="unread-badge${flags.muted ? ' muted' : ''}">${unread > 99 ? '99+' : unread}</span>` : ''}
        </div>
        ${metaLine ? `<div class="chat-row-meta">${metaLine}</div>` : ''}
      </div>
    </div>`);
  row.addEventListener('click', () => bus.emit('open-chat', chat.id));
  return row;
}

// ---------- фильтры списка и счётчики ----------
function renderFilters() {
  const box = qs('#list-filters');
  if (!box) return;
  const totalUnread = [...state.unread.values()].reduce((a, b) => a + b, 0);
  if (listFilter.startsWith('f:') && !folderExists(listFilter)) listFilter = 'all';
  box.innerHTML = FILTERS.map(([k, l]) => `<button class="lf-chip${listFilter === k ? ' on' : ''}" data-f="${k}">${l}${k === 'unread' && totalUnread ? ` <b>${totalUnread > 99 ? '99+' : totalUnread}</b>` : ''}</button>`).join('') + folderChipsHTML(listFilter);
  if (!box._wired) {
    box._wired = true;
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-f]'); if (!b) return;
      const k = b.dataset.f;
      if (k === '__new') { openFolderEditor(null, (f) => { listFilter = f || 'all'; renderChatList(); }); return; }
      if (k === '__edit') { openFolderEditor(listFilter.slice(2), (f) => { listFilter = f || 'all'; renderChatList(); }); return; }
      listFilter = k; renderChatList();
    });
  }
}

function updateUnreadIndicators() {
  const total = [...state.unread.entries()].reduce((a, [id, n]) => {
    const c = state.chats.get(id);
    return a + (c && myFlags(c).muted ? 0 : n);
  }, 0);
  document.title = total ? `(${total > 99 ? '99+' : total}) MSPgram` : 'MSPgram — мессенджер';
  try { if (navigator.setAppBadge) (total ? navigator.setAppBadge(total) : navigator.clearAppBadge()).catch(() => {}); } catch { /* */ }
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
  row.addEventListener('click', () => {
    // клик по человеку — открываем его профиль (кнопка «Написать» внутри)
    const q = qs('#search-input').value.trim();
    if (q) pushSearchHistory(q);
    searchMode = false;
    openProfile(p.id);
  });
  return row;
}

// ---------- флаги моего участия в чате (закреп/архив/мьют) ----------
function myFlags(c) {
  const mine = (c.members || []).find((x) => x.user_id === state.me?.id);
  return { pinned: !!mine?.pinned, archived: !!mine?.archived, muted: !!mine?.muted };
}

// ---------- история поиска ----------
function getSearchHistory() {
  try { return JSON.parse(localStorage.getItem('msp_search_hist') || '[]').slice(0, 8); }
  catch { return []; }
}
function pushSearchHistory(q) {
  try {
    const h = getSearchHistory().filter((x) => x !== q);
    h.unshift(q);
    localStorage.setItem('msp_search_hist', JSON.stringify(h.slice(0, 8)));
  } catch { /* */ }
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
        <div class="settings-sec">🌐 Сообщества</div>
        <button class="btn ghost sm" id="gr-show-public">Показать публичные серверы</button>
        <div id="gr-discover" class="gr-results"></div>
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

  // ---------- сообщества (публичные серверы) ----------
  qs('#gr-show-public', m).addEventListener('click', async (e) => {
    const box = qs('#gr-discover', m);
    e.target.disabled = true;
    box.innerHTML = '<div class="list-empty">Загрузка…</div>';
    try {
      const pubs = await dbApi.listPublicChats();
      if (!pubs.length) { box.innerHTML = '<div class="list-empty">Пока нет публичных серверов.<br>Сделай свой: галочка «🌐 Публичный» в настройках сервера.</div>'; return; }
      box.innerHTML = '';
      pubs.forEach((s) => {
        const mineAlready = state.chats.has(s.id);
        const row = el(`
          <div class="person-row sm">
            ${s.avatar_url
    ? `<span class="avatar sm"><img src="${esc(s.avatar_url)}" alt=""></span>`
    : `<span class="avatar sm server-av" style="background:${serverColor(s.id)}">${esc((s.title || 'S')[0].toUpperCase())}</span>`}
            <div class="chat-row-main">
              <span class="chat-row-title">${esc(s.title || 'Без названия')}</span>
              <span class="chat-row-preview">${s.members} участник${s.members === 1 ? '' : s.members % 10 >= 2 && s.members % 10 <= 4 && (s.members % 100 < 12 || s.members % 100 > 14) ? 'я' : 'ей'}</span>
            </div>
            <button class="btn primary sm" ${mineAlready ? 'disabled' : ''}>${mineAlready ? '✓ Есть' : 'Вступить'}</button>
          </div>`);
        row.querySelector('button').addEventListener('click', async (ev) => {
          ev.stopPropagation();
          try {
            const chatId = await dbApi.joinPublic(s.id);
            toast(`Ты в «${s.title}» 🎉`);
            m.remove();
            bus.emit('open-chat', chatId);
          } catch (err) { toast('Не вышло: ' + err.message); }
        });
        box.appendChild(row);
      });
    } catch (err) {
      box.innerHTML = `<div class="list-empty">${esc(err.message)}</div>`;
    } finally {
      e.target.disabled = false;
    }
  });

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

function pluralRows(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return '';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'а';
  return 'ов';
}

// ---------- аватарка и имя в сайдбаре ----------
export function renderSidebarMe() {
  const btn = qs('#profile-btn');
  if (!btn || !state.me) return;
  const st = state.me.presence_status || 'online';
  btn.innerHTML = `<span class="me-av">${avatarHTML(state.me.avatar_url, state.me.display_name || state.me.nickname, 'md')}<i class="me-dot st-${st}"></i></span>`;
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

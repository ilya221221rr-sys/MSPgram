// Список чатов, поиск людей, модалки профиля и создания группы
import { state, dbApi, storeApi, authApi, otherMember, chatTitleFor } from './api.js';
import {
  qs, esc, el, bus, toast, avatarHTML, fmtListTime,
  relLastSeen, debounce, confirmDialog,
} from './utils.js';

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

  qs('#profile-btn').addEventListener('click', openProfileModal);
  qs('#new-group-btn').addEventListener('click', openGroupModal);
  qs('#logout-btn').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Выйти из аккаунта?', text: '', okLabel: 'Выйти', danger: false });
    if (ok) await authApi.signOut();
  });
}

// ---------- рендер списка чатов ----------
export function renderChatList() {
  const list = qs('#chat-list');
  const results = qs('#search-results');
  const q = qs('#search-input').value.trim();

  // --- люди по поиску ---
  if (searchMode) {
    list.classList.add('hidden');
    results.classList.remove('hidden');
    const matchedChats = [...state.chats.values()].filter((c) =>
      chatTitleFor(c).toLowerCase().includes(q.toLowerCase()));
    results.innerHTML = '';
    if (matchedChats.length) {
      results.appendChild(el('<div class="search-section">Чаты</div>'));
      matchedChats.forEach((c) => results.appendChild(chatRowEl(c, true)));
    }
    if (searchResults.length) {
      results.appendChild(el('<div class="search-section">Люди</div>'));
      searchResults.forEach((p) => results.appendChild(personRowEl(p)));
    }
    if (!matchedChats.length && !searchResults.length) {
      results.appendChild(el('<div class="list-empty">Никого не нашлось.<br>Попробуй искать по нику или имени.</div>'));
    }
    return;
  }

  // --- обычный список чатов ---
  searchMode = false;
  results.classList.add('hidden');
  list.classList.remove('hidden');
  list.innerHTML = '';
  const chats = [...state.chats.values()]
    .sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
  if (!chats.length) {
    list.appendChild(el(`<div class="list-empty">
      Пока пусто 🙁<br><br>
      Напиши кому-нибудь: нажми <b>поиск сверху</b>, введи ник друга<br>и открой с ним чат.<br><br>
      Или создай <b>группу</b> кнопкой ＋.
    </div>`));
    return;
  }
  chats.forEach((c) => list.appendChild(chatRowEl(c, false)));
}

function chatRowEl(chat, inSearch) {
  const meId = state.me.id;
  const other = otherMember(chat, meId);
  const title = chatTitleFor(chat, meId);
  const isOnline = chat.type === 'direct' && other && state.online.has(other.id);
  const unread = state.unread.get(chat.id) || 0;
  const mine = chat.last_message_sender === meId;
  let preview = chat.last_message_text || (chat.type === 'group' ? 'Группа создана' : 'Напиши первое сообщение');
  if (mine && chat.last_message_text) preview = 'Вы: ' + preview;
  const active = state.activeChatId === chat.id ? ' active' : '';
  const row = el(`
    <div class="chat-row${active}" data-chat="${chat.id}">
      ${avatarHTML(chat.type === 'group' ? chat.avatar_url : other?.avatar_url, title, 'md', false)}
      <div class="chat-row-main">
        <div class="chat-row-top">
          <span class="chat-row-title">${esc(title)}</span>
          ${inSearch ? '' : `<span class="chat-row-time">${fmtListTime(chat.last_message_at)}</span>`}
        </div>
        <div class="chat-row-bottom">
          <span class="chat-row-preview">${esc(preview)}</span>
          ${unread ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
        </div>
      </div>
      ${isOnline ? '<span class="row-online" title="онлайн"></span>' : ''}
    </div>`);
  row.addEventListener('click', () => bus.emit('open-chat', chat.id));
  return row;
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

// ---------- модалка: мой профиль ----------
export function openProfileModal() {
  const me = state.me;
  const m = el(`
    <div class="modal-overlay">
      <div class="modal">
        <h3>Мой профиль</h3>
        <div class="avatar-edit">
          <div id="pf-avatar-preview">${avatarHTML(me.avatar_url, me.display_name || me.nickname, 'xl')}</div>
          <div>
            <button class="btn ghost sm" id="pf-avatar-btn">Сменить аватар</button>
            <div class="field-hint">PNG/JPG/WEBP, до 5 МБ</div>
          </div>
          <input type="file" id="pf-avatar-file" accept="image/*" class="hidden">
        </div>
        <label class="field">Имя (видно в чатах)
          <input id="pf-display" type="text" maxlength="40" value="${esc(me.display_name)}" placeholder="Как тебя зовут">
        </label>
        <label class="field">Ник (по нему тебя найдут)
          <input id="pf-nick" type="text" maxlength="20" value="${esc(me.nickname)}" placeholder="ник">
        </label>
        <label class="field">О себе
          <input id="pf-bio" type="text" maxlength="120" value="${esc(me.bio)}" placeholder="Пара слов">
        </label>
        <div class="form-error" id="pf-error"></div>
        <div class="modal-actions">
          <button class="btn ghost" data-act="close">Закрыть</button>
          <button class="btn primary" id="pf-save">Сохранить</button>
        </div>
      </div>
    </div>`);

  document.querySelector('#modal-root').appendChild(m);
  const close = () => m.remove();
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-act=close]')) close(); });

  const fileInput = qs('#pf-avatar-file', m);
  let newAvatarUrl = null;
  qs('#pf-avatar-btn', m).addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      toast('Загружаю аватар…');
      newAvatarUrl = await storeApi.uploadAvatar(file);
      qs('#pf-avatar-preview', m).innerHTML = avatarHTML(newAvatarUrl, me.nickname, 'xl');
    } catch (e) {
      qs('#pf-error', m).textContent = e.message;
    }
  });

  qs('#pf-save', m).addEventListener('click', async () => {
    const nick = qs('#pf-nick', m).value.trim();
    if (!/^[A-Za-z0-9_А-Яа-яЁё]{3,20}$/.test(nick)) {
      qs('#pf-error', m).textContent = 'Ник: 3–20 символов, без пробелов.';
      return;
    }
    try {
      const patch = {
        nickname: nick,
        display_name: qs('#pf-display', m).value.trim(),
        bio: qs('#pf-bio', m).value.trim(),
      };
      if (newAvatarUrl) patch.avatar_url = newAvatarUrl;
      await dbApi.updateMe(patch);
      renderChatList();
      bus.emit('chat-header-refresh');
      close();
      toast('Профиль сохранён ✓');
    } catch (e) {
      qs('#pf-error', m).textContent = e.message.includes('duplicate') || e.message.includes('unique')
        ? 'Такой ник уже занят.' : e.message;
    }
  });
}

// ---------- модалка: новая группа ----------
export function openGroupModal() {
  const selected = new Map(); // id -> profile
  const m = el(`
    <div class="modal-overlay">
      <div class="modal">
        <h3>Новая группа</h3>
        <label class="field">Название
          <input id="gr-title" type="text" maxlength="50" placeholder="Например: Друзья">
        </label>
        <label class="field">Добавить участников
          <input id="gr-search" type="text" placeholder="Поиск по нику или имени">
        </label>
        <div id="gr-selected" class="chips"></div>
        <div id="gr-results" class="gr-results"></div>
        <div class="form-error" id="gr-error"></div>
        <div class="modal-actions">
          <button class="btn ghost" data-act="close">Отмена</button>
          <button class="btn primary" id="gr-create">Создать группу</button>
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
    if (!title) { qs('#gr-error', m).textContent = 'Придумай название группы.'; return; }
    const btn = qs('#gr-create', m);
    btn.disabled = true;
    try {
      const chatId = await dbApi.createGroup(title, [...selected.keys()]);
      close();
      renderChatList();
      bus.emit('open-chat', chatId);
      toast('Группа создана ✓');
    } catch (e) {
      qs('#gr-error', m).textContent = e.message;
      btn.disabled = false;
    }
  });

  setTimeout(() => qs('#gr-title', m).focus(), 50);
}

// Обновить аватарку и имя в сайдбаре
export function renderSidebarMe() {
  const btn = qs('#profile-btn');
  btn.innerHTML = avatarHTML(state.me.avatar_url, state.me.display_name || state.me.nickname, 'md');
  btn.title = 'Мой профиль: @' + state.me.nickname;
}

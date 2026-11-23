// ============================================================
//  Админ-панель: пользователи (бан/разбан/переименовать)
//  и чтение переписки любых чатов. Видна только is_admin.
// ============================================================
import { state, dbApi } from './api.js';
import { esc, el, avatarHTML, relLastSeen, toast } from './utils.js';

const ADMIN_BADGE = (p) => {
  const badges = [];
  if (p.is_admin) badges.push('<span class="adm-badge admin">АДМИН</span>');
  if (p.is_banned && (!p.banned_until || new Date(p.banned_until) > new Date())) {
    badges.push('<span class="adm-badge banned">БАН</span>');
  }
  return badges.join(' ');
};

function memberTitle(chat) {
  if (chat.type === 'group') return `🌐 ${chat.title || 'Сервер'}`;
  const other = (chat.members || []).find((m) => m.user_id !== state.me.id);
  const prof = other ? other.profiles : null;
  return `👤 ${prof ? (prof.display_name || '@' + prof.nickname) : 'Личный чат'}`;
}

export async function openAdminPanel() {
  if (!state.me || !state.me.is_admin) { toast('Только для админов'); return; }

  const m = el(`
    <div class="modal-overlay admin-overlay">
      <div class="modal admin-modal">
        <h3>🛡 Админ-панель</h3>
        <div class="adm-tabs">
          <button class="adm-tab active" data-tab="users">Пользователи</button>
          <button class="adm-tab" data-tab="log">Переписка</button>
          <button class="adm-tab" data-tab="reports">Жалобы</button>
          <button class="adm-tab" data-tab="stats">Статистика</button>
        </div>
        <div class="adm-body" id="adm-body"></div>
        <div class="modal-actions">
          <button class="btn ghost" data-act="close">Закрыть</button>
        </div>
      </div>
    </div>`);

  document.querySelector('#modal-root').appendChild(m);
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-act=close]')) m.remove();
  });

  const body = qs2('#adm-body', m);

  // ---------- вкладка Пользователи ----------
  async function renderUsers() {
    body.innerHTML = '<div class="adm-empty">Загрузка…</div>';
    let users;
    try { users = await dbApi.adminListUsers(); }
    catch (e) { body.innerHTML = `<div class="adm-empty">${esc(e.message)}</div>`; return; }

    body.innerHTML = '';
    users.forEach((p) => {
      const isBanned = p.is_banned && (!p.banned_until || new Date(p.banned_until) > new Date());
      const row = el(`
        <div class="adm-user-row">
          ${avatarHTML(p.avatar_url, p.display_name || p.nickname, 'md', false)}
          <div class="adm-user-main">
            <div class="adm-user-name">${esc(p.display_name || p.nickname)} ${ADMIN_BADGE(p)}</div>
            <div class="adm-user-sub">@${esc(p.nickname)} · ${esc(relLastSeen(p.last_seen, state.online.has(p.id)))}</div>
            ${isBanned ? `<div class="adm-user-sub danger">Причина: ${esc(p.ban_reason || 'не указана')}${p.banned_until ? ` · до ${new Date(p.banned_until).toLocaleString('ru')}` : ' · навсегда'}</div>` : ''}
          </div>
          <div class="adm-user-actions">
            <button class="adm-btn" data-act="rename" data-id="${p.id}" title="Изменить имя и юзернейм">✏️</button>
            <button class="adm-btn ${isBanned ? 'ok' : 'danger'}" data-act="ban" data-id="${p.id}" data-banned="${isBanned ? 1 : 0}">${isBanned ? '✅' : '🚫'}</button>
          </div>
        </div>`);
      body.appendChild(row);
    });

    body.querySelectorAll('[data-act=rename]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const p = users.find((x) => x.id === btn.dataset.id);
        const newName = window.prompt('Новое имя пользователя:', p.display_name || '');
        if (newName === null) return;
        const newNick = window.prompt('Новый юзернейм (без @, латиница):', p.nickname || '');
        if (newNick === null) return;
        try {
          const patch = {};
          if (newName.trim()) patch.display_name = newName.trim();
          if (newNick.trim()) patch.nickname = newNick.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
          if (!Object.keys(patch).length) return;
          await dbApi.adminUpdateProfile(p.id, patch);
          toast('Профиль обновлён ✓');
          renderUsers();
        } catch (e) { toast('Ошибка: ' + e.message); }
      });
    });

    body.querySelectorAll('[data-act=ban]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const p = users.find((x) => x.id === btn.dataset.id);
        if (btn.dataset.banned === '1') {
          if (!window.confirm(`Разбанить ${p.display_name || p.nickname}?`)) return;
          try { await dbApi.adminSetBan(p.id, false); toast('Разбанен ✓'); renderUsers(); }
          catch (e) { toast('Ошибка: ' + e.message); }
          return;
        }
        if (p.id === state.me.id) { toast('Себя банить нельзя 🙂'); return; }
        const reason = window.prompt(`Бан ${p.display_name || p.nickname}.\nПричина (можно пусто):`, '') ?? null;
        if (reason === null) return; // отмена
        const daysRaw = window.prompt('На сколько дней? (пусто = навсегда):', '7');
        if (daysRaw === null) return;
        const days = parseInt(daysRaw, 10);
        const until = Number.isFinite(days) && days > 0
          ? new Date(Date.now() + days * 86400000).toISOString()
          : null;
        try {
          await dbApi.adminSetBan(p.id, true, reason.trim() || null, until);
          toast(`Забанен ${until ? `до ${new Date(until).toLocaleDateString('ru')}` : 'навсегда'} ✓`);
          renderUsers();
        } catch (e) { toast('Ошибка: ' + e.message); }
      });
    });
  }

  // ---------- вкладка Переписка ----------
  let chatsCache = [];
  async function renderLog() {
    body.innerHTML = '<div class="adm-empty">Загрузка чатов…</div>';
    try { chatsCache = await dbApi.adminFetchChats(); }
    catch (e) { body.innerHTML = `<div class="adm-empty">${esc(e.message)}</div>`; return; }

    body.innerHTML = `
      <label class="field">Выбери чат
        <select id="adm-chat-sel" class="adm-select">
          <option value="">— выбери чат —</option>
          ${chatsCache.map((c) => `<option value="${c.id}">${esc(memberTitle(c))} (${c.chat_members?.length || 0} уч.)</option>`).join('')}
        </select>
      </label>
      <div id="adm-log" class="adm-log"><div class="adm-empty">Переписка появится здесь</div></div>`;

    qs2('#adm-chat-sel', m).addEventListener('change', async (e) => {
      const box = qs2('#adm-log', m);
      const chatId = e.target.value;
      if (!chatId) { box.innerHTML = '<div class="adm-empty">Переписка появится здесь</div>'; return; }
      box.innerHTML = '<div class="adm-empty">Загрузка…</div>';
      const chat = chatsCache.find((c) => c.id === chatId);
      const nameOf = (uid) => {
        const mem = (chat.members || []).find((x) => x.user_id === uid);
        const prof = mem ? mem.profiles : null;
        return prof ? (prof.display_name || '@' + prof.nickname) : 'Кто-то';
      };
      try {
        const msgs = await dbApi.adminLoadMessages(chatId);
        if (!msgs.length) { box.innerHTML = '<div class="adm-empty">Сообщений нет</div>'; return; }
        box.innerHTML = msgs.map((msg) => `
          <div class="adm-msg">
            <div class="adm-msg-head">
              <b>${esc(nameOf(msg.sender_id))}</b>
              <span class="adm-msg-time">${new Date(msg.created_at).toLocaleString('ru')}</span>
              <button class="adm-btn danger sm" data-del="${msg.id}" title="Удалить сообщение">🗑</button>
            </div>
            <div class="adm-msg-text">${esc(msg.body || ({ image: '📷 Фото', video: '🎥 Видео', voice: '🎤 Голосовое', file: '📎 Файл', sticker: '🙂 Стикер' }[msg.attachment_type] || ''))}</div>
          </div>`).join('');
        box.querySelectorAll('[data-del]').forEach((b) => {
          b.addEventListener('click', async () => {
            if (!window.confirm('Удалить это сообщение?')) return;
            try {
              await dbApi.deleteMessage(b.dataset.del);
              b.closest('.adm-msg').remove();
              toast('Удалено ✓');
            } catch (e) { toast('Ошибка: ' + e.message); }
          });
        });
      } catch (err) { box.innerHTML = `<div class="adm-empty">${esc(err.message)}</div>`; }
    });
  }

  // ---------- вкладка Жалобы ----------
  async function renderReports() {
    body.innerHTML = '<div class="adm-empty">Загрузка…</div>';
    let reps;
    try { reps = await dbApi.adminReports(); }
    catch (e) { body.innerHTML = `<div class="adm-empty">${esc(e.message)}</div>`; return; }

    const open = reps.filter((r) => r.status === 'open');
    const done = reps.filter((r) => r.status !== 'open');
    body.innerHTML = '';
    if (!reps.length) { body.innerHTML = '<div class="adm-empty">Жалоб нет 🎉</div>'; return; }

    const list = el('<div></div>');
    const row = (r) => {
      const t = r.target;
      const rep = r.reporter;
      const box = el(`
        <div class="adm-msg ${r.status === 'open' ? '' : 'adm-done'}">
          <div class="adm-msg-head">
            <b>${esc(t ? (t.display_name || '@' + t.nickname) : 'Пользователь')}</b>
            ${r.status === 'open' ? '<span class="adm-badge banned">ОТКРЫТА</span>' : '<span class="adm-badge admin">ЗАКРЫТА</span>'}
            <span class="adm-msg-time">${new Date(r.created_at).toLocaleString('ru')}</span>
          </div>
          <div class="adm-msg-text">${esc(r.reason || 'Без причины')}</div>
          <div class="adm-user-sub">от ${esc(rep ? (rep.display_name || '@' + rep.nickname) : '?')} на @${esc(t?.nickname || '?')}</div>
          ${r.status === 'open' ? `
          <div class="chat-flag-row" style="margin-top:8px">
            <button class="btn danger sm" data-ract="ban7" data-id="${t?.id}" data-rid="${r.id}">🚫 Бан 7д</button>
            <button class="btn danger sm" data-ract="ban0" data-id="${t?.id}" data-rid="${r.id}">🚫 Бан навсегда</button>
            <button class="btn ghost sm" data-ract="close" data-rid="${r.id}">Закрыть жалобу</button>
          </div>` : ''}
        </div>`);
      return box;
    };
    open.forEach((r) => list.appendChild(row(r)));
    if (done.length) {
      list.appendChild(el('<div class="search-section">Обработанные</div>'));
      done.forEach((r) => list.appendChild(row(r)));
    }
    body.appendChild(list);

    body.querySelectorAll('[data-ract]').forEach((b) => {
      b.addEventListener('click', async () => {
        const act = b.dataset.ract;
        try {
          if (act === 'close') {
            await dbApi.adminSetReportStatus(b.dataset.rid, 'closed');
            toast('Жалоба закрыта');
          } else {
            const uid = b.dataset.id;
            if (!uid) { toast('Пользователь не найден'); return; }
            const days = act === 'ban7' ? 7 : null;
            await dbApi.adminSetBan(uid, true, 'По жалобе из админ-панели',
              days ? new Date(Date.now() + days * 86400000).toISOString() : null);
            if (b.dataset.rid) await dbApi.adminSetReportStatus(b.dataset.rid, 'banned');
            toast(`Забанен ${days ? 'на 7 дней' : 'навсегда'} ✓`);
          }
          renderReports();
        } catch (e) { toast('Ошибка: ' + e.message); }
      });
    });
  }

  // ---------- вкладка Статистика ----------
  async function renderStats() {
    body.innerHTML = '<div class="adm-empty">Считаю…</div>';
    let s;
    try { s = await dbApi.adminStats(); }
    catch (e) { body.innerHTML = `<div class="adm-empty">${esc(e.message)}</div>`; return; }

    const card = (label, val) => `
      <div class="stat-card"><div class="stat-val">${val ?? '—'}</div><div class="stat-label">${label}</div></div>`;
    const max = Math.max(...s.days, 1);
    const bars = s.days.map((v, i) => `
      <div class="stat-bar-col">
        <div class="stat-bar" style="height:${Math.round((v / max) * 64) + 2}px" title="${v} сообщ."></div>
        <span class="stat-day">${['пн','вт','ср','чт','пт','сб','вс'][new Date(Date.now() - (6 - i) * 86400000).getDay()]}</span>
      </div>`).join('');

    body.innerHTML = `
      <div class="stat-grid">
        ${card('Пользователи', s.users)}
        ${card('Чаты', s.chats)}
        ${card('Сообщения', s.messages)}
        ${card('Каналы', s.channels)}
        ${card('Открытые жалобы', s.reports)}
        ${card('Блокировки', s.blocks)}
      </div>
      <div class="search-section">Сообщения за 7 дней</div>
      <div class="stat-chart">${bars}</div>`;
  }

  // ---------- табы ----------
  m.querySelectorAll('.adm-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      m.querySelectorAll('.adm-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      if (tab.dataset.tab === 'users') renderUsers();
      else if (tab.dataset.tab === 'log') renderLog();
      else if (tab.dataset.tab === 'reports') renderReports();
      else renderStats();
    });
  });

  await renderUsers();
}

// локальный qs внутри модалки
function qs2(sel, root) { return root.querySelector(sel); }

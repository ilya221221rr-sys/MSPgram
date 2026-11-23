// ============================================================
//  Админ-панель: пользователи (бан/разбан/переименовать)
//  и чтение переписки любых чатов. Видна только is_admin.
// ============================================================
import { state, dbApi } from './api.js';
import { esc, el, avatarHTML, relLastSeen, toast } from './utils.js';
import { EXTRA_TABS, renderUsersTab, renderExtraTab, audit } from './admin2.js';

const ADMIN_BADGE = (p) => {
  const badges = [];
  if (p.is_admin) badges.push('<span class="adm-badge admin">АДМИН</span>');
  else if (p.is_moderator) badges.push('<span class="adm-badge mod">МОДЕР</span>');
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
  if (!state.me || !(state.me.is_admin || state.me.is_moderator)) { toast('Только для админов и модераторов'); return; }
  const isAdm = !!state.me.is_admin;

  const m = el(`
    <div class="modal-overlay admin-overlay">
      <div class="modal admin-modal">
        <h3>🛡 Админ-панель</h3>
        <div class="adm-tabs">
          <button class="adm-tab active" data-tab="users">Пользователи</button>
          ${isAdm ? '<button class="adm-tab" data-tab="log">Переписка</button><button class="adm-tab" data-tab="groups">Сообщества</button>' : ''}
          <button class="adm-tab" data-tab="reports">Жалобы</button>
          <button class="adm-tab" data-tab="stats">Статистика</button>
          ${EXTRA_TABS.filter(([, , onlyAdm]) => isAdm || !onlyAdm).map(([k, l]) => `<button class="adm-tab" data-tab="${k}">${l}</button>`).join('')}
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

  // ---------- вкладка Пользователи (v19: см. admin2.js) ----------
  const renderUsers = () => renderUsersTab(body, { isAdm });

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
              await dbApi.deleteMessage(b.dataset.del); audit('delete_message', b.dataset.del);
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
            audit('ban', uid, { by: 'report', days });
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

  // ---------- сообщества: управление группами и каналами ----------
  async function renderGroups() {
    body.innerHTML = '<div class="adm-empty">Загружаю…</div>';
    let chats = [];
    try { chats = (await dbApi.adminFetchChats()).filter((c) => c.type === 'group'); }
    catch (e) { body.innerHTML = `<div class="adm-empty">${esc(e.message)}</div>`; return; }
    if (!chats.length) { body.innerHTML = '<div class="adm-empty">Сообществ пока нет</div>'; return; }
    body.innerHTML = '';
    chats.forEach((c) => {
      const n = (c.chat_members || []).length;
      const row = el(`<div class="adm-user-row">
        ${avatarHTML(c.avatar_url, c.title || 'Группа', 'md', false)}
        <div class="adm-user-main"><div class="adm-user-name">${esc(c.title || 'Группа')} ${c.is_public ? '<span class="adm-badge">ПУБЛИЧНОЕ</span>' : ''}${c.only_admins_post ? ' <span class="adm-badge">КАНАЛ</span>' : ''}</div>
        <div class="adm-user-sub">${n} участн. · создано ${new Date(c.created_at).toLocaleDateString('ru')}</div></div>
        <div class="adm-user-actions">
          <button class="adm-btn" data-act="priv" title="Сделать ${c.is_public ? 'приватным' : 'публичным'}">${c.is_public ? '🔒' : '🌐'}</button>
          <button class="adm-btn danger" data-act="del" title="Удалить сообщество">🗑</button></div></div>`);
      row.querySelector('[data-act=priv]').addEventListener('click', async () => {
        try { await dbApi.updateChatSettings(c.id, { is_public: !c.is_public }); toast('Готово ✓'); renderGroups(); }
        catch (e) { toast('Ошибка: ' + e.message); }
      });
      row.querySelector('[data-act=del]').addEventListener('click', async () => {
        if (!window.confirm(`Удалить «${c.title}» вместе с историей? Это необратимо.`)) return;
        try { await dbApi.adminDeleteChat(c.id); audit('delete_chat', c.title || c.id); toast('Удалено ✓'); renderGroups(); }
        catch (e) { toast('Ошибка: ' + e.message); }
      });
      body.appendChild(row);
    });
  }

  // ---------- табы ----------
  m.querySelectorAll('.adm-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      m.querySelectorAll('.adm-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      if (tab.dataset.tab === 'users') renderUsers();
      else if (tab.dataset.tab === 'log') renderLog();
      else if (tab.dataset.tab === 'groups') renderGroups();
      else if (tab.dataset.tab === 'reports') renderReports();
      else if (tab.dataset.tab === 'stats') renderStats();
      else renderExtraTab(tab.dataset.tab, body, {});
    });
  });

  await renderUsers();
}

// локальный qs внутри модалки
function qs2(sel, root) { return root.querySelector(sel); }

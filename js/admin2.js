// ============================================================
//  Админ-панель v19 «Nova»: поиск и фильтры пользователей, карточка
//  пользователя, диалог бана, рассылки, журнал действий,
//  диагностика ИИ, состояние системы.
// ============================================================
import { getSb, state, dbApi } from './api.js?v=26';
import { qs, esc, el, toast, avatarHTML, relLastSeen, confirmDialog } from './utils.js';
import { renderAiDiag } from './ai-diag.js';
import { openRenameDialog } from './v23.js';

export const EXTRA_TABS = [
  ['ai', '🩺 ИИ', false],
  ['broadcast', '📣 Рассылка', true],
  ['audit', '📜 Журнал', true],
  ['system', '⚙ Система', true],
];

// ---------- журнал действий ----------
export async function audit(action, target = '', details = {}) {
  try {
    await getSb().from('admin_audit').insert({
      actor: state.me.id, actor_name: state.me.display_name || state.me.nickname, action, target: String(target || ''), details,
    });
  } catch { /* таблицы может не быть до миграции */ }
}

const isBannedNow = (p) => p.is_banned && (!p.banned_until || new Date(p.banned_until) > new Date());
const roleOf = (p) => (p.is_admin ? 'admin' : p.is_moderator ? 'mod' : 'user');
const BADGE = (p) => [
  p.is_admin ? '<span class="adm-badge admin">АДМИН</span>' : p.is_moderator ? '<span class="adm-badge mod">МОДЕР</span>' : '',
  isBannedNow(p) ? '<span class="adm-badge banned">БАН</span>' : '',
].join(' ');

// ---------- диалог бана ----------
function banDialog(p) {
  return new Promise((resolve) => {
    const m = el(`<div class="modal-overlay" style="z-index:1300"><div class="modal">
      <h3>🚫 Бан: ${esc(p.display_name || p.nickname)}</h3>
      <label class="field">Причина<input id="bd-reason" placeholder="Спам, оскорбления, мошенничество…" maxlength="200"></label>
      <div class="chip-row" id="bd-quick">${['Спам', 'Оскорбления', 'Мошенничество', '18+ контент', 'Нарушение правил'].map((x) => `<button class="chip" type="button">${x}</button>`).join('')}</div>
      <div class="field-hint" style="margin-top:12px">Срок</div>
      <div class="seg" id="bd-dur">${[['1h', '1 час'], ['1d', '1 день'], ['7d', '7 дней'], ['30d', '30 дней'], ['0', 'Навсегда']].map(([k, l], i) => `<button type="button" data-k="${k}" class="${i === 2 ? 'active' : ''}">${l}</button>`).join('')}</div>
      <div class="modal-actions"><button class="btn ghost" data-act="no">Отмена</button><button class="btn danger" data-act="ok">Забанить</button></div></div></div>`);
    document.querySelector('#modal-root').appendChild(m);
    const reason = qs('#bd-reason', m); let dur = '7d';
    m.addEventListener('click', (e) => {
      const q = e.target.closest('#bd-quick .chip'); if (q) reason.value = q.textContent;
      const d = e.target.closest('#bd-dur button'); if (d) { dur = d.dataset.k; m.querySelectorAll('#bd-dur button').forEach((x) => x.classList.toggle('active', x === d)); }
      if (e.target === m || e.target.closest('[data-act=no]')) { m.remove(); resolve(null); }
      if (e.target.closest('[data-act=ok]')) {
        const ms = { '1h': 3600e3, '1d': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3, 0: 0 }[dur] || 0;
        m.remove(); resolve({ reason: reason.value.trim() || null, until: ms ? new Date(Date.now() + ms).toISOString() : null, label: dur === '0' ? 'навсегда' : `на ${dur}` });
      }
    });
  });
}

async function doBan(p) {
  if (p.id === state.me.id) { toast('Себя банить нельзя 🙂'); return false; }
  if (p.is_admin && !state.me.is_admin) { toast('Модератор не может банить админа'); return false; }
  const r = await banDialog(p); if (!r) return false;
  await dbApi.adminSetBan(p.id, true, r.reason, r.until);
  audit('ban', `@${p.nickname}`, { reason: r.reason, until: r.until });
  toast(`Забанен ${r.label} ✓`); return true;
}

// ---------- карточка пользователя ----------
async function openUserCard(p, isAdm, reload) {
  const m = el(`<div class="modal-overlay" style="z-index:1200"><div class="modal ucard">
    <div class="ucard-head">${avatarHTML(p.avatar_url, p.display_name || p.nickname, 'lg', state.online.has(p.id))}
      <div><div class="ucard-name">${esc(p.display_name || p.nickname)} ${esc(p.status_emoji || '')} ${BADGE(p)}</div>
      <div class="muted">@${esc(p.nickname)} · ${esc(relLastSeen(p.last_seen, state.online.has(p.id)))}</div></div></div>
    <div class="stat-grid ucard-stats" id="uc-stats"><div class="stat-card"><div class="stat-val">…</div><div class="stat-label">сообщений</div></div></div>
    <div class="diag-card">
      <div class="diag-row"><span>Регистрация</span><b>${new Date(p.created_at).toLocaleString('ru')}</b></div>
      <div class="diag-row"><span>ID</span><b class="mono small">${esc(p.id)}</b></div>
      <div class="diag-row"><span>О себе</span><b>${esc(p.bio || p.about || '—')}</b></div>
      ${isBannedNow(p) ? `<div class="diag-row"><span>Бан</span><b class="danger-t">${esc(p.ban_reason || 'без причины')}${p.banned_until ? ' · до ' + new Date(p.banned_until).toLocaleString('ru') : ' · навсегда'}</b></div>` : ''}
    </div>
    <label class="field">Заметка персонала (пользователь её не видит)<textarea id="uc-note" rows="2" maxlength="500" placeholder="Например: предупреждён 12.05"></textarea></label>
    <div class="chat-flag-row" style="flex-wrap:wrap;gap:8px">
      <button class="btn ghost sm" data-a="note">💾 Сохранить заметку</button>
      <button class="btn ghost sm" data-a="copy">⧉ Копировать ID</button>
      ${isAdm ? '<button class="btn ghost sm" data-a="rename">✏️ Имя и юзернейм</button>' : ''}
      ${isAdm ? '<button class="btn ghost sm" data-a="wipe">🧹 Удалить все его сообщения</button>' : ''}
      <button class="btn ${isBannedNow(p) ? 'primary' : 'danger'} sm" data-a="ban">${isBannedNow(p) ? '✅ Разбанить' : '🚫 Забанить'}</button>
    </div>
    <div class="modal-actions"><button class="btn primary" data-a="close">Закрыть</button></div></div></div>`);
  document.querySelector('#modal-root').appendChild(m);
  const sb = getSb();
  sb.from('admin_notes').select('note').eq('user_id', p.id).maybeSingle().then(({ data }) => { const t = qs('#uc-note', m); if (t && data) t.value = data.note || ''; }, () => {});
  (async () => {
    const cnt = async (t, col) => { const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true }).eq(col, p.id); return error ? '—' : count; };
    const [msgs, chats] = await Promise.all([cnt('messages', 'sender_id'), cnt('chat_members', 'user_id')]);
    const box = qs('#uc-stats', m); if (!box) return;
    box.innerHTML = `<div class="stat-card"><div class="stat-val">${msgs}</div><div class="stat-label">сообщений</div></div><div class="stat-card"><div class="stat-val">${chats}</div><div class="stat-label">чатов</div></div>`;
  })();
  m.addEventListener('click', async (e) => {
    if (e.target === m) { m.remove(); return; }
    const b = e.target.closest('[data-a]'); if (!b) return;
    try {
      if (b.dataset.a === 'close') m.remove();
      if (b.dataset.a === 'copy') navigator.clipboard?.writeText(p.id).then(() => toast('ID скопирован ✓'));
      if (b.dataset.a === 'rename') openRenameDialog(p, (patch) => { audit('rename', `@${p.nickname}`, patch); m.remove(); reload(); });
      if (b.dataset.a === 'note') { const { error: ne } = await sb.from('admin_notes').upsert({ user_id: p.id, note: qs('#uc-note', m).value.trim(), updated_by: state.me.id, updated_at: new Date().toISOString() });
        if (ne) throw ne;
        audit('note', `@${p.nickname}`); toast('Заметка сохранена ✓'); }
      if (b.dataset.a === 'ban') {
        if (isBannedNow(p)) { await dbApi.adminSetBan(p.id, false); audit('unban', `@${p.nickname}`); toast('Разбанен ✓'); m.remove(); reload(); }
        else if (await doBan(p)) { m.remove(); reload(); }
      }
      if (b.dataset.a === 'wipe') {
        const ok = await confirmDialog({ title: 'Удалить все сообщения?', text: `Будут стёрты ВСЕ сообщения @${p.nickname} во всех чатах. Это необратимо.`, okLabel: 'Стереть' });
        if (!ok) return;
        const { error } = await sb.from('messages').delete().eq('sender_id', p.id);
        if (error) throw error;
        audit('wipe_messages', `@${p.nickname}`); toast('Сообщения удалены ✓');
      }
    } catch (err) { toast('Ошибка: ' + (err.message || err), 4500); }
  });
}

// ============================================================
//  Вкладка «Пользователи»
// ============================================================
export async function renderUsersTab(body, { isAdm }) {
  body.innerHTML = '<div class="adm-empty">Загрузка…</div>';
  let users;
  try { users = await dbApi.adminListUsers(); } catch (e) { body.innerHTML = `<div class="adm-empty">${esc(e.message)}</div>`; return; }
  const day = 86400e3;
  const filters = {
    all: () => true,
    online: (p) => state.online.has(p.id),
    staff: (p) => p.is_admin || p.is_moderator,
    banned: isBannedNow,
    new7: (p) => Date.now() - new Date(p.created_at) < 7 * day,
    inactive: (p) => !p.last_seen || Date.now() - new Date(p.last_seen) > 30 * day,
  };
  const sorts = {
    newest: (a, b) => new Date(b.created_at) - new Date(a.created_at),
    oldest: (a, b) => new Date(a.created_at) - new Date(b.created_at),
    seen: (a, b) => new Date(b.last_seen || 0) - new Date(a.last_seen || 0),
    name: (a, b) => (a.display_name || a.nickname || '').localeCompare(b.display_name || b.nickname || '', 'ru'),
  };
  let q = ''; let f = 'all'; let s = 'newest';
  body.innerHTML = `
    <div class="adm-toolbar">
      <input id="au-q" type="search" placeholder="Поиск: имя, @ник или ID" autocomplete="off">
      <select id="au-f" class="adm-select">
        <option value="all">Все</option><option value="online">В сети</option><option value="staff">Персонал</option>
        <option value="banned">Забаненные</option><option value="new7">Новые (7 дн.)</option><option value="inactive">Неактивные (30+ дн.)</option></select>
      <select id="au-s" class="adm-select"><option value="newest">Новые сверху</option><option value="oldest">Старые сверху</option><option value="seen">По активности</option><option value="name">По имени</option></select>
      <button class="adm-btn" id="au-csv" title="Скачать CSV">⬇ CSV</button>
    </div>
    <div class="adm-sum" id="au-sum"></div><div id="au-list"></div>`;
  const list = qs('#au-list', body);
  const draw = () => {
    const ql = q.toLowerCase();
    const arr = users.filter(filters[f]).filter((p) => !ql || (p.nickname || '').toLowerCase().includes(ql) || (p.display_name || '').toLowerCase().includes(ql) || p.id === q.trim()).sort(sorts[s]);
    qs('#au-sum', body).textContent = `Показано ${arr.length} из ${users.length} · в сети ${users.filter(filters.online).length} · забанено ${users.filter(filters.banned).length}`;
    list.innerHTML = '';
    if (!arr.length) { list.innerHTML = '<div class="adm-empty">Никого не найдено</div>'; return; }
    arr.slice(0, 200).forEach((p) => {
      const banned = isBannedNow(p);
      const row = el(`<div class="adm-user-row clickable">
        ${avatarHTML(p.avatar_url, p.display_name || p.nickname, 'md', state.online.has(p.id))}
        <div class="adm-user-main"><div class="adm-user-name">${esc(p.display_name || p.nickname)} ${BADGE(p)}</div>
          <div class="adm-user-sub">@${esc(p.nickname)} · ${esc(relLastSeen(p.last_seen, state.online.has(p.id)))}</div>
          ${banned ? `<div class="adm-user-sub danger">Причина: ${esc(p.ban_reason || 'не указана')}${p.banned_until ? ` · до ${new Date(p.banned_until).toLocaleString('ru')}` : ' · навсегда'}</div>` : ''}</div>
        <div class="adm-user-actions">
          ${isAdm ? '<button class="adm-btn" data-a="role" title="Роль">🎖</button><button class="adm-btn" data-a="rename" title="Имя и ник">✏️</button>' : ''}
          <button class="adm-btn ${banned ? 'ok' : 'danger'}" data-a="ban" title="${banned ? 'Разбанить' : 'Забанить'}">${banned ? '✅' : '🚫'}</button></div></div>`);
      row.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-a]');
        if (!b) { openUserCard(p, isAdm, () => renderUsersTab(body, { isAdm })); return; }
        try {
          if (b.dataset.a === 'ban') {
            if (banned) { if (await confirmDialog({ title: 'Разбанить?', text: p.display_name || p.nickname, okLabel: 'Разбанить', danger: false })) { await dbApi.adminSetBan(p.id, false); audit('unban', `@${p.nickname}`); toast('Разбанен ✓'); renderUsersTab(body, { isAdm }); } }
            else if (await doBan(p)) renderUsersTab(body, { isAdm });
          }
          if (b.dataset.a === 'role') {
            if (p.id === state.me.id) { toast('Свою роль менять нельзя'); return; }
            const v = window.prompt(`Роль для ${p.display_name || p.nickname}:\n1 — пользователь\n2 — модератор\n3 — администратор`, String(roleOf(p) === 'admin' ? 3 : roleOf(p) === 'mod' ? 2 : 1));
            const n = parseInt(v, 10); if (![1, 2, 3].includes(n)) return;
            await dbApi.adminSetRole(p.id, { is_admin: n === 3, is_moderator: n === 2 });
            audit('role', `@${p.nickname}`, { role: n }); toast('Роль обновлена ✓'); renderUsersTab(body, { isAdm });
          }
          if (b.dataset.a === 'rename') {
            openRenameDialog(p, (patch) => { audit('rename', `@${p.nickname}`, patch); renderUsersTab(body, { isAdm }); });
          }
        } catch (err) { toast('Ошибка: ' + err.message, 4500); }
      });
      list.appendChild(row);
    });
  };
  qs('#au-q', body).addEventListener('input', (e) => { q = e.target.value.trim(); draw(); });
  qs('#au-f', body).addEventListener('change', (e) => { f = e.target.value; draw(); });
  qs('#au-s', body).addEventListener('change', (e) => { s = e.target.value; draw(); });
  qs('#au-csv', body).addEventListener('click', () => {
    const rows = [['id', 'nickname', 'display_name', 'role', 'banned', 'created_at', 'last_seen']]
      .concat(users.map((p) => [p.id, p.nickname, p.display_name || '', roleOf(p), isBannedNow(p) ? 'yes' : 'no', p.created_at, p.last_seen || '']));
    const csv = '\ufeff' + rows.map((r) => r.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `mspgram-users-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    audit('export_csv', 'users'); toast('CSV скачан ✓');
  });
  draw();
}

// ============================================================
//  Остальные вкладки
// ============================================================
export async function renderExtraTab(key, body, ctx) {
  if (key === 'ai') return renderAiDiag(body, { admin: !!state.me.is_admin });
  if (key === 'broadcast') return renderBroadcast(body);
  if (key === 'audit') return renderAudit(body);
  if (key === 'system') return renderSystem(body, ctx);
  return null;
}

async function renderBroadcast(body) {
  body.innerHTML = `
    <label class="field">Заголовок<input id="bc-title" maxlength="80" placeholder="Например: Обновление v19"></label>
    <label class="field">Текст<textarea id="bc-text" rows="3" maxlength="500" placeholder="Что хотите сообщить всем пользователям"></textarea></label>
    <div class="adm-toolbar">
      <select id="bc-level" class="adm-select"><option value="info">ℹ️ Новость</option><option value="warn">⚠️ Важно</option><option value="critical">🛑 Срочно</option></select>
      <select id="bc-ttl" class="adm-select"><option value="1">1 день</option><option value="3">3 дня</option><option value="7" selected>7 дней</option><option value="30">30 дней</option><option value="0">Без срока</option></select>
      <button class="btn primary sm" id="bc-send">📣 Показать всем</button>
    </div>
    <div class="settings-sec">Активные объявления</div><div id="bc-list"><div class="adm-empty">Загружаю…</div></div>`;
  const load = async () => {
    const box = qs('#bc-list', body);
    const { data, error } = await getSb().from('app_announcements').select('*').order('created_at', { ascending: false }).limit(30);
    if (error) { box.innerHTML = `<div class="adm-empty">${esc(error.message)}<br>Примени supabase/migration-10-v19.sql</div>`; return; }
    if (!data.length) { box.innerHTML = '<div class="adm-empty">Объявлений нет</div>'; return; }
    box.innerHTML = data.map((a) => `<div class="adm-msg"><div class="adm-msg-head"><b>${esc(a.title)}</b>
      <span class="adm-badge ${a.level === 'info' ? '' : 'banned'}">${esc(a.level)}</span><span class="adm-msg-time">${new Date(a.created_at).toLocaleString('ru')}${a.expires_at ? ' → ' + new Date(a.expires_at).toLocaleDateString('ru') : ''}</span>
      <button class="adm-btn danger sm" data-del="${a.id}">🗑</button></div><div class="adm-msg-text">${esc(a.body)}</div></div>`).join('');
  };
  body.onclick = async (e) => {
    const d = e.target.closest('[data-del]');
    if (d) { await getSb().from('app_announcements').delete().eq('id', d.dataset.del); audit('announce_delete', d.dataset.del); load(); return; }
    if (!e.target.closest('#bc-send')) return;
    const title = qs('#bc-title', body).value.trim(); const text = qs('#bc-text', body).value.trim();
    if (!title) { toast('Введи заголовок'); return; }
    const ttl = Number(qs('#bc-ttl', body).value);
    const { error } = await getSb().from('app_announcements').insert({
      title, body: text, level: qs('#bc-level', body).value, created_by: state.me.id,
      expires_at: ttl ? new Date(Date.now() + ttl * 86400e3).toISOString() : null,
    });
    if (error) { toast('Ошибка: ' + error.message, 5000); return; }
    audit('announce', title); toast('Отправлено всем ✓'); qs('#bc-title', body).value = ''; qs('#bc-text', body).value = ''; load();
  };
  load();
}

const AUDIT_ICONS = { ban: '🚫', unban: '✅', role: '🎖', rename: '✏️', wipe_messages: '🧹', announce: '📣', delete_message: '🗑', delete_chat: '🗑', export_csv: '⬇', note: '📝' };
async function renderAudit(body) {
  body.innerHTML = '<div class="adm-empty">Загружаю…</div>';
  const { data, error } = await getSb().from('admin_audit').select('*').order('created_at', { ascending: false }).limit(150);
  if (error) { body.innerHTML = `<div class="adm-empty">${esc(error.message)}<br>Примени supabase/migration-10-v19.sql</div>`; return; }
  if (!data.length) { body.innerHTML = '<div class="adm-empty">Действий пока не было</div>'; return; }
  body.innerHTML = `<div class="adm-sum">Последние ${data.length} действий персонала</div>` + data.map((r) => `<div class="audit-row">
    <span class="audit-ic">${AUDIT_ICONS[r.action] || '•'}</span><div class="audit-main"><b>${esc(r.actor_name || '?')}</b> — ${esc(r.action)} <span class="muted">${esc(r.target || '')}</span>
    ${r.details && Object.keys(r.details).length ? `<div class="mono small muted">${esc(JSON.stringify(r.details))}</div>` : ''}</div>
    <span class="adm-msg-time">${new Date(r.created_at).toLocaleString('ru')}</span></div>`).join('');
}

async function renderSystem(body) {
  body.innerHTML = '<div class="adm-empty">Проверяю систему…</div>';
  const sb = getSb();
  const t0 = performance.now();
  const tables = ['profiles', 'chats', 'chat_members', 'messages', 'reactions', 'channels', 'reports', 'blocks', 'friendships', 'user_sessions', 'app_announcements', 'admin_audit', 'admin_notes', 'ai_errors'];
  const res = await Promise.all(tables.map(async (t) => {
    const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true });
    return { t, ok: !error, count, err: error?.message };
  }));
  const ping = Math.round(performance.now() - t0);
  let users = [];
  try { users = await dbApi.adminListUsers(); } catch { /* */ }
  const now = Date.now();
  const act = (ms) => users.filter((p) => p.last_seen && now - new Date(p.last_seen) < ms).length;
  let buckets = '—';
  try { const { data } = await sb.storage.listBuckets(); buckets = data ? data.map((b) => b.name).join(', ') || 'нет' : 'нет доступа (это нормально)'; } catch { /* */ }
  const swv = (await caches.keys().catch(() => [])).join(', ') || '—';
  const missing = res.filter((r) => !r.ok);
  body.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-val">${act(86400e3)}</div><div class="stat-label">активны за 24 ч</div></div>
      <div class="stat-card"><div class="stat-val">${act(7 * 86400e3)}</div><div class="stat-label">активны за 7 дн.</div></div>
      <div class="stat-card"><div class="stat-val">${users.filter((p) => now - new Date(p.created_at) < 7 * 86400e3).length}</div><div class="stat-label">новых за 7 дн.</div></div>
      <div class="stat-card"><div class="stat-val">${ping}<small>мс</small></div><div class="stat-label">отклик Supabase (${res.length} запросов)</div></div>
    </div>
    ${missing.length ? `<div class="diag-note bad">⚠ Не найдены/недоступны таблицы: <b>${missing.map((r) => r.t).join(', ')}</b>.<br>Выполни в Supabase → SQL Editor файл <b>supabase/migration-10-v19.sql</b> (и migration-9, если ещё нет).</div>` : '<div class="diag-note">✅ Все нужные таблицы на месте.</div>'}
    <div class="settings-sec">Таблицы базы данных</div>
    <div class="sys-grid">${res.map((r) => `<div class="sys-cell ${r.ok ? 'ok' : 'bad'}"><span>${r.ok ? '✓' : '✕'}</span><b>${r.t}</b><em>${r.ok ? (r.count ?? 0) : 'нет'}</em></div>`).join('')}</div>
    <div class="settings-sec">Окружение</div>
    <div class="diag-card">
      <div class="diag-row"><span>Версия приложения</span><b>${esc(window.MSP_VERSION || 'v20')}</b></div>
      <div class="diag-row"><span>Realtime-каналов</span><b>${sb.getChannels?.().length ?? '—'}</b></div>
      <div class="diag-row"><span>Хранилища</span><b>${esc(buckets)}</b></div>
      <div class="diag-row"><span>Кэш приложения</span><b class="mono small">${esc(swv)}</b></div>
      <div class="diag-row"><span>Экран</span><b>${innerWidth}×${innerHeight} · ${navigator.onLine ? 'онлайн' : 'офлайн'}</b></div>
    </div>
    <div class="chat-flag-row" style="gap:8px;flex-wrap:wrap;margin-top:10px">
      <button class="btn ghost sm" id="sy-cache">🧹 Сбросить кэш и перезагрузить</button>
      <button class="btn ghost sm" id="sy-refresh">↻ Обновить</button></div>`;
  qs('#sy-refresh', body).onclick = () => renderSystem(body);
  qs('#sy-cache', body).onclick = async () => {
    (await caches.keys()).forEach((k) => caches.delete(k));
    (await navigator.serviceWorker?.getRegistrations?.() || []).forEach((r) => r.unregister());
    location.reload();
  };
}

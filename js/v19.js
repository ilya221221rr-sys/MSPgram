// ============================================================
//  MSPgram v19 «Nova»: точка подключения новых возможностей
//  • черновики сообщений (как в Telegram)    • свайп влево — ответить
//  • спойлеры ||текст||                      • подсказки @упоминаний
//  • Ctrl/⌘+K — быстрый переход              • объявления от админов
//  • плашка «Нет соединения»                 • тёмные скины и обои
// ============================================================
import { getSb, state, memberProfile } from './api.js?v=26';
import { qs, esc, el, bus, getPrefs, setPrefs, avatarHTML } from './utils.js';
import { applyAppearance } from './appearance.js';
import { openPalette } from './palette.js';
import { replyToMessage } from './chatview.js';
import { pushNotice } from './notify.js';

export const VERSION = 'v19';
let wired = false;
let annChan = null;
let annTimer = null;

// ---------- черновики ----------
const DKEY = () => `msp_drafts_${state.me?.id || 'x'}`;
const drafts = () => { try { return JSON.parse(localStorage.getItem(DKEY()) || '{}'); } catch { return {}; } };
function setDraft(chatId, text) {
  if (!chatId) return;
  const d = drafts();
  if (text && text.trim()) d[chatId] = text; else delete d[chatId];
  try { localStorage.setItem(DKEY(), JSON.stringify(d)); } catch { /* */ }
}
function paintDrafts() {
  const d = drafts();
  document.querySelectorAll('#chat-list .chat-row[data-chat]').forEach((row) => {
    const id = row.dataset.chat; const prev = row.querySelector('.chat-row-preview');
    if (!prev || id === state.activeChatId || !d[id]) return;
    prev.innerHTML = `<span class="draft">Черновик:</span> ${esc(d[id].slice(0, 60))}`;
  });
}

function wireDrafts() {
  const input = qs('#msg-input'); if (!input) return;
  input.addEventListener('input', () => { setDraft(state.activeChatId, input.value); });
  const afterSend = () => { const id = state.activeChatId; setTimeout(() => { if (!input.value.trim()) { setDraft(id, ''); paintDrafts(); } }, 120); };
  qs('#send-btn')?.addEventListener('click', afterSend);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) afterSend(); });
  bus.on('open-chat', (id) => setTimeout(() => {
    const t = drafts()[id] || '';
    if (input.value !== t) { input.value = t; input.dispatchEvent(new Event('input')); }
    input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    paintDrafts();
  }, 140));
  const list = qs('#chat-list');
  if (list) new MutationObserver(paintDrafts).observe(list, { childList: true });
}

// ---------- свайп влево по сообщению = ответить ----------
function wireSwipe() {
  const box = qs('#messages'); if (!box) return;
  let row = null; let x0 = 0; let y0 = 0; let dx = 0; let locked = false;
  box.addEventListener('touchstart', (e) => {
    const r = e.target.closest('.msg-row'); if (!r || e.touches.length > 1) return;
    if (e.target.closest('.voice, video, audio, input, textarea, .spoiler')) return;
    row = r; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; locked = false;
  }, { passive: true });
  box.addEventListener('touchmove', (e) => {
    if (!row) return;
    const mx = x0 - e.touches[0].clientX; const my = Math.abs(e.touches[0].clientY - y0);
    if (!locked && my > 12 && my > Math.abs(mx)) { row = null; return; }
    if (mx > 10) locked = true;
    if (!locked) return;
    dx = Math.max(0, Math.min(mx, 90));
    row.style.transition = 'none'; row.style.transform = `translateX(${-dx * 0.8}px)`;
    row.classList.toggle('swipe-ready', dx > 60);
  }, { passive: true });
  const end = () => {
    if (!row) return;
    const r = row; row = null;
    r.style.transition = 'transform .22s cubic-bezier(.2,.9,.3,1)'; r.style.transform = '';
    if (dx > 60) { navigator.vibrate?.(12); replyToMessage(r.dataset.id); }
    r.classList.remove('swipe-ready'); dx = 0;
  };
  box.addEventListener('touchend', end, { passive: true });
  box.addEventListener('touchcancel', end, { passive: true });
}

// ---------- спойлеры ----------
function wireSpoilers() {
  document.addEventListener('click', (e) => {
    const s = e.target.closest('.spoiler'); if (s) { s.classList.toggle('open'); e.stopPropagation(); }
  }, true);
}

// ---------- подсказки @ник ----------
function wireMentions() {
  const input = qs('#msg-input'); const composer = qs('.composer'); if (!input || !composer) return;
  const pop = el('<div class="mention-pop hidden" id="mention-pop"></div>');
  composer.appendChild(pop);
  const hide = () => pop.classList.add('hidden');
  input.addEventListener('input', () => {
    const chat = state.chats.get(state.activeChatId);
    if (!chat || chat.type !== 'group') { hide(); return; }
    const before = input.value.slice(0, input.selectionStart);
    const mm = /(^|\s)@([\p{L}\p{N}_]{0,20})$/u.exec(before);
    if (!mm) { hide(); return; }
    const q = mm[2].toLowerCase();
    const people = (chat.members || []).filter((x) => x.user_id !== state.me.id).map((x) => memberProfile(chat, x.user_id)).filter(Boolean)
      .filter((p) => !q || (p.nickname || '').toLowerCase().startsWith(q) || (p.display_name || '').toLowerCase().startsWith(q)).slice(0, 6);
    if (!people.length) { hide(); return; }
    pop.innerHTML = people.map((p) => `<button type="button" class="mp-item" data-n="${esc(p.nickname)}">${avatarHTML(p.avatar_url, p.display_name || p.nickname, 'xs')}<b>${esc(p.display_name || p.nickname)}</b><span>@${esc(p.nickname)}</span></button>`).join('');
    pop.classList.remove('hidden');
  });
  pop.addEventListener('mousedown', (e) => e.preventDefault());
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('[data-n]'); if (!b) return;
    const pos = input.selectionStart; const before = input.value.slice(0, pos).replace(/@([\p{L}\p{N}_]{0,20})$/u, `@${b.dataset.n} `);
    input.value = before + input.value.slice(pos); input.setSelectionRange(before.length, before.length); input.focus(); hide();
    input.dispatchEvent(new Event('input'));
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}

// ---------- объявления от админов ----------
let shownAnn = null;
async function loadAnnouncements(notify = false) {
  try {
    const { data, error } = await getSb().from('app_announcements').select('*')
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`).order('created_at', { ascending: false }).limit(5);
    if (error || !data) return;
    const dismissed = getPrefs().annDismissed || [];
    const a = data.find((x) => !dismissed.includes(x.id));
    qs('#ann-banner')?.remove();
    if (!a) { shownAn(null); return; }
    shownAn(a);
    if (notify && a.created_by !== state.me.id) pushNotice({ kind: 'info', title: `📣 ${a.title}`, body: a.body || '' });
  } catch { /* таблицы нет до миграции */ }
}
function shownAn(a) {
  shownAnn = a; if (!a) return;
  const b = el(`<div class="ann-banner lvl-${esc(a.level)}" id="ann-banner"><span class="ann-ic">${{ info: '📣', warn: '⚠️', critical: '🛑' }[a.level] || '📣'}</span>
    <div class="ann-tx"><b>${esc(a.title)}</b>${a.body ? `<span>${esc(a.body)}</span>` : ''}</div><button class="ann-x" aria-label="Закрыть">✕</button></div>`);
  b.querySelector('.ann-x').onclick = () => { setPrefs({ annDismissed: [...(getPrefs().annDismissed || []).slice(-30), a.id] }); b.remove(); };
  qs('#app')?.prepend(b);
}

// ---------- сеть ----------
function wireNet() {
  const bar = el('<div class="net-banner hidden" id="net-banner">⚠ Нет соединения — ждём сеть…</div>');
  document.body.appendChild(bar);
  const upd = () => bar.classList.toggle('hidden', navigator.onLine);
  addEventListener('online', upd); addEventListener('offline', upd); upd();
}

// ---------- горячие клавиши ----------
function wireHotkeys() {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const ids = [...document.querySelectorAll('#chat-list .chat-row[data-chat]')].map((r) => r.dataset.chat);
      if (!ids.length) return;
      const i = ids.indexOf(state.activeChatId); const n = e.key === 'ArrowDown' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1);
      e.preventDefault(); bus.emit('open-chat', ids[n < 0 ? 0 : n]);
    }
  });
  const si = qs('#search-input'); if (si && matchMedia('(hover:hover)').matches) si.placeholder = 'Поиск: люди, чаты, сообщения (Ctrl+K — быстрый переход)';
}

// ---------- запуск ----------
export function v19Boot() {
  applyAppearance();
  window.MSP_VERSION = VERSION;
  const v = qs('#app-version'); if (v) v.textContent = VERSION;
  if (wired) return; wired = true;
  wireNet(); wireSpoilers(); wireHotkeys();
  wireDrafts(); wireSwipe(); wireMentions();
}

export function v19Enter() {
  loadAnnouncements(false);
  annTimer = setInterval(() => loadAnnouncements(false), 300000);
  try {
    annChan = getSb().channel('msp-v19-ann')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'app_announcements' }, () => loadAnnouncements(true))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'app_announcements' }, () => loadAnnouncements(false))
      .subscribe();
  } catch { /* */ }
  setTimeout(paintDrafts, 800);
}

export function v19Leave() {
  clearInterval(annTimer);
  if (annChan) { getSb().removeChannel(annChan).catch(() => {}); annChan = null; }
  qs('#ann-banner')?.remove();
}
export const currentAnnouncement = () => shownAnn;

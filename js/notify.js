// Центр уведомлений: упоминания, реакции, заявки в друзья + красивые плашки
import { state } from './api.js?v=26';
import { qs, esc, el, toast, avatarHTML, fmtListTime, beep } from './utils.js';
import { icon } from './icons.js';

const KEY = () => `msp_notices_${state.me?.id || 'x'}`;
let items = [];

function load() {
  try { items = JSON.parse(localStorage.getItem(KEY()) || '[]'); } catch { items = []; }
}
function save() {
  try { localStorage.setItem(KEY(), JSON.stringify(items.slice(0, 60))); } catch { /* */ }
}
export function initNotices() { load(); updateBadge(); }

export function unreadNotices() { return items.filter((n) => !n.read).length; }

function updateBadge() {
  const n = unreadNotices();
  const b = qs('#notif-badge');
  if (!b) return;
  b.textContent = n > 99 ? '99+' : String(n);
  b.classList.toggle('hidden', !n);
}

/** kind: mention | reaction | friend | info */
export function pushNotice({ kind = 'info', title, body = '', avatarUrl = null, name = '', chatId = null, action = null, silent = false }) {
  items.unshift({ id: Date.now() + Math.random(), kind, title, body, avatarUrl, name, chatId, action, at: new Date().toISOString(), read: false });
  save();
  updateBadge();
  const ico = { mention: '＠', reaction: '❤️', friend: '👋', info: '🔔' }[kind] || '🔔';
  const html = `<span class="toast-ic">${avatarUrl || name ? avatarHTML(avatarUrl, name, 'sm') : ico}</span>
    <span class="toast-tx"><b>${esc(title)}</b><span>${esc(body).slice(0, 120)}</span></span>`;
  toast(title, 5000, {
    html, kind: 'rich',
    onClick: () => handle(items[0]),
  });
  if (!silent) beep(kind === 'mention' ? 'mention' : undefined);
}

function handle(n) {
  if (!n) return;
  n.read = true; save(); updateBadge();
  if (n.chatId) import('./utils.js').then(({ bus }) => bus.emit('open-chat', n.chatId));
  else if (n.kind === 'friend') import('./friends.js').then((m) => m.openFriends(n.action === 'requests' ? 'requests' : 'friends'));
}

export function openNotifCenter() {
  items.forEach((n) => { n.read = true; });
  save(); updateBadge();
  const m = el(`
    <div class="modal-overlay">
      <div class="modal notif-modal">
        <div class="modal-head"><h3>Уведомления</h3>
          <button class="icon-btn" data-act="clear" title="Очистить">${icon('x', 18)}</button></div>
        <div class="notif-list"></div>
        <div class="modal-actions"><button class="btn ghost" data-act="close">Закрыть</button></div>
      </div>
    </div>`);
  const list = m.querySelector('.notif-list');
  const draw = () => {
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<div class="list-empty">Пока тихо ✨<br>Здесь появятся упоминания, реакции и заявки в друзья.</div>';
      return;
    }
    items.forEach((n) => {
      const ico = { mention: '＠', reaction: '❤️', friend: '👋', info: '🔔' }[n.kind] || '🔔';
      const row = el(`<div class="notif-row">
        <span class="notif-av">${n.avatarUrl || n.name ? avatarHTML(n.avatarUrl, n.name, 'md') : `<span class="notif-ico">${ico}</span>`}</span>
        <div class="notif-main"><div class="notif-title">${esc(n.title)}</div>
        <div class="notif-body">${esc(n.body || '')}</div></div>
        <span class="notif-time">${esc(fmtListTime(n.at))}</span></div>`);
      row.addEventListener('click', () => { m.remove(); handle(n); });
      list.appendChild(row);
    });
  };
  draw();
  document.querySelector('#modal-root').appendChild(m);
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-act=close]')) m.remove();
    if (e.target.closest('[data-act=clear]')) { items = []; save(); draw(); }
  });
}

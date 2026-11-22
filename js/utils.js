// Мелкие вспомогательные функции

// Простая шина событий: bus.on('msg', fn) / bus.emit('msg', data)
export const bus = {
  map: new Map(),
  on(ev, fn) {
    if (!this.map.has(ev)) this.map.set(ev, new Set());
    this.map.get(ev).add(fn);
    return () => this.map.get(ev)?.delete(fn);
  },
  emit(ev, ...args) {
    (this.map.get(ev) || []).forEach((fn) => {
      try { fn(...args); } catch (e) { console.error('bus handler', ev, e); }
    });
  },
};

export function qs(sel, root = document) { return root.querySelector(sel); }
export function qsa(sel, root = document) { return [...root.querySelectorAll(sel)]; }

// Экранирование HTML (защита от XSS в сообщениях и именах)
export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// Собрать DOM-элемент из HTML-строки
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function initials(name) {
  const s = String(name || '?').trim();
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase() || '?';
}

// Стабильный цвет аватара по нику
export function avatarColor(seed) {
  let h = 0;
  for (const ch of String(seed || '')) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${h} 55% 42%)`;
}

export function avatarHTML(url, name, cls = '', online = false) {
  const dot = online ? '<span class="online-dot"></span>' : '';
  if (url) {
    return `<span class="avatar ${cls}"><img src="${esc(url)}" alt="" loading="lazy">${dot}</span>`;
  }
  return `<span class="avatar ${cls}" style="background:${avatarColor(name)}">${esc(initials(name))}${dot}</span>`;
}

const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export function fmtTime(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Заголовок-разделитель дней: Сегодня / Вчера / 5 марта
export function fmtDaySep(iso) {
  const d = new Date(iso);
  const now = new Date();
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return 'Сегодня';
  if (sameDay(d, yest)) return 'Вчера';
  return `${d.getDate()} ${MONTHS_RU[d.getMonth()]}`;
}

export function sameDayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// "онлайн", "был(а) 5 мин назад"
export function relLastSeen(lastSeen, online) {
  if (online) return 'онлайн';
  if (!lastSeen) return 'не в сети';
  const diff = Date.now() - new Date(lastSeen).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'был(а) только что';
  if (min < 60) return `был(а) ${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `был(а) ${h} ч назад`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'был(а) вчера';
  if (d < 30) return `был(а) ${d} дн назад`;
  return 'был(а) давно';
}

// Короткое время для списка чатов
export function fmtListTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (sameDay(d, now)) return fmtTime(iso);
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (sameDay(d, yest)) return 'вчера';
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function fmtBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}

// 0:07 — длительность голосовых/видео
export function fmtDuration(totalSec) {
  const s = Math.max(0, Math.round(totalSec || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// Короткий звук уведомления (без файлов, через WebAudio)
let audioCtx = null;
export function ensureAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* нет звука */ }
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}
export function beep() {
  try {
    ensureAudio();
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const g = audioCtx.createGain();
    g.connect(audioCtx.destination);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    [[880, 0], [1175, 0.12]].forEach(([freq, dt]) => {
      const o = audioCtx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq;
      o.connect(g);
      o.start(t + dt);
      o.stop(t + dt + 0.18);
    });
  } catch { /* тишина */ }
}

export function toast(msg, ms = 2800) {
  const root = qs('#toast-root');
  const t = el(`<div class="toast">${esc(msg)}</div>`);
  root.appendChild(t);
  setTimeout(() => { t.classList.add('hide'); setTimeout(() => t.remove(), 350); }, ms);
}

// Красивый confirm вместо alert()
export function confirmDialog({ title, text, okLabel = 'Удалить', danger = true }) {
  return new Promise((resolve) => {
    const root = qs('#modal-root');
    const m = el(`
      <div class="modal-overlay">
        <div class="modal confirm-modal">
          <h3>${esc(title)}</h3>
          ${text ? `<p class="modal-text">${esc(text)}</p>` : ''}
          <div class="modal-actions">
            <button class="btn ghost" data-act="no">Отмена</button>
            <button class="btn ${danger ? 'danger' : 'primary'}" data-act="yes">${esc(okLabel)}</button>
          </div>
        </div>
      </div>`);
    root.appendChild(m);
    const close = (v) => { m.remove(); resolve(v); };
    m.addEventListener('click', (e) => {
      if (e.target === m) close(false);
      if (e.target.closest('[data-act="no"]')) close(false);
      if (e.target.closest('[data-act="yes"]')) close(true);
    });
    const escHandler = (e) => { if (e.key === 'Escape') { document.removeEventListener('keydown', escHandler); close(false); } };
    document.addEventListener('keydown', escHandler);
  });
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function uuid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

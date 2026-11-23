// ============================================================
//  MSPgram v22: точка подключения
//  • настоящий Web Push (js/webpush.js + Edge Function send-push)
//  • кнопка «скрыть / показать» левую панель серверов (удобно на телефоне)
//  • звук разблокируется первым касанием (правило браузеров) — и для сообщений, и для звонков
//  • открытие чата из уведомления даже при холодном старте приложения
// ============================================================
import { qs, el, ensureAudio } from './utils.js';
import { icon } from './icons.js';

export const VERSION = 'v22';
const RAIL_KEY = 'msp_rail_hidden';
let booted = false;

// ---------- левая панель серверов: скрыть / вернуть ----------
function railHidden() {
  try { return localStorage.getItem(RAIL_KEY) === '1'; } catch { return false; }
}

function applyRail(hidden) {
  document.body.classList.toggle('rail-hidden', hidden);
  const btn = qs('#rail-toggle');
  if (btn) {
    btn.classList.toggle('is-off', hidden);
    btn.setAttribute('aria-pressed', String(hidden));
    btn.title = hidden ? 'Показать панель серверов' : 'Скрыть панель серверов';
  }
}

function initRailToggle() {
  const head = qs('.sidebar-head');
  if (!head || qs('#rail-toggle')) return;
  const btn = el(`<button id="rail-toggle" class="icon-btn has-badge" type="button" aria-label="Панель серверов">
    ${icon('panel', 20)}<span class="rail-dot hidden"></span></button>`);
  head.insertBefore(btn, head.firstChild);
  btn.addEventListener('click', () => {
    const next = !document.body.classList.contains('rail-hidden');
    try { localStorage.setItem(RAIL_KEY, next ? '1' : '0'); } catch { /* */ }
    applyRail(next);
  });
  applyRail(railHidden());

  // точка на кнопке: в скрытой панели есть сервер с непрочитанными
  const rail = qs('#server-rail');
  if (rail) {
    const dot = qs('.rail-dot', btn);
    const upd = () => dot.classList.toggle('hidden', !rail.querySelector('.rail-badge'));
    new MutationObserver(upd).observe(rail, { childList: true, subtree: true });
    upd();
  }
}

// ---------- звук: разблокировка первым касанием ----------
function unlockAudioOnFirstTap() {
  const evs = ['pointerup', 'touchend', 'click', 'keydown'];
  const done = () => {
    ensureAudio();
    evs.forEach((e) => window.removeEventListener(e, done, true));
  };
  evs.forEach((e) => window.addEventListener(e, done, { capture: true, passive: true }));
}

// ---------- открыть чат из уведомления (?chat=<id>) ----------
const PENDING = 'msp_open_chat';
function capturePendingChat() {
  try {
    const p = new URLSearchParams(location.search);
    const id = p.get('chat');
    if (!id) return;
    sessionStorage.setItem(PENDING, id);
    p.delete('chat');
    const q = p.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
  } catch { /* */ }
}
/** Вызывается после загрузки чатов: вернуть id чата из уведомления (один раз) */
export function takePendingChat() {
  try {
    const id = sessionStorage.getItem(PENDING);
    sessionStorage.removeItem(PENDING);
    return id || null;
  } catch { return null; }
}

export function v22Boot() {
  window.MSP_VERSION = VERSION;
  const v = document.querySelector('#app-version');
  if (v) v.textContent = VERSION;
  if (booted) return;
  booted = true;
  capturePendingChat();
  try { initRailToggle(); } catch (e) { console.warn('rail toggle:', e); }
  unlockAudioOnFirstTap();
}

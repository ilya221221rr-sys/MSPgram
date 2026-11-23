// ============================================================
//  MSPgram v21: рингтоны звонка
//   • «in»  — мелодия, когда тебе звонят (+ вибрация + системное уведомление)
//   • «out» — гудки, когда ты звонишь (пока собеседник не ответил)
//  Звук генерируется в коде (WAV в памяти), файлов не нужно.
//  Играет через <audio loop> — это работает и при свёрнутом приложении.
// ============================================================
import { getPrefs, ensureAudio } from './utils.js';
import { showSystemNotification, closeSystemNotification } from './push.js';

const RATE = 22050;
const urls = {};
let player = null;       // активный <audio>
let mode = null;         // 'in' | 'out' | null
let vibTimer = null;
let watchTimer = null;
let fallbackTimer = null;
let unlocked = false;

function makeWav(seconds, fn) {
  const n = Math.floor(RATE * seconds);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, fn(i / RATE)));
    v.setInt16(44 + i * 2, s * 32767, true);
  }
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

// мягкий «колокольчик»: основной тон + обертоны, быстрая атака, плавное затухание
function bell(t, f, start, dur, vol = 1) {
  const x = t - start;
  if (x < 0 || x > dur) return 0;
  const env = Math.min(1, x / 0.012) * Math.exp(-x * (3.2 / dur) * 1.6);
  return env * vol * (
    Math.sin(2 * Math.PI * f * x) * 0.62 +
    Math.sin(2 * Math.PI * f * 2 * x) * 0.22 +
    Math.sin(2 * Math.PI * f * 3 * x) * 0.08
  );
}

function getUrl(kind) {
  if (urls[kind]) return urls[kind];
  if (kind === 'in') {
    // 3.6 сек: мелодичная фраза два раза + пауза
    const E5 = 659.25, G5 = 783.99, A5 = 880, C6 = 1046.5, D6 = 1174.66;
    const phrase = [[E5, 0, .22], [G5, .2, .22], [A5, .4, .22], [C6, .6, .5], [A5, .95, .22], [G5, 1.15, .22], [D6, 1.35, .6]];
    urls.in = makeWav(3.6, (t) => {
      let s = 0;
      for (const [f, st, d] of phrase) { s += bell(t, f, st, d); s += bell(t, f, st + 1.7, d, 0.95); }
      return s * 1.4;
    });
  } else {
    // гудки «ту-у…» 425 Гц: 1 сек звук, 3 сек тишина
    urls.out = makeWav(4, (t) => {
      if (t > 1.0) return 0;
      const env = Math.min(1, t / 0.03) * Math.min(1, (1.0 - t) / 0.05);
      return Math.sin(2 * Math.PI * 425 * t) * 0.32 * env;
    });
  }
  return urls[kind];
}

/** Разблокировка звука первым касанием (требование браузеров/iOS).
 *  Chrome на Android не считает touchstart/pointerdown «жестом» — слушаем pointerup/touchend/click
 *  и снимаем слушатели только после успешного разблокирования. */
const UNLOCK_EVENTS = ['pointerup', 'touchend', 'keydown', 'click'];
function removeUnlockListeners() {
  UNLOCK_EVENTS.forEach((ev) => window.removeEventListener(ev, unlock, true));
}
function unlock() {
  if (unlocked) return;
  unlocked = true;
  ensureAudio();
  ['in', 'out'].forEach((k) => {
    try {
      const a = new Audio(getUrl(k));
      a.muted = true;
      const p = a.play();
      if (p && p.then) p.then(() => { a.pause(); removeUnlockListeners(); }).catch(() => { unlocked = false; });
    } catch { /* */ }
  });
}
UNLOCK_EVENTS.forEach((ev) => {
  window.addEventListener(ev, unlock, { passive: true, capture: true });
});

function vibrate(on) {
  clearInterval(vibTimer);
  vibTimer = null;
  try { navigator.vibrate && navigator.vibrate(0); } catch { /* */ }
  if (!on) return;
  const buzz = () => { try { navigator.vibrate && navigator.vibrate([600, 300, 600]); } catch { /* */ } };
  buzz();
  vibTimer = setInterval(buzz, 3600);
}

// запасной вариант, если <audio> заблокирован: короткие сигналы через WebAudio
function fallbackBeeps(kind) {
  import('./utils.js').then(({ beep }) => {
    if (mode !== kind) return;
    const tick = () => beep('mention');
    tick();
    fallbackTimer = setInterval(tick, kind === 'in' ? 1800 : 4000);
  }).catch(() => {});
}

export function startRingtone(kind, info = {}) {
  stopRingtone(false);
  mode = kind;
  const prefs = getPrefs();
  const muted = prefs.ringtone === false || prefs._dnd;

  if (!muted) {
    try {
      player = new Audio(getUrl(kind));
      player.loop = true;
      player.volume = kind === 'in' ? 1 : 0.8;
      const p = player.play();
      if (p && p.catch) p.catch(() => { if (mode === kind && !fallbackTimer) fallbackBeeps(kind); });
    } catch { fallbackBeeps(kind); }
  }

  if (kind === 'in') {
    vibrate(true);
    if (document.visibilityState !== 'visible') {
      showSystemNotification({
        title: info.title || 'Входящий звонок',
        body: info.body || 'MSPgram',
        tag: 'msp-call',
        requireInteraction: true,
        renotify: true,
        vibrate: [600, 300, 600, 300, 600],
      });
    }
    // сам останавливаемся, когда окно входящего пропало (принято/отклонено/отменено)
    clearInterval(watchTimer);
    watchTimer = setInterval(() => {
      if (!document.querySelector('#ring-overlay')) stopRingtone();
    }, 400);
  }
}

export function stopRingtone(closeNotice = true) {
  const had = mode;
  mode = null;
  clearInterval(watchTimer); watchTimer = null;
  clearInterval(fallbackTimer); fallbackTimer = null;
  if (player) {
    try { player.pause(); player.currentTime = 0; } catch { /* */ }
    player = null;
  }
  vibrate(false);
  if (closeNotice && had === 'in') closeSystemNotification('msp-call');
}

// предпросмотр в настройках: проиграть мелодию один раз
export function previewRingtone() {
  try {
    const a = new Audio(getUrl('in'));
    a.volume = 1;
    a.play().catch(() => {});
    setTimeout(() => { try { a.pause(); } catch { /* */ } }, 3400);
  } catch { /* */ }
}

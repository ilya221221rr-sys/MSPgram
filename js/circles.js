// ============================================================
//  Видеокружки как в Telegram (v20)
//  • запись: круглое превью, кольцо-таймер, переворот камеры, до 60 сек
//  • «не лагает»: 480×480, 24 к/с, ~0.6 Мбит/с, кодек VP8 (самый лёгкий) / H.264 на Safari
//  • воспроизведение: круг с кольцом прогресса, тап — пуск/пауза со звуком
//  Хранится как обычное видео-сообщение, имя файла начинается с «circle-» — миграция БД не нужна.
// ============================================================
import { el, toast, fmtDuration, esc } from './utils.js';
import { icon } from './icons.js';

const MIMES = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];
const CAP_MS = 60 * 1000;
const R = 46; const CIRC = 2 * Math.PI * R;

const pick = () => {
  if (!window.MediaRecorder) return '';
  for (const t of MIMES) { try { if (MediaRecorder.isTypeSupported(t)) return t; } catch { /* */ } }
  return '';
};

export function canRecordCircle() {
  return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder && pick());
}

export const isCircle = (m) => m.attachment_type === 'video' && /^circle-/i.test(m.attachment_name || '');

const ringSvg = (cls) => `<svg class="${cls}" viewBox="0 0 100 100" aria-hidden="true"><circle class="rg-bg" cx="50" cy="50" r="${R}"/><circle class="rg-fg" cx="50" cy="50" r="${R}" stroke-dasharray="${CIRC.toFixed(2)}" stroke-dashoffset="${CIRC.toFixed(2)}"/></svg>`;

// ---------- запись ----------
export function recordCircle() {
  return new Promise(async (resolve) => {
    let facing = 'user';
    let stream = null;
    const open = async () => navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: { facingMode: facing, width: { ideal: 480 }, height: { ideal: 480 }, aspectRatio: { ideal: 1 }, frameRate: { ideal: 24, max: 30 } },
    });
    try { stream = await open(); } catch {
      toast('Нет доступа к камере или микрофону. Разреши доступ в настройках браузера.');
      resolve(null); return;
    }
    const mime = pick();

    const o = el(`
      <div class="circ-overlay">
        <div class="circ-top"><span class="circ-dot"></span><span class="circ-time">0:00</span></div>
        <div class="circ-stage">
          <video class="circ-preview mirror" autoplay muted playsinline></video>
          ${ringSvg('circ-ring')}
        </div>
        <div class="circ-hint">Нажми красную кнопку, чтобы записать кружок (до 60 сек)</div>
        <div class="circ-actions">
          <button class="circ-btn" data-act="cancel" title="Отмена">${icon('x', 22)}</button>
          <button class="circ-rec" data-act="rec" title="Записать"><i></i></button>
          <button class="circ-btn" data-act="flip" title="Перевернуть камеру">${icon('flip', 22)}</button>
        </div>
      </div>`);
    document.body.appendChild(o);
    const pv = o.querySelector('.circ-preview');
    const fg = o.querySelector('.rg-fg');
    const timeEl = o.querySelector('.circ-time');
    const hint = o.querySelector('.circ-hint');
    const recBtn = o.querySelector('.circ-rec');
    pv.srcObject = stream;

    let rec = null; let chunks = []; let t0 = 0; let tick = null;
    let cancelled = false; let finished = false; let recording = false; let capTimer = null;

    const stopTracks = () => { stream?.getTracks().forEach((t) => t.stop()); };
    const cleanup = () => { clearInterval(tick); clearTimeout(capTimer); stopTracks(); pv.srcObject = null; o.remove(); };
    const finish = () => {
      if (finished) return; finished = true;
      const dur = recording ? Date.now() - t0 : 0;
      if (cancelled || dur < 700) { cleanup(); if (!cancelled && dur) toast('Слишком короткий кружок'); resolve(null); return; }
      const blob = new Blob(chunks, { type: rec.mimeType || mime || 'video/webm' });
      cleanup();
      resolve({ blob, durationMs: dur });
    };

    const start = () => {
      try {
        rec = new MediaRecorder(stream, {
          ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 600000, audioBitsPerSecond: 64000,
        });
      } catch { toast('Запись видео не поддерживается этим браузером.'); cancelled = true; finish(); return; }
      chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = finish;
      recording = true; t0 = Date.now();
      try { rec.start(500); } catch { cancelled = true; finish(); return; }
      o.classList.add('live');
      recBtn.title = 'Остановить и отправить';
      o.querySelector('[data-act=flip]').style.visibility = 'hidden';
      hint.textContent = 'Идёт запись… нажми ■, чтобы отправить';
      tick = setInterval(() => {
        const el2 = Date.now() - t0;
        timeEl.textContent = fmtDuration(el2 / 1000);
        fg.style.strokeDashoffset = String(CIRC * (1 - Math.min(1, el2 / CAP_MS)));
      }, 100);
      capTimer = setTimeout(() => { toast('Максимум — 60 секунд'); try { rec.stop(); } catch { finish(); } }, CAP_MS);
    };

    o.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const act = b.dataset.act;
      if (act === 'cancel') {
        cancelled = true;
        if (recording && rec && rec.state !== 'inactive') { try { rec.stop(); } catch { finish(); } } else finish();
      } else if (act === 'rec') {
        if (!recording) start();
        else { try { rec.stop(); } catch { finish(); } }
      } else if (act === 'flip' && !recording) {
        facing = facing === 'user' ? 'environment' : 'user';
        const old = stream;
        try {
          stream = await open();
          old.getTracks().forEach((t) => t.stop());
          pv.srcObject = stream;
          pv.classList.toggle('mirror', facing === 'user');
        } catch { facing = facing === 'user' ? 'environment' : 'user'; toast('Не удалось переключить камеру'); }
      }
    });
    document.addEventListener('keydown', function esc2(ev) {
      if (!document.body.contains(o)) { document.removeEventListener('keydown', esc2); return; }
      if (ev.key === 'Escape') { cancelled = true; if (recording && rec?.state !== 'inactive') { try { rec.stop(); } catch { finish(); } } else finish(); }
    });
  });
}

// ---------- сообщение-кружок в ленте ----------
export function circleHTML(m) {
  const dur = Math.round((m.duration_ms || 0) / 1000);
  return `
    <div class="vcircle" data-dur="${dur}">
      <video src="${esc(m.attachment_url)}#t=0.1" preload="metadata" playsinline webkit-playsinline></video>
      ${ringSvg('vc-ring')}
      <span class="vc-badge">${fmtDuration(dur)}</span>
      <span class="vc-play">▶</span>
    </div>`;
}

let current = null;
function stopCurrent(except) {
  if (current && current !== except) {
    const v = current.querySelector('video');
    try { v.pause(); } catch { /* */ }
    current.classList.remove('playing');
  }
}

/** Один раз: клики/прогресс кружков в ленте (делегирование — работает после любого перерендера) */
export function initCircles(box) {
  if (!box || box.__circles) return;
  box.__circles = true;
  box.addEventListener('click', (e) => {
    const c = e.target.closest('.vcircle'); if (!c) return;
    const v = c.querySelector('video');
    if (v.paused) {
      stopCurrent(c);
      current = c; v.muted = false; v.currentTime = v.ended ? 0 : v.currentTime;
      v.play().then(() => c.classList.add('playing')).catch(() => toast('Не удалось воспроизвести'));
    } else { v.pause(); c.classList.remove('playing'); }
  });
  box.addEventListener('timeupdate', (e) => {
    const v = e.target; const c = v.closest?.('.vcircle'); if (!c) return;
    const total = v.duration && isFinite(v.duration) ? v.duration : Number(c.dataset.dur) || 1;
    const fg = c.querySelector('.rg-fg');
    if (fg) fg.style.strokeDashoffset = String(CIRC * (1 - Math.min(1, v.currentTime / total)));
    c.querySelector('.vc-badge').textContent = fmtDuration(Math.max(0, total - v.currentTime));
  }, true);
  box.addEventListener('ended', (e) => {
    const v = e.target; const c = v.closest?.('.vcircle'); if (!c) return;
    c.classList.remove('playing');
    const fg = c.querySelector('.rg-fg'); if (fg) fg.style.strokeDashoffset = String(CIRC);
    c.querySelector('.vc-badge').textContent = fmtDuration(Number(c.dataset.dur) || 0);
    current = null;
  }, true);
}

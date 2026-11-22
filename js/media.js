// Запись голосовых и видеосообщений (MediaRecorder + камера/микрофон)
import { el, toast, fmtDuration } from './utils.js';

const VOICE_MIMES = [
  'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus',
];
const VIDEO_MIMES = [
  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4',
];

function pickMime(list) {
  if (!window.MediaRecorder) return '';
  for (const t of list) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch { /* дальше */ }
  }
  return '';
}

export function canRecordVoice() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    && !!window.MediaRecorder && !!pickMime(VOICE_MIMES);
}
export function canRecordVideo() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    && !!window.MediaRecorder && !!pickMime(VIDEO_MIMES);
}

export function extOf(mime) {
  const m = String(mime || '');
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('ogg')) return 'ogg';
  return 'webm';
}

const VOICE_CAP_MS = 5 * 60 * 1000;   // голосовое: до 5 минут
const VIDEO_CAP_MS = 60 * 1000;       // видеосообщение: до 60 секунд

// ---------- голосовое ----------
export function recordVoice() {
  return new Promise(async (resolve) => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast('Нет доступа к микрофону. Разреши доступ в настройках браузера.');
      resolve(null);
      return;
    }

    const mime = pickMime(VOICE_MIMES);
    let rec;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      toast('Запись не поддерживается этим браузером.');
      stream.getTracks().forEach((t) => t.stop());
      resolve(null);
      return;
    }

    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    const startedAt = Date.now();
    let cancelled = false;
    let finished = false;

    const wave = Array.from({ length: 14 }, (_, i) =>
      `<i style="animation-delay:${(i * 0.09).toFixed(2)}s"></i>`).join('');

    const o = el(`
      <div class="rec-overlay">
        <div class="rec-card">
          <div class="rec-title"><span class="rec-dot"></span>Голосовое сообщение</div>
          <div class="rec-timer">0:00</div>
          <div class="rec-wave">${wave}</div>
          <div class="rec-hint">Нажми «Готово», чтобы отправить</div>
          <div class="rec-actions">
            <button class="btn ghost" data-act="cancel">Отмена</button>
            <button class="btn primary" data-act="stop">Готово</button>
          </div>
        </div>
      </div>`);
    document.body.appendChild(o);

    const timerEl = o.querySelector('.rec-timer');
    const tick = setInterval(() => {
      timerEl.textContent = fmtDuration((Date.now() - startedAt) / 1000);
    }, 250);

    const cleanup = () => {
      clearInterval(tick);
      stream.getTracks().forEach((t) => t.stop());
      o.remove();
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      const dur = Date.now() - startedAt;
      if (cancelled || dur < 700) {
        cleanup();
        resolve(null);
        return;
      }
      const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
      cleanup();
      resolve({ blob, durationMs: dur });
    };

    o.addEventListener('click', (e) => {
      if (e.target.closest('[data-act=cancel]')) {
        cancelled = true;
        try { rec.stop(); } catch { finish(); }
      }
      if (e.target.closest('[data-act=stop]')) {
        try { rec.stop(); } catch { finish(); }
      }
    });

    rec.onstop = finish;
    try { rec.start(200); } catch { finish(); return; }

    // авто-стоп на максимуме
    setTimeout(() => {
      if (rec.state === 'recording') {
        toast('Максимум — 5 минут, запись остановлена');
        try { rec.stop(); } catch { /* */ }
      }
    }, VOICE_CAP_MS);
  });
}

// ---------- видеосообщение (камера) ----------
export function recordVideo() {
  return new Promise(async (resolve) => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 1280 } },
      });
    } catch {
      toast('Нет доступа к камере или микрофону. Разреши доступ в настройках браузера.');
      resolve(null);
      return;
    }

    const mime = pickMime(VIDEO_MIMES);
    let rec;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch {
      toast('Запись видео не поддерживается этим браузером.');
      stream.getTracks().forEach((t) => t.stop());
      resolve(null);
      return;
    }

    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    const o = el(`
      <div class="rec-overlay">
        <div class="rec-card video">
          <div class="rec-title"><span class="rec-dot"></span>Видеосообщение</div>
          <video class="rec-preview" autoplay muted playsinline></video>
          <div class="rec-timer">0:00</div>
          <div class="rec-actions">
            <button class="btn ghost" data-act="cancel">Отмена</button>
            <button class="btn primary" data-act="toggle">Записать</button>
          </div>
        </div>
      </div>`);
    document.body.appendChild(o);

    const preview = o.querySelector('.rec-preview');
    const btn = o.querySelector('[data-act=toggle]');
    const timerEl = o.querySelector('.rec-timer');
    const dot = o.querySelector('.rec-dot');
    preview.srcObject = stream;

    let recording = false;
    let cancelled = false;
    let finished = false;
    let startedAt = 0;
    let tick = null;

    const cleanup = () => {
      if (tick) clearInterval(tick);
      stream.getTracks().forEach((t) => t.stop());
      preview.srcObject = null;
      o.remove();
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      const dur = recording ? Date.now() - startedAt : 0;
      if (cancelled || dur < 700) {
        cleanup();
        resolve(null);
        return;
      }
      const blob = new Blob(chunks, { type: rec.mimeType || mime || 'video/webm' });
      cleanup();
      resolve({ blob, durationMs: dur });
    };

    o.addEventListener('click', (e) => {
      if (e.target.closest('[data-act=cancel]')) {
        cancelled = true;
        if (recording) { try { rec.stop(); } catch { finish(); } }
        else finish();
        return;
      }
      if (e.target.closest('[data-act=toggle]')) {
        if (!recording) {
          recording = true;
          startedAt = Date.now();
          btn.textContent = 'Стоп';
          btn.classList.remove('primary');
          btn.classList.add('danger');
          dot.classList.add('live');
          tick = setInterval(() => {
            timerEl.textContent = fmtDuration((Date.now() - startedAt) / 1000);
          }, 250);
          try { rec.start(200); } catch { finish(); }
        } else {
          try { rec.stop(); } catch { finish(); }
        }
      }
    });

    rec.onstop = finish;

    // авто-стоп через 60 секунд
    setTimeout(() => {
      if (recording && rec.state === 'recording') {
        toast('Максимум — 60 секунд');
        try { rec.stop(); } catch { /* */ }
      }
    }, VIDEO_CAP_MS);
  });
}

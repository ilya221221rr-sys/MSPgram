// ============================================================
//  Диагностика ИИ (v19): самотест, журнал ошибок, пресеты.
//  Открывается из Настройки → ИИ и из Админ-панели → «ИИ».
// ============================================================
import { getSb } from './api.js?v=26';
import { qs, esc, el, toast, getPrefs, setPrefs } from './utils.js';
import {
  getAiLog, clearAiLog, runAiTest, buildReport, normalizeAiUrl, maskKey, liveFreeModels, OR_URL,
} from './ai-core.js';

const rel = (iso) => new Date(iso).toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const AI_PRESETS = {
  openrouter: { label: 'OpenRouter Free', aiUrl: OR_URL, aiModel: 'openrouter/free' },
  pollinations: { label: 'Pollinations (без ключа)', aiUrl: '', aiModel: '', clearKey: true },
};

/** Рисует панель диагностики внутрь host. admin=true добавляет ошибки всех пользователей */
export function renderAiDiag(host, { admin = false } = {}) {
  let steps = [];
  const draw = () => {
    const p = getPrefs(); const n = normalizeAiUrl(p.aiUrl);
    const log = getAiLog();
    const fails = log.filter((x) => !x.ok).length;
    host.innerHTML = `
      <div class="diag">
        <div class="diag-card">
          <div class="diag-row"><span>Провайдер</span><b>${esc(n.provider)}</b></div>
          <div class="diag-row"><span>Адрес</span><b class="mono">${esc(n.url)}</b></div>
          <div class="diag-row"><span>Модель</span><b class="mono">${esc(p.aiModel || '(авто)')}</b></div>
          <div class="diag-row"><span>Ключ</span><b class="mono">${esc(maskKey((p.aiKey || '').trim()))}</b></div>
          ${n.note ? `<div class="diag-note">⚙ ${esc(n.note)}</div>` : ''}
        </div>
        <div class="diag-actions">
          <button class="btn primary sm" data-d="test">▶ Запустить проверку</button>
          <button class="btn ghost sm" data-d="fix-or">⚡ Настроить OpenRouter Free</button>
          <button class="btn ghost sm" data-d="models">↻ Обновить список моделей</button>
          <button class="btn ghost sm" data-d="copy">⧉ Копировать отчёт</button>
        </div>
        <div class="diag-steps" id="diag-steps">${steps.map(stepHTML).join('')}</div>
        <div class="settings-sec">Журнал запросов на этом устройстве ${fails ? `<span class="adm-badge banned">${fails} ошибок</span>` : ''}</div>
        <div class="diag-log">${log.length ? log.slice(0, 25).map(logHTML).join('') : '<div class="adm-empty">Пока пусто — журнал заполнится, когда ты воспользуешься ИИ.</div>'}</div>
        ${log.length ? '<button class="btn ghost sm" data-d="clear">Очистить журнал</button>' : ''}
        ${admin ? '<div class="settings-sec">Ошибки ИИ у всех пользователей</div><div id="diag-remote" class="diag-log"><div class="adm-empty">Загружаю…</div></div>' : ''}
      </div>`;
    if (admin) loadRemote();
  };
  const stepHTML = (s) => `<div class="diag-step ${s.ok ? 'ok' : 'bad'}"><span class="diag-dot">${s.ok ? '✓' : '✕'}</span><div><b>${esc(s.title)}</b><pre>${esc(s.detail)}</pre></div></div>`;
  const logHTML = (e) => `<details class="diag-item ${e.ok ? 'ok' : 'bad'}"><summary><span class="diag-dot">${e.ok ? '✓' : '✕'}</span>
      <span class="diag-t">${esc(rel(e.t))}</span><span class="mono diag-m">${esc(e.model)}</span><span class="diag-s">${e.status || '—'}</span><span class="diag-ms">${e.ms} мс</span></summary>
      <div class="diag-more">${e.error ? `<div><b>Ошибка:</b> ${esc(e.error)}</div>` : ''}${e.hint ? `<div class="diag-hint">💡 ${esc(e.hint)}</div>` : ''}
      <div class="mono small">${esc(e.url)} · попытка ${e.attempt || 1}</div>${e.body ? `<pre>${esc(e.body)}</pre>` : ''}</div></details>`;

  async function loadRemote() {
    const box = qs('#diag-remote', host); if (!box) return;
    const { data, error } = await getSb().from('ai_errors').select('*, profiles(nickname, display_name)').order('created_at', { ascending: false }).limit(40);
    if (error) { box.innerHTML = `<div class="adm-empty">Нет данных: ${esc(error.message)}<br>Примени supabase/migration-10-v19.sql</div>`; return; }
    if (!data.length) { box.innerHTML = '<div class="adm-empty">Ошибок нет 🎉</div>'; return; }
    box.innerHTML = data.map((r) => `<details class="diag-item bad"><summary><span class="diag-dot">✕</span>
      <span class="diag-t">${esc(rel(r.created_at))}</span><span class="diag-m">@${esc(r.profiles?.nickname || '?')}</span><span class="mono diag-m">${esc(r.model)}</span><span class="diag-s">${r.status || '—'}</span></summary>
      <div class="diag-more"><div><b>Ошибка:</b> ${esc(r.message)}</div>${r.hint ? `<div class="diag-hint">💡 ${esc(r.hint)}</div>` : ''}<div class="mono small">${esc(r.url)}</div>${r.details ? `<pre>${esc(r.details)}</pre>` : ''}</div></details>`).join('')
      + '<button class="btn ghost sm" data-d="clear-remote">Очистить серверный журнал</button>';
  }

  host.onclick = async (e) => {
    const b = e.target.closest('[data-d]'); if (!b) return;
    const act = b.dataset.d;
    if (act === 'test') {
      b.disabled = true; b.textContent = '⏳ Проверяю…'; steps = []; draw();
      const box = qs('#diag-steps', host);
      await runAiTest((s) => { steps.push(s); box.insertAdjacentHTML('beforeend', stepHTML(s)); });
      const keepSteps = steps; draw(); steps = keepSteps; qs('#diag-steps', host).innerHTML = steps.map(stepHTML).join('');
    } else if (act === 'fix-or') {
      const cur = getPrefs();
      setPrefs({ aiUrl: OR_URL, aiModel: 'openrouter/free', aiKey: cur.aiKey || '' });
      toast(cur.aiKey ? 'Готово: OpenRouter Free ✓' : 'Адрес и модель выставлены. Осталось вставить ключ sk-or-v1-… (Настройки → ИИ)', 5000);
      draw();
    } else if (act === 'models') {
      const list = await liveFreeModels(true);
      toast(`Бесплатных моделей сейчас: ${list.length}`);
    } else if (act === 'copy') {
      navigator.clipboard?.writeText(buildReport(steps)).then(() => toast('Отчёт скопирован ✓'), () => toast('Не удалось скопировать'));
    } else if (act === 'clear') { clearAiLog(); draw(); }
    else if (act === 'clear-remote') {
      const { error } = await getSb().from('ai_errors').delete().gte('created_at', '2000-01-01');
      if (error) toast('Ошибка: ' + error.message, 4000); else loadRemote();
    }
  };
  draw();
}

export function openAiDiag() {
  if (qs('#ai-diag-modal')) return;
  const m = el(`<div class="modal-overlay" id="ai-diag-modal"><div class="modal diag-modal">
    <h3>🩺 Диагностика ИИ</h3><div id="diag-host"></div>
    <div class="modal-actions"><button class="btn primary" data-act="close">Закрыть</button></div></div></div>`);
  qs('#modal-root').appendChild(m);
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-act=close]')) m.remove(); });
  renderAiDiag(qs('#diag-host', m));
}

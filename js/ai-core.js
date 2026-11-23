// ============================================================
//  MSP AI — ядро (v19): запросы к ИИ, авто-исправление адреса,
//  цепочка запасных моделей, ЖУРНАЛ ОШИБОК и самотест.
//  Именно здесь решается проблема «OpenRouter Free → 404».
// ============================================================
import { getSb, state } from './api.js';
import { getPrefs } from './utils.js';

export const DEFAULT_URL = 'https://text.pollinations.ai/openai';
export const DEFAULT_MODEL = 'openai-fast';
export const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const OR_MODELS_URL = 'https://openrouter.ai/api/v1/models';
// запасной список, если живой список моделей получить не удалось
const OR_STATIC = [
  'openrouter/free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'google/gemma-4-26b-a4b-it:free',
  'inclusionai/ling-3.2-flash:free',
];

const LOG_KEY = 'msp_ai_log';
const OK_KEY = 'msp_ai_ok_model';
const LIST_KEY = 'msp_or_free_list';

// ---------- адрес ----------
/** Приводит адрес к рабочему виду и говорит, что было исправлено */
export function normalizeAiUrl(raw) {
  let u = (raw || '').trim();
  if (!u) return { url: DEFAULT_URL, provider: 'pollinations', fixed: false, note: '' };
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  let parsed;
  try { parsed = new URL(u); } catch { return { url: u, provider: 'custom', fixed: false, invalid: true, note: 'Адрес не похож на ссылку' }; }
  if (/(^|\.)openrouter\.ai$/i.test(parsed.hostname)) {
    const fixed = parsed.href.replace(/\/+$/, '') !== OR_URL;
    return { url: OR_URL, provider: 'openrouter', fixed, note: fixed ? `Адрес автоматически исправлен на ${OR_URL}` : '' };
  }
  let path = parsed.pathname.replace(/\/+$/, '');
  const before = parsed.href;
  if (!/\/(chat\/completions|completions|openai|generate)$/.test(path)) {
    if (/\/v1$/.test(path)) path += '/chat/completions';
    else if (path === '') path = '/v1/chat/completions';
  }
  parsed.pathname = path;
  const provider = /pollinations/i.test(parsed.hostname) ? 'pollinations' : 'custom';
  return { url: parsed.href, provider, fixed: parsed.href !== before, note: parsed.href !== before ? `Адрес дополнен до ${parsed.href}` : '' };
}

// ---------- журнал ----------
export function getAiLog() { try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; } }
export function clearAiLog() { localStorage.removeItem(LOG_KEY); }
let lastRemote = 0;
function pushLog(e) {
  const arr = getAiLog();
  arr.unshift(e);
  try { localStorage.setItem(LOG_KEY, JSON.stringify(arr.slice(0, 60))); } catch { /* квота */ }
  if (!e.ok && state.me && Date.now() - lastRemote > 8000) {
    lastRemote = Date.now();
    try {
      getSb()?.from('ai_errors').insert({
        user_id: state.me.id, url: e.url, model: e.model, status: e.status || null,
        message: String(e.error || '').slice(0, 400), hint: String(e.hint || '').slice(0, 600),
        details: String(e.body || '').slice(0, 1500),
      }).then(() => {}, () => {});
    } catch { /* таблицы может ещё не быть */ }
  }
}
export const maskKey = (k) => (!k ? '— не указан —' : k.length <= 10 ? '••••' : `${k.slice(0, 6)}…${k.slice(-4)} (${k.length} симв.)`);

// ---------- подсказки: ПОЧЕМУ ошибка ----------
export function explain({ status, message = '', provider, model, networkFail, urlNote }) {
  const m = String(message);
  if (networkFail) {
    return provider === 'openrouter'
      ? 'Браузер не смог связаться с openrouter.ai. Возможные причины: нет интернета, сайт заблокирован провайдером (в России часто нужен VPN), расширение-блокировщик (AdBlock) режет запрос.'
      : 'Нет связи с ИИ-сервером: проверь интернет, адрес API и что сервер разрешает запросы из браузера (CORS).';
  }
  if (status === 404) {
    if (/data policy|privacy|guardrail|publication/i.test(m)) {
      return 'OpenRouter не нашёл бесплатных эндпоинтов под твои настройки приватности. Открой openrouter.ai/settings/privacy и включи «Enable free endpoints that may train on inputs / publish prompts». Без этого все :free-модели отвечают 404.';
    }
    if (/no endpoints found/i.test(m)) {
      return `Модель «${model}» удалена или временно недоступна (бесплатные модели часто убирают). MSPgram сам пробует запасные; можно выбрать «openrouter/free» — это авто-подбор живой бесплатной модели.`;
    }
    if (/^not found$/i.test(m.trim()) || !m) {
      return provider === 'openrouter' ? `Адрес API неверный (сервер ответил «Not Found»). Для OpenRouter адрес должен быть ${OR_URL}.` : 'Адрес API неверный (сервер ответил «Not Found»). Проверь адрес в Настройки → ИИ: обычно он заканчивается на /v1/chat/completions.';
    }
    return 'Сервер не нашёл ресурс: проверь адрес API и название модели.';
  }
  if (status === 401 || status === 403) return 'Ключ API не принят: он неверный, удалён или скопирован не полностью. Создай новый на openrouter.ai/keys (начинается с sk-or-v1-…).';
  if (status === 402) return 'На аккаунте OpenRouter нет кредитов, а выбранная модель платная. Используй модель с :free или openrouter/free.';
  if (status === 408) return 'Сервер слишком долго отвечал. Попробуй ещё раз или выбери другую модель.';
  if (status === 429) return 'Лимит запросов: у бесплатных моделей ~20 запросов в минуту и ~50 в день (1000/день после пополнения на $10). Подожди или смени модель.';
  if (status === 400) return 'Сервер отклонил запрос: модель не принимает такой формат (часто — системные инструкции) или слишком длинный контекст.';
  if (status >= 500) return 'Ошибка на стороне провайдера модели — это временно. Попробуй другую модель.';
  if (/пустой ответ/i.test(m)) return 'Модель вернула пустой ответ. Часто бывает у перегруженных бесплатных моделей — попробуй ещё раз.';
  return 'Неизвестная ошибка — открой журнал ИИ (Настройки → ИИ → Диагностика), там полный ответ сервера.';
}

// ---------- список бесплатных моделей ----------
export async function liveFreeModels(force = false) {
  try {
    const c = JSON.parse(localStorage.getItem(LIST_KEY) || 'null');
    if (!force && c && Date.now() - c.t < 6 * 3600e3 && c.list?.length) return c.list;
  } catch { /* */ }
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 7000);
    const res = await fetch(OR_MODELS_URL, { signal: ctrl.signal }); clearTimeout(t);
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    const list = (j.data || [])
      .filter((x) => /:free$/.test(x.id) && /^text/.test(x.architecture?.modality || 'text') && (x.architecture?.output_modalities || ['text']).includes('text'))
      .sort((a, b) => (b.created || 0) - (a.created || 0))
      .map((x) => x.id);
    if (list.length) { localStorage.setItem(LIST_KEY, JSON.stringify({ t: Date.now(), list })); return list; }
  } catch { /* оставим запасной список */ }
  return OR_STATIC.filter((x) => x !== 'openrouter/free');
}

async function modelChain(userModel) {
  const okModel = localStorage.getItem(OK_KEY) || '';
  const live = await liveFreeModels();
  const chain = [userModel, okModel, 'openrouter/free', ...live].filter(Boolean);
  // если пользователь выбрал свою платную/не-free модель — пробуем её первой и один запасной
  return [...new Set(chain)].slice(0, 4);
}

// ---------- один запрос ----------
const mergeSystem = (msgs) => {
  const sys = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const rest = msgs.filter((m) => m.role !== 'system').map((m) => ({ ...m }));
  const i = rest.findIndex((m) => m.role === 'user');
  if (sys && i >= 0) {
    if (Array.isArray(rest[i].content)) rest[i].content = [{ type: 'text', text: sys }, ...rest[i].content];
    else rest[i].content = `${sys}\n\n${rest[i].content}`;
  }
  return rest;
};

async function callOnce({ url, key, model, messages, temperature, timeoutMs, provider, attempt, urlNote }) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (provider === 'openrouter') { headers['HTTP-Referer'] = location.origin || 'https://mspgram.app'; headers['X-Title'] = 'MSPgram'; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  const entry = { t: new Date().toISOString(), url, model, provider, attempt, ok: false, status: 0, ms: 0, error: '', hint: '', body: '' };
  const fail = (e, retryable) => {
    entry.ms = Math.round(performance.now() - t0);
    entry.error = e.message;
    entry.hint = explain({ status: entry.status, message: entry.body ? parseMsg(entry.body) || e.message : e.message, provider, model, networkFail: e.net, urlNote });
    pushLog(entry);
    const err = new Error(e.net ? entry.hint : entry.hint ? `${e.message}. ${entry.hint}` : e.message);
    err.status = entry.status; err.retryable = retryable; err.entry = entry;
    return err;
  };
  let sendMsgs = messages;
  try {
    for (let round = 0; round < 2; round++) {
      let res;
      try {
        res = await fetch(url, { method: 'POST', headers, signal: ctrl.signal, body: JSON.stringify({ model, messages: sendMsgs, temperature }) });
      } catch (e) {
        if (e.name === 'AbortError') throw fail(Object.assign(new Error('Таймаут: ИИ отвечает слишком долго'), { net: false }), false);
        throw fail(Object.assign(new Error('Нет связи с ИИ-сервером (Failed to fetch)'), { net: true }), false);
      }
      entry.status = res.status;
      const raw = await res.text();
      entry.body = raw.replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-…').slice(0, 1500);
      if (!res.ok) {
        const msg = parseMsg(raw) || res.statusText || 'ошибка';
        // некоторые модели (Gemma и др.) не принимают system-сообщения — повторяем без них
        if (round === 0 && res.status === 400 && /system|developer|instruction/i.test(msg) && sendMsgs.some((m) => m.role === 'system')) {
          sendMsgs = mergeSystem(sendMsgs); continue;
        }
        const retry = [400, 404, 408, 422, 429, 500, 502, 503, 504].includes(res.status);
        throw fail(new Error(`ИИ-сервер ответил ${res.status}: ${msg}`), retry);
      }
      let data; try { data = JSON.parse(raw); } catch { throw fail(new Error('Сервер вернул не JSON'), true); }
      if (data?.error) { // OpenRouter иногда отдаёт ошибку с кодом 200
        entry.status = Number(data.error.code) || 502;
        throw fail(new Error(`ИИ-сервер: ${data.error.message || 'ошибка провайдера'}`), true);
      }
      let text = data?.choices?.[0]?.message?.content || '';
      if (Array.isArray(text)) text = text.map((x) => x.text || '').join('');
      text = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (!text) throw fail(new Error('Пустой ответ'), true);
      entry.ok = true; entry.ms = Math.round(performance.now() - t0); entry.body = '';
      pushLog(entry);
      return { text, model: data.model || model };
    }
    throw fail(new Error('Не удалось получить ответ'), true);
  } finally { clearTimeout(timer); }
}

function parseMsg(raw) {
  try {
    const j = JSON.parse(raw);
    const e = j.error || j;
    const inner = e.metadata?.raw ? ` (${String(e.metadata.raw).slice(0, 160)})` : '';
    return (typeof e === 'string' ? e : e.message || '') + inner;
  } catch { return String(raw).slice(0, 160); }
}

// ---------- модели с поддержкой картинок (v20) ----------
const VIS_STATIC = [
  'openrouter/free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3.5-super-vl:free',
];
const VIS_LIST_KEY = 'msp_or_vision_list';
const VIS_OK_KEY = 'msp_ai_ok_vision';

export async function liveVisionModels() {
  try {
    const c = JSON.parse(localStorage.getItem(VIS_LIST_KEY) || 'null');
    if (c && Date.now() - c.t < 6 * 3600e3 && c.list?.length) return c.list;
  } catch { /* */ }
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 7000);
    const res = await fetch(OR_MODELS_URL, { signal: ctrl.signal }); clearTimeout(t);
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    const list = (j.data || [])
      .filter((x) => /:free$/.test(x.id) && (x.architecture?.input_modalities || []).includes('image')
        && (x.architecture?.output_modalities || ['text']).includes('text'))
      .sort((a, b) => (b.created || 0) - (a.created || 0))
      .map((x) => x.id);
    if (list.length) { localStorage.setItem(VIS_LIST_KEY, JSON.stringify({ t: Date.now(), list })); return list; }
  } catch { /* запасной список */ }
  return VIS_STATIC.filter((x) => x !== 'openrouter/free');
}

/** Настройки для запроса с картинкой. Анонимный Pollinations картинки не понимает —
 *  поэтому берём OpenRouter (бесплатный ключ) или собственный провайдер пользователя. */
export function visionSetup() {
  const p = getPrefs();
  const n = normalizeAiUrl(p.aiUrl);
  const orKey = (p.aiVisionKey || (n.provider === 'openrouter' ? p.aiKey : '') || '').trim();
  if (n.provider === 'custom') return { ok: true, url: n.url, key: (p.aiKey || '').trim(), provider: 'custom', models: [(p.aiModel || '').trim() || 'gpt-4o-mini'], note: n.note };
  if (!orKey) return { ok: false };
  return { ok: true, url: OR_URL, key: orKey, provider: 'openrouter', models: null, note: '' };
}

// ---------- публичный вызов (используется всем приложением) ----------
export async function aiComplete(messages, { temperature = 0.6, timeoutMs = 40000 } = {}) {
  const hasImage = messages.some((m) => Array.isArray(m.content) && m.content.some((x) => x.type === 'image_url'));
  if (hasImage) return aiCompleteVision(messages, { temperature, timeoutMs: Math.max(timeoutMs, 70000) });
  const p = getPrefs();
  const n = normalizeAiUrl(p.aiUrl);
  const key = (p.aiKey || '').trim();
  const userModel = (p.aiModel || '').trim();
  const models = n.provider === 'openrouter' ? await modelChain(userModel) : [userModel || DEFAULT_MODEL];
  let lastErr;
  for (let i = 0; i < models.length; i++) {
    try {
      const r = await callOnce({ url: n.url, key, model: models[i], messages, temperature, timeoutMs, provider: n.provider, attempt: i + 1, urlNote: n.note });
      if (n.provider === 'openrouter') localStorage.setItem(OK_KEY, models[i]);
      return r.text;
    } catch (e) {
      lastErr = e;
      if (!e.retryable) break;
    }
  }
  throw lastErr || new Error('ИИ недоступен');
}

async function aiCompleteVision(messages, { temperature, timeoutMs }) {
  const v = visionSetup();
  if (!v.ok) {
    const err = new Error('Для анализа фото нужен ИИ с поддержкой картинок. Вставь бесплатный ключ OpenRouter — это один раз.');
    err.needKey = true;
    throw err;
  }
  let models = v.models;
  if (!models) {
    const okModel = localStorage.getItem(VIS_OK_KEY) || '';
    const live = await liveVisionModels();
    models = [...new Set([okModel, 'openrouter/free', ...live].filter(Boolean))].slice(0, 4);
  }
  let lastErr;
  for (let i = 0; i < models.length; i++) {
    try {
      const r = await callOnce({ url: v.url, key: v.key, model: models[i], messages, temperature, timeoutMs, provider: v.provider, attempt: i + 1, urlNote: v.note });
      if (v.provider === 'openrouter') localStorage.setItem(VIS_OK_KEY, models[i]);
      return r.text;
    } catch (e) {
      lastErr = e;
      if (e.status === 401 || e.status === 403) { e.needKey = true; break; }
      if (!e.retryable) break;
    }
  }
  throw lastErr || new Error('ИИ недоступен');
}

// ---------- самотест: по шагам показывает, где ломается ----------
export async function runAiTest(onStep = () => {}) {
  const steps = []; const add = (s) => { steps.push(s); onStep(s); };
  const p = getPrefs();
  const n = normalizeAiUrl(p.aiUrl);
  const key = (p.aiKey || '').trim();
  add({ ok: true, title: 'Настройки', detail: `Провайдер: ${n.provider}\nАдрес: ${n.url}\nМодель: ${p.aiModel || '(авто)'}\nКлюч: ${maskKey(key)}${n.note ? '\n⚙ ' + n.note : ''}` });
  if (n.invalid) { add({ ok: false, title: 'Адрес', detail: n.note }); return steps; }
  if (n.provider === 'openrouter') {
    if (!key) add({ ok: false, title: 'Ключ API', detail: 'Ключ не указан. Бесплатные модели OpenRouter тоже требуют ключ (бесплатный, openrouter.ai/keys).' });
    // 1. доступен ли сайт
    let list = [];
    try {
      const r = await fetch(OR_MODELS_URL);
      const j = await r.json(); list = (j.data || []);
      add({ ok: r.ok, title: 'Связь с openrouter.ai', detail: r.ok ? `Доступно, моделей в каталоге: ${list.length}` : `Статус ${r.status}` });
    } catch { add({ ok: false, title: 'Связь с openrouter.ai', detail: explain({ networkFail: true, provider: 'openrouter' }) }); return steps; }
    // 2. ключ
    if (key) {
      try {
        const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` } });
        const j = await r.json().catch(() => ({}));
        if (r.ok) {
          const d = j.data || {};
          add({ ok: true, title: 'Ключ API', detail: `Принят${d.label ? ` («${d.label}»)` : ''}. Бесплатный тариф: ${d.is_free_tier ? 'да (лимит ~50 запросов/день)' : 'нет'}. Использовано: $${d.usage ?? 0}${d.limit != null ? ` из $${d.limit}` : ''}` });
        } else add({ ok: false, title: 'Ключ API', detail: `${r.status}: ${parseMsg(JSON.stringify(j))}. ${explain({ status: r.status, provider: 'openrouter' })}` });
      } catch { add({ ok: false, title: 'Ключ API', detail: 'Не удалось проверить ключ (нет связи).' }); }
    }
    // 3. модель
    const want = (p.aiModel || '').trim();
    if (want && list.length) {
      const found = list.find((x) => x.id === want);
      add({ ok: !!found || want === 'openrouter/free', title: `Модель «${want}»`, detail: found ? `Есть в каталоге${found.pricing?.prompt === '0' ? ' (бесплатная)' : ' (ПЛАТНАЯ)'}` : 'НЕТ в каталоге OpenRouter — она удалена или переименована. Это и есть причина 404. Выбери «openrouter/free».' });
    }
  }
  // 4. боевой запрос
  try {
    const t0 = performance.now();
    const text = await aiComplete([{ role: 'user', content: 'Ответь одним словом: ok' }], { timeoutMs: 40000 });
    add({ ok: true, title: 'Тестовый запрос', detail: `Ответ получен за ${Math.round(performance.now() - t0)} мс: «${text.slice(0, 80)}»\nРабочая модель: ${localStorage.getItem(OK_KEY) || p.aiModel || DEFAULT_MODEL}` });
  } catch (e) { add({ ok: false, title: 'Тестовый запрос', detail: e.message }); }
  return steps;
}

export function buildReport(steps = []) {
  const p = getPrefs(); const n = normalizeAiUrl(p.aiUrl);
  const head = `MSPgram AI report\n${new Date().toISOString()}\nUA: ${navigator.userAgent}\nURL: ${n.url} (${n.provider})\nModel: ${p.aiModel || '(auto)'}\nKey: ${maskKey((p.aiKey || '').trim())}\n`;
  const st = steps.map((s) => `[${s.ok ? 'OK' : 'FAIL'}] ${s.title}: ${s.detail}`).join('\n');
  const lg = getAiLog().slice(0, 10).map((e) => `${e.t} ${e.ok ? 'OK' : 'ERR'} ${e.status} ${e.model} ${e.error || ''}\n   ${e.body || ''}`).join('\n');
  return `${head}\n--- steps ---\n${st}\n\n--- last log ---\n${lg}`;
}

// ============================================================
//  MSP AI: ассистент, перевод, пересказ, умные ответы, помощь в тексте
//  По умолчанию — бесплатный OpenAI-совместимый шлюз Pollinations (без ключа).
//  В Настройках → ИИ можно указать свой endpoint / ключ / модель.
// ============================================================
import { state, memberProfile, chatTitleFor, dbApi } from './api.js';
import { qs, esc, el, toast, getPrefs, setPrefs } from './utils.js';
import { icon } from './icons.js';
import { getLoadedMessages, refreshMessages } from './chatview.js';
import { aiComplete } from './ai-core.js';

const SYSTEM = 'Ты — MSP AI, дружелюбный и толковый ассистент внутри мессенджера MSPgram. '
  + 'Отвечай по делу и кратко, на языке пользователя (по умолчанию — русский). Не выдумывай факты.';

export const LANGS = [
  ['ru', 'Русский'], ['en', 'English'], ['uk', 'Українська'], ['es', 'Español'], ['de', 'Deutsch'],
  ['fr', 'Français'], ['it', 'Italiano'], ['pt', 'Português'], ['tr', 'Türkçe'], ['pl', 'Polski'],
  ['zh', '中文'], ['ja', '日本語'], ['ko', '한국어'], ['ar', 'العربية'], ['kk', 'Қазақша'],
];
const langName = (c) => (LANGS.find((l) => l[0] === c) || [c, c])[1];

// переводы сообщений (msgId -> {lang, text}) — показываются под сообщением
export const translations = new Map();
export function translationHTML(id) {
  const t = translations.get(id);
  if (!t) return '';
  return `<div class="msg-translation"><span class="tr-lang">🌐 ${esc(t.lang.toUpperCase())}</span>${esc(t.text).replaceAll('\n', '<br>')}</div>`;
}

// ---------- ядро: см. ai-core.js (адрес, запасные модели, журнал ошибок) ----------
export { aiComplete };

function renderMd(s) {
  return esc(s)
    .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replaceAll('\n', '<br>');
}

function nameOf(chat, uid) {
  if (uid === state.me.id) return 'Я';
  const p = memberProfile(chat, uid);
  return p ? (p.display_name || p.nickname) : 'Собеседник';
}
function transcriptOf(chat, msgs) {
  return msgs.filter((m) => m.body && m.body.trim())
    .map((m) => `${nameOf(chat, m.sender_id)}: ${m.body.replace(/\s+/g, ' ').slice(0, 500)}`).join('\n');
}

// ---------- ассистент ----------
const histKey = () => `msp_ai_${state.me?.id}`;
function loadHist() { try { return JSON.parse(localStorage.getItem(histKey()) || '[]'); } catch { return []; } }
function saveHist(h) { try { localStorage.setItem(histKey(), JSON.stringify(h.slice(-40))); } catch { /* */ } }

export function openAssistant() {
  if (!state.me || qs('#ai-modal')) return;
  let hist = loadHist();
  const m = el(`
    <div class="modal-overlay" id="ai-modal">
      <div class="modal ai-modal">
        <div class="ai-head">
          <span class="ai-logo">${icon('sparkles', 20)}</span>
          <div class="ai-head-t"><b>MSP AI</b><span>ассистент MSPgram</span></div>
          <button class="icon-btn" data-act="clear" title="Очистить диалог">${icon('x', 18)}</button>
        </div>
        <div class="ai-log" id="ai-log"></div>
        <div class="ai-chips" id="ai-chips"></div>
        <div class="ai-input">
          <textarea id="ai-text" rows="1" placeholder="Спроси что угодно…"></textarea>
          <button class="send-btn" id="ai-send" title="Отправить">${icon('send', 18)}</button>
        </div>
        <button class="btn ghost sm ai-close" data-act="close">Закрыть</button>
      </div>
    </div>`);
  document.querySelector('#modal-root').appendChild(m);
  const log = qs('#ai-log', m); const input = qs('#ai-text', m);
  const bubble = (role, text) => {
    const b = el(`<div class="ai-msg ${role}"><div class="ai-bubble">${renderMd(text)}</div>
      ${role === 'assistant' ? '<button class="ai-copy" title="Копировать">⧉</button>' : ''}</div>`);
    b.querySelector('.ai-copy')?.addEventListener('click', () => navigator.clipboard?.writeText(text).then(() => toast('Скопировано ✓')));
    log.appendChild(b); log.scrollTop = log.scrollHeight; return b;
  };
  if (!hist.length) bubble('assistant', 'Привет! Я MSP AI 👋 Помогу написать сообщение, объясню что-нибудь, переведу или придумаю идею. С чего начнём?');
  hist.forEach((h) => bubble(h.role, h.content));

  const chips = ['Помоги написать вежливое сообщение', 'Объясни простыми словами…', 'Придумай идею подарка', 'Переведи на английский: '];
  qs('#ai-chips', m).innerHTML = chips.map((c) => `<button class="chip">${esc(c)}</button>`).join('');
  qs('#ai-chips', m).addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    input.value = c.textContent; input.focus();
  });

  let busy = false;
  const send = async () => {
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true; input.value = '';
    hist.push({ role: 'user', content: text }); bubble('user', text);
    const typing = bubble('assistant', '…'); typing.classList.add('typing');
    try {
      const answer = await aiComplete([{ role: 'system', content: SYSTEM }, ...hist.slice(-16)]);
      typing.remove(); bubble('assistant', answer);
      hist.push({ role: 'assistant', content: answer }); saveHist(hist);
    } catch (e) {
      typing.remove(); bubble('assistant', '⚠️ ' + e.message);
      hist.pop(); saveHist(hist);
    } finally { busy = false; input.focus(); }
  };
  qs('#ai-send', m).addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; });
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-act=close]')) m.remove();
    if (e.target.closest('[data-act=clear]')) { hist = []; saveHist(hist); log.innerHTML = ''; bubble('assistant', 'Диалог очищен. О чём поговорим?'); }
  });
  setTimeout(() => input.focus(), 50);
}

// ---------- пересказ переписки ----------
export async function summarizeChat() {
  const chat = state.chats.get(state.activeChatId);
  if (!chat) return;
  const m = el(`
    <div class="modal-overlay"><div class="modal ai-result">
      <h3>${icon('sparkles', 18)} Кратко о переписке</h3>
      <div class="ai-result-body"><div class="ai-spin">ИИ читает переписку…</div></div>
      <div class="modal-actions"><button class="btn ghost" data-act="copy">Копировать</button><button class="btn primary" data-act="close">Готово</button></div>
    </div></div>`);
  document.querySelector('#modal-root').appendChild(m);
  const body = qs('.ai-result-body', m); let result = '';
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-act=close]')) m.remove();
    if (e.target.closest('[data-act=copy]') && result) navigator.clipboard?.writeText(result).then(() => toast('Скопировано ✓'));
  });
  try {
    const msgs = await dbApi.loadMessages(chat.id, 120);
    const text = transcriptOf(chat, msgs);
    if (text.length < 40) { body.innerHTML = '<p class="muted">Слишком мало текста для пересказа.</p>'; return; }
    result = await aiComplete([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Перескажи переписку «${chatTitleFor(chat)}» в 3–6 коротких пунктах: о чём говорили, какие решения и договорённости, что осталось сделать. Без воды.\n\n${text.slice(-9000)}` },
    ], { temperature: 0.3 });
    body.innerHTML = `<div class="ai-text">${renderMd(result)}</div>`;
  } catch (e) { body.innerHTML = `<p class="form-error">${esc(e.message)}</p>`; }
}

// ---------- умные ответы ----------
export async function suggestReplies(targetMsg = null) {
  const chat = state.chats.get(state.activeChatId);
  if (!chat) return;
  const box = ensureSuggestBox();
  box.innerHTML = '<span class="ai-spin sm">ИИ придумывает ответы…</span>';
  box.classList.remove('hidden');
  try {
    const msgs = getLoadedMessages().slice(-14);
    const focus = targetMsg ? `\nОтветь именно на сообщение: «${(targetMsg.body || '').slice(0, 300)}»` : '';
    const raw = await aiComplete([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Вот конец переписки (я — «Я»):\n${transcriptOf(chat, msgs)}${focus}\n\nПредложи ровно 3 коротких разных варианта моего ответа (тёплый, нейтральный, с юмором). Каждый вариант — с новой строки, без нумерации, без кавычек, без пояснений.` },
    ], { temperature: 0.9 });
    const lines = raw.split('\n').map((s) => s.replace(/^[\s\-–•\d.)"«]+|["»]+$/g, '').trim()).filter(Boolean).slice(0, 3);
    if (!lines.length) throw new Error('ИИ не предложил вариантов');
    box.innerHTML = lines.map((l) => `<button class="ai-sug">${esc(l)}</button>`).join('')
      + '<button class="ai-sug-x" title="Скрыть">✕</button>';
    box.onclick = (e) => {
      if (e.target.closest('.ai-sug-x')) { box.classList.add('hidden'); return; }
      const b = e.target.closest('.ai-sug'); if (!b) return;
      const ta = qs('#msg-input'); ta.value = b.textContent; ta.dispatchEvent(new Event('input')); ta.focus();
      box.classList.add('hidden');
    };
  } catch (e) { box.innerHTML = `<span class="form-error">${esc(e.message)}</span><button class="ai-sug-x">✕</button>`; box.onclick = () => box.classList.add('hidden'); }
}
function ensureSuggestBox() {
  let b = qs('#ai-suggest');
  if (!b) {
    b = el('<div id="ai-suggest" class="ai-suggest hidden"></div>');
    const comp = qs('.composer'); comp.insertBefore(b, qs('.composer-row', comp));
  }
  return b;
}

// ---------- помощь в тексте ----------
const REWRITES = [
  ['fix', '✅ Исправить ошибки', 'Исправь орфографию и пунктуацию, ничего не меняя по смыслу и стилю.'],
  ['better', '✨ Улучшить текст', 'Перепиши яснее и красивее, сохрани смысл и тон.'],
  ['short', '✂️ Короче', 'Сократи, оставив главное.'],
  ['friendly', '😊 Дружелюбнее', 'Перепиши в тёплом дружелюбном тоне.'],
  ['formal', '👔 Официальнее', 'Перепиши в вежливом деловом стиле.'],
  ['en', '🇬🇧 На английский', 'Переведи на английский язык.'],
];
export function openWriteMenu(anchor) {
  qs('.ai-write-menu')?.remove();
  const menu = el(`<div class="ai-write-menu">
    ${REWRITES.map(([k, l]) => `<button data-k="${k}">${l}</button>`).join('')}
    <button data-k="suggest">💬 Придумать ответ</button></div>`);
  qs('.composer').appendChild(menu);
  const close = () => { menu.remove(); document.removeEventListener('click', onDoc, true); };
  const onDoc = (e) => { if (!e.target.closest('.ai-write-menu') && !e.target.closest('#ai-write-btn')) close(); };
  setTimeout(() => document.addEventListener('click', onDoc, true), 0);
  menu.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    close();
    if (b.dataset.k === 'suggest') { suggestReplies(); return; }
    const ta = qs('#msg-input'); const src = ta.value.trim();
    if (!src) { toast('Сначала напиши текст — ИИ его улучшит ✍️'); return; }
    const rule = REWRITES.find((r) => r[0] === b.dataset.k)[2];
    anchor.classList.add('busy');
    try {
      const out = await aiComplete([
        { role: 'system', content: 'Ты редактор текста для мессенджера. Возвращай ТОЛЬКО итоговый текст, без кавычек и пояснений.' },
        { role: 'user', content: `${rule}\n\nТекст:\n${src}` },
      ], { temperature: 0.4 });
      ta.value = out.replace(/^["«]|["»]$/g, ''); ta.dispatchEvent(new Event('input'));
      toast('Текст обновлён ✨', 6000, { onClick: () => { ta.value = src; ta.dispatchEvent(new Event('input')); toast('Вернул как было'); }, html: '✨ Текст обновлён · <u>нажми, чтобы вернуть</u>' });
    } catch (err) { toast('Ошибка ИИ: ' + err.message, 4500); }
    finally { anchor.classList.remove('busy'); }
  });
}

// ---------- перевод сообщения ----------
export function openTranslate(msg) {
  const last = getPrefs().trLang || 'en';
  const has = translations.has(msg.id);
  const m = el(`
    <div class="modal-overlay"><div class="modal">
      <h3>🌐 Перевести сообщение</h3>
      <p class="modal-text quote">${esc((msg.body || '').slice(0, 200))}</p>
      <div class="chip-row lang-row">${LANGS.map(([c, n]) => `<button class="size-chip ${c === last ? 'sel' : ''}" data-l="${c}">${n}</button>`).join('')}</div>
      <div class="modal-actions">${has ? '<button class="btn ghost" data-act="hide">Убрать перевод</button>' : ''}<button class="btn ghost" data-act="close">Отмена</button></div>
    </div></div>`);
  document.querySelector('#modal-root').appendChild(m);
  m.addEventListener('click', async (e) => {
    if (e.target === m || e.target.closest('[data-act=close]')) { m.remove(); return; }
    if (e.target.closest('[data-act=hide]')) { translations.delete(msg.id); refreshMessages(); m.remove(); return; }
    const b = e.target.closest('[data-l]'); if (!b) return;
    const lang = b.dataset.l; setPrefs({ trLang: lang }); m.remove();
    toast('Перевожу…');
    try {
      const out = await aiComplete([
        { role: 'system', content: 'Ты переводчик. Верни ТОЛЬКО перевод, без пояснений и кавычек. Сохраняй эмодзи, ссылки и @упоминания.' },
        { role: 'user', content: `Переведи на язык «${langName(lang)}»:\n\n${msg.body}` },
      ], { temperature: 0.1 });
      translations.set(msg.id, { lang, text: out });
      refreshMessages();
    } catch (err) { toast('Ошибка перевода: ' + err.message, 4500); }
  });
}

// кнопки в шапке чата и композере
export function initAI() {
  const wb = qs('#ai-write-btn');
  if (wb) wb.addEventListener('click', (e) => { e.stopPropagation(); openWriteMenu(wb); });
  const sb = qs('#ai-sum-btn');
  if (sb) sb.addEventListener('click', summarizeChat);
}

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
import { imageToDataUrl, urlToFile, isImageFile } from './ai-vision.js';

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
function saveHist(h) { try { localStorage.setItem(histKey(), JSON.stringify(h.slice(-40).map((x) => ({ role: x.role, content: x.img ? `🖼 ${x.content}` : x.content })))); } catch { /* */ } }

export function openAssistant(opts) {
  if (!state.me) return;
  const imageUrl = opts && typeof opts.imageUrl === 'string' ? opts.imageUrl : '';
  const existing = qs('#ai-modal');
  if (existing) { existing.__attachUrl?.(imageUrl); return; }
  // история: в памяти у сообщений может лежать img (картинка текущей сессии), в localStorage — только текст
  let hist = loadHist();
  const m = el(`
    <div class="modal-overlay" id="ai-modal">
      <div class="modal ai-modal">
        <div class="ai-head">
          <span class="ai-logo">${icon('sparkles', 20)}</span>
          <div class="ai-head-t"><b>MSP AI</b><span>ассистент · умеет смотреть фото</span></div>
          <button class="icon-btn" data-act="clear" title="Очистить диалог">${icon('trash', 18)}</button>
        </div>
        <div class="ai-log" id="ai-log"></div>
        <div class="ai-chips" id="ai-chips"></div>
        <div class="ai-attach hidden" id="ai-attach"></div>
        <div class="ai-input">
          <button class="icon-btn ai-photo-btn" id="ai-photo" title="Загрузить фото для ИИ">${icon('image', 20)}</button>
          <input type="file" id="ai-file" accept="image/*" class="hidden">
          <textarea id="ai-text" rows="1" placeholder="Спроси что угодно или загрузи фото…"></textarea>
          <button class="send-btn" id="ai-send" title="Отправить">${icon('send', 18)}</button>
        </div>
        <button class="btn ghost sm ai-close" data-act="close">Закрыть</button>
      </div>
    </div>`);
  document.querySelector('#modal-root').appendChild(m);
  const log = qs('#ai-log', m); const input = qs('#ai-text', m);
  const strip = qs('#ai-attach', m); const fileIn = qs('#ai-file', m);
  let pending = null; // { dataUrl, w, h, kb }

  const bubble = (role, text, img) => {
    const b = el(`<div class="ai-msg ${role}"><div class="ai-bubble">${img ? `<img class="ai-pic" src="${esc(img)}" alt="Фото">` : ''}${text ? renderMd(text) : ''}</div>
      ${role === 'assistant' ? '<button class="ai-copy" title="Копировать">⧉</button>' : ''}</div>`);
    b.querySelector('.ai-copy')?.addEventListener('click', () => navigator.clipboard?.writeText(text).then(() => toast('Скопировано ✓')));
    log.appendChild(b); log.scrollTop = log.scrollHeight; return b;
  };

  // карточка «вставь ключ» — нужна один раз, чтобы ИИ видел картинки
  const keyCard = (retry) => {
    const b = el(`<div class="ai-msg assistant"><div class="ai-bubble ai-keycard">
      <b>🔑 Нужен ключ для фото</b>
      <p>Бесплатный ИИ без ключа картинки не понимает. Получи бесплатный ключ на <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a> (вход через Google/GitHub, карта не нужна) и вставь сюда — это один раз. Остальные функции ИИ в приложении не изменятся.</p>
      <div class="ai-keyrow"><input type="password" placeholder="sk-or-v1-…" autocomplete="off"><button class="btn primary sm">Сохранить</button></div>
    </div></div>`);
    b.querySelector('button').addEventListener('click', () => {
      const k = b.querySelector('input').value.trim();
      if (!/^sk-/.test(k)) { toast('Ключ начинается с sk-or-v1-…'); return; }
      setPrefs({ aiVisionKey: k });
      b.remove(); toast('Ключ сохранён ✓');
      retry();
    });
    log.appendChild(b); log.scrollTop = log.scrollHeight;
  };

  const renderStrip = () => {
    if (!pending) { strip.classList.add('hidden'); strip.innerHTML = ''; return; }
    strip.classList.remove('hidden');
    strip.innerHTML = `<div class="ai-thumb"><img src="${esc(pending.dataUrl)}" alt=""><button title="Убрать фото" data-x>✕</button></div>
      <div class="ai-thumb-info"><b>Фото готово</b><span>${pending.w}×${pending.h} · ${pending.kb} КБ</span></div>`;
  };
  strip.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) { pending = null; renderStrip(); } });

  const attachFile = async (file) => {
    if (!file) return;
    try {
      strip.classList.remove('hidden'); strip.innerHTML = '<span class="ai-spin sm">Готовлю фото…</span>';
      pending = await imageToDataUrl(file);
      renderStrip(); input.focus();
      if (!input.value.trim()) input.placeholder = 'Что узнать про фото? (можно оставить пустым)';
    } catch (e) { pending = null; renderStrip(); toast('Ошибка: ' + e.message, 4000); }
  };
  m.__attachUrl = async (url) => {
    if (!url) return;
    try { await attachFile(await urlToFile(url)); } catch (e) { toast('Ошибка: ' + e.message, 4000); }
  };

  qs('#ai-photo', m).addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', () => { attachFile(fileIn.files[0]); fileIn.value = ''; });
  input.addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files || [])].find(isImageFile);
    if (f) { e.preventDefault(); attachFile(f); }
  });
  const dz = qs('.ai-modal', m);
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); dz.classList.add('drop'); } }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove('drop')));
  dz.addEventListener('drop', (e) => { const f = [...(e.dataTransfer?.files || [])].find(isImageFile); if (f) { e.preventDefault(); attachFile(f); } });

  if (!hist.length) bubble('assistant', 'Привет! Я MSP AI 👋 Помогу написать сообщение, объясню что-нибудь, переведу или придумаю идею. А ещё могу **посмотреть фото**: нажми 🖼 слева от поля ввода — опишу, переведу текст с картинки или помогу с задачей.');
  hist.forEach((h) => bubble(h.role, h.content, h.img));

  const chips = [
    ['📷 Опиши фото', 'Опиши подробно, что на этом фото.', true],
    ['🔤 Текст с фото', 'Выпиши весь текст с фото и переведи на русский, если он на другом языке.', true],
    ['🧮 Реши задачу', 'Реши задачу с фото и объясни решение по шагам.', true],
    ['✍️ Вежливое сообщение', 'Помоги написать вежливое сообщение', false],
    ['💡 Идея подарка', 'Придумай идею подарка', false],
  ];
  qs('#ai-chips', m).innerHTML = chips.map((c, i) => `<button class="chip" data-i="${i}">${esc(c[0])}</button>`).join('');
  qs('#ai-chips', m).addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    const [, text, needPhoto] = chips[Number(c.dataset.i)];
    input.value = text; input.focus();
    if (needPhoto && !pending) fileIn.click();
  });

  let busy = false;
  const toApi = (h, withImg) => (withImg && h.img
    ? { role: h.role, content: [{ type: 'text', text: h.content || 'Опиши фото' }, { type: 'image_url', image_url: { url: h.img } }] }
    : { role: h.role, content: h.content });

  const ask = async () => {
    // картинки шлём только из последних 3 реплик — экономим трафик и токены
    const tail = hist.slice(-16);
    const lastImgIdx = tail.map((h) => !!h.img);
    const payload = tail.map((h, i) => toApi(h, lastImgIdx[i] && tail.length - i <= 3));
    const typing = bubble('assistant', '…'); typing.classList.add('typing');
    try {
      const answer = await aiComplete([{ role: 'system', content: SYSTEM }, ...payload]);
      typing.remove(); bubble('assistant', answer);
      hist.push({ role: 'assistant', content: answer }); saveHist(hist);
    } catch (e) {
      typing.remove();
      if (e.needKey) {
        keyCard(() => { busy = true; ask().finally(() => { busy = false; }); });
      } else {
        bubble('assistant', '⚠️ ' + e.message);
        const last = hist[hist.length - 1];
        if (last && last.role === 'user') { hist.pop(); const b = [...log.querySelectorAll('.ai-msg.user')].pop(); b?.remove(); }
        saveHist(hist);
      }
    }
  };

  const send = async () => {
    const text = input.value.trim();
    if ((!text && !pending) || busy) return;
    busy = true; input.value = ''; input.style.height = 'auto'; input.placeholder = 'Спроси что угодно или загрузи фото…';
    const img = pending ? pending.dataUrl : '';
    const content = text || (img ? 'Опиши, что на фото.' : '');
    pending = null; renderStrip();
    hist.push(img ? { role: 'user', content, img } : { role: 'user', content });
    bubble('user', text, img);
    try { await ask(); } finally { busy = false; input.focus(); }
  };
  qs('#ai-send', m).addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; });
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-act=close]')) m.remove();
    if (e.target.closest('[data-act=clear]')) { hist = []; saveHist(hist); log.innerHTML = ''; bubble('assistant', 'Диалог очищен. О чём поговорим?'); }
  });
  setTimeout(() => input.focus(), 50);
  if (imageUrl) m.__attachUrl(imageUrl);
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

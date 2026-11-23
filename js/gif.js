// GIF-панель (Giphy). Ключ — бесплатный, берётся на developers.giphy.com;
// вписывается один раз в js/config.js (giphyKey) или прямо здесь в панели.
import { state, dbApi } from './api.js';
import { qs, el, esc, toast, getPrefs, setPrefs, debounce } from './utils.js';
import { onNewMessage } from './chatview.js';

let panel = null;

const getKey = () => (window.MSP_CONFIG && window.MSP_CONFIG.giphyKey) || getPrefs().giphyKey || '';

export function initGifs() {
  const btn = qs('#gif-btn');
  if (!btn) return;
  panel = qs('#gif-panel');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    qs('#sticker-panel')?.classList.add('hidden');
    if (panel.classList.contains('hidden')) { build(); panel.classList.remove('hidden'); } else panel.classList.add('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('hidden') && !e.target.closest('#gif-panel') && !e.target.closest('#gif-btn')) panel.classList.add('hidden');
  });
}

function build() {
  if (!getKey()) {
    panel.innerHTML = `<div class="gif-setup">
      <b>GIF через Giphy</b>
      <p>Нужен бесплатный ключ: <a href="https://developers.giphy.com/dashboard/" target="_blank" rel="noopener">developers.giphy.com</a> → Create an App → API.</p>
      <input id="gif-key" placeholder="Вставь API-ключ Giphy">
      <button class="btn primary sm" id="gif-key-save">Сохранить</button></div>`;
    qs('#gif-key-save', panel).addEventListener('click', () => {
      const v = qs('#gif-key', panel).value.trim();
      if (v.length < 16) { toast('Похоже, ключ неполный'); return; }
      setPrefs({ giphyKey: v }); build();
    });
    return;
  }
  panel.innerHTML = `<div class="gif-head"><input id="gif-q" placeholder="Поиск GIF…" autocomplete="off"></div><div class="gif-grid" id="gif-grid"></div>`;
  const q = qs('#gif-q', panel);
  const load = async (term) => {
    const grid = qs('#gif-grid', panel);
    grid.innerHTML = '<div class="list-empty">Загружаю…</div>';
    try {
      const url = term
        ? `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(getKey())}&q=${encodeURIComponent(term)}&limit=30&rating=pg-13&lang=ru`
        : `https://api.giphy.com/v1/gifs/trending?api_key=${encodeURIComponent(getKey())}&limit=30&rating=pg-13`;
      const r = await fetch(url);
      if (r.status === 401 || r.status === 403) { setPrefs({ giphyKey: '' }); toast('Ключ Giphy не подошёл'); build(); return; }
      const j = await r.json();
      grid.innerHTML = '';
      (j.data || []).forEach((g) => {
        const small = g.images?.fixed_height_small?.url || g.images?.fixed_height?.url;
        const full = g.images?.downsized?.url || g.images?.fixed_height?.url;
        if (!small || !full) return;
        const img = el(`<img src="${esc(small)}" alt="GIF" loading="lazy">`);
        img.addEventListener('click', () => sendGif(full));
        grid.appendChild(img);
      });
      if (!grid.children.length) grid.innerHTML = '<div class="list-empty">Ничего не нашлось</div>';
    } catch { grid.innerHTML = '<div class="list-empty">Нет связи с Giphy</div>'; }
  };
  q.addEventListener('input', debounce(() => load(q.value.trim()), 350));
  load('');
}

async function sendGif(url) {
  if (!state.activeChatId) return;
  panel.classList.add('hidden');
  try {
    const m = await dbApi.sendMessage(state.activeChatId, {
      attachment: { attachment_url: url, attachment_type: 'image', attachment_name: 'gif', attachment_size: null },
    });
    onNewMessage(m);
  } catch (e) { toast('Не отправилось: ' + e.message); }
}

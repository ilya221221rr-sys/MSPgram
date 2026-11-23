// MSPgram Stickers: встроенные анимированные стикеры (без CDN, работают офлайн)
// Отправляются как сообщения attachment_type='sticker', анимация — CSS.
import { dbApi, state } from './api.js';
import { el, qs, toast } from './utils.js';

export const STICKER_PACKS = [
  {
    id: 'cats', name: 'Котики', anim: 'anim-bounce',
    items: ['😺', '😸', '😹', '😻', '😽', '😼', '🙀', '😿', '😾', '🐱', '🐈', '🐈‍⬛'],
  },
  {
    id: 'emotions', name: 'Эмоции', anim: 'anim-pop',
    items: ['😀', '😂', '🥹', '😍', '🤯', '😎', '🥳', '😴', '🤬', '🫠', '🤗', '🫡'],
  },
  {
    id: 'party', name: 'Праздник', anim: 'anim-spin',
    items: ['🎉', '🎊', '🥂', '🎆', '🎁', '🎂', '🕺', '💃', '✨', '🔥', '💯', '🚀'],
  },
  {
    id: 'life', name: 'Жизнь', anim: 'anim-wobble',
    items: ['👍', '👎', '👋', '🙏', '💪', '🤝', '👀', '💀', '🤡', '🍕', '☕', '🌙'],
  },
];

export function stickerAnimOf(m) {
  // attachment_name: "<эмодзи>|<packId>"
  const packId = String(m.attachment_name || '').split('|')[1];
  const pack = STICKER_PACKS.find((p) => p.id === packId);
  return pack ? pack.anim : 'anim-bounce';
}

export function stickerEmojiOf(m) {
  return String(m.attachment_name || '').split('|')[0] || '🙂';
}

let panelBuilt = false;

export function initStickers() {
  const btn = qs('#sticker-btn');
  const panel = qs('#sticker-panel');
  if (!btn || !panel) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!panelBuilt) buildPanel(panel);
    panel.classList.toggle('hidden');
    panelBuilt = true;
  });
  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('hidden')
      && !e.target.closest('#sticker-panel') && !e.target.closest('#sticker-btn')) {
      panel.classList.add('hidden');
    }
  });
}

function buildPanel(panel) {
  let tabsHtml = STICKER_PACKS.map((p, i) =>
    `<button class="stk-tab ${i === 0 ? 'active' : ''}" data-pack="${p.id}" title="${p.name}">${p.items[0]}</button>`).join('');
  panel.innerHTML = `
    <div class="stk-tabs">${tabsHtml}</div>
    <div class="stk-grid" id="stk-grid"></div>`;
  renderPack(panel, STICKER_PACKS[0]);

  panel.querySelector('.stk-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.stk-tab');
    if (!tab) return;
    panel.querySelectorAll('.stk-tab').forEach((t) => t.classList.toggle('active', t === tab));
    const pack = STICKER_PACKS.find((p) => p.id === tab.dataset.pack);
    if (pack) renderPack(panel, pack);
  });
}

function renderPack(panel, pack) {
  const grid = panel.querySelector('#stk-grid');
  grid.innerHTML = pack.items.map((s) =>
    `<button class="stk-item ${pack.anim}" data-sticker="${s}" data-pack="${pack.id}">${s}</button>`).join('');
  grid.onclick = async (e) => {
    const item = e.target.closest('.stk-item');
    if (!item || !state.activeChatId) return;
    try {
      await dbApi.sendMessage(state.activeChatId, {
        attachment: {
          attachment_type: 'sticker',
          attachment_name: `${item.dataset.sticker}|${item.dataset.pack}`,
        },
      });
      panel.classList.add('hidden');
    } catch (err) {
      toast('Ошибка: ' + err.message);
    }
  };
}

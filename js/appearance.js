// ============================================================
//  Оформление v19: темы-«скины», обои чата, форма пузырей,
//  плотность, анимации. Всё через data-атрибуты на <html>,
//  стили — в css/v19.css.
// ============================================================
import { qs, el, getPrefs, setPrefs, toast } from './utils.js';

export const SKINS = [
  ['nova', 'Nova', '#0b1020', '#5b8cff'],
  ['amoled', 'AMOLED', '#000000', '#7c5bff'],
  ['midnight', 'Midnight', '#0a1628', '#38bdf8'],
  ['graphite', 'Graphite', '#16181d', '#34d399'],
  ['plum', 'Plum', '#140d1f', '#e879f9'],
  ['forest', 'Forest', '#0a1713', '#4ade80'],
];
export const WALLS = [
  ['none', 'Без обоев'], ['aurora', 'Аврора'], ['dusk', 'Закат'], ['ocean', 'Океан'],
  ['mint', 'Мята'], ['doodle', 'Узор'], ['stars', 'Звёзды'], ['grid', 'Сетка'],
];

export function applyAppearance() {
  const p = getPrefs(); const d = document.documentElement.dataset;
  d.skin = p.skin || 'nova';
  d.wall = p.wall || 'aurora';
  d.bubble = p.bubble || 'tail';
  d.density = p.density || 'cozy';
  d.motion = p.motion || (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full');
  const sk = SKINS.find((s) => s[0] === d.skin);
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta && d.theme !== 'light' && sk) meta.content = sk[2];
}

export function mountAppearance(modal) {
  const host = qs('#st-extra', modal); if (!host || qs('#st-look', host)) return;
  const p = getPrefs();
  const box = el(`<div id="st-look">
    <div class="settings-sec">Тема оформления</div>
    <div class="skin-grid" id="lk-skin">${SKINS.map(([k, l, bg, ac]) => `<button type="button" class="skin-card${(p.skin || 'nova') === k ? ' on' : ''}" data-k="${k}" style="--sk-bg:${bg};--sk-ac:${ac}"><i></i><span>${l}</span></button>`).join('')}</div>
    <div class="field-hint">Тёмные темы работают при выключенной светлой теме.</div>
    <div class="settings-sec">Обои чата</div>
    <div class="wall-grid" id="lk-wall">${WALLS.map(([k, l]) => `<button type="button" class="wall-card${(p.wall || 'aurora') === k ? ' on' : ''}" data-k="${k}" data-wall="${k}"><span>${l}</span></button>`).join('')}</div>
    <div class="settings-sec">Сообщения</div>
    <div class="settings-row"><div class="settings-row-title">Форма пузырей</div>
      <div class="seg" id="lk-bubble">${[['round', 'Мягкие'], ['tail', 'Как в Telegram'], ['flat', 'Строгие']].map(([k, l]) => `<button type="button" data-k="${k}" class="${(p.bubble || 'tail') === k ? 'active' : ''}">${l}</button>`).join('')}</div></div>
    <div class="settings-row"><div class="settings-row-title">Плотность</div>
      <div class="seg" id="lk-density">${[['cozy', 'Свободно'], ['compact', 'Компактно']].map(([k, l]) => `<button type="button" data-k="${k}" class="${(p.density || 'cozy') === k ? 'active' : ''}">${l}</button>`).join('')}</div></div>
    <div class="settings-row"><div><div class="settings-row-title">Меньше анимаций</div><div class="settings-row-sub">Для слабых телефонов и экономии батареи</div></div>
      <label class="switch"><input type="checkbox" id="lk-motion" ${(document.documentElement.dataset.motion === 'reduced') ? 'checked' : ''}><span></span></label></div>
  </div>`);
  host.prepend(box);
  const pick = (id, key) => qs(id, box).addEventListener('click', (e) => {
    const b = e.target.closest('[data-k]'); if (!b) return;
    setPrefs({ [key]: b.dataset.k }); applyAppearance();
    qs(id, box).querySelectorAll('[data-k]').forEach((x) => { x.classList.toggle('on', x === b); x.classList.toggle('active', x === b); });
  });
  pick('#lk-skin', 'skin'); pick('#lk-wall', 'wall'); pick('#lk-bubble', 'bubble'); pick('#lk-density', 'density');
  qs('#lk-motion', box).addEventListener('change', (e) => { setPrefs({ motion: e.target.checked ? 'reduced' : 'full' }); applyAppearance(); toast('Сохранено ✓'); });
}

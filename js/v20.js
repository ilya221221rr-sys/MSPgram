// ============================================================
//  MSPgram v20 «Aurora»: точка подключения
//  • нижняя панель-«док»: аватар профиля, подсветка открытого раздела
//  • версия приложения
//  Остальное подключается из своих модулей:
//   calls.js (камера в звонке, свернуть, фон, история), callcard.js,
//   circles.js (видеокружки), ai.js + ai-vision.js (фото в ИИ)
// ============================================================
import { qs } from './utils.js';
import { icon } from './icons.js';

export const VERSION = 'v20';
let wired = false;

function wireDock() {
  const dock = qs('#dock');
  if (!dock) return;

  // аватар профиля в панели — копия аватара из шапки (обновляется сам)
  const src = qs('#profile-btn');
  const dst = qs('#dock-avatar');
  if (dst) {
    dst.innerHTML = icon('user', 22);
    if (src) {
      const sync = () => { if (src.innerHTML.trim()) dst.innerHTML = src.innerHTML; };
      new MutationObserver(sync).observe(src, { childList: true, subtree: true });
      sync();
    }
  }

  // подсвечиваем раздел, пока он открыт в окне
  let last = null;
  dock.addEventListener('click', (e) => {
    const b = e.target.closest('.nav-btn');
    if (b && b.id !== 'nav-chats') last = b;
  }, true);
  const root = qs('#modal-root');
  if (root) {
    const chats = qs('#nav-chats');
    new MutationObserver(() => {
      const open = root.children.length > 0 && !!last;
      dock.querySelectorAll('.nav-btn.active').forEach((n) => n.classList.remove('active'));
      if (open) last.classList.add('active');
      else { chats?.classList.add('active'); last = null; }
    }).observe(root, { childList: true });
  }
}

export function v20Boot() {
  window.MSP_VERSION = VERSION;
  const v = qs('#app-version');
  if (v) v.textContent = VERSION;
  if (wired) return;
  wired = true;
  wireDock();
}

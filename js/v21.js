// ============================================================
//  MSPgram v21 «Fixed»: точка подключения
//  • фиксация размера экрана (visualViewport → --app-h), учёт клавиатуры
//  • запрет зума щипком / «растягивания» страницы
//  • кнопка «Назад» на Android закрывает чат/окно, а не само приложение
//  • системные уведомления (через Service Worker), клик открывает чат
// ============================================================
import { askNotifyPermissionOnTap, listenNotificationClicks } from './push.js';

export const VERSION = 'v21';
let booted = false;

function lockViewport() {
  const root = document.documentElement;
  const vv = window.visualViewport;

  const apply = () => {
    const h = Math.round(vv ? vv.height : window.innerHeight);
    root.style.setProperty('--app-h', h + 'px');
    // iOS при открытии клавиатуры «сдвигает» страницу — возвращаем на место
    if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
    if (vv && (vv.offsetTop || vv.offsetLeft)) window.scrollTo(0, 0);
  };
  apply();
  if (vv) { vv.addEventListener('resize', apply); vv.addEventListener('scroll', apply); }
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', () => setTimeout(apply, 250));
  window.addEventListener('scroll', () => { if (window.scrollY || window.scrollX) window.scrollTo(0, 0); }, { passive: true });

  // когда клавиатура открыта — поле ввода должно оставаться видимым
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName)) {
      setTimeout(() => { try { t.scrollIntoView({ block: 'nearest' }); } catch { /* */ } }, 300);
    }
  });

  // запрет зума щипком (iOS gesture* и многопальцевый touchmove)
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) => {
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  });
  document.addEventListener('touchmove', (e) => {
    if (e.touches && e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  // Ctrl+колесо / Ctrl+± на ПК не нужны внутри приложения-мессенджера на телефоне
  window.addEventListener('wheel', (e) => { if (e.ctrlKey && matchMedia('(pointer: coarse)').matches) e.preventDefault(); }, { passive: false });
}

function markEnvironment() {
  const root = document.documentElement;
  const standalone = matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
    || document.referrer.startsWith('android-app://');
  root.classList.toggle('is-standalone', standalone);
  root.classList.toggle('is-touch', matchMedia('(pointer: coarse)').matches);

  // жёстко фиксируем viewport (на случай WebView-обёртки, которая его «забыла»)
  let meta = document.querySelector('meta[name="viewport"]');
  if (!meta) { meta = document.createElement('meta'); meta.name = 'viewport'; document.head.appendChild(meta); }
  meta.content = 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content';
}

// Кнопка «Назад» на телефоне: закрывает верхний слой (окно → чат), а не выходит из приложения
function wireBackButton() {
  const body = document.body;
  const modalRoot = document.querySelector('#modal-root');
  const lightbox = document.querySelector('#lightbox');
  const active = () => matchMedia('(max-width: 900px), (pointer: coarse)').matches;

  const layers = () => {
    if (!active()) return 0;
    return (body.classList.contains('chat-open') ? 1 : 0)
      + (modalRoot ? modalRoot.children.length : 0)
      + (lightbox && !lightbox.classList.contains('hidden') ? 1 : 0);
  };

  let depth = 0;   // сколько записей истории добавили мы
  let skip = 0;    // сколько popstate нужно проигнорировать (когда сами откатываем историю)
  let timer = null;

  const sync = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const n = layers();
      while (depth < n) { history.pushState({ msp: ++depth }, ''); }
      if (depth > n) {
        const d = depth - n;
        depth = n;
        skip += 1;
        history.go(-d);
      }
    }, 30);
  };

  window.addEventListener('popstate', () => {
    if (skip > 0) { skip -= 1; return; }
    if (depth > 0) depth -= 1;
    // закрываем самый верхний слой
    if (lightbox && !lightbox.classList.contains('hidden')) { lightbox.click(); return; }
    if (modalRoot && modalRoot.lastElementChild) {
      const top = modalRoot.lastElementChild;
      const closeBtn = top.querySelector('[data-act=close], [data-act=no], [data-act=cancel]');
      if (closeBtn) closeBtn.click(); else top.remove();
      sync();
      return;
    }
    if (body.classList.contains('chat-open')) {
      const back = document.querySelector('#back-btn');
      if (back) back.click();
      sync();
    }
  });

  new MutationObserver(sync).observe(body, { attributes: true, attributeFilter: ['class'] });
  if (modalRoot) new MutationObserver(sync).observe(modalRoot, { childList: true });
  if (lightbox) new MutationObserver(sync).observe(lightbox, { attributes: true, attributeFilter: ['class'] });
}

export function v21Boot(openChat) {
  window.MSP_VERSION = VERSION;
  const v = document.querySelector('#app-version');
  if (v) v.textContent = VERSION;
  if (booted) return;
  booted = true;
  markEnvironment();
  lockViewport();
  try { wireBackButton(); } catch (e) { console.warn('back:', e); }
  askNotifyPermissionOnTap();
  if (openChat) listenNotificationClicks(openChat);
}

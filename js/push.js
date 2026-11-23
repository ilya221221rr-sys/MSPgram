// ============================================================
//  MSPgram v21: системные уведомления, которые РАБОТАЮТ на Android/APK
//  На телефоне `new Notification()` не работает — бросает ошибку
//  «Illegal constructor». Нужно показывать через Service Worker.
// ============================================================

async function getReg() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((r) => setTimeout(() => r(null), 2500)),
    ]);
    return reg || null;
  } catch { return null; }
}

export function canNotify() {
  return 'Notification' in window && Notification.permission === 'granted';
}

export async function showSystemNotification({
  title, body = '', tag = '', chatId = null, icon = 'icons/icon-192.png',
  requireInteraction = false, renotify = false, vibrate = [200, 100, 200],
}) {
  if (!canNotify()) return false;
  const opts = {
    body, icon, badge: 'icons/icon-192.png', tag: tag || undefined,
    renotify: !!(tag && renotify), requireInteraction, vibrate,
    data: { chatId, tag, url: './' },
  };
  const reg = await getReg();
  try {
    if (reg && reg.showNotification) { await reg.showNotification(title, opts); return true; }
  } catch (e) { console.warn('SW notify:', e.message); }
  try {
    const n = new Notification(title, opts);
    n.onclick = () => {
      window.focus();
      if (chatId) import('./utils.js').then(({ bus }) => bus.emit('open-chat', chatId));
      n.close();
    };
    return true;
  } catch { return false; }
}

export async function closeSystemNotification(tag) {
  try {
    const reg = await getReg();
    if (!reg || !reg.getNotifications) return;
    (await reg.getNotifications({ tag })).forEach((n) => n.close());
  } catch { /* */ }
}

/** Запрос разрешения: по первому касанию (браузеры требуют жест пользователя) */
export function askNotifyPermissionOnTap() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  const ask = () => {
    window.removeEventListener('pointerup', ask, true);
    window.removeEventListener('touchend', ask, true);
    window.removeEventListener('click', ask, true);
    Notification.requestPermission()
      .then((res) => { if (res === 'granted') import('./webpush.js').then((m) => m.syncPushSilently()).catch(() => {}); })
      .catch(() => {});
  };
  window.addEventListener('pointerup', ask, true);
  window.addEventListener('touchend', ask, true);
  window.addEventListener('click', ask, true);
}

/** Клик по уведомлению: Service Worker просит открыть нужный чат */
export function listenNotificationClicks(openChat) {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type === 'open-chat' && d.chatId) openChat(d.chatId);
    if (d.type === 'push-resubscribe') import('./webpush.js').then((m) => m.syncPushSilently()).catch(() => {});
  });
}

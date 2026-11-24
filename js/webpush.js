// ============================================================
//  MSPgram v22: настоящий Web Push (клиентская часть)
//  Подписывает устройство на push и сохраняет подписку в Supabase.
//  Отправляет сообщения Edge Function «send-push» (supabase/functions/send-push).
//  Публичный VAPID-ключ приложение берёт у самой функции — вписывать его не нужно
//  (можно и вручную: window.MSP_CONFIG.vapidPublicKey в js/config.js).
// ============================================================
import { getSb, state } from './api.js?v=26';

const FN = 'send-push';
const EP_KEY = 'msp_push_endpoint';

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function b64uToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function sameKey(buf, bytes) {
  if (!buf) return false;
  const a = new Uint8Array(buf);
  if (a.length !== bytes.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== bytes[i]) return false;
  return true;
}

async function getVapidKey() {
  const manual = (window.MSP_CONFIG && window.MSP_CONFIG.vapidPublicKey) || '';
  if (manual) return manual;
  try {
    const { data, error } = await getSb().functions.invoke(FN, { body: { type: 'vapid' } });
    if (!error && data && data.publicKey) {
      localStorage.setItem('msp_vapid', data.publicKey);
      return data.publicKey;
    }
  } catch { /* офлайн / функция не задеплоена */ }
  const cached = localStorage.getItem('msp_vapid');
  if (cached) return cached;
  throw new Error('Серверная часть push не настроена (Edge Function send-push)');
}

async function swReady() {
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise((r) => setTimeout(() => r(null), 6000)),
  ]);
  if (!reg) throw new Error('Service Worker не запущен');
  return reg;
}

/** Состояние для экрана настроек: unsupported | denied | default | off | on */
export async function getPushState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission === 'default') return 'default';
  try {
    const reg = await swReady();
    const sub = await reg.pushManager.getSubscription();
    return sub && localStorage.getItem(EP_KEY) === sub.endpoint ? 'on' : 'off';
  } catch { return 'off'; }
}

/** Подписать это устройство. silent=true — не спрашивать разрешение, работать только если оно уже выдано. */
export async function subscribePush({ silent = false } = {}) {
  if (!pushSupported()) throw new Error('Браузер не поддерживает push');
  if (!state.me) throw new Error('Сначала войди в аккаунт');
  if (Notification.permission !== 'granted') {
    if (silent) return null;
    const res = await Notification.requestPermission();
    if (res !== 'granted') return null;
  }
  const keyStr = await getVapidKey();
  const keyBytes = b64uToBytes(keyStr);
  const reg = await swReady();

  let sub = await reg.pushManager.getSubscription();
  // ключ сервера сменился — старая подписка недействительна
  if (sub && !sameKey(sub.options && sub.options.applicationServerKey, keyBytes)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes });

  const j = sub.toJSON();
  const { error } = await getSb().rpc('register_push', {
    p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth,
    p_ua: (navigator.userAgent || '').slice(0, 200),
  });
  if (error) throw new Error(error.message || 'Не удалось сохранить подписку (применена ли migration-11?)');
  localStorage.setItem(EP_KEY, j.endpoint);
  return sub;
}

/** При входе и запуске: тихо обновить подписку, если разрешение уже есть */
export async function syncPushSilently() {
  try {
    if (!pushSupported() || Notification.permission !== 'granted' || !state.me) return;
    await subscribePush({ silent: true });
  } catch (e) { console.warn('push sync:', e.message); }
}

/** При выходе из аккаунта: отвязать это устройство, чтобы чужие сообщения сюда не приходили */
export async function unregisterPush() {
  try {
    const ep = localStorage.getItem(EP_KEY);
    localStorage.removeItem(EP_KEY);
    if (!ep) return;
    await getSb().rpc('unregister_push', { p_endpoint: ep });
  } catch { /* не критично */ }
}

/** Тестовое уведомление «с сервера» (приходит как настоящий push) */
export async function sendTestPush() {
  const { data, error } = await getSb().functions.invoke(FN, { body: { type: 'test' } });
  if (error) throw new Error(error.message || 'Функция send-push недоступна');
  if (data && data.error) throw new Error(data.error);
  return data;
}

/** Исходящий звонок: будим телефон собеседника, даже если приложение закрыто */
export function pushCall({ chatId, callId, video }) {
  try {
    getSb().functions.invoke(FN, { body: { type: 'call', chatId, callId, video: !!video } }).catch(() => {});
  } catch { /* push необязателен: звонок и так идёт через realtime */ }
}

// Онлайн-статусы: Realtime Presence (в сети / отошёл / не беспокоить / невидимка)
// + heartbeat «был(а) в сети». Простой автопереход в «отошёл» через 5 минут без активности.
import { getSb, state, dbApi } from './api.js';
import { bus, setPrefs } from './utils.js';

let channel = null;
let heartbeat = null;
let unloadHandler = null;
let subscribed = false;
let idleTimer = null;
let autoAway = false;
let activityHandler = null;

const IDLE_MS = 5 * 60 * 1000;

function myStatus() {
  const s = state.me?.presence_status || 'online';
  if (s === 'online' && autoAway) return 'away';
  return s;
}

// публикуем себя в presence (невидимка — не публикуем вовсе)
export async function trackMe() {
  if (!channel || !subscribed || !state.me) return;
  const s = myStatus();
  setPrefs({ _dnd: s === 'dnd' });
  try {
    if (s === 'invisible') await channel.untrack();
    else await channel.track({ uid: state.me.id, status: s });
  } catch { /* связь моргнула */ }
}

export function startPresence() {
  if (channel) return;
  const sb = getSb();
  channel = sb.channel('msp-online', { config: { presence: { key: state.me.id } } });

  channel.on('presence', { event: 'sync' }, () => {
    const st = channel.presenceState();
    state.online = new Set(Object.keys(st));
    state.presence = new Map();
    for (const [uid, metas] of Object.entries(st)) {
      const meta = (metas && metas[metas.length - 1]) || {};
      state.presence.set(uid, meta.status || 'online');
    }
    bus.emit('presence');
  }).subscribe((status) => {
    if (status === 'SUBSCRIBED') { subscribed = true; trackMe(); }
  });

  // heartbeat: обновляем last_seen раз в минуту (ошибка сети не должна ломать запуск)
  const beat = () => { try { Promise.resolve(dbApi.touchLastSeen()).catch(() => {}); } catch { /* */ } };
  beat();
  heartbeat = setInterval(beat, 60000);
  unloadHandler = beat;
  window.addEventListener('beforeunload', unloadHandler);

  // автоотход
  const bump = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (autoAway) { autoAway = false; trackMe(); }
    idleTimer = setTimeout(() => { autoAway = true; trackMe(); }, IDLE_MS);
  };
  activityHandler = bump;
  ['mousemove', 'keydown', 'touchstart', 'click'].forEach((ev) => window.addEventListener(ev, bump, { passive: true }));
  bump();
}

export function stopPresence() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  autoAway = false;
  subscribed = false;
  if (activityHandler) {
    ['mousemove', 'keydown', 'touchstart', 'click'].forEach((ev) => window.removeEventListener(ev, activityHandler));
    activityHandler = null;
  }
  if (unloadHandler) window.removeEventListener('beforeunload', unloadHandler);
  unloadHandler = null;
  if (channel) {
    const sb = getSb();
    sb.removeChannel(channel).catch(() => {});
    channel = null;
  }
}

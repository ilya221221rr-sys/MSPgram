// Онлайн-статусы через Realtime Presence + heartbeat "был(а) в сети"
import { getSb, state, dbApi } from './api.js';
import { bus } from './utils.js';

let channel = null;
let heartbeat = null;
let unloadHandler = null;

export function startPresence() {
  if (channel) return;
  const sb = getSb();
  channel = sb.channel('msp-online', { config: { presence: { key: state.me.id } } });

  channel.on('presence', { event: 'sync' }, () => {
    state.online = new Set(Object.keys(channel.presenceState()));
    bus.emit('presence');
  }).subscribe();

  // heartbeat: обновляем last_seen раз в минуту
  const beat = () => dbApi.touchLastSeen();
  beat();
  heartbeat = setInterval(beat, 60000);
  unloadHandler = beat;
  window.addEventListener('beforeunload', unloadHandler);
}

export function stopPresence() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  if (unloadHandler) window.removeEventListener('beforeunload', unloadHandler);
  unloadHandler = null;
  if (channel) {
    const sb = getSb();
    sb.removeChannel(channel).catch(() => {});
    channel = null;
  }
}

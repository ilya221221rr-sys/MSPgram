// MSPgram Calls v20: 1-на-1 аудио/видеозвонки + голосовые каналы серверов (WebRTC)
// Сигналинг — через Supabase Realtime broadcast, медиа — P2P (STUN/TURN), свой сервер не нужен.
//
// Новое в v20:
//  • камеру можно включить/выключить прямо во время обычного (аудио) звонка — без пересоздания соединения
//    (видео-«слот» создаётся сразу, потом в него подставляется дорожка камеры → никаких лагов и пауз);
//  • звонок можно СВЕРНУТЬ в плашку и пользоваться приложением; в фоне работают
//    «картинка в картинке», Media Session (кнопка «завершить» в шторке), блокировка засыпания экрана;
//  • авто-восстановление связи (ICE restart) при смене сети / возврате в приложение —
//    звонок больше не сбрасывается от короткой потери связи;
//  • история звонков пишется в чат карточкой (см. callcard.js);
//  • мягкие настройки видео (≈640×360, ≤24 к/с, ≤0.8 Мбит/с, maintain-framerate) — меньше лагов.
import { getSb, state, otherMember, memberProfile, chatTitleFor, isSavedChat, dbApi } from './api.js';
import { el, qs, toast, avatarHTML, esc, fmtDuration } from './utils.js';
import { icon } from './icons.js';
import { callBody } from './callcard.js';
import { startRingtone, stopRingtone } from './ringtone.js';
import { pushCall } from './webpush.js';

const ICE = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
    // Бесплатный TURN (обходит строгий NAT — без него многие соединения не проходят)
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle',
};

// ---------- состояние модуля ----------
let ringChan = null;          // мой канал входящих звонков
let call = null;              // активный звонок 1:1
let voice = null;             // голосовой канал {chan, peers: Map(uid->{pc,audio}), ...}
let localStream = null;
let micMuted = false;
let camOff = false;           // используется голосовым каналом
let deafened = false;
let wakeLock = null;

const camConstraints = (facing = 'user') => ({
  facingMode: facing,
  // умеренное качество — меньше лагов на слабых устройствах и каналах
  width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 24 },
});

export const inCall = () => !!call;

// ================== ЗВОНОК 1:1 ==================

async function getMedia(video) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: video ? camConstraints('user') : false,
    });
  } catch {
    toast('Нет доступа к микрофону/камере. Разреши доступ в браузере.');
    return null;
  }
}

function stopStream(s) {
  if (s) s.getTracks().forEach((t) => t.stop());
}

// ограничиваем битрейт/частоту — стабильнее на слабом интернете
function tuneVideoSender(sender) {
  try {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = 800000;
    p.encodings[0].maxFramerate = 24;
    p.degradationPreference = 'maintain-framerate';
    sender.setParameters(p).catch(() => {});
  } catch { /* не поддерживается */ }
}

// ---------- интерфейс звонка ----------
function callOverlay(c, { remote, incoming }) {
  const name = remote ? (remote.display_name || remote.nickname || '') : '';
  const o = el(`
    <div class="call-overlay in-call" id="call-overlay">
      <video id="call-remote-video" class="call-remote-video" autoplay playsinline></video>
      <div class="call-shade"></div>
      <div class="call-stage">
        <button class="call-top-btn" id="call-min" title="Свернуть — звонок продолжится">${icon('minimize', 20)}</button>
        <div class="call-avatar-wrap">
          ${avatarHTML(remote?.avatar_url, name || '?', 'xl', false)}
        </div>
        <div class="call-info">
          <div class="call-name">${esc(name)}</div>
          <div class="call-status" id="call-status">${incoming ? 'Соединение…' : 'Вызываю…'}</div>
        </div>
        <video id="call-local-video" class="call-local-video mirror" autoplay playsinline muted></video>
        <div class="call-controls">
          <button class="call-btn" id="call-mute" title="Микрофон">${icon('mic', 22)}</button>
          <button class="call-btn" id="call-cam" title="Включить камеру">${icon('video', 22)}</button>
          <button class="call-btn" id="call-flip" title="Перевернуть камеру">${icon('flip', 22)}</button>
          <button class="call-btn" id="call-pip" title="Видео поверх других приложений">${icon('pip', 22)}</button>
          <button class="call-btn danger big" id="call-hangup" title="Завершить"><span class="hang-ic">${icon('phone', 26)}</span></button>
          <button class="call-btn" id="call-expand" title="Развернуть">${icon('expand', 20)}</button>
        </div>
      </div>
    </div>`);
  document.body.appendChild(o);
  c.overlay = o;
  return o;
}

function callStatus(txt) {
  const s = qs('#call-status');
  if (s) s.textContent = txt;
}

function paintStatus(c) {
  const s = qs('#call-status');
  if (!s || call !== c) return;
  if (c.note) s.textContent = c.note;
  else if (c.connected) s.textContent = fmtDuration((Date.now() - c.startedAt) / 1000);
}

function startTimer(c) {
  clearInterval(c.timer);
  c.timer = setInterval(() => paintStatus(c), 1000);
  paintStatus(c);
}

// обновляет внешний вид по состоянию камер
function syncUI(c) {
  const o = c.overlay;
  if (!o || call !== c) return;
  o.classList.toggle('cam-local', !!c.camOn);
  o.classList.toggle('cam-remote', !!c.remoteCam);
  const cam = qs('#call-cam', o);
  if (cam) { cam.classList.toggle('on', !!c.camOn); cam.title = c.camOn ? 'Выключить камеру' : 'Включить камеру'; }
  const lv = qs('#call-local-video', o);
  if (lv) {
    lv.classList.toggle('mirror', c.facing === 'user');
    const vt = localStream?.getVideoTracks()[0];
    const want = c.camOn && vt ? new MediaStream([vt]) : null;
    if (want) { if (!lv.srcObject || lv.srcObject.getVideoTracks()[0] !== vt) lv.srcObject = want; lv.play?.().catch(() => {}); }
    else lv.srcObject = null;
  }
  const flip = qs('#call-flip', o);
  if (flip) flip.classList.toggle('hidden', !(c.camOn && matchMedia('(pointer:coarse)').matches));
  const pip = qs('#call-pip', o);
  if (pip) pip.classList.toggle('hidden', !(c.remoteCam && pipSupported()));
}

function setMini(on) {
  if (!call || !call.overlay) return;
  call.mini = on;
  call.overlay.classList.toggle('mini', on);
  document.body.classList.toggle('call-mini', on);
}

function toggleMute() {
  micMuted = !micMuted;
  localStream?.getAudioTracks().forEach((t) => { t.enabled = !micMuted; });
  qs('#call-mute')?.classList.toggle('off', micMuted);
}

// ---------- камера во время звонка ----------
async function setCam(c, on, facing) {
  if (!localStream || call !== c || c.camBusy) return;
  c.camBusy = true;
  try {
    if (on) {
      const f = facing || c.facing || 'user';
      const s = await navigator.mediaDevices.getUserMedia({ video: camConstraints(f) });
      const track = s.getVideoTracks()[0];
      localStream.getVideoTracks().forEach((t) => { t.stop(); localStream.removeTrack(t); });
      localStream.addTrack(track);
      c.facing = f;
      c.camOn = true;
      c.usedVideo = true;
      if (c.videoSender) { await c.videoSender.replaceTrack(track); tuneVideoSender(c.videoSender); }
    } else {
      localStream.getVideoTracks().forEach((t) => { t.stop(); localStream.removeTrack(t); });
      c.camOn = false;
      if (c.videoSender) await c.videoSender.replaceTrack(null);
    }
    sendCallEvent('call-cam', { callId: c.id, on: c.camOn });
  } catch (e) {
    console.warn('setCam:', e);
    toast('Не удалось включить камеру. Проверь разрешение в браузере.');
  } finally {
    c.camBusy = false;
    syncUI(c);
  }
}

// ---------- картинка-в-картинке и фон ----------
function pipSupported() {
  const v = qs('#call-remote-video');
  return !!(document.pictureInPictureEnabled || (v && typeof v.webkitSetPresentationMode === 'function'));
}
async function togglePip() {
  const v = qs('#call-remote-video');
  if (!v) return;
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (document.pictureInPictureEnabled) await v.requestPictureInPicture();
    else if (typeof v.webkitSetPresentationMode === 'function') {
      v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
    }
  } catch { toast('Окно поверх приложений недоступно в этом браузере'); }
}

async function holdAwake() {
  try {
    if (wakeLock || !('wakeLock' in navigator)) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* не поддерживается / запрещено */ }
}
function releaseAwake() {
  try { wakeLock?.release(); } catch { /* */ }
  wakeLock = null;
}

function setMediaSession(c) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: `Звонок · ${c.otherName || 'MSPgram'}`,
      artist: 'MSPgram',
      artwork: [{ src: new URL('../icons/icon-192.png', import.meta.url).href, sizes: '192x192', type: 'image/png' }],
    });
    navigator.mediaSession.playbackState = 'playing';
  } catch { /* */ }
  const handlers = [['hangup', () => hangup(c)], ['togglemicrophone', toggleMute], ['enterpictureinpicture', togglePip]];
  handlers.forEach(([a, fn]) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch { /* нет такого действия */ } });
}
function clearMediaSession() {
  if (!('mediaSession' in navigator)) return;
  ['hangup', 'togglemicrophone', 'enterpictureinpicture'].forEach((a) => { try { navigator.mediaSession.setActionHandler(a, null); } catch { /* */ } });
  try { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; } catch { /* */ }
}

document.addEventListener('visibilitychange', () => {
  const c = call;
  if (!c) return;
  if (document.visibilityState === 'hidden') {
    // ушли из приложения: видео собеседника — в окно поверх всего
    if (c.remoteCam && document.pictureInPictureEnabled && !document.pictureInPictureElement) {
      qs('#call-remote-video')?.requestPictureInPicture?.().catch(() => {});
    }
  } else {
    holdAwake();
    if (document.pictureInPictureElement && c.autoPip) document.exitPictureInPicture().catch(() => {});
    if (c.connected && !isLive(c)) requestRestart(c);
  }
});
window.addEventListener('online', () => { if (call && call.connected && !isLive(call)) requestRestart(call); });

function bindCallControls(c) {
  const o = c.overlay;
  qs('#call-mute', o).addEventListener('click', toggleMute);
  qs('#call-cam', o).addEventListener('click', () => setCam(c, !c.camOn));
  qs('#call-flip', o).addEventListener('click', () => setCam(c, true, c.facing === 'user' ? 'environment' : 'user'));
  qs('#call-pip', o).addEventListener('click', togglePip);
  qs('#call-min', o).addEventListener('click', () => setMini(true));
  qs('#call-expand', o).addEventListener('click', () => setMini(false));
  qs('#call-hangup', o).addEventListener('click', () => hangup(c));
  // клик по свёрнутой плашке — развернуть
  o.addEventListener('click', (e) => { if (c.mini && !e.target.closest('button')) setMini(false); });
}

// ---------- общие части звонка (оба участника) ----------
function newPc(c) {
  const pc = new RTCPeerConnection(ICE);
  c.pc = pc;
  c.pendingIce = [];
  c.localCand = [];
  c.remoteStream = new MediaStream();
  const rv = qs('#call-remote-video', c.overlay);
  if (rv) { rv.srcObject = c.remoteStream; rv.play?.().catch(() => {}); }

  pc.ontrack = (e) => {
    if (!c.remoteStream.getTracks().includes(e.track)) c.remoteStream.addTrack(e.track);
    const v = qs('#call-remote-video', c.overlay);
    if (v) { if (v.srcObject !== c.remoteStream) v.srcObject = c.remoteStream; v.play?.().catch(() => {}); }
  };
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    const cj = e.candidate.toJSON();
    c.localCand.push(cj);
    sendCallEvent('call-ice', { callId: c.id, candidate: cj });
  };
  const onState = () => {
    if (call !== c) return;
    const st = pc.connectionState && pc.connectionState !== 'new' ? pc.connectionState : pc.iceConnectionState;
    if (st === 'connected' || st === 'completed') {
      clearTimeout(c.discTimer); clearTimeout(c.deadTimer); c.deadTimer = null;
      c.note = '';
      markConnected(c);
      paintStatus(c);
    } else if (st === 'connecting' || st === 'checking') {
      if (!c.connected) callStatus('Соединение…');
    } else if (st === 'disconnected') {
      onLost(c, false);
    } else if (st === 'failed') {
      onLost(c, true);
    } else if (st === 'closed') {
      cleanupCall(c.connected ? 'ended' : 'failed');
    }
  };
  pc.onconnectionstatechange = onState;
  pc.oniceconnectionstatechange = onState;
  return pc;
}

const isLive = (c) => {
  const st = c.pc && (c.pc.connectionState && c.pc.connectionState !== 'new' ? c.pc.connectionState : c.pc.iceConnectionState);
  return st === 'connected' || st === 'completed';
};

function markConnected(c) {
  if (c.connected) return;
  c.connected = true;
  c.startedAt = Date.now();
  stopRingtone();
  clearTimeout(c.ringTimeout);
  c.overlay?.classList.add('connected');
  startTimer(c);
  holdAwake();
  setMediaSession(c);
  sendCallEvent('call-cam', { callId: c.id, on: !!c.camOn }); // синхронизируем состояние камер
}

function onLost(c, hard) {
  if (!c.connected) {
    if (hard) { toast('Не удалось соединить устройства (NAT). Смени сеть (Wi‑Fi ↔ мобильный интернет) и попробуй снова', 6000); cleanupCall('failed'); }
    return;
  }
  c.note = hard ? 'Нет связи — переподключаюсь…' : 'Связь потеряна — восстанавливаю…';
  paintStatus(c);
  clearTimeout(c.discTimer);
  c.discTimer = setTimeout(() => requestRestart(c), hard ? 300 : 3000);
  if (!c.deadTimer) {
    // ждём восстановления до 45 секунд — потом сдаёмся
    c.deadTimer = setTimeout(() => {
      if (call === c && !isLive(c)) { toast('Связь потеряна — звонок завершён'); cleanupCall('ended'); }
    }, 45000);
  }
}

// перезапуск ICE: звонивший делает новый offer, принявший — просит его об этом
function requestRestart(c) {
  if (call !== c || !c.pc) return;
  if (c.role === 'caller') iceRestart(c);
  else sendCallEvent('call-need-restart', { callId: c.id });
}

async function iceRestart(c) {
  const pc = c.pc;
  if (call !== c || !pc || Date.now() - (c.lastRestart || 0) < 6000) return;
  c.lastRestart = Date.now();
  try {
    if (pc.signalingState === 'have-local-offer') await pc.setLocalDescription({ type: 'rollback' });
    if (pc.restartIce) pc.restartIce();
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    await waitIce(pc, 2000);
    sendCallEvent('call-renego', { callId: c.id, sdp: pc.localDescription.sdp });
  } catch (e) { console.warn('iceRestart:', e); }
}

async function addIce(c, cand) {
  if (!cand) return;
  if (c.pc && c.pc.remoteDescription) { try { await c.pc.addIceCandidate(cand); } catch { /* дубликат/поздний */ } }
  else c.pendingIce.push(cand);
}
async function flushIce(c, extra = []) {
  const all = [...(c.pendingIce || []), ...extra];
  c.pendingIce = [];
  for (const cd of all) { try { await c.pc.addIceCandidate(cd); } catch { /* дубликат */ } }
}

// видео-«слот»: сразу создаём видео-линию, чтобы камеру можно было включить без пересогласования
function prepareVideoSender(c, pc) {
  let vs = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
  if (!vs) {
    const tr = pc.getTransceivers().find((t) => t.receiver?.track?.kind === 'video' && !t.sender.track && t.currentDirection !== 'stopped');
    if (tr) {
      tr.direction = 'sendrecv';
      vs = tr.sender;
      try { vs.setStreams?.(localStream); } catch { /* */ }
    } else {
      vs = pc.addTransceiver('video', { direction: 'sendrecv', streams: [localStream] }).sender;
    }
  }
  c.videoSender = vs;
  tuneVideoSender(vs);
}

// события, общие для звонящего и принимающего
function wireCommon(chan, c) {
  return chan
    .on('broadcast', { event: 'call-ice' }, ({ payload }) => {
      if (call !== c || payload.callId !== c.id) return;
      addIce(c, payload.candidate);
    })
    .on('broadcast', { event: 'call-hangup' }, ({ payload }) => {
      if (call !== c || payload.callId !== c.id) return;
      toast('Звонок завершён');
      cleanupCall(c.connected ? 'ended' : (c.role === 'caller' ? 'declined' : 'missed'));
    })
    .on('broadcast', { event: 'call-cam' }, ({ payload }) => {
      if (call !== c || payload.callId !== c.id) return;
      c.remoteCam = !!payload.on;
      if (c.remoteCam) c.usedVideo = true;
      syncUI(c);
    })
    // принимающий: звонящий прислал новый offer (восстановление связи)
    .on('broadcast', { event: 'call-renego' }, async ({ payload }) => {
      if (call !== c || c.role !== 'callee' || payload.callId !== c.id || !c.pc) return;
      try {
        const pc = c.pc;
        if (pc.signalingState === 'have-local-offer') await pc.setLocalDescription({ type: 'rollback' });
        await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
        await flushIce(c);
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        await waitIce(pc, 1500);
        sendCallEvent('call-renego-answer', { callId: c.id, sdp: pc.localDescription.sdp });
      } catch (e) { console.warn('renego:', e); }
    })
    // звонящий: получил ответ на восстановление / просьбу о нём
    .on('broadcast', { event: 'call-renego-answer' }, async ({ payload }) => {
      if (call !== c || c.role !== 'caller' || payload.callId !== c.id || !c.pc) return;
      try {
        if (c.pc.signalingState === 'have-local-offer') {
          await c.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
          await flushIce(c);
        }
      } catch (e) { console.warn('renego answer:', e); }
    })
    .on('broadcast', { event: 'call-need-restart' }, ({ payload }) => {
      if (call !== c || c.role !== 'caller' || payload.callId !== c.id) return;
      iceRestart(c);
    });
}

// ---------- инициатор ----------
export async function startCall(chat, withVideo) {
  if (call || voice) {
    if (call) setMini(false);
    toast('Ты уже в звонке или голосовом канале');
    return;
  }
  if (!chat || chat.type !== 'direct' || isSavedChat(chat)) return;
  const other = otherMember(chat);
  if (!other) return;

  localStream = await getMedia(withVideo);
  if (!localStream) return;

  const callId = (crypto.randomUUID && crypto.randomUUID()) || Math.random().toString(36).slice(2);
  const myName = state.me.display_name || state.me.nickname;
  const remoteName = other.display_name || `@${other.nickname}`;

  const sb = getSb();
  const chan = sb.channel(`call-${callId}`);
  const c = {
    id: callId, role: 'caller', chan, chatId: chat.id, otherId: other.id, otherName: remoteName,
    video: withVideo, usedVideo: withVideo, camOn: withVideo, remoteCam: false, facing: 'user',
    pc: null, overlay: null, connected: false, mini: false, note: '',
  };
  call = c;
  callOverlay(c, { remote: other, incoming: false });
  bindCallControls(c);
  syncUI(c);
  startRingtone('out'); // гудки, пока собеседник не ответил

  wireCommon(chan, c)
    .on('broadcast', { event: 'call-accept' }, async ({ payload }) => {
      if (call !== c || payload.callId !== c.id || c.pc) return; // c.pc: защита от двойного accept
      stopRingtone(); // собеседник ответил — гудки замолкают
      callStatus('Соединение…');
      await makePeerCaller(c);
    })
    .on('broadcast', { event: 'call-reject' }, ({ payload }) => {
      if (call !== c || payload.callId !== c.id) return;
      const out = payload.busy ? 'busy' : payload.timeout ? 'missed' : 'declined';
      cleanupCall(out);
      toast(payload.busy ? `${remoteName} сейчас занят(а)` : payload.timeout ? `${remoteName} не ответил(а)` : `${remoteName} отклонил(а) звонок`);
    })
    .on('broadcast', { event: 'call-answer' }, async ({ payload }) => {
      if (call !== c || payload.callId !== c.id || !c.pc) return;
      try {
        await c.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        await flushIce(c, payload.candidates || []);
      } catch (e) { console.warn(e); }
    })
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        // во время идущего разговора канал сигналинга сам переподключится — не рвём звонок
        if (call === c && !c.connected) { toast('Ошибка связи при звонке — проверь интернет'); cleanupCall('failed'); }
      }
    });

  // звоним (сигнал собеседнику)
  await sendRingEvent(other.id, 'ring', {
    callId, video: withVideo, from: myName, avatar: state.me.avatar_url || '', chatId: chat.id,
  });
  // v22: настоящий push — разбудит телефон собеседника, даже если приложение закрыто
  pushCall({ chatId: chat.id, callId, video: withVideo });

  // таймаут: 40 сек без ответа
  c.ringTimeout = setTimeout(() => {
    if (call === c && !c.connected) {
      sendRingEvent(other.id, 'call-cancel', { callId });
      sendCallEvent('call-hangup', { callId });
      cleanupCall('missed');
      toast('Не дозвонился. Попроси собеседника обновить страницу и проверь интернет');
    }
  }, 40000);
}

async function makePeerCaller(c) {
  const pc = newPc(c);
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  prepareVideoSender(c, pc);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIce(pc); // ждём кандидаты — оффер уходит сразу «полным»
  sendCallEvent('call-offer', { callId: c.id, sdp: pc.localDescription.sdp, candidates: c.localCand });
}

export function hangup(c = call) {
  if (!c || call !== c) return;
  sendCallEvent('call-hangup', { callId: c.id });
  if (!c.connected && c.role === 'caller' && c.otherId) sendRingEvent(c.otherId, 'call-cancel', { callId: c.id });
  cleanupCall(c.connected ? 'ended' : (c.role === 'caller' ? 'cancelled' : 'declined'));
}
export const acceptCall = async () => {};
export const rejectCall = () => hangup();

// ---------- обработка входящих (подписка один раз) ----------
let ringSubscribed = false;

export function initCallsUI() {
  // безопасно вызывать когда угодно: подпишемся, как только появится профиль
  if (state.me && state.me.id) subscribeRing();
}

export function ensureCallsReady() {
  if (state.me && state.me.id && !ringSubscribed) subscribeRing();
}

export function stopCalls() {
  if (ringChan) {
    getSb().removeChannel(ringChan).catch(() => {});
    ringChan = null;
  }
  ringSubscribed = false;
}

function subscribeRing() {
  if (ringSubscribed) return;
  ringSubscribed = true;
  const sb = getSb();
  ringChan = sb.channel(`ring-${state.me.id}`);
  ringChan.on('broadcast', { event: 'ring' }, ({ payload }) => {
    if (!payload) return;
    if (call || voice) {
      // занят — сразу отклоняем (звонящий увидит «занят» в истории)
      rejectRing(payload, { busy: true });
      return;
    }
    showIncomingRing(payload);
  }).on('broadcast', { event: 'call-cancel' }, ({ payload }) => {
    const ov = qs('#ring-overlay');
    if (ov && payload && ov.dataset.callid === payload.callId) { ov.remove(); stopRingtone(); }
  }).subscribe((status) => {
    // если канал входящих умер — через 2 сек пересоздаём (иначе звонки не доходят)
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      setTimeout(() => { stopCalls(); if (state.me && state.me.id) subscribeRing(); }, 2000);
    }
  });
}

function showIncomingRing(p) {
  if (qs('#ring-overlay')) return;
  const o = el(`
    <div class="call-overlay ring" id="ring-overlay" data-callid="${esc(p.callId)}">
      <div class="call-stage">
        <div class="call-avatar-wrap pulse">
          ${p.avatar
    ? `<img class="avatar xl" src="${esc(p.avatar)}" alt="">`
    : `<span class="avatar xl" style="background:linear-gradient(135deg,var(--accent),var(--accent2))">${esc((p.from || '?')[0].toUpperCase())}</span>`}
        </div>
        <div class="call-info">
          <div class="call-name">${esc(p.from || 'Неизвестный')}</div>
          <div class="call-status">${p.video ? '📹 Видеозвонок…' : '📞 Аудиозвонок…'}</div>
        </div>
        <div class="call-controls">
          <button class="call-btn danger big" id="ring-reject" title="Отклонить">${icon('x', 26)}</button>
          <button class="call-btn accept big" id="ring-accept" title="Принять">${icon('phone', 26)}</button>
        </div>
      </div>
    </div>`);
  document.body.appendChild(o);
  // рингтон + вибрация (+ системное уведомление, если приложение свёрнуто)
  startRingtone('in', {
    title: `${p.from || 'Кто-то'} звонит`,
    body: p.video ? '📹 Входящий видеозвонок' : '📞 Входящий звонок',
  });
  o.querySelector('#ring-reject').addEventListener('click', () => {
    stopRingtone();
    rejectRing(p);
    o.remove();
  });
  o.querySelector('#ring-accept').addEventListener('click', async () => {
    stopRingtone();
    o.remove();
    await answerRing(p);
  });
  setTimeout(() => {
    if (qs(`#ring-overlay[data-callid="${p.callId}"]`)) {
      stopRingtone();
      rejectRing(p, { timeout: true });
      o.remove();
    }
  }, 45000);
}

function rejectRing(p, extra = {}) {
  const sb = getSb();
  const ch = sb.channel(`call-${p.callId}`);
  sendOn(ch, 'call-reject', { callId: p.callId, ...extra }).catch(() => {}).then(() => {
    sb.removeChannel(ch).catch(() => {});
  });
}

async function answerRing(p) {
  if (call || voice) { rejectRing(p, { busy: true }); return; }
  localStream = await getMedia(p.video);
  if (!localStream) { rejectRing(p); return; }

  const sb = getSb();
  const chan = sb.channel(`call-${p.callId}`);
  const c = {
    id: p.callId, role: 'callee', chan, chatId: p.chatId || null, otherId: null, otherName: p.from || 'Собеседник',
    video: p.video, usedVideo: !!p.video, camOn: !!p.video, remoteCam: false, facing: 'user',
    pc: null, overlay: null, connected: false, mini: false, note: '',
  };
  call = c;
  callOverlay(c, { remote: { display_name: p.from, avatar_url: p.avatar || '' }, incoming: true });
  bindCallControls(c);
  syncUI(c);

  wireCommon(chan, c)
    .on('broadcast', { event: 'call-offer' }, async ({ payload }) => {
      if (call !== c || payload.callId !== c.id || c.pc) return; // защита от повторного offer
      try {
        const pc = newPc(c);
        localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
        await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
        prepareVideoSender(c, pc);
        await flushIce(c, payload.candidates || []);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitIce(pc);
        sendCallEvent('call-answer', { callId: c.id, sdp: pc.localDescription.sdp, candidates: c.localCand });
      } catch (e) {
        console.warn('offer:', e);
        toast('Не удалось принять звонок');
        cleanupCall('failed');
      }
    })
    .subscribe((status) => {
      // КЛЮЧЕВОЙ ФИКС: сообщаем инициатору, что приняли —
      // без этого он не создаёт offer и звонок «не работает»
      if (status === 'SUBSCRIBED' && call === c) {
        sendOn(chan, 'call-accept', { callId: c.id }).catch(() => {});
        callStatus('Соединение…');
      }
    });

  // если соединение так и не поднялось — выходим сами
  c.ringTimeout = setTimeout(() => {
    if (call === c && !c.connected) { toast('Не удалось соединиться'); cleanupCall('failed'); }
  }, 40000);
}

function sendCallEvent(event, payload) {
  if (!call) return;
  sendOn(call.chan, event, payload).catch(() => {});
}

function sendOn(chan, event, payload) {
  return chan.send({ type: 'broadcast', event, payload });
}

// сообщение на личный канал входящих пользователя (ring / call-cancel)
async function sendRingEvent(userId, event, payload) {
  const sb = getSb();
  const rc = sb.channel(`ring-${userId}`);
  await Promise.race([
    sendWhenJoined(rc, event, payload),
    new Promise((r) => setTimeout(r, 10000)), // защита от «повисшего» канала
  ]);
  sb.removeChannel(rc).catch(() => {});
}

// ждём завершения сбора ICE-кандидатов (максимум ms мс)
function waitIce(pc, ms = 1500) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const timer = setTimeout(resolve, ms);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
    });
  });
}

function sendWhenJoined(chan, event, payload) {
  return new Promise((resolve) => {
    chan.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await chan.send({ type: 'broadcast', event, payload }).catch(() => {});
        resolve();
      }
    });
    setTimeout(resolve, 3000); // не зависаем, если канал не поднялся
  });
}

// ---------- запись звонка в историю чата ----------
async function logCall(c, outcome) {
  if (!c.chatId || c.logged) return;
  c.logged = true;
  const dur = c.connected && c.startedAt ? Date.now() - c.startedAt : 0;
  const kind = c.usedVideo ? 'video' : 'audio';
  const out = c.connected ? 'ended' : outcome;
  try {
    const m = await dbApi.sendMessage(c.chatId, {
      body: callBody(out, kind, dur),
      attachment: { attachment_type: 'call', attachment_name: `${out}:${kind}`, attachment_url: '', duration_ms: dur },
    });
    const cv = await import('./chatview.js');
    cv.onNewMessage(m);
  } catch (e) { console.warn('история звонка:', e); }
}

function cleanupCall(outcome = 'ended') {
  const c = call;
  if (!c) return;
  call = null; // сначала обнуляем: обработчики состояния WebRTC дальше сами выйдут
  stopRingtone();
  clearInterval(c.timer);
  clearTimeout(c.ringTimeout);
  clearTimeout(c.discTimer);
  clearTimeout(c.deadTimer);
  if (c.pc) {
    c.pc.onconnectionstatechange = null;
    c.pc.oniceconnectionstatechange = null;
    c.pc.ontrack = null;
    try { c.pc.close(); } catch { /* */ }
  }
  getSb().removeChannel(c.chan).catch(() => {});
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  const rv = c.overlay && c.overlay.querySelector('#call-remote-video');
  if (rv) rv.srcObject = null;
  c.overlay?.remove();
  document.body.classList.remove('call-mini');
  stopStream(localStream);
  localStream = null;
  micMuted = false;
  camOff = false;
  releaseAwake();
  clearMediaSession();
  if (c.role === 'caller') logCall(c, outcome);
}

window.addEventListener('beforeunload', () => {
  if (call) sendCallEvent('call-hangup', { callId: call.id });
  if (voice) sendOn(voice.chan, 'voice-leave', { uid: state.me.id }).catch(() => {});
});

// ================== ГОЛОСОВОЙ КАНАЛ (mesh) ==================

export function inVoice() { return !!voice; }

export async function joinVoice(chat, withVideo = false) {
  if (call) { toast('Нельзя: идёт звонок'); return; }
  if (voice) { leaveVoice(); return; }
  const stream = await getMedia(withVideo);
  if (!stream) return;

  const sb = getSb();
  const chan = sb.channel(`voice-${chat.id}`);
  voice = { chan, chatId: chat.id, peers: new Map(), bar: null, stream, video: withVideo, localTile: null };
  if (withVideo) voice.localTile = makeTile('Ты', stream, true, true);

  chan.on('broadcast', { event: 'voice-hello' }, async ({ payload }) => {
    if (!voice || payload.uid === state.me.id) return;
    // уже соединены?
    if (voice.peers.has(payload.uid)) return;
    // существующие участники делают оффер новичку
    await makeVoicePeer(payload.uid, payload.name, true);
  }).on('broadcast', { event: 'voice-offer' }, async ({ payload }) => {
    if (!voice || payload.to !== state.me.id) return;
    let p = voice.peers.get(payload.from);
    if (!p) {
      p = await makeVoicePeer(payload.from, payload.name, false);
    }
    try {
      await p.pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
      const answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      sendOn(chan, 'voice-answer', { from: state.me.id, to: payload.from, sdp: p.pc.localDescription.sdp });
    } catch (e) { console.warn('voice offer:', e); }
  }).on('broadcast', { event: 'voice-answer' }, async ({ payload }) => {
    if (!voice || payload.to !== state.me.id) return;
    const p = voice.peers.get(payload.from);
    if (p) {
      try { await p.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp }); } catch (e) { console.warn(e); }
    }
  }).on('broadcast', { event: 'voice-ice' }, async ({ payload }) => {
    if (!voice || payload.to !== state.me.id) return;
    const p = voice.peers.get(payload.from);
    if (p) {
      try { await p.pc.addIceCandidate(payload.candidate); } catch { /* поздний */ }
    }
  }).on('broadcast', { event: 'voice-leave' }, ({ payload }) => {
    if (!voice || payload.uid === state.me.id) return;
    dropVoicePeer(payload.uid);
  }).subscribe(async () => {
    await sendOn(chan, 'voice-hello', { uid: state.me.id, name: myName() });
    renderVoiceBar();
    toast(`Голосовой канал «${chatTitleFor(chat)}» — ты в эфире 🎙`);
  });

  function myName() { return state.me.display_name || state.me.nickname; }

  async function makeVoicePeer(uid, name, isOfferer) {
    const pc = new RTCPeerConnection(ICE);
    const p = { pc, name, audio: null };
    voice.peers.set(uid, p);
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    pc.ontrack = (e) => {
      const [s] = e.streams;
      // видео собеседника — плитка в сетке группового звонка (звук идёт через неё же)
      if (e.track.kind === 'video') {
        if (p.audio) { try { p.audio.pause(); } catch { /* */ } p.audio = null; }
        if (!p.tile) p.tile = makeTile(p.name || 'участник', s, deafened, false);
        renderVoiceBar();
        return;
      }
      if (p.tile) return;
      const a = new Audio();
      a.srcObject = s;
      a.autoplay = true;
      a.muted = deafened;
      p.audio = a;
      a.play().catch(() => {});
      renderVoiceBar();
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) sendOn(chan, 'voice-ice', { from: state.me.id, to: uid, candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) dropVoicePeer(uid);
    };
    if (isOfferer) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendOn(chan, 'voice-offer', { from: state.me.id, to: uid, name: myName(), sdp: pc.localDescription.sdp });
    }
    renderVoiceBar();
    return p;
  }

  function dropVoicePeer(uid) {
    const p = voice?.peers.get(uid);
    if (!p) return;
    try { p.pc.close(); } catch { /* */ }
    if (p.audio) { try { p.audio.pause(); } catch { /* */ } }
    if (p.tile) p.tile.remove();
    voice.peers.delete(uid);
    renderVoiceBar();
  }
}

export function leaveVoice() {
  if (!voice) return;
  sendOn(voice.chan, 'voice-leave', { uid: state.me.id }).catch(() => {});
  voice.peers.forEach((p) => {
    try { p.pc.close(); } catch { /* */ }
    if (p.audio) { try { p.audio.pause(); } catch { /* */ } }
  });
  getSb().removeChannel(voice.chan).catch(() => {});
  stopStream(voice.stream);
  voice.bar?.remove();
  qs('#voice-grid')?.remove();
  qs('#voice-bar')?.remove();
  camOff = false;
  voice = null;
  micMuted = false;
  deafened = false;
}

// ---------- плашка голосового канала ----------
function renderVoiceBar() {
  if (!voice) return;
  let bar = qs('#voice-bar');
  if (!bar) {
    bar = el(`
      <div id="voice-bar" class="voice-bar">
        <div class="voice-bar-users" id="voice-users"></div>
        <div class="voice-bar-controls">
          <button class="call-btn sm" id="vb-mute" title="Микрофон">🎙</button>
          ${voice.video ? '<button class="call-btn sm" id="vb-cam" title="Камера">📹</button>' : ''}
          <button class="call-btn sm" id="vb-deaf" title="Звук">🔊</button>
          <button class="call-btn danger sm" id="vb-leave" title="Покинуть">⏻</button>
        </div>
      </div>`);
    document.body.appendChild(bar);
    bar.querySelector('#vb-mute').addEventListener('click', () => {
      micMuted = !micMuted;
      voice.stream.getAudioTracks().forEach((t) => { t.enabled = !micMuted; });
      bar.querySelector('#vb-mute').classList.toggle('off', micMuted);
    });
    bar.querySelector('#vb-cam')?.addEventListener('click', () => {
      camOff = !camOff;
      voice.stream.getVideoTracks().forEach((t) => { t.enabled = !camOff; });
      bar.querySelector('#vb-cam').classList.toggle('off', camOff);
      voice.localTile?.classList.toggle('cam-off', camOff);
    });
    bar.querySelector('#vb-deaf').addEventListener('click', () => {
      deafened = !deafened;
      voice.peers.forEach((p) => {
        if (p.audio) p.audio.muted = deafened;
        const v = p.tile && p.tile.querySelector('video');
        if (v) v.muted = deafened;
      });
      bar.querySelector('#vb-deaf').classList.toggle('off', deafened);
    });
    bar.querySelector('#vb-leave').addEventListener('click', () => leaveVoice());
  }
  const users = bar.querySelector('#voice-users');
  const me = state.me;
  users.innerHTML = `
    <span class="voice-user" title="Ты">
      <span class="vu-dot"></span>${esc(me.display_name || me.nickname)}${micMuted ? ' 🔇' : ''}
    </span>
    ${[...voice.peers.entries()].map(([uid, p]) => `
      <span class="voice-user" data-uid="${esc(uid)}">
        <span class="vu-dot"></span>${esc(p.name || 'участник')}
      </span>`).join('')}`;
  if (!voice) bar.remove();
  renderGrid();
}

// ---------- сетка видео группового звонка ----------
function makeTile(name, stream, muted, mirror) {
  const t = el(`<div class="vtile ${mirror ? 'mirror' : ''}"><video autoplay playsinline></video><span class="vtile-name">${esc(name)}</span></div>`);
  const v = t.querySelector('video');
  v.srcObject = stream; v.muted = muted;
  v.play().catch(() => {});
  return t;
}
function renderGrid() {
  if (!voice) return;
  const tiles = [];
  if (voice.video && voice.localTile) tiles.push(voice.localTile);
  voice.peers.forEach((p) => { if (p.tile) tiles.push(p.tile); });
  let grid = qs('#voice-grid');
  if (!tiles.length) { if (grid) grid.remove(); return; }
  if (!grid) { grid = el('<div id="voice-grid" class="voice-grid"></div>'); document.body.appendChild(grid); }
  grid.dataset.n = String(tiles.length);
  tiles.forEach((t) => { if (t.parentNode !== grid) grid.appendChild(t); });
  [...grid.children].forEach((c) => { if (!tiles.includes(c)) c.remove(); });
}

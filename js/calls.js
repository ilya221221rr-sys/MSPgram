// MSPgram Calls: 1-на-1 аудио/видеозвонки + голосовые каналы серверов (WebRTC)
// Сигналинг — через Supabase Realtime broadcast, медиа — P2P (STUN), сервер не нужен.
import { getSb, state, otherMember, memberProfile, chatTitleFor, isSavedChat } from './api.js';
import { el, qs, toast, avatarHTML, esc, fmtDuration } from './utils.js';

const ICE = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ],
};

// ---------- состояние модуля ----------
let ringChan = null;          // мой канал входящих звонков
let call = null;              // активный звонок {pc, chan, callId, video, ...}
let voice = null;             // голосовой канал {chan, peers: Map(uid->{pc,audio}), ...}
let localStream = null;
let micMuted = false;
let camOff = false;
let deafened = false;
let timerInt = null;

// ================== ЗВОНОК 1:1 ==================

async function getMedia(video) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: video ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
  } catch {
    toast('Нет доступа к микрофону/камере. Разреши доступ в браузере.');
    return null;
  }
}

function stopStream(s) {
  if (s) s.getTracks().forEach((t) => t.stop());
}

// ---------- интерфейс звонка ----------
function callOverlay({ remote, incoming, video }) {
  const o = el(`
    <div class="call-overlay" id="call-overlay">
      <div class="call-stage">
        <video id="call-remote-video" class="call-remote-video ${video ? '' : 'hidden'}" autoplay playsinline></video>
        <div class="call-avatar-wrap ${video ? 'video-bg' : ''}">
          ${avatarHTML(remote?.avatar_url, remote ? (remote.display_name || remote.nickname) : '?', 'xl', false)}
        </div>
        <div class="call-info">
          <div class="call-name">${esc(remote ? (remote.display_name || remote.nickname) : '')}</div>
          <div class="call-status" id="call-status">${incoming ? 'Входящий звонок…' : 'Соединение…'}</div>
        </div>
        <video id="call-local-video" class="call-local-video ${video ? '' : 'hidden'}" autoplay playsinline muted></video>
        <div class="call-controls">
          <button class="call-btn" id="call-mute" title="Микрофон">🎙</button>
          ${video ? '<button class="call-btn" id="call-cam" title="Камера">📷</button>' : ''}
          <button class="call-btn danger big" id="call-hangup" title="Завершить">📞</button>
        </div>
      </div>
    </div>`);
  document.body.appendChild(o);
  return o;
}

function callStatus(txt) {
  const s = qs('#call-status');
  if (s) s.textContent = txt;
}

function startTimer() {
  const s = qs('#call-status');
  const t0 = Date.now();
  clearInterval(timerInt);
  timerInt = setInterval(() => {
    if (s) s.textContent = fmtDuration((Date.now() - t0) / 1000);
  }, 1000);
}

function bindCallControls(callObj) {
  qs('#call-mute').addEventListener('click', () => {
    micMuted = !micMuted;
    localStream?.getAudioTracks().forEach((t) => { t.enabled = !micMuted; });
    qs('#call-mute').classList.toggle('off', micMuted);
  });
  const camBtn = qs('#call-cam');
  if (camBtn) camBtn.addEventListener('click', () => {
    camOff = !camOff;
    localStream?.getVideoTracks().forEach((t) => { t.enabled = !camOff; });
    camBtn.classList.toggle('off', camOff);
  });
  qs('#call-hangup').addEventListener('click', () => hangup(callObj));
}

// ---------- инициатор ----------
export async function startCall(chat, withVideo) {
  if (call || voice) { toast('Ты уже в звонке или голосовом канале'); return; }
  if (!chat || chat.type !== 'direct' || isSavedChat(chat)) return;
  const other = otherMember(chat);
  if (!other) return;

  localStream = await getMedia(withVideo);
  if (!localStream) return;

  const callId = (crypto.randomUUID && crypto.randomUUID())
    || Math.random().toString(36).slice(2);
  const myName = state.me.display_name || state.me.nickname;
  const remoteName = other.display_name || `@${other.nickname}`;

  // сигналлинг звонка
  const sb = getSb();
  const chan = sb.channel(`call-${callId}`);
  call = {
    id: callId, chan, video: withVideo, otherId: other.id, otherName: remoteName,
    pc: null, overlay: null, connected: false,
  };

  chan.on('broadcast', { event: 'call-accept' }, async ({ payload }) => {
    if (!call || payload.callId !== call.id) return;
    callStatus('Соединение…');
    await makePeer(call, true);
  }).on('broadcast', { event: 'call-reject' }, ({ payload }) => {
    if (!call || payload.callId !== call.id) return;
    cleanupCall();
    toast(`${remoteName} отклонил(а) звонок`);
  }).on('broadcast', { event: 'call-offer' }, async ({ payload }) => {
    // я инициатор — оффер мне не нужен
  }).on('broadcast', { event: 'call-answer' }, async ({ payload }) => {
    if (!call || payload.callId !== call.id || !call.pc) return;
    try { await call.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp }); } catch (e) { console.warn(e); }
  }).on('broadcast', { event: 'call-ice' }, async ({ payload }) => {
    if (!call || !call.pc || payload.callId !== call.id) return;
    try { await call.pc.addIceCandidate(payload.candidate); } catch { /* лед поздний */ }
  }).on('broadcast', { event: 'call-hangup' }, ({ payload }) => {
    if (!call || payload.callId !== call.id) return;
    cleanupCall();
    toast('Звонок завершён');
  }).subscribe();

  // звоним (сигнал собеседнику)
  const ringChan = sb.channel(`ring-${other.id}`);
  await sendWhenJoined(ringChan, 'ring', {
    callId, video: withVideo, from: myName, chatId: chat.id,
  });
  sb.removeChannel(ringChan).catch(() => {});

  // свой UI
  call.overlay = callOverlay({ remote: other, incoming: false, video: withVideo });
  bindCallControls(call);
  if (withVideo) {
    const lv = qs('#call-local-video', call.overlay);
    if (lv) lv.srcObject = localStream;
  }

  // таймаут: 45 сек без ответа
  call.ringTimeout = setTimeout(() => {
    if (call && !call.connected) {
      sendCallEvent('call-cancel', { callId: call.id });
      cleanupCall();
      toast('Не дозвонился');
    }
  }, 45000);
}

// ---------- принимающая сторона ----------
export async function acceptCall() {
  if (!call) return;
  callStatus('Соединение…');
  sendCallEvent('call-accept', { callId: call.id });
  await makePeer(call, false);
  startTimer();
}

export function rejectCall() {
  if (!call) return;
  sendCallEvent('call-reject', { callId: call.id });
  cleanupCall();
}

export function hangup(c = call) {
  if (!c) return;
  sendCallEvent('call-hangup', { callId: c.id });
  cleanupCall();
}

async function makePeer(c, isCaller) {
  const pc = new RTCPeerConnection(ICE);
  c.pc = pc;
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  const rv = qs('#call-remote-video');
  pc.ontrack = (e) => {
    const [stream] = e.streams;
    const av = qs('.call-avatar-wrap');
    if (av) av.classList.add('hidden');
    const v = qs('#call-remote-video');
    if (v && c.video) {
      v.srcObject = stream;
      v.classList.remove('hidden');
      callStatus('Соединено ✓');
      startTimer();
      call.connected = true;
    } else {
      // аудиозвонок — просто статус
      callStatus('Соединено ✓');
      startTimer();
      call.connected = true;
      const audio = new Audio();
      audio.srcObject = stream;
      audio.autoplay = true;
      audio._keepalive = true;
      audio.play().catch(() => {});
      c.remoteAudio = audio;
    }
    void stream;
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) sendCallEvent('call-ice', { callId: c.id, candidate: e.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && call === c) {
      if (pc.connectionState !== 'closed') cleanupCall();
    }
  };

  if (isCaller) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendCallEvent('call-offer', { callId: c.id, sdp: pc.localDescription.sdp });
  } else {
    // оффер придёт событием
  }
  void rv;
}

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
    if (!payload || call || voice) {
      // занят — сразу отклоняем
      if (payload) {
        const c2 = getSb().channel(`call-${payload.callId}`);
        sendOn(c2, 'call-reject', { callId: payload.callId }).then(() => {
          sb.removeChannel(c2).catch(() => {});
        });
      }
      return;
    }
    showIncomingRing(payload);
  }).on('broadcast', { event: 'call-cancel' }, ({ payload }) => {
    const ov = qs('#ring-overlay');
    if (ov && payload && ov.dataset.callid === payload.callId) ov.remove();
  }).subscribe();
}

function showIncomingRing(p) {
  if (qs('#ring-overlay')) return;
  const o = el(`
    <div class="call-overlay ring" id="ring-overlay" data-callid="${esc(p.callId)}">
      <div class="call-stage">
        <div class="call-avatar-wrap pulse">
          <span class="avatar xl" style="background:linear-gradient(135deg,var(--accent),var(--accent2))">${esc((p.from || '?')[0].toUpperCase())}</span>
        </div>
        <div class="call-info">
          <div class="call-name">${esc(p.from || 'Неизвестный')}</div>
          <div class="call-status">${p.video ? '📹 Видеозвонок…' : '📞 Аудиозвонок…'}</div>
        </div>
        <div class="call-controls">
          <button class="call-btn danger big" id="ring-reject" title="Отклонить">✕</button>
          <button class="call-btn accept big" id="ring-accept" title="Принять">📞</button>
        </div>
      </div>
    </div>`);
  document.body.appendChild(o);
  o.querySelector('#ring-reject').addEventListener('click', () => {
    rejectRing(p);
    o.remove();
  });
  o.querySelector('#ring-accept').addEventListener('click', async () => {
    o.remove();
    await answerRing(p);
  });
  setTimeout(() => {
    if (qs(`#ring-overlay[data-callid="${p.callId}"]`)) {
      rejectRing(p);
      o.remove();
    }
  }, 45000);
}

function rejectRing(p) {
  const sb = getSb();
  const c = sb.channel(`call-${p.callId}`);
  sendOn(c, 'call-reject', { callId: p.callId }).then(() => {
    sb.removeChannel(c).catch(() => {});
  });
}

async function answerRing(p) {
  if (call || voice) { rejectRing(p); return; }
  localStream = await getMedia(p.video);
  if (!localStream) { rejectRing(p); return; }

  const sb = getSb();
  const chan = sb.channel(`call-${p.callId}`);
  call = {
    id: p.callId, chan, video: p.video, otherId: null, otherName: p.from,
    pc: null, overlay: null, connected: false,
  };

  chan.on('broadcast', { event: 'call-offer' }, async ({ payload }) => {
    if (!call || payload.callId !== call.id) return;
    const pc = new RTCPeerConnection(ICE);
    call.pc = pc;
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    pc.ontrack = (e) => {
      const [stream] = e.streams;
      const av = qs('.call-avatar-wrap');
      if (av) av.classList.add('hidden');
      call.connected = true;
      if (call.video) {
        const v = qs('#call-remote-video');
        if (v) { v.srcObject = stream; v.classList.remove('hidden'); }
        callStatus('Соединено ✓');
      } else {
        const audio = new Audio();
        audio.srcObject = stream;
        audio.autoplay = true;
        call.remoteAudio = audio;
        callStatus('Соединено ✓');
      }
      startTimer();
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) sendCallEvent('call-ice', { callId: call.id, candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected'].includes(pc.connectionState) && call) cleanupCall();
    };
    await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendCallEvent('call-answer', { callId: call.id, sdp: pc.localDescription.sdp });
    if (call.video) {
      const lv = qs('#call-local-video');
      if (lv) lv.srcObject = localStream;
    }
  }).on('broadcast', { event: 'call-ice' }, async ({ payload }) => {
    if (!call || !call.pc || payload.callId !== call.id) return;
    try { await call.pc.addIceCandidate(payload.candidate); } catch { /* поздний ICE */ }
  }).on('broadcast', { event: 'call-hangup' }, ({ payload }) => {
    if (!call || payload.callId !== call.id) return;
    cleanupCall();
    toast('Звонок завершён');
  }).subscribe();

  call.overlay = callOverlay({
    remote: { display_name: p.from }, incoming: true, video: p.video,
  });
  bindCallControls(call);
  if (p.video) {
    const lv = qs('#call-local-video', call.overlay);
    if (lv) lv.srcObject = localStream;
  }
}

function sendCallEvent(event, payload) {
  if (!call) return;
  sendOn(call.chan, event, payload).catch(() => {});
}

function sendOn(chan, event, payload) {
  return chan.send({ type: 'broadcast', event, payload });
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

function cleanupCall() {
  clearInterval(timerInt);
  if (call) {
    try { call.pc?.close(); } catch { /* */ }
    getSb().removeChannel(call.chan).catch(() => {});
    call.overlay?.remove();
    if (call.remoteAudio) { try { call.remoteAudio.pause(); } catch { /* */ } }
    call.ringTimeout && clearTimeout(call.ringTimeout);
    call = null;
  }
  stopStream(localStream);
  localStream = null;
  micMuted = false;
  camOff = false;
}

window.addEventListener('beforeunload', () => {
  if (call) sendCallEvent('call-hangup', { callId: call.id });
  if (voice) sendOn(voice.chan, 'voice-leave', { uid: state.me.id }).catch(() => {});
});

// ================== ГОЛОСОВОЙ КАНАЛ (mesh) ==================

export function inVoice() { return !!voice; }

export async function joinVoice(chat) {
  if (call) { toast('Нельзя: идёт звонок'); return; }
  if (voice) { leaveVoice(); return; }
  const stream = await getMedia(false);
  if (!stream) return;

  const sb = getSb();
  const chan = sb.channel(`voice-${chat.id}`);
  voice = { chan, chatId: chat.id, peers: new Map(), bar: null, stream };

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
    bar.querySelector('#vb-deaf').addEventListener('click', () => {
      deafened = !deafened;
      voice.peers.forEach((p) => { if (p.audio) p.audio.muted = deafened; });
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
}

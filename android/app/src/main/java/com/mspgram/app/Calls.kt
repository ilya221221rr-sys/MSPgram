package com.mspgram.app

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.JsonObject as JO
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera2Enumerator
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.SessionDescription
import java.util.UUID

// ============================================================
//  Звонки — полный порт js/calls.js на Android WebRTC:
//  • 1:1 аудио/видео звонки: ring-<uid> → call-<callId>
//    (call-accept один раз → offer с собранными ICE → answer)
//  • голосовые каналы серверов: voice-<chatId> mesh
//    (voice-hello → существующие шлют offer новичку)
//  • TURN openrelay + STUN google/cloudflare (как ICE на сайте)
// ============================================================

class CallState {
    val phase = MutableStateFlow("idle") // idle | ringing-out | ringing-in | connecting | connected
    val incoming = MutableStateFlow<InRing?>(null)
    val remoteName = MutableStateFlow("")
    val remoteAvatar = MutableStateFlow<String?>(null)
    val video = MutableStateFlow(false)
    val micMuted = MutableStateFlow(false)
    val camOff = MutableStateFlow(false)
    val statusText = MutableStateFlow("")
    val timer = MutableStateFlow(0)
    val toast = MutableStateFlow<String?>(null)

    // голосовой канал
    val inVoice = MutableStateFlow(false)
    val voiceChatId = MutableStateFlow<String?>(null)
    val voiceMembers = MutableStateFlow<List<VoicePeer>>(emptyList())

    fun toastMsg(msg: String) { toast.value = msg }
}

data class InRing(val callId: String, val video: Boolean, val from: String, val chatId: String, val avatar: String?)
data class VoicePeer(val uid: String, val name: String, val avatar: String?, val video: Boolean)

// Рингтоны звонка (ringtone.js): «in» — мелодия при входящем (+ вибрация),
// «out» — гудки при исходящем. Генерируются тонами системы, файлов не нужно.
object CallRingtone {
    private var tg: android.media.ToneGenerator? = null
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private var mode: String? = null
    private var step = 0

    private val inMelody = intArrayOf(
        android.media.ToneGenerator.TONE_PROP_BEEP,
        android.media.ToneGenerator.TONE_PROP_BEEP2,
        android.media.ToneGenerator.TONE_CDMA_CALL_SIGNAL_ISDN_PAT3,
    )
    private val outTone = android.media.ToneGenerator.TONE_SUP_RINGTONE

    fun start(kind: String) {
        stop()
        mode = kind; step = 0
        try {
            tg = android.media.ToneGenerator(android.media.AudioManager.STREAM_MUSIC, 70)
        } catch (_: Exception) { tg = null }
        vibrate()
        loop()
    }

    private fun loop() {
        val k = mode ?: return
        try {
            when (k) {
                "in" -> {
                    tg?.startTone(inMelody[step % inMelody.size], 900)
                    step++
                    handler.postDelayed({ loop() }, 1500)
                }
                else -> {
                    tg?.startTone(outTone, 1200)
                    handler.postDelayed({ loop() }, 4000)
                }
            }
        } catch (_: Exception) { }
    }

    private fun vibrate() {
        try {
            val v = MspApp.instance?.getSystemService(android.content.Context.VIBRATOR_SERVICE) as? android.os.Vibrator ?: return
            v.vibrate(android.os.VibrationEffect.createWaveform(longArrayOf(0, 200, 100, 200, 100, 200), -1))
        } catch (_: Exception) { }
    }

    fun stop() {
        mode = null
        handler.removeCallbacksAndMessages(null)
        try { tg?.release() } catch (_: Exception) { }
        tg = null
    }
}

object Calls {
    val state = CallState()
    private val scope = CoroutineScope(Dispatchers.Main)

    private lateinit var factory: PeerConnectionFactory
    private var ready = false

    val egl = EglBase.create()

    private var pc: PeerConnection? = null
    private var callId: String? = null
    private var isCaller = false
    private var withVideo = false
    private var connected = false
    private var micMuted = false
    private var camOff = false
    private var timerJob: Job? = null
    private var timeoutJob: Job? = null

    private var localAudioSource: AudioSource? = null
    private var localAudioTrack: AudioTrack? = null
    private var localVideoSource: VideoSource? = null
    private var localVideoTrack: VideoTrack? = null
    private var capturer: org.webrtc.VideoCapturer? = null
    private var helper: SurfaceTextureHelper? = null
    private var localStream: MediaStream? = null

    var remoteRenderer: org.webrtc.SurfaceViewRenderer? = null
    var localRenderer: org.webrtc.SurfaceViewRenderer? = null
    private var remoteVideoTrack: VideoTrack? = null

    // голосовой канал
    private var voiceChatId: String? = null
    private val voicePcs = mutableMapOf<String, PeerConnection>()
    private val voiceNames = mutableMapOf<String, String>()

    fun init(ctx: Context) {
        if (ready) return
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(ctx).createInitializationOptions(),
        )
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()
        ready = true
        subscribeRing()
    }

    // ---------- подписка на входящие (ring-<myId>) ----------

    private var ringJoined = false
    private fun subscribeRing() {
        val me = Supa.userId ?: return
        val topic = "ring-$me"
        Realtime.join(topic)
        ringJoined = true
        scope.launch {
            Realtime.broadcast.collect { b ->
                if (b.topic != topic) return@collect
                when (b.event) {
                    "ring" -> {
                        if (pc != null || voiceChatId != null) {
                            // занят — авто-reject (как на сайте)
                            Realtime.sendBroadcast("call-${b.payload.str("callId")}", "call-reject", "{}")
                            return@collect
                        }
                        state.incoming.value = InRing(
                            callId = b.payload.str("callId") ?: return@collect,
                            video = b.payload.bool("video") ?: false,
                            from = b.payload.str("from") ?: "Неизвестный",
                            chatId = b.payload.str("chatId") ?: "",
                            avatar = b.payload.str("avatar"),
                        )
                        state.phase.value = "ringing-in"
                        CallRingtone.start("in")
                    }
                    "call-cancel" -> {
                        if (state.incoming.value?.callId == b.payload.str("callId")) {
                            state.incoming.value = null
                            state.phase.value = "idle"
                            CallRingtone.stop()
                        }
                    }
                }
            }
        }
    }

    // ---------- исходящий звонок ----------

    fun startCall(chat: Chat, video: Boolean, ctx: Context, onNeedPermission: (List<String>) -> Unit) {
        if (pc != null || voiceChatId != null) { state.toastMsg("Ты уже в звонке"); return }
        if (chat.type != "direct" || chat.isSaved()) return
        val other = chat.otherMember(Supa.userId ?: "") ?: return
        val perms = buildList {
            add(android.Manifest.permission.RECORD_AUDIO)
            if (video) add(android.Manifest.permission.CAMERA)
        }
        val missing = perms.filter {
            androidx.core.content.ContextCompat.checkSelfPermission(ctx, it) != android.content.pm.PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            pendingCall = { startCall(chat, video, ctx, onNeedPermission) }
            onNeedPermission(missing)
            return
        }
        getMedia(ctx, video) { streamReady ->
            if (!streamReady) return@getMedia
            val id = UUID.randomUUID().toString()
            callId = id
            isCaller = true
            withVideo = video
            connected = false
            state.phase.value = "ringing-out"
            CallRingtone.start("out")
            state.remoteName.value = other.name
            state.remoteAvatar.value = other.avatar_url
            state.video.value = video
            state.statusText.value = "Вызов…"

            Realtime.join("call-$id")
            sendWhenJoined("call-$id") {
                // звоним собеседнику
                Realtime.sendBroadcast(
                    "ring-${other.id}", "ring",
                    """{"callId":"$id","video":$video,"from":"${esc(other.name)}","avatar":${jsonOrNull(other.avatar_url)},"chatId":"${chat.id}"}""",
                )
            }
            // таймаут 45с (как на сайте)
            timeoutJob = scope.launch {
                delay(45_000)
                if (!connected && callId == id) {
                    Realtime.sendBroadcast("call-$id", "call-cancel", "{}")
                    cleanup()
                    state.toastMsg("Не дозвонился")
                }
            }
        }
    }

    private var pendingCall: (() -> Unit)? = null
    fun onPermissionsResult(granted: Boolean) {
        if (granted) pendingCall?.invoke()
        pendingCall = null
    }

    fun acceptIncoming(ctx: Context) {
        CallRingtone.stop()
        val ring = state.incoming.value ?: return
        val perms = buildList {
            add(android.Manifest.permission.RECORD_AUDIO)
            if (ring.video) add(android.Manifest.permission.CAMERA)
        }
        val missing = perms.filter {
            androidx.core.content.ContextCompat.checkSelfPermission(ctx, it) != android.content.pm.PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            pendingCall = { acceptIncoming(ctx) }
            state.toastMsg("Дай разрешение на микрофон/камеру")
            return
        }
        getMedia(ctx, ring.video) { ok ->
            if (!ok) {
                rejectIncoming()
                return@getMedia
            }
            callId = ring.callId
            isCaller = false
            withVideo = ring.video
            state.phase.value = "connecting"
            state.remoteName.value = ring.from
            state.remoteAvatar.value = ring.avatar
            state.video.value = ring.video
            state.statusText.value = "Соединение…"
            state.incoming.value = null
            Realtime.join("call-${ring.callId}")
            sendWhenJoined("call-${ring.callId}") {
                // КЛЮЧЕВОЙ контракт сайта: call-accept ровно один раз (после SUBSCRIBED)
                Realtime.sendBroadcast("call-${ring.callId}", "call-accept", "{}")
            }
        }
    }

    fun rejectIncoming() {
        CallRingtone.stop()
        val ring = state.incoming.value ?: return
        Realtime.sendBroadcast("call-${ring.callId}", "call-reject", "{}")
        state.incoming.value = null
        state.phase.value = "idle"
    }

    fun hangup() {
        callId?.let { Realtime.sendBroadcast("call-$it", "call-hangup", "{}") }
        cleanup()
    }

    fun toggleMic() {
        micMuted = !micMuted
        localAudioTrack?.setEnabled(!micMuted)
        state.micMuted.value = micMuted
    }

    fun toggleCam() {
        camOff = !camOff
        localVideoTrack?.setEnabled(!camOff)
        state.camOff.value = camOff
    }

    fun switchCamera() {
        (capturer as? org.webrtc.CameraVideoCapturer)?.switchCamera(null)
    }

    // ---------- peer connection (звонок) ----------

    private fun makePeer(): PeerConnection {
        val ice = listOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
            PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer(),
            PeerConnection.IceServer.builder("turn:openrelay.metered.ca:80")
                .setUsername("openrelayproject").setPassword("openrelayproject").createIceServer(),
            PeerConnection.IceServer.builder("turn:openrelay.metered.ca:443")
                .setUsername("openrelayproject").setPassword("openrelayproject").createIceServer(),
            PeerConnection.IceServer.builder("turn:openrelay.metered.ca:443?transport=tcp")
                .setUsername("openrelayproject").setPassword("openrelayproject").createIceServer(),
        )
        val cfg = PeerConnection.RTCConfiguration(ice).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val cand = mutableListOf<IceCandidate>()
        val myPc = factory.createPeerConnection(cfg, object : PeerConnection.Observer {
            override fun onIceCandidate(c: IceCandidate) {
                cand.add(c)
                Realtime.sendBroadcast("call-$callId", "call-ice",
                    """{"candidate":${candidateJson(c)}}""")
            }
            override fun onAddStream(stream: MediaStream) {
                connected = true
                timeoutJob?.cancel()
                state.phase.value = "connected"
                state.statusText.value = "Соединено ✓"
                startTimer()
                remoteVideoTrack = stream.videoTracks.firstOrNull()
                remoteVideoTrack?.let { t -> remoteRenderer?.let { t.addSink(it) } }
            }
            override fun onRemoveStream(stream: MediaStream) { }
            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                when (newState) {
                    PeerConnection.PeerConnectionState.DISCONNECTED -> state.statusText.value = "Связь потеряна…"
                    PeerConnection.PeerConnectionState.FAILED -> {
                        state.statusText.value = "Ошибка соединения"
                        state.toastMsg("Не удалось соединить устройства. Смени сеть и попробуй снова")
                        cleanup()
                    }
                    else -> { }
                }
            }
            // обязательные заглушки Observer
            override fun onSignalingChange(state: PeerConnection.SignalingState) { }
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) { }
            override fun onIceConnectionReceivingChange(receiving: Boolean) { }
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) { }
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) { }
            override fun onAddTrack(receiver: org.webrtc.RtpReceiver, streams: Array<out MediaStream>) { }
            override fun onTrack(transceiver: org.webrtc.RtpTransceiver) { }
            override fun onDataChannel(dc: org.webrtc.DataChannel) { }
            override fun onRenegotiationNeeded() { }
        }) ?: throw Exception("WebRTC недоступен")

        localStream?.let { myPc.addStream(it) }
        candByPc[myPc] = cand
        return myPc
    }

    private val candByPc = mutableMapOf<PeerConnection, MutableList<IceCandidate>>()

    private fun startTimer() {
        timerJob?.cancel()
        timerJob = scope.launch {
            state.timer.value = 0
            while (isActive && connected) {
                delay(1000)
                state.timer.value = state.timer.value + 1
            }
        }
    }

    // ---------- обработка call-* событий ----------

    fun handleCallBroadcast(b: RtBroadcast) {
        val id = callId ?: return
        if (b.topic != "call-$id") return
        val p = b.payload
        when (b.event) {
            "call-accept" -> {
                if (!isCaller || pc != null) return // защита от двойного accept (фикс v15)
                scope.launch { makeOffer() }
            }
            "call-offer" -> {
                if (pc != null) return // защита от повторного offer
                try {
                    pc = makePeer()
                    val sdp = p.str("sdp") ?: return
                    pc?.setRemoteDescription(sdpObs, SessionDescription(SessionDescription.Type.OFFER, sdp))
                    for (c in p.candidates()) pc?.addIceCandidate(c)
                    pc?.createAnswer(object : Sdp() {
                        override fun onCreateSuccess(desc: SessionDescription) {
                            pc?.setLocalDescription(sdpObs, desc)
                            scope.launch {
                                delay(1200) // waitIce (как на сайте)
                                Realtime.sendBroadcast("call-$id", "call-answer",
                                    """{"sdp":${jsonStr(pc?.localDescription?.description ?: "")},"candidates":${candsJson(candByPc[pc])}}""")
                            }
                        }
                    }, MediaConstraints())
                } catch (e: Exception) {
                    state.toastMsg("Ошибка соединения: ${e.message}")
                    cleanup()
                }
            }
            "call-answer" -> {
                val sdp = p.str("sdp") ?: return
                try {
                    pc?.setRemoteDescription(sdpObs, SessionDescription(SessionDescription.Type.ANSWER, sdp))
                    for (c in p.candidates()) pc?.addIceCandidate(c)
                } catch (_: Exception) { }
            }
            "call-ice" -> {
                val c = p.candidate() ?: return
                try { pc?.addIceCandidate(c) } catch (_: Exception) { }
            }
            "call-hangup" -> { cleanup(); state.toastMsg("Звонок завершён") }
            "call-reject" -> { cleanup(); state.toastMsg("Звонок отклонён") }
        }
    }

    private suspend fun makeOffer() {
        state.statusText.value = "Соединение…"
        pc = makePeer()
        pc?.createOffer(object : Sdp() {
            override fun onCreateSuccess(desc: SessionDescription) {
                pc?.setLocalDescription(sdpObs, desc)
                scope.launch {
                    delay(1200) // waitIce: оффер уходит с полным набором кандидатов
                    Realtime.sendBroadcast("call-$callId", "call-offer",
                        """{"sdp":${jsonStr(pc?.localDescription?.description ?: "")},"candidates":${candsJson(candByPc[pc])}}""")
                }
            }
        }, MediaConstraints())
    }

    // ---------- медиа ----------

    private fun getMedia(ctx: Context, video: Boolean, cb: (Boolean) -> Unit) {
        scope.launch {
            try {
                val constraints = MediaConstraints()
                localAudioSource = factory.createAudioSource(constraints)
                localAudioTrack = factory.createAudioTrack("msp-a0", localAudioSource)
                if (video) {
                    val enumerator = Camera2Enumerator(ctx)
                    val name = enumerator.deviceNames.firstOrNull { enumerator.isFrontFacing(it) }
                        ?: enumerator.deviceNames.firstOrNull() ?: throw Exception("Камера не найдена")
                    capturer = enumerator.createCapturer(name, null)
                    localVideoSource = factory.createVideoSource(capturer!!.isScreencast)
                    helper = SurfaceTextureHelper.create("msp-cap", egl.eglBaseContext)
                    capturer!!.initialize(helper!!, ctx, localVideoSource!!.capturerObserver)
                    capturer!!.startCapture(640, 360, 15)
                    localVideoTrack = factory.createVideoTrack("msp-v0", localVideoSource)
                }
                val stream = factory.createLocalMediaStream("msp-local")
                stream.addTrack(localAudioTrack!!)
                localVideoTrack?.let { stream.addTrack(it) }
                localStream = stream
                cb(true)
            } catch (e: Exception) {
                state.toastMsg("Нет доступа к микрофону/камере")
                cb(false)
            }
        }
    }

    fun attachRenderers(local: org.webrtc.SurfaceViewRenderer?, remote: org.webrtc.SurfaceViewRenderer?) {
        if (local != null) {
            localRenderer = local
            localVideoTrack?.addSink(local)
        }
        if (remote != null) {
            remoteRenderer = remote
            remoteVideoTrack?.addSink(remote)
        }
    }

    fun detachRenderers() {
        try {
            localRenderer?.let { localVideoTrack?.removeSink(it) }
            remoteRenderer?.let { remoteVideoTrack?.removeSink(it) }
        } catch (_: Exception) { }
        localRenderer = null
        remoteRenderer = null
    }

    private fun cleanup() {
        CallRingtone.stop()
        try { pc?.close() } catch (_: Exception) { }
        pc = null
        timerJob?.cancel()
        timeoutJob?.cancel()
        callId?.let { Realtime.leave("call-$it") }
        callId = null
        connected = false
        detachRenderers()
        try {
            capturer?.stopCapture(); capturer?.dispose()
        } catch (_: Exception) { }
        capturer = null
        localAudioSource?.dispose(); localAudioSource = null
        localVideoSource?.dispose(); localVideoSource = null
        localAudioTrack = null; localVideoTrack = null
        remoteVideoTrack = null
        localStream = null
        state.phase.value = "idle"
        state.timer.value = 0
    }

    // ============================================================
    //  Голосовые каналы серверов (voice-<chatId> mesh)
    // ============================================================

    fun joinVoice(chat: Chat, ctx: Context, onNeedPermission: () -> Unit) {
        if (pc != null) { state.toastMsg("Нельзя: идёт звонок"); return }
        if (voiceChatId != null) { leaveVoice(); return }
        val missing = listOf(android.Manifest.permission.RECORD_AUDIO).filter {
            androidx.core.content.ContextCompat.checkSelfPermission(ctx, it) != android.content.pm.PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) { onNeedPermission(); return }
        scope.launch {
            getMedia(ctx, false) { ok ->
                if (!ok) return@getMedia
                val cid = chat.id
                voiceChatId = cid
                state.inVoice.value = true
                state.voiceChatId.value = cid
                voiceNames.clear()
                voicePcs.values.forEach { try { it.close() } catch (_: Exception) { } }
                voicePcs.clear()
                val meId = Supa.userId ?: return@getMedia
                voiceNames[meId] = Supa.me?.name ?: "Я"
                renderVoiceMembers()
                Realtime.join("voice-$cid")
                sendWhenJoined("voice-$cid") {
                    Realtime.sendBroadcast("voice-$cid", "voice-hello",
                        """{"uid":"$meId","name":"${esc(Supa.me?.name ?: "Я")}","avatar":${jsonOrNull(Supa.me?.avatar_url)}}""")
                }
            }
        }
    }

    fun leaveVoice() {
        val cid = voiceChatId ?: return
        Realtime.sendBroadcast("voice-$cid", "voice-leave", """{"uid":"${Supa.userId ?: ""}"}""")
        Realtime.leave("voice-$cid")
        voicePcs.values.forEach { try { it.close() } catch (_: Exception) { } }
        voicePcs.clear()
        voiceChatId = null
        state.inVoice.value = false
        state.voiceChatId.value = null
        state.voiceMembers.value = emptyList()
        cleanup()
    }

    private fun renderVoiceMembers() {
        val meId = Supa.userId ?: ""
        val list = voiceNames.map { (uid, name) -> VoicePeer(uid, if (uid == meId) "Ты" else name, null, false) }
        state.voiceMembers.value = list
    }

    fun handleVoiceBroadcast(b: RtBroadcast) {
        val cid = voiceChatId ?: return
        if (b.topic != "voice-$cid") return
        val p = b.payload
        val meId = Supa.userId ?: return
        when (b.event) {
            "voice-hello" -> {
                val uid = p.str("uid") ?: return
                if (uid == meId) return
                voiceNames[uid] = p.str("name") ?: "Участник"
                renderVoiceMembers()
                // существующие участники шлют offer новичку (контракт сайта)
                makeVoicePeer(cid, uid, isOfferer = true)
            }
            "voice-offer" -> {
                val uid = p.str("uid") ?: return
                if (uid == meId) return
                voiceNames[uid] = p.str("name") ?: "Участник"
                val peer = getVoicePeer(cid, uid, isOfferer = false)
                try {
                    peer.setRemoteDescription(sdpObs, SessionDescription(SessionDescription.Type.OFFER, p.str("sdp") ?: return))
                    peer.createAnswer(object : Sdp() {
                        override fun onCreateSuccess(desc: SessionDescription) {
                            peer.setLocalDescription(sdpObs, desc)
                            scope.launch {
                                delay(800)
                                Realtime.sendBroadcast("voice-$cid", "voice-answer",
                                    """{"uid":"$meId","to":"$uid","sdp":${jsonStr(peer.localDescription?.description ?: "")}}""")
                            }
                        }
                    }, MediaConstraints())
                } catch (_: Exception) { }
            }
            "voice-answer" -> {
                val uid = p.str("uid") ?: return
                val peer = voicePcs[uid] ?: return
                try {
                    peer.setRemoteDescription(sdpObs, SessionDescription(SessionDescription.Type.ANSWER, p.str("sdp") ?: return))
                } catch (_: Exception) { }
            }
            "voice-ice" -> {
                val uid = p.str("uid") ?: return
                voicePcs[uid]?.let { try { it.addIceCandidate(p.candidate()) } catch (_: Exception) { } }
            }
            "voice-leave" -> {
                val uid = p.str("uid") ?: return
                voicePcs.remove(uid)?.let { try { it.close() } catch (_: Exception) { } }
                voiceNames.remove(uid)
                renderVoiceMembers()
            }
        }
    }

    private fun getVoicePeer(cid: String, uid: String, isOfferer: Boolean): PeerConnection {
        voicePcs[uid]?.let { return it }
        val peer = buildVoicePeer(uid)
        voicePcs[uid] = peer
        if (isOfferer) {
            peer.createOffer(object : Sdp() {
                override fun onCreateSuccess(desc: SessionDescription) {
                    peer.setLocalDescription(sdpObs, desc)
                    scope.launch {
                        delay(800)
                        Realtime.sendBroadcast("voice-$cid", "voice-offer",
                            """{"uid":"${Supa.userId ?: ""}","name":"${esc(Supa.me?.name ?: "Я")}","to":"$uid","sdp":${jsonStr(peer.localDescription?.description ?: "")}}""")
                    }
                }
            }, MediaConstraints())
        }
        return peer
    }

    private fun makeVoicePeer(cid: String, uid: String, isOfferer: Boolean) {
        val peer = getVoicePeer(cid, uid, isOfferer)
        if (isOfferer) { /* offer уже отправлен в getVoicePeer */ }
    }

    private fun buildVoicePeer(uid: String): PeerConnection {
        val ice = listOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
            PeerConnection.IceServer.builder("turn:openrelay.metered.ca:80")
                .setUsername("openrelayproject").setPassword("openrelayproject").createIceServer(),
        )
        val cfg = PeerConnection.RTCConfiguration(ice)
        val pcv = factory.createPeerConnection(cfg, object : PeerConnection.Observer {
            override fun onIceCandidate(c: IceCandidate) {
                Realtime.sendBroadcast("voice-$voiceChatId", "voice-ice", """{"uid":"${Supa.userId ?: ""}","candidate":${candidateJson(c)}}""")
            }
            override fun onAddStream(stream: MediaStream) { /* аудио играется автоматически */ }
            override fun onRemoveStream(stream: MediaStream) { }
            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) { }
            override fun onSignalingChange(state: PeerConnection.SignalingState) { }
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) { }
            override fun onIceConnectionReceivingChange(receiving: Boolean) { }
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) { }
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) { }
            override fun onAddTrack(receiver: org.webrtc.RtpReceiver, streams: Array<out MediaStream>) { }
            override fun onTrack(transceiver: org.webrtc.RtpTransceiver) { }
            override fun onDataChannel(dc: org.webrtc.DataChannel) { }
            override fun onRenegotiationNeeded() { }
        }) ?: throw Exception("WebRTC недоступен")
        localStream?.let { pcv.addStream(it) }
        return pcv
    }

    // ---------- служебное ----------

    private fun sendWhenJoined(topic: String, action: () -> Unit) {
        scope.launch {
            // ждём SUBSCRIBED (соединение) до 10с, как Promise.race на сайте
            var waited = 0
            while (!Realtime.connected.value && waited < 10_000) {
                delay(200); waited += 200
            }
            action()
        }
    }

    private val sdpObs = object : Sdp() { }

    open class Sdp : SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription) { }
        override fun onSetSuccess() { }
        override fun onCreateFailure(error: String?) { }
        override fun onSetFailure(error: String?) { }
    }

    private fun candidateJson(c: IceCandidate): String {
        val mid = c.sdpMid ?: "0"
        val line = c.sdp
        return """{"candidate":${jsonStr(line)},"sdpMid":"$mid","sdpMLineIndex":${c.sdpMLineIndex}}"""
    }

    private fun candsJson(list: List<IceCandidate>?): String {
        val arr = (list ?: emptyList()).joinToString(",", "[", "]") { candidateJson(it) }
        return arr
    }

    private fun JsonObject.str(key: String): String? =
        (this[key] as? JsonPrimitive)?.contentOrNull

    private fun JsonObject.bool(key: String): Boolean? =
        (this[key] as? JsonPrimitive)?.let { it.contentOrNull == "true" || it.contentOrNull == "1" }

    private fun JsonObject.candidates(): List<IceCandidate> {
        val arr = (this["candidates"] as? kotlinx.serialization.json.JsonArray) ?: return emptyList()
        return arr.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            try {
                IceCandidate(
                    (o["sdpMid"] as? JsonPrimitive)?.contentOrNull ?: "0",
                    (o["sdpMLineIndex"] as? JsonPrimitive)?.contentOrNull?.toIntOrNull() ?: 0,
                    (o["candidate"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null,
                )
            } catch (_: Exception) { null }
        }
    }

    private fun JsonObject.candidate(): IceCandidate? {
        val o = (this["candidate"] as? JsonObject) ?: return null
        return try {
            IceCandidate(
                (o["sdpMid"] as? JsonPrimitive)?.contentOrNull ?: "0",
                (o["sdpMLineIndex"] as? JsonPrimitive)?.contentOrNull?.toIntOrNull() ?: 0,
                (o["candidate"] as? JsonPrimitive)?.contentOrNull ?: return null,
            )
        } catch (_: Exception) { null }
    }

    private fun jsonStr(s: String): String {
        val esc = s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r")
        return "\"$esc\""
    }

    private fun jsonOrNull(s: String?): String = if (s.isNullOrBlank()) "null" else jsonStr(s)

    private fun esc(s: String): String =
        s.replace("\\", "\\\\").replace("\"", "\\\"")

    fun fmtTimer(sec: Int): String {
        val m = sec / 60
        val s = sec % 60
        return "%02d:%02d".format(m, s)
    }
}

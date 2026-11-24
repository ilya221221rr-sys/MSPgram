package com.mspgram.app

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import java.util.UUID

// ============================================================
//  Realtime — Phoenix-клиент поверх WebSocket, ровно как supabase-js:
//  • realtime:msp-db   — postgres_changes (messages, reactions, chats,
//                        chat_members, friendships, user_sessions)
//  • typing-<chatId>   — broadcast «печатает…»
//  • msp-online        — presence (кто в сети, как presence.js)
//  • ring-<userId>     — входящие звонки
//  • call-<callId>     — сигналинг звонка
//  • voice-<chatId>    — голосовые каналы серверов
// ============================================================

class RtDataEvent(
    val table: String,
    val event: String, // INSERT / UPDATE / DELETE
    val record: JsonObject,
    val oldRecord: JsonObject?,
)

class RtBroadcast(
    val topic: String,
    val event: String,
    val payload: JsonObject,
)

object Realtime {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    private val scope = CoroutineScope(Dispatchers.IO)

    private var ws: WebSocket? = null
    private var hb: Job? = null
    private var refCounter = 1
    private var retries = 0
    private val joined = mutableMapOf<String, String?>() // топик → конфиг postgres_changes

    // публичные потоки (UI и звонки подписываются)
    val db = MutableSharedFlow<RtDataEvent>(extraBufferCapacity = 64)
    val broadcast = MutableSharedFlow<RtBroadcast>(extraBufferCapacity = 64)
    val connected = MutableStateFlow(false)

    // presence (онлайн-набор uid, как state.online на сайте)
    val online = MutableStateFlow<Set<String>>(emptySet())
    private val presenceRefs = mutableMapOf<String, MutableSet<String>>()

    private fun nextRef(): String = (refCounter++).toString()

    private fun client(): OkHttpClient = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private var lastApikey = ""
    private var lastUrl = ""

    fun connect(apikey: String, url: String) {
        if (ws != null) return
        lastApikey = apikey
        lastUrl = url
        val u = "$url/realtime/v1/websocket?apikey=$apikey&vsn=1.0.0"
        ws = client().newWebSocket(Request.Builder().url(u).build(), listener)
    }

    fun close() {
        try { ws?.close(1000, "bye") } catch (_: Exception) { }
        ws = null
        hb?.cancel(); hb = null
        joined.clear()
        connected.value = false
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            retries = 0
            connected.value = true
            hb?.cancel()
            hb = scope.launch {
                while (isActive) {
                    delay(25_000)
                    webSocket.send(phxEvent("phoenix", "heartbeat", JsonObject(emptyMap())))
                }
            }
            // перезайти во все топики после переподключения (с их конфигами)
            joined.forEach { (t, cfg) -> rejoin(t, cfg) }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            try {
                val env = json.decodeFromString<RtEnvelope>(text)
                val topic = env.topic ?: return
                when (env.event) {
                    "phx_reply" -> {
                        val status = env.payload?.get("status")?.jsonPrimitive?.contentOrNull
                        if (topic == "msp-online" && status == "ok" && uidKey.isNotBlank()) {
                            val myStatus = Supa.me?.presence_status?.takeIf { it.isNotBlank() } ?: "online"
                            if (myStatus == "invisible") presenceUntrack()
                            else presenceTrack(uidKey, myStatus)
                        }
                    }
                    "postgres_changes" -> {
                        val data = env.payload?.get("data") as? JsonObject ?: return
                        val ev = data["event"]?.jsonPrimitive?.contentOrNull ?: return
                        val table = (data["ids"]?.jsonArray?.firstOrNull() as? JsonObject)
                            ?.get("table")?.jsonPrimitive?.contentOrNull
                            ?: data["table"]?.jsonPrimitive?.contentOrNull ?: return
                        val record = data["record"] as? JsonObject ?: JsonObject(emptyMap())
                        val old = data["old_record"] as? JsonObject
                        db.tryEmit(RtDataEvent(table, ev, record, old))
                    }
                    "presence_state" -> {
                        val ps = env.payload ?: return
                        presenceRefs.clear()
                        for ((uid, value) in ps) {
                            val metas = when (value) {
                                is kotlinx.serialization.json.JsonArray -> value
                                is JsonObject -> value["metas"] as? kotlinx.serialization.json.JsonArray
                                else -> null
                            } ?: continue
                            val refs = metas.mapIndexed { index, meta ->
                                (meta as? JsonObject)?.get("presence_ref")?.jsonPrimitive?.contentOrNull
                                    ?: "meta-$index"
                            }.toMutableSet()
                            if (refs.isNotEmpty()) presenceRefs[uid] = refs
                        }
                        online.value = presenceRefs.keys.toSet()
                    }
                    "presence_diff" -> {
                        val ps = env.payload ?: return
                        fun applyPresence(section: String, joining: Boolean) {
                            val entries = ps[section] as? JsonObject ?: return
                            for ((uid, value) in entries) {
                                val metas = when (value) {
                                    is kotlinx.serialization.json.JsonArray -> value
                                    is JsonObject -> value["metas"] as? kotlinx.serialization.json.JsonArray
                                    else -> null
                                } ?: continue
                                val refs = presenceRefs.getOrPut(uid) { mutableSetOf() }
                                metas.forEachIndexed { index, meta ->
                                    val ref = (meta as? JsonObject)?.get("presence_ref")?.jsonPrimitive?.contentOrNull
                                        ?: "meta-$index"
                                    if (joining) refs.add(ref) else refs.remove(ref)
                                }
                                if (refs.isEmpty()) presenceRefs.remove(uid)
                            }
                        }
                        applyPresence("joins", joining = true)
                        applyPresence("leaves", joining = false)
                        online.value = presenceRefs.keys.toSet()
                    }
                    "broadcast" -> {
                        val ev = env.payload?.get("event")?.jsonPrimitive?.contentOrNull ?: return
                        val p = (env.payload?.get("payload") as? JsonObject) ?: JsonObject(emptyMap())
                        broadcast.tryEmit(RtBroadcast(topic, ev, p))
                    }
                }
            } catch (_: Exception) { /* чужие сообщения */ }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            ws = null
            connected.value = false
            hb?.cancel(); hb = null
            scheduleReconnect(lastApikey, lastUrl)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            ws = null
            connected.value = false
            hb?.cancel(); hb = null
            scheduleReconnect(lastApikey, lastUrl)
        }
    }

    private var reconnectPending = false

    private fun scheduleReconnect(apikey: String, url: String) {
        if (ws != null || reconnectPending) return
        reconnectPending = true
        retries += 1
        val wait = minOf(3000L * retries, 15000L)
        scope.launch {
            delay(wait)
            reconnectPending = false
            connect(apikey, url)
        }
    }

    private fun phxEvent(topic: String, event: String, payload: JsonObject): String {
        val parts = mutableListOf<String>()
        parts.add("\"topic\":\"$topic\"")
        parts.add("\"event\":\"$event\"")
        parts.add("\"ref\":\"${nextRef()}\"")
        parts.add("\"payload\":${json.encodeToString(JsonObject.serializer(), payload)}")
        return "{${parts.joinToString(",")}}"
    }

    /** Войти в топик. postgresChanges — конфиг postgres_changes, иначе broadcast/presence. */
    fun join(topic: String, postgresChanges: String? = null) {
        if (ws == null) { joined[topic] = postgresChanges; return }
        if (joined.containsKey(topic)) return
        joined[topic] = postgresChanges
        rejoin(topic, postgresChanges)
    }

    fun rejoin(topic: String, postgresChanges: String? = null) {
        val payload = if (postgresChanges != null) {
            """{"config":{"postgres_changes":$postgresChanges,"broadcast":{"self":false},"presence":{"key":""}}}"""
        } else {
            val presenceKey = if (topic == "msp-online") uidKey else ""
            """{"config":{"broadcast":{"self":false},"presence":{"key":"$presenceKey"}}}"""
        }
        val msg = """{"topic":"$topic","event":"phx_join","ref":"${nextRef()}","payload":$payload}"""
        ws?.send(msg)
    }

    fun leave(topic: String) {
        joined.remove(topic)
        ws?.send("""{"topic":"$topic","event":"phx_leave","ref":"${nextRef()}","payload":{}}""")
    }

    /** broadcast в топик (typing, звонки, голосовые) */
    fun sendBroadcast(topic: String, event: String, payloadJson: String) {
        val msg = """{"topic":"$topic","event":"broadcast","ref":"${nextRef()}","payload":{"type":"broadcast","event":"$event","payload":$payloadJson}}"""
        ws?.send(msg)
    }

    /** presence: обновить свой статус (как presence.track) */
    fun presenceTrack(uid: String, status: String) {
        // ключ присутствия — uid (как на сайте)
        val msg = """{"topic":"msp-online","event":"presence","ref":"${nextRef()}","payload":{"type":"presence","event":"track","payload":{"uid":"$uid","status":"$status"},"presence_key":"$uid"}}"""
        ws?.send(msg)
    }

    fun presenceUntrack() {
        val msg = """{"topic":"msp-online","event":"presence","ref":"${nextRef()}","payload":{"type":"presence","event":"untrack","payload":{},"presence_key":"$uidKey"}}"""
        ws?.send(msg)
    }

    private var uidKey: String = ""

    fun setPresenceKey(uid: String) { uidKey = uid }

    fun newRef(): String = UUID.randomUUID().toString().take(8)
}

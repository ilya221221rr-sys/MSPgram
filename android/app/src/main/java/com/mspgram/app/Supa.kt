package com.mspgram.app

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.decodeFromJsonElement
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.TimeUnit

// ============================================================
//  Клиент Supabase: REST (PostgREST), Auth, Storage, Realtime
//  Работает на тех же таблицах и политиках, что и веб-версия.
// ============================================================

object Supa {
    const val URL = "https://xqjtycvfjamnqtkznyio.supabase.co"
    const val KEY = "sb_publishable_eQyTtqtK38L0UY1HbyHyIw_UjUW-pVx"

    val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
        explicitNulls = false
    }

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    private lateinit var prefs: SharedPreferences

    fun init(ctx: Context) {
        prefs = ctx.getSharedPreferences("mspgram", Context.MODE_PRIVATE)
    }

    private fun initialized(): Boolean = this::prefs.isInitialized

    // ---------- сессия ----------

    var session: Session? = null
    var me: Profile? = null

    val userId: String? get() = if (initialized()) prefs.getString("uid", null) else null

    suspend fun restore() {
        if (!initialized()) return
        val a = prefs.getString("access", null) ?: return
        val r = prefs.getString("refresh", null) ?: return
        session = Session(a, r, prefs.getLong("exp", 0))
        try {
            ensureToken()
            me = loadMe(userId ?: return)
        } catch (_: Exception) {
            // сессия невосстановима — покажем вход
        }
    }

    private fun save(s: Session, uid: String) {
        session = s
        prefs.edit()
            .putString("access", s.access)
            .putString("refresh", s.refresh)
            .putLong("exp", s.expAt)
            .putString("uid", uid)
            .apply()
    }

    fun logout() {
        session = null
        me = null
        prefs.edit().clear().apply()
        closeRealtime()
    }

    private suspend fun ensureToken() {
        val s = session ?: return
        if (s.expAt - 60_000L < System.currentTimeMillis()) refresh()
    }

    suspend fun signIn(email: String, pass: String) {
        val body = json.encodeToString(SignInBody(email, pass))
        val resp = req("POST", "/auth/v1/token?grant_type=password", body, false)
        if (resp.code != 200) throw Exception(authErr(resp.body))
        val ar = json.decodeFromString<AuthResp>(resp.body)
        val uid = ar.user?.id ?: throw Exception("Ответ не содержит пользователя")
        save(Session(ar.access_token ?: "", ar.refresh_token ?: "", System.currentTimeMillis() + ar.expires_in * 1000), uid)
        me = loadMe(uid)
    }

    suspend fun signUp(email: String, pass: String, nickname: String) {
        val body = json.encodeToString(SignUpBody(email, pass, SignUpData(nickname, nickname)))
        val resp = req("POST", "/auth/v1/signup", body, false)
        if (resp.code != 200) throw Exception(authErr(resp.body))
        val ar = json.decodeFromString<AuthResp>(resp.body)
        if (ar.access_token.isNullOrEmpty()) {
            throw Exception("Аккаунт создан ✓ Подтверди email по письму, потом войди")
        }
        val uid = ar.user?.id ?: throw Exception("Ответ не содержит пользователя")
        save(Session(ar.access_token, ar.refresh_token ?: "", System.currentTimeMillis() + ar.expires_in * 1000), uid)
        me = loadMe(uid)
    }

    private suspend fun refresh() {
        val cur = session ?: return
        val body = json.encodeToString(RefreshBody(cur.refresh))
        val resp = req("POST", "/auth/v1/token?grant_type=refresh_token", body, false)
        if (resp.code != 200) throw Exception("Сессия истекла — войди заново")
        val ar = json.decodeFromString<AuthResp>(resp.body)
        save(
            Session(ar.access_token ?: "", ar.refresh_token ?: "", System.currentTimeMillis() + ar.expires_in * 1000),
            userId ?: "",
        )
    }

    private fun authErr(body: String): String = try {
        val e = json.decodeFromString<Map<String, JsonElement>>(body)
        (e["error_description"]?.toString() ?: e["msg"]?.toString() ?: e["error"]?.toString() ?: "Ошибка входа")
            .trim('"')
    } catch (_: Exception) {
        "Ошибка входа (HTTP)"
    }

    // ---------- HTTP ----------

    data class Resp(val code: Int, val body: String)

    private suspend fun req(method: String, path: String, body: String?, withAuth: Boolean): Resp {
        return kotlinx.coroutines.withContext(Dispatchers.IO) {
            if (withAuth) ensureToken()
            val media = "application/json; charset=utf-8".toMediaType()
            val rb = Request.Builder().url(URL + path).header("apikey", KEY)
            if (withAuth && session != null) rb.header("Authorization", "Bearer " + session!!.access)
            when (method) {
                "GET" -> rb.get()
                else -> rb.method(method, (body ?: "{}").toRequestBody(media))
            }
            val call = http.newCall(rb.build())
            call.execute().use { r ->
                Resp(r.code, r.body?.string() ?: "")
            }
        }
    }

    private suspend fun get(path: String): String {
        val r = req("GET", path, null, true)
        if (r.code != 200) throw Exception("HTTP ${r.code}: ${r.body.take(160)}")
        return r.body
    }

    private suspend fun post(path: String, body: String): String {
        val r = req("POST", path, body, true)
        if (r.code !in 200..299) throw Exception("HTTP ${r.code}: ${r.body.take(160)}")
        return r.body
    }

    private suspend fun patch(path: String, body: String): String {
        val r = req("PATCH", path, body, true)
        if (r.code !in 200..299) throw Exception("HTTP ${r.code}: ${r.body.take(160)}")
        return r.body
    }

    private suspend fun delete(path: String): String {
        val r = req("DELETE", path, null, true)
        if (r.code !in 200..299) throw Exception("HTTP ${r.code}: ${r.body.take(160)}")
        return r.body
    }

    // ---------- API приложения ----------

    suspend fun loadMe(id: String): Profile {
        val arr = json.decodeFromString<List<Profile>>(get("/rest/v1/profiles?select=*&id=eq.$id"))
        return arr.firstOrNull() ?: throw Exception("Профиль не найден")
    }

    suspend fun loadChats(): List<Chat> =
        json.decodeFromString(get("/rest/v1/chats?select=*,chat_members(*,profiles(*))"))

    suspend fun unreadCounts(): Map<String, Long> = try {
        json.decodeFromString<List<UnreadRow>>(post("/rest/v1/rpc/unread_counts", "{}"))
            .associate { it.chat_id to it.cnt }
    } catch (_: Exception) {
        emptyMap()
    }

    suspend fun loadChannels(chatId: String): List<Channel> = try {
        json.decodeFromString(get("/rest/v1/channels?select=*&chat_id=eq.$chatId&order=id"))
    } catch (_: Exception) {
        emptyList()
    }

    suspend fun loadMessages(chatId: String, channelId: String?): List<Message> {
        var p = "/rest/v1/messages?select=*&chat_id=eq.$chatId"
        if (channelId != null) p += "&channel_id=eq.$channelId"
        p += "&order=created_at.desc&limit=60"
        return json.decodeFromString<List<Message>>(get(p)).reversed()
    }

    suspend fun sendMessage(chatId: String, channelId: String?, body: String): Message =
        sendMessageFull(chatId, channelId, body, null, null, null, null)

    suspend fun sendMessageFull(
        chatId: String,
        channelId: String?,
        body: String?,
        attachmentType: String?,
        attachmentUrl: String?,
        attachmentName: String?,
        attachmentSize: Long?,
    ): Message {
        val meId = userId ?: throw Exception("Нет сессии")
        val payload = json.encodeToString(MsgPayload(
            chat_id = chatId,
            sender_id = meId,
            body = body,
            channel_id = channelId,
            attachment_type = attachmentType,
            attachment_url = attachmentUrl,
            attachment_name = attachmentName,
            attachment_size = attachmentSize,
        ))
        // return=representation идёт заголовком
        val r = reqRaw("POST", "/rest/v1/messages", payload, mapOf("Prefer" to "return=representation"))
        if (r.code !in 200..299) throw Exception("HTTP ${r.code}: ${r.body.take(160)}")
        return json.decodeFromString<List<Message>>(r.body).first()
    }

    suspend fun editMessage(id: String, body: String): Message {
        val r = reqRaw(
            "PATCH", "/rest/v1/messages?id=eq.$id",
            json.encodeToString(EditPayload(body, isoNow())), emptyMap(),
        )
        if (r.code !in 200..299) throw Exception("HTTP ${r.code}")
        val arr = json.decodeFromString<List<Message>>(r.body)
        return arr.firstOrNull() ?: throw Exception("Сообщение не найдено")
    }

    suspend fun deleteMessage(id: String) {
        delete("/rest/v1/messages?id=eq.$id")
    }

    suspend fun markRead(chatId: String) {
        val meId = userId ?: return
        try {
            patch(
                "/rest/v1/chat_members?chat_id=eq.$chatId&user_id=eq.$meId",
                json.encodeToString(MarkReadPayload(isoNow())),
            )
        } catch (_: Exception) { /* не критично */ }
    }

    suspend fun registerFcm(token: String) {
        if (session == null || userId == null) return
        try {
            post(
                "/rest/v1/rpc/register_fcm",
                json.encodeToString(FcmRegisterPayload(token, "android")),
            )
        } catch (_: Exception) { /* push не критичен */ }
    }

    suspend fun uploadImage(chatId: String, bytes: ByteArray, name: String): Pair<String, Long> {
        val meId = userId ?: throw Exception("Нет сессии")
        val ext = if (name.lowercase().endsWith(".png")) "png" else "jpg"
        val path = "$chatId/${UUID.randomUUID()}__$meId.$ext"
        val media = (if (ext == "png") "image/png" else "image/jpeg").toMediaType()
        val rb = Request.Builder()
            .url("$URL/storage/v1/object/chat-files/$path")
            .header("apikey", KEY)
            .header("Authorization", "Bearer " + (session?.access ?: ""))
            .post(bytes.toRequestBody(media))
        kotlinx.coroutines.withContext(Dispatchers.IO) {
            http.newCall(rb.build()).execute().use { r ->
                if (r.code !in 200..299) throw Exception("Загрузка не удалась: HTTP ${r.code}")
            }
        }
        return "$URL/storage/v1/object/public/chat-files/$path" to bytes.size.toLong()
    }

    // ---------- Realtime (WebSocket) ----------

    val events = kotlinx.coroutines.flow.MutableSharedFlow<Pair<String, Message>>(extraBufferCapacity = 32)

    private val rtScope = CoroutineScope(Dispatchers.IO)
    private var ws: WebSocket? = null
    private var hb: Job? = null
    private var reconnects = 0

    fun connectRealtime() {
        if (!initialized() || session == null) return
        closeRealtime()
        val url = "$URL/realtime/v1/websocket?apikey=$KEY&vsn=1.0.0"
        ws = http.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                reconnects = 0
                webSocket.send(
                    """{"topic":"realtime:msp-db","event":"phx_join","ref":"1","payload":{"config":{"postgres_changes":[{"event":"*","schema":"public","table":"messages"},{"event":"*","schema":"public","table":"reactions"}],"broadcast":{"self":false},"presence":{"key":""}}}}""",
                )
                hb = rtScope.launch {
                    while (kotlinx.coroutines.isActive) {
                        delay(25_000)
                        webSocket.send("""{"topic":"phoenix","event":"heartbeat","ref":"hb","payload":{}}""")
                    }
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val ev = json.decodeFromString<RtEvent>(text)
                    val d = ev.payload?.data ?: return
                    if (d.table == "messages" && d.record != null && d.event != null) {
                        val m = json.decodeFromJsonElement<Message>(d.record)
                        events.tryEmit(d.event!! to m)
                    }
                } catch (_: Exception) { /* не наше событие */ }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                scheduleReconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        if (session == null) return
        reconnects += 1
        val wait = minOf(3000L * reconnects, 15000L)
        rtScope.launch {
            delay(wait)
            connectRealtime()
        }
    }

    fun closeRealtime() {
        hb?.cancel(); hb = null
        try { ws?.close(1000, null) } catch (_: Exception) { }
        ws = null
    }

    // ---------- утилиты ----------

    private suspend fun reqRaw(method: String, path: String, body: String, headers: Map<String, String>): Resp {
        return kotlinx.coroutines.withContext(Dispatchers.IO) {
            ensureToken()
            val media = "application/json; charset=utf-8".toMediaType()
            val rb = Request.Builder().url(URL + path).header("apikey", KEY)
            if (session != null) rb.header("Authorization", "Bearer " + session!!.access)
            headers.forEach { (k, v) -> rb.header(k, v) }
            if (method == "GET") rb.get() else rb.method(method, body.toRequestBody(media))
            http.newCall(rb.build()).execute().use { r -> Resp(r.code, r.body?.string() ?: "") }
        }
    }

    fun isoNow(): String {
        val f = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        f.timeZone = TimeZone.getTimeZone("UTC")
        return f.format(Date())
    }
}

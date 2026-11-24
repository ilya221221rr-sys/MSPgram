package com.mspgram.app

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.TimeUnit

// ============================================================
//  Supa — слой данных. Все методы повторяют dbApi веб-версии:
//  те же таблицы, те же RPC (friend_request, toggle_reaction,
//  get_or_create_direct_chat, search_public_chats, unread_counts),
//  те же пути REST и Storage.
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
        .readTimeout(45, TimeUnit.SECONDS)
        .writeTimeout(90, TimeUnit.SECONDS)
        .build()

    private lateinit var prefs: SharedPreferences
    fun init(ctx: Context) { prefs = ctx.getSharedPreferences("mspgram", Context.MODE_PRIVATE) }
    fun initialized(): Boolean = this::prefs.isInitialized

    // ---------- состояние ----------
    var session: Session? = null
    var me: Profile? = null
    var sid: String? = null // активная сессия (user_sessions, как msp_sid на сайте)

    var chats: List<Chat> = emptyList()
    var unread: MutableMap<String, Long> = mutableMapOf()
    var reactions: MutableMap<String, MutableList<ReactionRow>> = mutableMapOf()
    var friends: List<FriendEntry> = emptyList()
    var friendReqs: List<FriendEntry> = emptyList()
    var friendOut: List<FriendEntry> = emptyList()
    var myBlocks: MutableSet<String> = mutableSetOf()

    val chatListVersion = MutableStateFlow(0) // сигнал перерисовать список

    val userId: String? get() = if (initialized()) prefs.getString("uid", null) else null

    // ---------- сессия ----------

    suspend fun restore() {
        if (!initialized()) return
        sid = prefs.getString("msp_sid", null)
        val a = prefs.getString("access", null) ?: return
        val r = prefs.getString("refresh", null) ?: return
        session = Session(a, r, prefs.getLong("exp", 0))
        try {
            ensureToken()
            val uid = userId ?: return
            me = loadMe(uid)
            Realtime.setPresenceKey(uid)
        } catch (_: Exception) {
            session = null; me = null
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
        sid = null
        chats = emptyList(); unread.clear(); reactions.clear()
        friends = emptyList(); friendReqs = emptyList(); friendOut = emptyList()
        myBlocks.clear()
        prefs.edit().clear().apply()
        Realtime.close()
    }

    private suspend fun ensureToken() {
        val s = session ?: return
        if (s.expAt - 60_000L < System.currentTimeMillis()) refresh()
    }

    // 2FA (extras.js ensureMfa): логин возвращает aal1-сессию, нужен TOTP-код
    class MfaRequiredException(val uid: String) : Exception("Требуется код двухфакторной аутентификации")

    suspend fun signIn(email: String, pass: String) {
        val resp = req("POST", "/auth/v1/token?grant_type=password", json.encodeToString(SignInBody(email, pass)), false)
        if (resp.code != 200) throw Exception(authErr(resp.body))
        val ar = json.decodeFromString<AuthResp>(resp.body)
        val uid = ar.user?.id ?: throw Exception("Ответ не содержит пользователя")
        if (ar.access_token != null) {
            save(Session(ar.access_token, ar.refresh_token ?: "", System.currentTimeMillis() + ar.expires_in * 1000), uid)
            // у пользователя включена 2FA? → запросить код (как mfa.listFactors после signInWithPassword)
            val fr = reqRaw("GET", "/auth/v1/mfa/factors", null)
            if (fr.code == 200) {
                val factors = runCatching { json.decodeFromString<List<MfaFactor>>(fr.body) }.getOrDefault(emptyList())
                if (factors.any { it.status == "verified" && it.factor_type == "totp" }) {
                    throw MfaRequiredException(uid)
                }
            }
        }
        me = loadMe(uid)
        Realtime.setPresenceKey(uid)
    }

    // подтвердить вход кодом 2FA (challengeAndVerify)
    suspend fun mfaVerifyCode(code: String) {
        val fr = reqRaw("GET", "/auth/v1/mfa/factors", null)
        if (fr.code != 200) throw Exception("Не удалось получить факторы 2FA")
        val factors = json.decodeFromString<List<MfaFactor>>(fr.body)
        val factor = factors.firstOrNull { it.status == "verified" && it.factor_type == "totp" }
            ?: throw Exception("Нет активного фактора 2FA")
        val ch = reqRaw("POST", "/auth/v1/mfa/challenge", json.encodeToString(MfaChallengeBody(factor.id)))
        if (ch.code != 200) throw Exception("Ошибка challenge: " + ch.body.take(120))
        val challenge = json.decodeFromString<MfaChallengeResp>(ch.body)
        val ver = reqRaw("POST", "/auth/v1/mfa/verify", json.encodeToString(MfaVerifyBody(factor.id, challenge.id, code)))
        if (ver.code != 200) throw Exception(if (ver.code == 422) "Неверный код" else "Ошибка: " + ver.body.take(120))
        val ar = json.decodeFromString<AuthResp>(ver.body)
        val uid = ar.user?.id ?: userId ?: ""
        ar.access_token?.let { save(Session(it, ar.refresh_token ?: "", System.currentTimeMillis() + ar.expires_in * 1000), uid) }
        me = loadMe(uid)
        Realtime.setPresenceKey(uid)
    }

    suspend fun signUp(email: String, pass: String, nickname: String) {
        val resp = req("POST", "/auth/v1/signup", json.encodeToString(SignUpBody(email, pass, SignUpData(nickname, nickname))), false)
        if (resp.code != 200) throw Exception(authErr(resp.body))
        val ar = json.decodeFromString<AuthResp>(resp.body)
        if (ar.access_token.isNullOrEmpty()) throw Exception("Аккаунт создан ✓ Подтверди email по письму, потом войди")
        val uid = ar.user?.id ?: throw Exception("Ответ не содержит пользователя")
        save(Session(ar.access_token, ar.refresh_token ?: "", System.currentTimeMillis() + ar.expires_in * 1000), uid)
        me = loadMe(uid)
        Realtime.setPresenceKey(uid)
    }

    private suspend fun refresh() {
        val cur = session ?: return
        val resp = req("POST", "/auth/v1/token?grant_type=refresh_token", json.encodeToString(RefreshBody(cur.refresh)), false)
        if (resp.code != 200) throw Exception("Сессия истекла — войди заново")
        val ar = json.decodeFromString<AuthResp>(resp.body)
        save(Session(ar.access_token ?: "", ar.refresh_token ?: "", System.currentTimeMillis() + ar.expires_in * 1000), userId ?: "")
    }

    private fun authErr(body: String): String = try {
        val e = json.decodeFromString<Map<String, JsonElement>>(body)
        (e["error_description"]?.toString() ?: e["msg"]?.toString() ?: e["error"]?.toString() ?: "Ошибка входа").trim('"')
    } catch (_: Exception) { "Ошибка входа (HTTP)" }

    // ---------- HTTP ----------

    data class Resp(val code: Int, val body: String, val contentRange: String = "")

    private suspend fun reqRaw(method: String, path: String, body: String?, headers: Map<String, String> = emptyMap(), auth: Boolean = true): Resp =
        withContext(Dispatchers.IO) {
            if (auth) ensureToken()
            val media = "application/json; charset=utf-8".toMediaType()
            val rb = Request.Builder().url(URL + path).header("apikey", KEY)
            if (auth && session != null) rb.header("Authorization", "Bearer " + session!!.access)
            headers.forEach { (k, v) -> rb.header(k, v) }
            when (method) {
                "GET" -> rb.get()
                "DELETE" -> rb.delete((body ?: "{}").toRequestBody(media))
                else -> rb.method(method, (body ?: "{}").toRequestBody(media))
            }
            http.newCall(rb.build()).execute().use { r ->
                Resp(r.code, r.body?.string() ?: "", r.header("Content-Range") ?: "")
            }
        }

    private suspend fun req(method: String, path: String, body: String?, auth: Boolean): Resp {
        if (auth) ensureToken()
        return reqRaw(method, path, body, emptyMap(), auth)
    }

    private suspend fun get(path: String): String {
        val r = req("GET", path, null, true)
        if (r.code != 200) throw Exception("HTTP ${r.code}: ${r.body.take(160)}")
        return r.body
    }

    private suspend fun patch(path: String, body: String, headers: Map<String, String> = emptyMap()): Resp {
        val r = reqRaw("PATCH", path, body, headers)
        if (r.code !in 200..299) throw Exception("HTTP ${r.code}: ${r.body.take(160)}")
        return r
    }

    private suspend fun del(path: String): String {
        val r = req("DELETE", path, null, true)
        if (r.code !in 200..299) throw Exception("HTTP ${r.code}")
        return r.body
    }

    // ---------- чаты ----------

    suspend fun loadChats() {
        chats = json.decodeFromString(get("/rest/v1/chats?select=*,chat_members(*,profiles(*))"))
        try { unreadCounts().forEach { (k, v) -> unread[k] = v } } catch (_: Exception) { }
        chatListVersion.value++
    }

    suspend fun unreadCounts(): Map<String, Long> = try {
        val r = reqRaw("POST", "/rest/v1/rpc/unread_counts", "{}")
        if (r.code in 200..299) json.decodeFromString<List<UnreadRow>>(r.body).associate { it.chat_id to it.cnt }
        else emptyMap()
    } catch (_: Exception) { emptyMap() }

    fun chatById(id: String): Chat? = chats.firstOrNull { it.id == id }

    suspend fun loadChannels(chatId: String): List<Channel> = try {
        json.decodeFromString(get("/rest/v1/channels?select=*&chat_id=eq.$chatId&order=id"))
    } catch (_: Exception) { emptyList() }

    suspend fun loadMessages(chatId: String, channelId: String?): List<Message> {
        var p = "/rest/v1/messages?select=*&chat_id=eq.$chatId"
        if (channelId != null) p += "&channel_id=eq.$channelId"
        p += "&order=created_at.desc&limit=60"
        return json.decodeFromString<List<Message>>(get(p)).reversed()
    }

    // история до момента (chatview.js: load-earlier / jumpToMessage, MSG_LIMIT 50)
    suspend fun loadMessagesBefore(chatId: String, channelId: String?, beforeIso: String, limit: Int = 50): List<Message> {
        var p = "/rest/v1/messages?select=*&chat_id=eq.$chatId&created_at=lt.$beforeIso"
        if (channelId != null) p += "&channel_id=eq.$channelId"
        p += "&order=created_at.desc&limit=$limit"
        return json.decodeFromString<List<Message>>(get(p)).reversed()
    }

    // сообщение из любого места истории (jumpToMessage.findMessageAnywhere)
    suspend fun findMessage(chatId: String, msgId: String): Message? {
        val r = runCatching { get("/rest/v1/messages?select=*&id=eq.$msgId&chat_id=eq.$chatId") }.getOrDefault("")
        val list = runCatching { json.decodeFromString<List<Message>>(r) }.getOrDefault(emptyList())
        return list.firstOrNull()
    }

    // 🔖 в «Избранное» (api.js saveToFavorites): сообщение копируется в saved-чат
    suspend fun saveToFavorites(m: Message) {
        val savedId = savedChatId() ?: throw Exception("Не удалось открыть «Избранное»")
        val row = MsgPayload(
            chat_id = savedId, sender_id = userId ?: "",
            body = m.body ?: "",
            channel_id = null,
            attachment_type = m.attachment_type, attachment_url = m.attachment_url,
            attachment_name = m.attachment_name, attachment_size = m.attachment_size,
            duration_ms = m.duration_ms,
        )
        reqRaw("POST", "/rest/v1/messages", json.encodeToString(row), mapOf("Prefer" to "return=minimal"))
    }

    suspend fun savedChatId(): String? {
        val r = reqRaw("POST", "/rest/v1/rpc/get_or_create_saved_chat", "{}", mapOf("Prefer" to "return=representation"))
        if (r.code == 200) {
            val clean = r.body.trim().trim('"')
            if (clean.length > 20) return clean
        }
        val meId = userId ?: return null
        val rows = runCatching {
            json.decodeFromString<List<Chat>>(get("/rest/v1/chats?select=*&is_saved=eq.true&limit=1"))
        }.getOrDefault(emptyList())
        return rows.firstOrNull()?.id
    }

    suspend fun sendMessageFull(p: MsgPayload): Message {
        val r = reqRaw(
            "POST", "/rest/v1/messages", json.encodeToString(p),
            mapOf("Prefer" to "return=representation"),
        )
        if (r.code !in 200..299) throw Exception("HTTP ${r.code}: ${r.body.take(160)}")
        return json.decodeFromString<List<Message>>(r.body).first()
    }

    suspend fun sendMessage(chatId: String, channelId: String?, body: String, replyTo: String? = null): Message =
        sendMessageFull(MsgPayload(chat_id = chatId, sender_id = userId ?: "", body = body, channel_id = channelId, reply_to = replyTo))

    suspend fun editMessage(id: String, body: String): Message {
        val r = patch("/rest/v1/messages?id=eq.$id", json.encodeToString(EditPayload(body, isoNow())))
        return json.decodeFromString<List<Message>>(r.body).firstOrNull() ?: throw Exception("Сообщение не найдено")
    }

    suspend fun deleteMessage(id: String) { del("/rest/v1/messages?id=eq.$id") }

    suspend fun forwardMessage(targetChatId: String, src: Message, fromName: String): Message {
        val target = chatById(targetChatId)
        val channelId = if (target?.type == "group") loadChannels(targetChatId).firstOrNull()?.id else null
        return sendMessageFull(MsgPayload(
            chat_id = targetChatId,
            sender_id = userId ?: "",
            body = src.body,
            channel_id = channelId,
            attachment_type = src.attachment_type,
            attachment_url = src.attachment_url,
            attachment_name = src.attachment_name,
            attachment_size = src.attachment_size,
            duration_ms = src.duration_ms,
            forwarded_from = fromName,
        ))
    }

    suspend fun loadReactions(msgIds: List<String>) {
        if (msgIds.isEmpty()) return
        val ids = msgIds.joinToString(",") { "\"$it\"" }
        try {
            val rows = json.decodeFromString<List<ReactionRow>>(get("/rest/v1/reactions?select=message_id,user_id,emoji&message_id=in.($ids)"))
            reactions.clear()
            rows.forEach { reactions.getOrPut(it.message_id) { mutableListOf() }.add(it) }
        } catch (_: Exception) { }
    }

    suspend fun toggleReaction(msgId: String, emoji: String): Boolean {
        val body = json.encodeToString(buildJsonObject { put("msg", msgId); put("emo", emoji) })
        val r = reqRaw("POST", "/rest/v1/rpc/toggle_reaction", body)
        if (r.code !in 200..299) throw Exception("Не удалось поставить реакцию")
        return r.body.contains("true")
    }

    suspend fun pinMessage(chatId: String, msgId: String) {
        patch("/rest/v1/chats?id=eq.$chatId", json.encodeToString(PinPayload(msgId)))
        chatById(chatId)?.let { c ->
            val i = chats.indexOfFirst { it.id == chatId }
            if (i >= 0) chats = chats.toMutableList().apply { set(i, c.copy(pinned_message_id = msgId)) }
        }
        chatListVersion.value++
    }

    suspend fun unpinMessage(chatId: String) {
        patch("/rest/v1/chats?id=eq.$chatId", json.encodeToString(PinPayload(null)))
        chatById(chatId)?.let { c ->
            val i = chats.indexOfFirst { it.id == chatId }
            if (i >= 0) chats = chats.toMutableList().apply { set(i, c.copy(pinned_message_id = null)) }
        }
        chatListVersion.value++
    }

    suspend fun setChatFlags(chatId: String, flags: MemberFlagPayload) {
        val meId = userId ?: return
        patch("/rest/v1/chat_members?chat_id=eq.$chatId&user_id=eq.$meId", json.encodeToString(flags))
        // локально
        val i = chats.indexOfFirst { it.id == chatId }
        if (i >= 0) {
            val c = chats[i]
            val nm = c.members.map {
                if (it.user_id == meId) it.copy(
                    muted = flags.muted ?: it.muted,
                    pinned = flags.pinned ?: it.pinned,
                    archived = flags.archived ?: it.archived,
                    last_read_at = flags.last_read_at ?: it.last_read_at,
                ) else it
            }
            chats = chats.toMutableList().apply { set(i, c.copy(members = nm)) }
        }
        chatListVersion.value++
    }

    suspend fun markRead(chatId: String) {
        val meId = userId ?: return
        try {
            patch("/rest/v1/chat_members?chat_id=eq.$chatId&user_id=eq.$meId", json.encodeToString(MemberFlagPayload(last_read_at = isoNow())))
            unread.remove(chatId)
            chatListVersion.value++
        } catch (_: Exception) { }
    }

    suspend fun markDelivered(chatId: String? = null) {
        val meId = userId ?: return
        try {
            val q = if (chatId != null) "/rest/v1/chat_members?chat_id=eq.$chatId&user_id=eq.$meId" else "/rest/v1/chat_members?user_id=eq.$meId"
            patch(q, json.encodeToString(MemberFlagPayload(last_delivered_at = isoNow())))
        } catch (_: Exception) { }
    }

    // ---------- профили ----------

    suspend fun loadMe(id: String): Profile =
        json.decodeFromString<List<Profile>>(get("/rest/v1/profiles?select=*&id=eq.$id")).first()

    suspend fun loadProfile(id: String): Profile =
        json.decodeFromString<List<Profile>>(get("/rest/v1/profiles?select=*&id=eq.$id")).firstOrNull()
            ?: throw Exception("Профиль не найден")

    suspend fun searchUsers(q: String): List<Profile> {
        val safe = q.replace(",", " ").replace("(", " ").replace(")", " ")
        return json.decodeFromString(
            get("/rest/v1/profiles?select=*&or=(nickname.ilike.*$safe*,display_name.ilike.*$safe*)&limit=10"),
        )
    }

    suspend fun updateMe(patch: ProfilePatch) {
        val meId = userId ?: return
        patch("/rest/v1/profiles?id=eq.$meId", json.encodeToString(patch))
        me = loadMe(meId)
        chatListVersion.value++
    }

    suspend fun uploadAvatar(ctx: Context, uri: android.net.Uri): String {
        val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() }
            ?: throw Exception("Не удалось прочитать файл")
        val mime = ctx.contentResolver.getType(uri)?.takeIf { it.startsWith("image/") } ?: "image/jpeg"
        val ext = android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(mime) ?: "jpg"
        val path = "${userId}/${UUID.randomUUID()}.$ext"
        val url = storageUpload("avatars", path, bytes, mime)
        updateMe(ProfilePatch(avatar_url = url))
        return url
    }

    suspend fun uploadChatFile(chatId: String, bytes: ByteArray, mime: String, name: String): Pair<String, Long> {
        val path = "$chatId/${UUID.randomUUID()}__${name.replace(Regex("[\\\\/#?&%\"']"), "_")}"
        val url = storageUpload("chat-files", path, bytes, mime)
        return url to bytes.size.toLong()
    }

    private suspend fun storageUpload(bucket: String, path: String, bytes: ByteArray, mime: String): String = withContext(Dispatchers.IO) {
        val encodedPath = path.split("/").joinToString("/") { java.net.URLEncoder.encode(it, "UTF-8").replace("+", "%20") }
        val rb = Request.Builder()
            .url("$URL/storage/v1/object/$bucket/$encodedPath")
            .header("apikey", KEY)
            .header("Authorization", "Bearer " + (session?.access ?: ""))
            .header("x-upsert", "true")
            .post(bytes.toRequestBody(mime.toMediaType()))
        http.newCall(rb.build()).execute().use { r ->
            if (r.code !in 200..299) throw Exception("Загрузка не удалась: HTTP ${r.code} ${r.body?.string()?.take(120)}")
        }
        "$URL/storage/v1/object/public/$bucket/$encodedPath"
    }

    // ---------- личные чаты / блокировки ----------

    suspend fun startDirect(userId2: String): String {
        // guard блокировок (как в api.js startDirect)
        try {
            val meId = userId ?: throw Exception("Нет сессии")
            val r = reqRaw(
                "GET",
                "/rest/v1/blocks?select=blocker,blocked&or=(and(blocker.eq.$meId,blocked.eq.$userId2),and(blocker.eq.$userId2,blocked.eq.$meId))&limit=1",
                null,
            )
            if (r.code == 200 && r.body.contains("blocker")) {
                val isMine = r.body.contains("\"blocker\":\"$meId\"")
                throw Exception(if (isMine) "Ты заблокировал(а) этого пользователя" else "Пользователь заблокировал тебя 😔")
            }
        } catch (e: Exception) {
            if (e.message?.contains("блокир") == true) throw e
        }
        // штатный путь — RPC с сайта
        try {
            val r = reqRaw("POST", "/rest/v1/rpc/get_or_create_direct_chat", json.encodeToString(buildJsonObject { put("other_user", userId2) }))
            if (r.code in 200..299 && !r.body.startsWith("null")) {
                val id = r.body.trim('"')
                if (id.isNotBlank() && chatById(id) == null) loadChats()
                return id
            }
        } catch (_: Exception) { }
        // фолбэк: найти существующий
        chats.firstOrNull { c ->
            c.type == "direct" && !c.isSaved() && c.members.any { it.user_id == userId2 }
        }?.let { return it.id }
        throw Exception("Не удалось открыть чат")
    }

    suspend fun loadMyBlocks() {
        val meId = userId ?: return
        try {
            val rows = json.decodeFromString<List<JsonObject>>(get("/rest/v1/blocks?select=blocker,blocked&or=(blocker.eq.$meId,blocked.eq.$meId)"))
            myBlocks = rows.mapNotNull { it["blocked"]?.jsonPrimitive?.contentOrNull }.toMutableSet()
        } catch (_: Exception) { }
    }

    suspend fun setBlock(target: String, blocked: Boolean) {
        val meId = userId ?: throw Exception("Нет сессии")
        if (blocked) {
            val body = json.encodeToString(buildJsonObject { put("blocker", meId); put("blocked", target) })
            val r = reqRaw("POST", "/rest/v1/blocks", body, mapOf("Prefer" to "return=minimal"))
            if (r.code !in 200..299) throw Exception("Не удалось заблокировать")
            myBlocks.add(target)
        } else {
            del("/rest/v1/blocks?blocker=eq.$meId&blocked=eq.$target")
            myBlocks.remove(target)
        }
    }

    // ---------- друзья (RPC из migration-9) ----------

    suspend fun loadFriends() {
        try {
            val rows = json.decodeFromString<List<Friendship>>(get("/rest/v1/friendships?select=*"))
            val meId = userId ?: return
            val ids = rows.map { if (it.requester == meId) it.addressee else it.requester }.distinct()
            val profs: Map<String, Profile> = if (ids.isNotEmpty()) {
                json.decodeFromString<List<Profile>>(
                    get("/rest/v1/profiles?select=*&id=in.(${ids.joinToString(",") { "\"$it\"" }})"),
                ).associateBy { it.id }
            } else emptyMap()
            val wrap = { r: Friendship ->
                FriendEntry(id = r.id, status = r.status, profile = profs[if (r.requester == meId) r.addressee else r.requester], created_at = r.created_at)
            }
            friends = rows.filter { it.status == "accepted" }.map(wrap).filter { it.profile != null }
            friendReqs = rows.filter { it.status == "pending" && it.addressee == meId }.map(wrap).filter { it.profile != null }
            friendOut = rows.filter { it.status == "pending" && it.requester == meId }.map(wrap).filter { it.profile != null }
            chatListVersion.value++
        } catch (_: Exception) { /* миграции нет — тихо */ }
    }

    suspend fun friendRequest(target: String) {
        val r = reqRaw("POST", "/rest/v1/rpc/friend_request", json.encodeToString(buildJsonObject { put("target", target) }))
        if (r.code !in 200..299) throw Exception("Не удалось отправить заявку")
        loadFriends()
    }

    suspend fun friendRespond(reqId: String, accept: Boolean) {
        val r = reqRaw("POST", "/rest/v1/rpc/friend_respond", json.encodeToString(buildJsonObject { put("req", reqId); put("accept", accept) }))
        if (r.code !in 200..299) throw Exception("Не удалось обработать заявку")
        loadFriends()
    }

    suspend fun friendRemove(reqId: String) {
        del("/rest/v1/friendships?id=eq.$reqId")
        loadFriends()
    }

    // ---------- жалобы ----------

    suspend fun createReport(target: String, reason: String) {
        val body = json.encodeToString(ReportInsert(reporter = userId ?: "", target_profile = target, reason = reason))
        val r = reqRaw("POST", "/rest/v1/reports", body, mapOf("Prefer" to "return=minimal"))
        if (r.code !in 200..299) throw Exception("Не удалось отправить жалобу")
    }

    // ---------- сообщества ----------

    suspend fun searchPublicChats(q: String): List<PublicChatRow> = try {
        val r = reqRaw("POST", "/rest/v1/rpc/search_public_chats", json.encodeToString(buildJsonObject { put("q", q) }))
        if (r.code in 200..299) json.decodeFromString(r.body) else fallbackPublic()
    } catch (_: Exception) { fallbackPublic() }

    private suspend fun fallbackPublic(): List<PublicChatRow> = try {
        json.decodeFromString(get("/rest/v1/chats?select=id,title,avatar_url&is_public=eq.true&type=eq.group&limit=20"))
    } catch (_: Exception) { emptyList() }

    suspend fun joinPublic(chatId: String) {
        val body = json.encodeToString(buildJsonObject {
            put("chat_id", chatId); put("user_id", userId ?: ""); put("role", "member")
        })
        reqRaw("POST", "/rest/v1/chat_members", body, mapOf("Prefer" to "return=minimal"))
        loadChats()
    }

    suspend fun createServer(title: String, memberIds: List<String> = emptyList()): String {
        val chatBody = json.encodeToString(buildJsonObject {
            put("type", "group"); put("title", title); put("created_by", userId ?: "")
        })
        val r = reqRaw("POST", "/rest/v1/chats", chatBody, mapOf("Prefer" to "return=representation"))
        if (r.code !in 200..299) throw Exception("Не удалось создать сервер: ${r.body.take(120)}")
        val chat = json.decodeFromString<List<Chat>>(r.body).first()
        addMembers(chat.id, memberIds)
        val memBody = json.encodeToString(buildJsonObject {
            put("chat_id", chat.id); put("user_id", userId ?: ""); put("role", "owner")
        })
        reqRaw("POST", "/rest/v1/chat_members", memBody, mapOf("Prefer" to "return=minimal"))
        loadChats()
        return chat.id
    }

    // ---------- активные сессии (как api-v18) ----------

    suspend fun registerSession(device: String) {
        val meId = userId ?: return
        // старая сессия жива?
        sid?.let { s ->
            try {
                val rows = json.decodeFromString<List<SessionRow>>(get("/rest/v1/user_sessions?select=id,revoked&id=eq.$s"))
                val row = rows.firstOrNull()
                if (row != null && row.revoked) { forceLogout(); return }
                if (row != null) {
                    patch("/rest/v1/user_sessions?id=eq.$s", json.encodeToString(buildJsonObject { put("last_active", isoNow()) }))
                    return
                }
            } catch (_: Exception) { return }
        }
        val s = UUID.randomUUID().toString()
        val body = json.encodeToString(SessionInsert(id = s, user_id = meId, device = device, user_agent = "Android ${android.os.Build.VERSION.RELEASE}"))
        val r = reqRaw("POST", "/rest/v1/user_sessions", body, mapOf("Prefer" to "return=minimal"))
        if (r.code in 200..299) {
            sid = s
            prefs.edit().putString("msp_sid", s).apply()
        }
    }

    suspend fun pingSession() {
        val s = sid ?: return
        try {
            val rows = json.decodeFromString<List<SessionRow>>(get("/rest/v1/user_sessions?select=id,revoked&id=eq.$s"))
            if (rows.firstOrNull()?.revoked == true) forceLogout()
            else patch("/rest/v1/user_sessions?id=eq.$s", json.encodeToString(buildJsonObject { put("last_active", isoNow()) }))
        } catch (_: Exception) { }
    }

    suspend fun listSessions(): List<SessionRow> = try {
        json.decodeFromString(get("/rest/v1/user_sessions?select=*&revoked=eq.false&order=last_active.desc"))
    } catch (_: Exception) { emptyList() }

    suspend fun revokeSession(id: String) {
        patch("/rest/v1/user_sessions?id=eq.$id", json.encodeToString(buildJsonObject { put("revoked", true) }))
    }

    suspend fun revokeOtherSessions() {
        val s = sid
        val q = if (s != null) "/rest/v1/user_sessions?user_id=eq.$userId&id=neq.$s" else "/rest/v1/user_sessions?user_id=eq.$userId"
        patch(q, json.encodeToString(buildJsonObject { put("revoked", true) }))
    }

    suspend fun forceLogout() {
        logout()
    }

    // ---------- админ (как admin.js / admin2.js) ----------

    suspend fun adminListUsers(): List<Profile> =
        json.decodeFromString(get("/rest/v1/profiles?select=*&order=created_at"))

    suspend fun adminSetBan(id: String, banned: Boolean, reason: String?, untilIso: String?) {
        val body = json.encodeToString(BanPayload(is_banned = banned, ban_reason = reason, banned_until = untilIso))
        val r = patch("/rest/v1/profiles?id=eq.$id", body)
        if (r.code !in 200..299) throw Exception("Не удалось применить бан")
    }

    suspend fun adminUpdateProfile(id: String, patch: ProfilePatch) {
        patch("/rest/v1/profiles?id=eq.$id", json.encodeToString(patch))
    }

    suspend fun adminReports(): List<ReportRow> =
        json.decodeFromString(get("/rest/v1/reports?select=*&order=created_at.desc"))

    suspend fun adminSetReportStatus(id: String, status: String) {
        patch("/rest/v1/reports?id=eq.$id", json.encodeToString(buildJsonObject { put("status", status) }))
    }

    suspend fun adminStats(): Map<String, Long> = mapOf(
        "users" to countExact("profiles"),
        "chats" to countExact("chats"),
        "messages" to countExact("messages"),
        "reports" to countExact("reports"),
        "blocks" to countExact("blocks"),
    )

    private suspend fun countExact(table: String): Long {
        val r = reqRaw("GET", "/rest/v1/$table?select=id&limit=1", null, mapOf("Prefer" to "count=exact"))
        // Content-Range: "0-0/42" → 42; либо "*/42"
        val cr = r.contentRange
        val total = cr.substringAfter('/', "").takeWhile { it.isDigit() }
        return total.toLongOrNull() ?: 0L
    }

    // ---------- утилиты ----------

    // ---------- группы: инвайты, участники, каналы, права (как api.js) ----------

    suspend fun createInvite(chatId: String, maxUses: Long? = null, hours: Long = 168): String {
        val body = json.encodeToString(buildJsonObject {
            put("chat", chatId); put("max_uses", maxUses); put("hours", hours)
        })
        val r = reqRaw("POST", "/rest/v1/rpc/create_invite", body)
        if (r.code !in 200..299) throw Exception("Не удалось создать ссылку")
        return json.decodeFromString<String>(r.body).trim('"')
    }

    suspend fun joinByInvite(code: String): String {
        val body = json.encodeToString(buildJsonObject { put("inv", code.trim()) })
        val r = reqRaw("POST", "/rest/v1/rpc/join_by_invite", body)
        if (r.code !in 200..299) throw Exception("Не удалось присоединиться")
        return json.decodeFromString<String>(r.body).trim('"')
    }

    suspend fun addMembers(chatId: String, ids: List<String>) {
        if (ids.isEmpty()) return
        val arr = buildJsonArray {
            ids.forEach { addJsonObject { put("chat_id", chatId); put("user_id", it); put("role", "member") } }
        }
        val r = reqRaw("POST", "/rest/v1/chat_members", json.encodeToString(arr), mapOf("Prefer" to "return=minimal"))
        if (r.code !in 200..299) throw Exception("Не удалось добавить участников")
        loadChats()
    }

    suspend fun leaveChat(chatId: String) {
        del("/rest/v1/chat_members?chat_id=eq.$chatId&user_id=eq.$userId")
        chats = chats.filter { it.id != chatId }
        chatListVersion.value++
    }

    suspend fun deleteChat(chatId: String) {
        del("/rest/v1/chats?id=eq.$chatId")
        chats = chats.filter { it.id != chatId }
        chatListVersion.value++
    }

    suspend fun setServerPublic(chatId: String, public: Boolean) {
        val r = patch("/rest/v1/chats?id=eq.$chatId", json.encodeToString(buildJsonObject { put("is_public", public) }))
        if (r.code !in 200..299) throw Exception("Не удалось изменить приватность")
        val i = chats.indexOfFirst { it.id == chatId }
        if (i >= 0) chats = chats.toMutableList().apply { set(i, chats[i].copy(is_public = public)) }
        chatListVersion.value++
    }

    suspend fun setMemberRole(chatId: String, uid: String, role: String) {
        val r = patch("/rest/v1/chat_members?chat_id=eq.$chatId&user_id=eq.$uid",
            json.encodeToString(buildJsonObject { put("role", role) }))
        if (r.code !in 200..299) throw Exception("Не удалось изменить роль")
    }

    suspend fun kickMember(chatId: String, uid: String) {
        del("/rest/v1/chat_members?chat_id=eq.$chatId&user_id=eq.$uid")
        loadChats()
    }

    suspend fun createChannel(chatId: String, name: String): Channel {
        val body = json.encodeToString(buildJsonObject { put("chat_id", chatId); put("name", name) })
        val r = reqRaw("POST", "/rest/v1/channels", body, mapOf("Prefer" to "return=representation"))
        if (r.code !in 200..299) throw Exception("Не удалось создать канал")
        return json.decodeFromString<List<Channel>>(r.body).first()
    }

    suspend fun deleteChannel(channelId: String) {
        del("/rest/v1/channels?id=eq.$channelId")
    }

    suspend fun updateChatSettings(chatId: String, description: String?, onlyAdmins: Boolean?, allowMedia: Boolean?) {
        val o = buildJsonObject {
            if (description != null) put("description", description)
            if (onlyAdmins != null) put("only_admins_post", onlyAdmins)
            if (allowMedia != null) put("allow_media", allowMedia)
        }
        val r = patch("/rest/v1/chats?id=eq.$chatId", json.encodeToString(o))
        if (r.code !in 200..299) throw Exception("Не удалось сохранить права")
        val i = chats.indexOfFirst { it.id == chatId }
        if (i >= 0) {
            val c = chats[i]
            chats = chats.toMutableList().apply {
                set(i, c.copy(
                    description = description ?: c.description,
                    only_admins_post = onlyAdmins ?: c.only_admins_post,
                    allow_media = allowMedia ?: c.allow_media,
                ))
            }
        }
        chatListVersion.value++
    }

    suspend fun loadAnnouncements(): List<Announcement> = try {
        json.decodeFromString<List<Announcement>>(
            get("/rest/v1/app_announcements?select=*&or=(expires_at.is.null,expires_at.gt.${isoNow()})&order=created_at.desc&limit=5"),
        )
    } catch (_: Exception) { emptyList() }

    fun isoNow(): String {
        val f = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        f.timeZone = TimeZone.getTimeZone("UTC")
        return f.format(Date())
    }

    suspend fun registerFcm(token: String) {
        if (session == null || userId == null) return
        try {
            reqRaw("POST", "/rest/v1/rpc/register_fcm", json.encodeToString(buildJsonObject {
                put("p_token", token); put("p_ua", "android")
            }))
        } catch (_: Exception) { }
    }

    fun canPostIn(chat: Chat): Boolean {
        val meId = userId ?: return false
        val mine = chat.myFlags(meId) ?: return false
        if (chat.only_admins_post) return mine.role in listOf("owner", "admin") || me?.is_admin == true
        return true
    }

    fun presenceOf(p: Profile?): String? {
        if (p == null) return null
        val privacy = p.privacy_last_seen ?: "everyone"
        if (privacy == "nobody") return null
        if (privacy == "friends" && friends.none { it.profile?.id == p.id }) return null
        if (!Realtime.online.value.contains(p.id)) return null
        return p.presence_status?.takeIf { it in listOf("online", "away", "dnd") } ?: "online"
    }
}

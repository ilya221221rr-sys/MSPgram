package com.mspgram.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Button
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.contentOrNull
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

// ============================================================
//  MSPgram Android — точка входа. Все функции веб-версии.
// ============================================================

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Supa.init(this)
        Prefs.init(this)
        Calls.init(this)
        val jumpChat = intent?.getStringExtra("chatId")
        setContent {
            MspTheme {
                Root(jumpChat)
            }
        }
    }
}

@Composable
fun Root(jumpChat: String?) {
    var loading by remember { mutableStateOf(true) }
    var me by remember { mutableStateOf<Profile?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        Supa.restore()
        me = Supa.me
        loading = false
    }

    if (loading) {
        Box(Modifier.fillMaxSize().background(DarkBg), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(color = accentColor(Prefs.get().accent))
        }
    } else if (me == null) {
        LoginScreen(onEnter = { me = Supa.me })
    } else {
        MainScreen(me!!, jumpChat, onLogout = {
            scope.launch { Supa.logout() }
            me = null
        })
    }
}

// ---------- ВХОД ----------

@Composable
fun LoginScreen(onEnter: () -> Unit) {
    var mode by remember { mutableStateOf("login") }
    var email by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }
    var nick by remember { mutableStateOf("") }
    var err by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Column(
        Modifier.fillMaxSize().background(DarkBg).padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("MSPgram", fontSize = 34.sp, fontWeight = FontWeight.Bold, color = accentColor(Prefs.get().accent))
        Text("Нативный мессенджер", fontSize = 13.sp, color = MutedText)
        Spacer(Modifier.size(28.dp))
        if (mode == "signup") {
            OutlinedTextField(
                value = nick, onValueChange = { nick = it },
                label = { Text("Ник (латиница)") }, singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.size(10.dp))
        }
        OutlinedTextField(value = email, onValueChange = { email = it }, label = { Text("Email") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.size(10.dp))
        OutlinedTextField(value = pass, onValueChange = { pass = it }, label = { Text("Пароль") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        if (err.isNotEmpty()) {
            Spacer(Modifier.size(10.dp))
            Text(err, color = DangerColor, fontSize = 13.sp)
        }
        Spacer(Modifier.size(18.dp))
        if (busy) {
            CircularProgressIndicator(color = accentColor(Prefs.get().accent))
        } else {
            Button(
                onClick = {
                    busy = true; err = ""
                    scope.launch {
                        try {
                            if (mode == "login") Supa.signIn(email.trim(), pass)
                            else Supa.signUp(email.trim(), pass, nick.trim())
                            onEnter()
                        } catch (e: Exception) { err = e.message ?: "Ошибка" }
                        busy = false
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (mode == "login") "Войти" else "Создать аккаунт") }
            TextButton(onClick = { mode = if (mode == "login") "signup" else "login"; err = "" }) {
                Text(if (mode == "login") "Нет аккаунта? Зарегистрироваться" else "У меня есть аккаунт — войти")
            }
        }
    }
}

// ---------- ГЛАВНЫЙ ЭКРАН: нижняя навигация ----------

@Composable
fun MainScreen(me: Profile, jumpChat: String?, onLogout: () -> Unit) {
    val scope = rememberCoroutineScope()
    val ctx = androidx.compose.ui.platform.LocalContext.current

    // таб: 0 чаты, 1 друзья, 2 AI, 3 настройки (как панели сайта)
    var tab by remember { mutableStateOf(0) }
    var openChatId by remember { mutableStateOf<String?>(jumpChat) }
    var adminOpen by remember { mutableStateOf(false) }
    var announcement by remember { mutableStateOf<Announcement?>(null) }
    val connected by Realtime.connected.collectAsState()

    fun reloadAnnouncement() {
        scope.launch {
            try {
                val dismissed = try {
                    kotlinx.serialization.json.Json.decodeFromString<List<String>>(Prefs.get().annDismissed)
                } catch (_: Exception) { emptyList() }
                announcement = Supa.loadAnnouncements().firstOrNull { it.id !in dismissed }
            } catch (_: Exception) { }
        }
    }

    // ---------- глобальная инициализация ----------
    val notifPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) registerFcm(ctx)
    }

    LaunchedEffect(Unit) {
        Supa.loadChats()
        Supa.loadFriends()
        Supa.loadMyBlocks()
        Realtime.connect(Supa.KEY, Supa.URL)
        Realtime.join(
            "realtime:msp-db",
            """[{"event":"*","schema":"public","table":"messages"},{"event":"*","schema":"public","table":"reactions"},{"event":"*","schema":"public","table":"chats"},{"event":"*","schema":"public","table":"chat_members"},{"event":"*","schema":"public","table":"friendships"},{"event":"*","schema":"public","table":"user_sessions"},{"event":"*","schema":"public","table":"app_announcements"}]""",
        )
        reloadAnnouncement()
        Realtime.join("msp-online")
        Realtime.presenceTrack(Supa.userId ?: "", Supa.me?.presence_status ?: "online")
        Supa.registerSession("Android")
        Supa.markDelivered()
        startSessionHeartbeat()
        // уведомления: запрос разрешения из композиции (в RESUMED нельзя)
        Notifs.ensureChannels(ctx)
        if (Build.VERSION.SDK_INT >= 33 &&
            ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) notifPerm.launch(Manifest.permission.POST_NOTIFICATIONS)
        else registerFcm(ctx)
    }

    // ---------- realtime: база ----------
    LaunchedEffect(Unit) {
        Realtime.db.collect { ev ->
            when (ev.table) {
                "messages" -> {
                    try {
                        val m = Supa.json.decodeFromJsonElement(Message.serializer(), ev.record)
                        val c = Supa.chatById(m.chat_id)
                        if (ev.event == "INSERT") {
                            ChatSession.onNewMessage(m)
                            val mine = m.sender_id == Supa.userId
                            if (openChatId != m.chat_id) {
                                Supa.unread[m.chat_id] = (Supa.unread[m.chat_id] ?: 0L) + 1
                                if (!mine && Prefs.get().sound && c?.myFlags(Supa.userId ?: "")?.muted != true) {
                                    beep()
                                    val from = c?.members?.firstOrNull { it.user_id == m.sender_id }?.profiles?.name
                                    Notifs.push(ctx, from ?: "Новое сообщение", m.body ?: previewOf(m), m.chat_id)
                                }
                            } else {
                                Supa.markRead(m.chat_id)
                            }
                            c?.let { cc ->
                                Supa.chats = Supa.chats.map { x ->
                                    if (x.id == cc.id) x.copy(last_message_at = m.created_at, last_message_text = previewOf(m), last_message_sender = m.sender_id)
                                    else x
                                }
                            }
                            Supa.chatListVersion.value++
                        } else if (ev.event == "UPDATE") {
                            ChatSession.onEditMessage(m)
                        } else if (ev.event == "DELETE") {
                            ChatSession.onDeleteMessage(m.id)
                        }
                    } catch (_: Exception) { }
                }
                "reactions" -> {
                    try {
                        val r = Supa.json.decodeFromJsonElement(ReactionRow.serializer(), ev.record)
                        val list = Supa.reactions.getOrPut(r.message_id) { mutableListOf() }
                        if (ev.event == "INSERT") {
                            if (list.none { it.user_id == r.user_id && it.emoji == r.emoji }) list.add(r)
                            Notifs.onReaction(r)
                        } else {
                            list.removeAll { it.user_id == r.user_id && it.emoji == r.emoji }
                        }
                        ChatSession.bumpReactions()
                    } catch (_: Exception) { }
                }
                "chats" -> {
                    if (ev.event == "UPDATE") {
                        try {
                            val row = Supa.json.decodeFromJsonElement(Chat.serializer(), ev.record)
                            Supa.chats = Supa.chats.map { if (it.id == row.id) it.copy(pinned_message_id = row.pinned_message_id, only_admins_post = row.only_admins_post, allow_media = row.allow_media, title = row.title) else it }
                            Supa.chatListVersion.value++
                        } catch (_: Exception) { }
                    } else if (ev.event == "INSERT") {
                        scope.launch { Supa.loadChats() }
                    } else if (ev.event == "DELETE") {
                        scope.launch { Supa.loadChats() }
                    }
                }
                "chat_members" -> {
                    scope.launch { Supa.loadChats() }
                }
                "app_announcements" -> {
                    reloadAnnouncement()
                    if (ev.event == "INSERT") {
                        val title = ev.record.str("title")
                        val body = ev.record.str("body") ?: ""
                        val createdBy = ev.record.str("created_by")
                        if (createdBy != Supa.userId) Notifs.push(ctx, "📣 $title", body)
                    }
                }
                "friendships" -> {
                    scope.launch {
                        Supa.loadFriends()
                        if (ev.event == "INSERT") {
                            val addressee = ev.record.str("addressee") ?: return@launch
                            if (addressee == Supa.userId) {
                                val requester = ev.record.str("requester") ?: return@launch
                                val prof = runCatching { Supa.loadProfile(requester) }.getOrNull()
                                Notifs.push(ctx, "${prof?.name ?: "Кто-то"} хочет дружить", "Открой «Друзья», чтобы принять заявку")
                            }
                        }
                    }
                }
                "user_sessions" -> {
                    if (ev.event == "UPDATE") {
                        val id = ev.record.str("id")
                        val revoked = (ev.record["revoked"] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull == "true"
                        if (revoked && id == Supa.sid) { Supa.logout(); onLogout() }
                    }
                }
            }
        }
    }

    // ---------- realtime: broadcast (звонки, голосовые, typing) ----------
    LaunchedEffect(Unit) {
        Realtime.broadcast.collect { b ->
            when {
                b.topic.startsWith("call-") -> Calls.handleCallBroadcast(b)
                b.topic.startsWith("voice-") -> Calls.handleVoiceBroadcast(b)
                b.topic.startsWith("typing-") -> {
                    val chatId = b.topic.removePrefix("typing-")
                    val uid = b.payload.str("uid") ?: return@collect
                    if (uid != Supa.userId) ChatSession.onTyping(chatId, uid, b.payload.str("name") ?: "Кто-то")
                }
            }
        }
    }

    // ---------- контент ----------
    Box(Modifier.fillMaxSize().background(DarkBg)) {
        // объявление от админов (v19: ann-banner)
        announcement?.let { ann ->
            val icon = when (ann.level) { "warn" -> "⚠️"; "critical" -> "🛑"; else -> "📣" }
            Surface(
                color = when (ann.level) {
                    "warn" -> Color(0xFFF5B73D).copy(alpha = 0.18f)
                    "critical" -> DangerColor.copy(alpha = 0.22f)
                    else -> accentColor(Prefs.get().accent).copy(alpha = 0.18f)
                },
                shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp),
                modifier = Modifier.align(Alignment.TopCenter).padding(top = 8.dp, start = 10.dp, end = 10.dp).fillMaxWidth(),
            ) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(icon, fontSize = 16.sp)
                    Spacer(Modifier.width(8.dp))
                    Column(Modifier.weight(1f)) {
                        Text(ann.title, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        ann.body?.let { Text(it, color = MutedText, fontSize = 12.sp) }
                    }
                    Text("✕", color = MutedText, fontSize = 14.sp, modifier = Modifier.clickable {
                        val dismissed = try {
                            kotlinx.serialization.json.Json.decodeFromString<List<String>>(Prefs.get().annDismissed)
                        } catch (_: Exception) { emptyList() }
                        Prefs.set(mapOf("annDismissed" to kotlinx.serialization.json.Json.encodeToString((dismissed + ann.id).takeLast(31))))
                        announcement = null
                    })
                }
            }
        }
        // «Нет соединения» (v19: net-bar)
        if (!connected) {
            Surface(
                color = Color(0xFFF5B73D).copy(alpha = 0.9f),
                shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp),
                modifier = Modifier.align(Alignment.TopCenter).padding(top = if (announcement == null) 8.dp else 76.dp),
            ) {
                Text("Нет соединения — переподключаемся…", color = Color(0xFF0D1220), fontSize = 12.sp,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 5.dp))
            }
        }
        when (tab) {
            0 -> ChatsScreen(me, onOpen = { openChatId = it })
            1 -> FriendsScreen(me, onOpenChat = { openChatId = it }, onOpenProfile = { ProfileSheet.open(it) })
            2 -> AiScreen(me)
            3 -> SettingsScreen(me, onLogout = onLogout, onOpenAdmin = { adminOpen = true })
        }

        if (adminOpen && me.is_admin) {
            AdminScreen(me, onClose = { adminOpen = false }, onOpenChat = { adminOpen = false; openChatId = it })
        }

        val chat = openChatId
        if (chat != null) {
            ChatScreen(me, chat, onBack = { openChatId = null })
        }

        // звонки поверх всего
        CallOverlay(me)
        val inVoice by Calls.state.inVoice.collectAsState()
        if (inVoice) VoiceBar(me)
        if (ProfileSheet.visible.value) ProfileSheetView(me, onOpenChat = { openChatId = it })

        // тосты
        val t = Calls.state.toast.value
        if (t != null) {
            LaunchedEffect(t) {
                kotlinx.coroutines.delay(3500)
                Calls.state.toast.value = null
            }
            Surface(color = DarkSurface2, shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp),
                modifier = Modifier.align(Alignment.TopCenter).padding(top = 30.dp)) {
                Text(t, color = Color.White, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp))
            }
        }
    }
}

private fun startSessionHeartbeat() {
    CoroutineScope(Dispatchers.IO).launch {
        while (isActive) {
            kotlinx.coroutines.delay(120_000)
            try { Supa.pingSession() } catch (_: Exception) { }
        }
    }
}

private fun registerFcm(ctx: android.content.Context) {
    try {
        FirebaseMessaging.getInstance().token.addOnSuccessListener { t ->
            CoroutineScope(Dispatchers.IO).launch { Supa.registerFcm(t) }
        }
    } catch (_: Exception) { }
}

// «📷 Фото» — как previewOf на сайте
fun previewOf(m: Message): String {
    if (!m.body.isNullOrBlank()) return m.body!!
    return when (m.attachment_type) {
        "image" -> "📷 Фото"
        "video" -> "🎥 Видеосообщение"
        "voice" -> "🎤 Голосовое сообщение"
        "file" -> "📎 ${m.attachment_name ?: "Файл"}"
        "sticker" -> "${Stickers.stickerOf(m.attachment_name ?: "").first} Стикер"
        "gif" -> "GIF"
        else -> ""
    }
}

// json-хелперы payload Realtime (kotlinx JsonObject)
fun kotlinx.serialization.json.JsonObject.str(key: String): String? =
    (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull

fun kotlinx.serialization.json.JsonObject.bool(key: String): Boolean? =
    (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.let { it.contentOrNull == "true" }

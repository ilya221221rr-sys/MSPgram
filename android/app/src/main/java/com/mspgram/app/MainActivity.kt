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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.imePadding
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Button
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.OutlinedTextFieldDefaults
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
import androidx.compose.ui.graphics.Brush
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
        // Системные панели оформлены в той же палитре, что и нативный интерфейс.
        window.statusBarColor = android.graphics.Color.rgb(11, 16, 32)
        window.navigationBarColor = android.graphics.Color.rgb(11, 16, 32)
        window.decorView.systemUiVisibility = 0
        window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
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
    var mfaCode by remember { mutableStateOf("") } // 2FA: ввод кода из приложения-аутентификатора
    var mfaBusy by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    // auth-hero + auth-card (style.css): логотип, слоган, карточка с табами
    Column(
        Modifier.fillMaxSize()
            .background(Brush.radialGradient(listOf(Color(0x443E63DD), Color(0x227C5BFF), DarkBg), radius = 900f))
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .imePadding().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier.size(74.dp).background(
                Brush.linearGradient(listOf(accentColor(Prefs.get().accent), Accent2)),
                RoundedCornerShape(22.dp),
            ),
            contentAlignment = Alignment.Center,
        ) { Text("✈️", fontSize = 35.sp) }
        Text("MSPgram", fontSize = 32.sp, fontWeight = FontWeight.ExtraBold, color = TextC)
        Text(
            "Мессенджер нового поколения.\nСерверы и каналы — как в Discord.\nСкорость и удобство — как в Telegram.",
            fontSize = 14.sp, color = MutedText, lineHeight = 20.sp,
            modifier = Modifier.padding(vertical = 8.dp).widthIn(max = 390.dp),
        )
        Row(
            Modifier.widthIn(max = 390.dp).fillMaxWidth().padding(bottom = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            listOf("💬 Чаты", "👥 Сообщества", "✨ MSP AI").forEach { label ->
                Box(
                    Modifier.background(Color(0x1A5B8CFF), RoundedCornerShape(50))
                        .border(1.dp, Color(0x385B8CFF), RoundedCornerShape(50))
                        .padding(horizontal = 9.dp, vertical = 5.dp),
                ) { Text(label, color = Color(0xFF9DB4FF), fontSize = 10.sp, fontWeight = FontWeight.Medium) }
            }
        }
        Column(
            Modifier.widthIn(max = 390.dp).fillMaxWidth()
                .background(Color(0xE6111827), RoundedCornerShape(22.dp))
                .border(1.dp, Color(0x405D6EA0), RoundedCornerShape(22.dp))
                .padding(horizontal = 26.dp, vertical = 30.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            // табы Вход/Регистрация (.tabs/.tab)
            Row(Modifier.fillMaxWidth().background(DarkSurface2, RoundedCornerShape(12.dp)).padding(4.dp)) {
                listOf("login" to "Вход", "signup" to "Регистрация").forEach { (key, label) ->
                    Box(
                        Modifier.weight(1f)
                            .background(if (mode == key) HoverC else Color.Transparent, RoundedCornerShape(9.dp))
                            .clickable { mode = key; err = "" }
                            .padding(vertical = 9.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(label, fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
                            color = if (mode == key) TextC else MutedText)
                    }
                }
            }
            Spacer(Modifier.size(16.dp))
            val fieldColors = androidx.compose.material3.OutlinedTextFieldDefaults.colors(
                focusedBorderColor = accentColor(Prefs.get().accent),
                unfocusedBorderColor = LineC,
                focusedContainerColor = DarkSurface2,
                unfocusedContainerColor = DarkSurface2,
                focusedTextColor = TextC,
                unfocusedTextColor = TextC,
                cursorColor = accentColor(Prefs.get().accent),
            )
            if (mode == "signup") {
                OutlinedTextField(
                    value = nick, onValueChange = { nick = it },
                    label = { Text("Ник (латиница)", color = MutedText) }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(), colors = fieldColors,
                    shape = RoundedCornerShape(10.dp),
                )
                Spacer(Modifier.size(10.dp))
            }
            OutlinedTextField(value = email, onValueChange = { email = it }, label = { Text("Email", color = MutedText) },
                singleLine = true, modifier = Modifier.fillMaxWidth(), colors = fieldColors, shape = RoundedCornerShape(10.dp))
            Spacer(Modifier.size(10.dp))
            OutlinedTextField(value = pass, onValueChange = { pass = it }, label = { Text("Пароль", color = MutedText) },
                singleLine = true, visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth(), colors = fieldColors, shape = RoundedCornerShape(10.dp))
            if (err.isNotEmpty()) {
                Spacer(Modifier.size(10.dp))
                Text(err, color = Color(0xFFFF8F92), fontSize = 13.sp)
            }
            Spacer(Modifier.size(18.dp))
            if (busy) {
                CircularProgressIndicator(color = accentColor(Prefs.get().accent))
            } else {
                Box(Modifier.fillMaxWidth().height(46.dp).background(
                        Brush.linearGradient(listOf(accentColor(Prefs.get().accent), Accent2)),
                        RoundedCornerShape(10.dp),
                    ).clickable {
                        busy = true; err = ""
                        scope.launch {
                            try {
                                if (mode == "login") Supa.signIn(email.trim(), pass)
                                else Supa.signUp(email.trim(), pass, nick.trim())
                                onEnter()
                            } catch (e: Supa.MfaRequiredException) {
                                mfaBusy = true // показать диалог кода 2FA
                            } catch (e: Exception) { err = e.message ?: "Ошибка" }
                            busy = false
                        }
                    }, contentAlignment = Alignment.Center) {
                    Text(if (mode == "login") "Войти" else "Создать аккаунт",
                        color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                }
                Spacer(Modifier.size(10.dp))
                Text(
                    if (mode == "login") "Нет аккаунта? Зарегистрироваться" else "У меня есть аккаунт — войти",
                    color = accentColor(Prefs.get().accent), fontSize = 13.sp,
                    modifier = Modifier.clickable { mode = if (mode == "login") "signup" else "login"; err = "" }.padding(6.dp),
                )
            }
        }
    }

    // ---------- 2FA: ввод 6-значного кода (extras.js ensureMfa) ----------
    if (mfaBusy) {
        AlertDialog(
            onDismissRequest = { mfaBusy = false },
            containerColor = DarkSurface,
            titleContentColor = TextC,
            title = { Text("Код 2FA") },
            text = {
                Column {
                    Text("Введи 6-значный код из приложения-аутентификатора", color = MutedText, fontSize = 13.sp)
                    Spacer(Modifier.size(10.dp))
                    OutlinedTextField(
                        value = mfaCode, onValueChange = { if (it.length <= 6) mfaCode = it.filter { c -> c.isDigit() } },
                        singleLine = true,
                        shape = RoundedCornerShape(10.dp),
                        colors = androidx.compose.material3.OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = accentColor(Prefs.get().accent),
                            unfocusedBorderColor = LineC,
                            focusedContainerColor = DarkSurface2,
                            unfocusedContainerColor = DarkSurface2,
                            focusedTextColor = TextC,
                            unfocusedTextColor = TextC,
                            cursorColor = accentColor(Prefs.get().accent),
                        ),
                    )
                    if (err.isNotEmpty()) { Spacer(Modifier.size(8.dp)); Text(err, color = Color(0xFFFF8F92), fontSize = 12.sp) }
                }
            },
            confirmButton = {
                TextButton(
                    enabled = mfaCode.length == 6,
                    onClick = {
                        scope.launch {
                            try {
                                Supa.mfaVerifyCode(mfaCode)
                                mfaBusy = false
                                onEnter()
                            } catch (e: Exception) { err = e.message ?: "Ошибка" }
                        }
                    },
                ) { Text("Подтвердить", color = if (mfaCode.length == 6) accentColor(Prefs.get().accent) else MutedText) }
            },
            dismissButton = { TextButton(onClick = { mfaBusy = false; err = "" }) { Text("Отмена", color = MutedText) } },
        )
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

    // ---------- контент: рейл + содержимое (раскладка сайта) ----------
    Box(Modifier.fillMaxSize().background(DarkBg).windowInsetsPadding(WindowInsets.safeDrawing)) {
        val chatOpen = openChatId != null
        if (!chatOpen) {
            val deviceConfig = androidx.compose.ui.platform.LocalConfiguration.current
            // В мобильной версии сайта рейл шириной 58 px остаётся слева.
            // Он скрывается только в короткой альбомной ориентации, как в v21.css.
            val compactLandscape = deviceConfig.screenWidthDp > 900 && deviceConfig.screenHeightDp < 520
            Row(Modifier.fillMaxSize()) {
                if (!compactLandscape) {
                    val railVersion by Supa.chatListVersion.collectAsState()
                    val railUnread = Supa.unread.mapValues { it.value.toInt() }
                    ServerRail(
                        servers = Supa.chats.filter { it.type == "group" && it.myFlags(me.id)?.archived != true }.also { railVersion },
                        activeChatId = null,
                        unread = railUnread,
                        onHome = { tab = 0 },
                        onServer = { c -> openChatId = c.id },
                        onAdd = { tab = 0; ServerCreation.open.value = true },
                    )
                }
                Box(Modifier.weight(1f)) {
                    when (tab) {
                        0 -> ChatsScreen(me, onOpen = { openChatId = it })
                        1 -> FriendsScreen(me, onOpenChat = { openChatId = it }, onOpenProfile = { ProfileSheet.open(it) })
                        2 -> AiScreen(me)
                        3 -> SettingsScreen(me, onLogout = onLogout, onOpenAdmin = { adminOpen = true })
                    }
                }
            }
        }
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

        // нижний док (v20) — поверх контента, скрыт в чате
        if (!chatOpen && !adminOpen) {
            Dock(
                modifier = Modifier.align(Alignment.BottomCenter),
                tab = tab,
                me = me,
                onChats = { tab = 0 },
                onFriends = { tab = 1 },
                onAi = { tab = 2 },
                onSaved = {
                    scope.launch {
                        try {
                            val saved = Supa.chats.firstOrNull { it.isSaved() }
                                ?: Supa.chats.firstOrNull { it.type == "direct" && it.members.size == 1 }
                            val id = saved?.id ?: Supa.startDirect(Supa.userId ?: "")
                            openChatId = id
                        } catch (_: Exception) { }
                    }
                },
                onProfile = { tab = 3 },
            )
        }

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
            kotlinx.coroutines.delay(60_000)
            try {
                Supa.pingSession()
                Supa.touchLastSeen()
            } catch (_: Exception) { }
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

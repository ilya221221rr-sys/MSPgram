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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.firebase.messaging.FirebaseMessaging
import java.text.SimpleDateFormat
import java.util.Locale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

// ============================================================
//  MSPgram — нативный клиент (Jetpack Compose)
//  Экраны: вход → список чатов → чат
// ============================================================

val Accent = Color(0xFF5B8CFF)
val Accent2 = Color(0xFF7C5BFF)
val DarkBg = Color(0xFF0D1220)
val DarkSurface = Color(0xFF151A26)
val MutedText = Color(0xFF8A93A6)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Supa.init(this)
        val jumpChat = intent?.getStringExtra("chatId")
        setContent { MspTheme { Root(jumpChat) } }
    }
}

@Composable
fun MspTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Accent,
            secondary = Accent2,
            background = DarkBg,
            surface = DarkSurface,
        ),
        content = content,
    )
}

@Composable
fun Root(jumpChat: String?) {
    var loading by remember { mutableStateOf(true) }
    var me by remember { mutableStateOf<Profile?>(null) }

    LaunchedEffect(Unit) {
        Supa.restore()
        me = Supa.me
        loading = false
    }

    if (loading) {
        Box(Modifier.fillMaxSize().background(DarkBg), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(color = Accent)
        }
    } else if (me == null) {
        LoginScreen(onEnter = { me = Supa.me })
    } else {
        AppUi(me!!, jumpChat, onLogout = {
            Supa.logout()
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
        Text("MSPgram", fontSize = 34.sp, fontWeight = FontWeight.Bold, color = Accent)
        Text("Нативное приложение", fontSize = 13.sp, color = MutedText)
        Spacer(Modifier.size(28.dp))

        if (mode == "signup") {
            OutlinedTextField(
                value = nick, onValueChange = { nick = it },
                label = { Text("Ник (латиница)") }, singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.size(10.dp))
        }
        OutlinedTextField(
            value = email, onValueChange = { email = it },
            label = { Text("Email") }, singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.size(10.dp))
        OutlinedTextField(
            value = pass, onValueChange = { pass = it },
            label = { Text("Пароль") }, singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        if (err.isNotEmpty()) {
            Spacer(Modifier.size(10.dp))
            Text(err, color = Color(0xFFE5484D), fontSize = 13.sp)
        }
        Spacer(Modifier.size(18.dp))
        if (busy) {
            CircularProgressIndicator(color = Accent)
        } else {
            Button(
                onClick = {
                    busy = true; err = ""
                    scope.launch {
                        try {
                            if (mode == "login") {
                                Supa.signIn(email.trim(), pass)
                            } else {
                                Supa.signUp(email.trim(), pass, nick.trim())
                            }
                            onEnter()
                        } catch (e: Exception) {
                            err = e.message ?: "Ошибка"
                        }
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

// ---------- ОСНОВНОЙ ЭКРАН ----------

@Composable
fun AppUi(me: Profile, jumpChat: String?, onLogout: () -> Unit) {
    var openChatId by remember { mutableStateOf<String?>(jumpChat) }

    LaunchedEffect(Unit) { Supa.connectRealtime() }

    // разрешение на уведомления (Android 13+) + регистрация FCM-токена
    val ctx = LocalContext.current
    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) registerFcmToken()
    }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33) {
            if (ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                permLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                registerFcmToken()
            }
        } else {
            registerFcmToken()
        }
    }

    val chat = openChatId
    if (chat == null) ChatsScreen(me, onOpen = { openChatId = it }, onLogout = onLogout)
    else ChatScreen(me, chat, onBack = { openChatId = null })
}

private fun registerFcmToken() {
    try {
        FirebaseMessaging.getInstance().token.addOnSuccessListener { t ->
            CoroutineScope(Dispatchers.IO).launch { Supa.registerFcm(t) }
        }
    } catch (_: Exception) { /* Firebase не настроен — без push */ }
}

// ---------- СПИСОК ЧАТОВ ----------

@Composable
fun ChatsScreen(me: Profile, onOpen: (String) -> Unit, onLogout: () -> Unit) {
    var chats by remember { mutableStateOf<List<Chat>>(emptyList()) }
    var unread by remember { mutableStateOf<Map<String, Long>>(emptyMap()) }
    var err by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    suspend fun reload() {
        try {
            chats = Supa.loadChats().sortedByDescending { it.last_message_at ?: "" }
            unread = Supa.unreadCounts()
            err = ""
        } catch (e: Exception) {
            err = e.message ?: "Ошибка сети"
        }
    }

    LaunchedEffect(Unit) { reload() }
    LaunchedEffect(Unit) {
        Supa.events.collect { reload() }
    }

    Scaffold(
        containerColor = DarkBg,
        topBar = {
            Row(
                Modifier.fillMaxWidth().background(DarkSurface).padding(horizontal = 16.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Avatar(me.name, 36.dp)
                Spacer(Modifier.width(10.dp))
                Column {
                    Text("MSPgram", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                    Text("@${me.nickname}", color = MutedText, fontSize = 11.sp)
                }
                Spacer(Modifier.weight(1f))
                TextButton(onClick = onLogout) { Text("Выйти", color = MutedText) }
            }
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().background(DarkBg)) {
            if (err.isNotEmpty()) {
                Text(
                    err, color = Color(0xFFE5484D), fontSize = 12.sp,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                )
            }
            LazyColumn(Modifier.fillMaxSize()) {
                items(chats) { c ->
                    ChatRow(me.id, c, unread[c.id] ?: 0) { onOpen(c.id) }
                }
                if (chats.isEmpty()) {
                    item {
                        Text(
                            "Пока пусто.\nНайди друзей через поиск в веб-версии —\nздесь появятся все твои чаты.",
                            color = MutedText, fontSize = 14.sp,
                            modifier = Modifier.padding(24.dp),
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun Avatar(name: String, dpSize: Dp) {
    Box(
        Modifier.size(dpSize).background(Brush.linearGradient(listOf(Accent, Accent2)), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(name.take(1).uppercase(), color = Color.White, fontWeight = FontWeight.Bold)
    }
}

@Composable
fun ChatRow(meId: String, chat: Chat, unreadCnt: Long, onClick: () -> Unit) {
    val title = chat.titleFor(meId)
    val preview = chat.last_message_text ?: "Напиши первое сообщение"

    Row(
        Modifier
            .fillMaxWidth()
            .background(DarkBg)
            .clickable { onClick() }
            .padding(horizontal = 14.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(title.removePrefix("🔖 ").trim(), 48.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            Text(preview, color = MutedText, fontSize = 13.sp, maxLines = 1)
        }
        if (unreadCnt > 0) {
            Box(
                Modifier.size(22.dp).background(Accent, CircleShape),
                contentAlignment = Alignment.Center,
            ) { Text("$unreadCnt", color = Color.White, fontSize = 11.sp) }
        }
    }
}

// ---------- ЧАТ ----------

@Composable
fun ChatScreen(me: Profile, chatId: String, onBack: () -> Unit) {
    var chat by remember { mutableStateOf<Chat?>(null) }
    var channel by remember { mutableStateOf<Channel?>(null) }
    var msgs by remember { mutableStateOf<List<Message>>(emptyList()) }
    var input by remember { mutableStateOf("") }
    var err by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current

    val pickImage = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) {
            scope.launch {
                busy = true; err = ""
                try {
                    val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                        ?: throw Exception("Не удалось прочитать файл")
                    val (url, size) = Supa.uploadImage(chatId, bytes, "photo.jpg")
                    val m = Supa.sendMessageFull(chatId, channel?.id, null, "image", url, "Фото", size)
                    if (msgs.none { it.id == m.id }) msgs = msgs + m
                } catch (e: Exception) {
                    err = e.message ?: "Ошибка отправки"
                }
                busy = false
            }
        }
    }

    LaunchedEffect(chatId) {
        try {
            val c = Supa.loadChats().firstOrNull { it.id == chatId }
            chat = c
            if (c?.type == "group") channel = Supa.loadChannels(chatId).firstOrNull()
            msgs = Supa.loadMessages(chatId, channel?.id)
            Supa.markRead(chatId)
        } catch (e: Exception) {
            err = e.message ?: "Ошибка загрузки"
        }
    }

    LaunchedEffect(chatId) {
        Supa.events.collect { (ev, m) ->
            if (m.chat_id != chatId) return@collect
            when (ev) {
                "INSERT" -> {
                    if (msgs.none { it.id == m.id }) msgs = msgs + m
                    Supa.markRead(chatId)
                }
                "UPDATE" -> msgs = msgs.map { if (it.id == m.id) m else it }
            }
        }
    }

    Scaffold(
        containerColor = DarkBg,
        topBar = {
            Row(
                Modifier.fillMaxWidth().background(DarkSurface).padding(horizontal = 4.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onBack) { Text("←", color = Accent, fontSize = 20.sp) }
                Column(Modifier.weight(1f)) {
                    Text(
                        chat?.titleFor(me.id) ?: "Чат",
                        color = Color.White, fontWeight = FontWeight.Bold,
                    )
                    if (channel != null) Text("#${channel!!.name}", color = MutedText, fontSize = 12.sp)
                }
                TextButton(onClick = { pickImage.launch("image/*") }) { Text("🖼", fontSize = 18.sp) }
            }
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().background(DarkBg)) {
            LazyColumn(
                Modifier.weight(1f).fillMaxWidth().padding(horizontal = 10.dp),
                reverseLayout = true,
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                items(msgs.reversed()) { m -> MsgRow(me.id, m, chat) }
            }
            if (err.isNotEmpty()) {
                Text(
                    err, color = Color(0xFFE5484D), fontSize = 12.sp,
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
            }
            Row(
                Modifier.fillMaxWidth().background(DarkSurface).padding(8.dp).imePadding(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = input, onValueChange = { input = it },
                    placeholder = { Text("Сообщение…", color = MutedText) },
                    modifier = Modifier.weight(1f),
                    maxLines = 4,
                )
                Spacer(Modifier.width(8.dp))
                Button(
                    enabled = input.isNotBlank() && !busy,
                    onClick = {
                        val text = input.trim()
                        input = ""
                        scope.launch {
                            busy = true
                            try {
                                val m = Supa.sendMessage(chatId, channel?.id, text)
                                if (msgs.none { it.id == m.id }) msgs = msgs + m
                            } catch (e: Exception) {
                                err = e.message ?: "Не отправилось"
                                input = text
                            }
                            busy = false
                        }
                    },
                ) { Text("➤") }
            }
        }
    }
}

@Composable
fun MsgRow(meId: String, m: Message, chat: Chat?) {
    val own = m.sender_id == meId
    val sender = chat?.members?.firstOrNull { it.user_id == m.sender_id }?.profiles
    val time = try {
        SimpleDateFormat("HH:mm", Locale.getDefault())
            .format(SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).parse(m.created_at)!!)
    } catch (_: Exception) {
        ""
    }

    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (own) Alignment.End else Alignment.Start) {
        if (!own && chat?.type == "group") {
            Text(
                sender?.name ?: "Участник",
                color = Accent, fontSize = 11.sp,
                modifier = Modifier.padding(horizontal = 12.dp),
            )
        }
        Surface(
            color = if (own) Accent.copy(alpha = 0.28f) else DarkSurface,
            shape = RoundedCornerShape(
                topStart = 16.dp, topEnd = 16.dp,
                bottomStart = if (own) 16.dp else 4.dp,
                bottomEnd = if (own) 4.dp else 16.dp,
            ),
            modifier = Modifier.widthIn(max = 300.dp),
        ) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 7.dp)) {
                if (m.attachment_type == "image" && !m.attachment_url.isNullOrEmpty()) {
                    CoilImage(m.attachment_url!!)
                }
                if (!m.body.isNullOrEmpty()) {
                    Text(m.body!!, color = Color.White, fontSize = 15.sp)
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    if (m.edited_at != null) Text("изм. ", color = MutedText, fontSize = 10.sp)
                    Text(time, color = MutedText, fontSize = 10.sp)
                }
            }
        }
    }
}

@Composable
fun CoilImage(url: String) {
    coil.compose.AsyncImage(
        model = url,
        contentDescription = "Фото",
        modifier = Modifier.fillMaxWidth().heightIn(max = 320.dp),
    )
}

package com.mspgram.app

import android.Manifest
import android.content.Intent
import androidx.activity.compose.BackHandler
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

// ============================================================
//  Чат — полный порт js/chatview.js:
//  сообщения всех типов, реакции (QUICK_EMOJI), ответы, правка,
//  удаление, закреп (pinned bar), пересылка, поиск в чате,
//  typing, галочки ✓✓, каналы серверов, стикеры, GIF, ИИ,
//  голосовые (запись/воспроизведение), видео-кружки, файлы.
// ============================================================

object ChatSession {
    val activeId = mutableStateOf<String?>(null)
    val playingCircleId = mutableStateOf<String?>(null) // какой кружок играет сейчас (один за раз)
    val messages = mutableStateOf<List<Message>>(emptyList())
    val pinned = mutableStateOf<Message?>(null)
    val typing = mutableStateOf<Map<String, Pair<String, Long>>>(emptyMap()) // uid → (имя, до)
    val version = mutableStateOf(0)
    val channelId = mutableStateOf<String?>(null)

    fun onNewMessage(m: Message) {
        if (activeId.value == m.chat_id) {
            if (messages.value.none { it.id == m.id }) {
                messages.value = messages.value + m
                Supa.reactions.remove(m.id)
            }
        }
    }

    fun onEditMessage(m: Message) {
        if (activeId.value == m.chat_id) {
            messages.value = messages.value.map { if (it.id == m.id) m else it }
        }
        version.value++
    }

    fun onDeleteMessage(id: String) {
        messages.value = messages.value.filter { it.id != id }
        version.value++
    }

    fun bumpReactions() { version.value++ }

    fun onTyping(chatId: String, uid: String, name: String) {
        if (activeId.value != chatId) return
        typing.value = typing.value + (uid to (name to System.currentTimeMillis() + 3000))
        version.value++
    }

    fun typingText(): String {
        val now = System.currentTimeMillis()
        val names = typing.value.values.filter { it.second > now }.map { it.first }.distinct()
        return when {
            names.isEmpty() -> ""
            names.size == 1 -> "${names[0]} печатает…"
            names.size == 2 -> "${names[0]} и ${names[1]} печатают…"
            else -> "несколько человек печатают…"
        }
    }

    fun typingIn(chatId: String): String = if (activeId.value == chatId) typingText() else ""
}

@Composable
fun ChatScreen(me: Profile, chatId: String, onBack: () -> Unit) {
    val chat = Supa.chatById(chatId)
    if (chat == null) {
        LaunchedEffect(chatId) {
            Supa.loadChats()
        }
        Box(Modifier.fillMaxSize().background(DarkBg), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(color = accentColor(Prefs.get().accent))
        }
        return
    }

    var infoOpen by remember { mutableStateOf(false) }
    var inviteCode by remember { mutableStateOf<String?>(null) }
    var channels by remember { mutableStateOf<List<Channel>>(emptyList()) }
    var searchOpen by remember { mutableStateOf(false) }
    var replyTo by remember { mutableStateOf<Message?>(null) }
    var editing by remember { mutableStateOf<Message?>(null) }
    var input by remember(chatId) { mutableStateOf(DraftStore.get(chatId)) } // черновики v19
    var mentionQuery by remember { mutableStateOf<String?>(null) }
    var err by remember { mutableStateOf("") }
    var menuMsg by remember { mutableStateOf<Message?>(null) }
    var forwardMsg by remember { mutableStateOf<Message?>(null) }
    var viewerImg by remember { mutableStateOf<String?>(null) }
    var playerVoice by remember { mutableStateOf<Message?>(null) }
    var aiSummarize by remember { mutableStateOf(false) }
    var aiWrite by remember { mutableStateOf(false) }
    var stickersOpen by remember { mutableStateOf(false) }
    var gifsOpen by remember { mutableStateOf(false) }
    var circleOpen by remember { mutableStateOf(false) }
    var circlePending by remember { mutableStateOf(false) }

    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val acc = accentColor(Prefs.get().accent)

    // ---------- разрешения (должны быть в композиции) ----------
    var micPending by remember { mutableStateOf<(() -> Unit)?>(null) }
    val micPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { g ->
        if (g) micPending?.invoke()
        micPending = null
    }
    fun askMic(after: () -> Unit) {
        if (androidx.core.content.ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO)
            == android.content.pm.PackageManager.PERMISSION_GRANTED) after()
        else { micPending = after; micPerm.launch(Manifest.permission.RECORD_AUDIO) }
    }
    val callPerms = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { map ->
        if (circlePending) {
            circlePending = false
            if (map.values.all { it }) circleOpen = true
            else err = "Нужны доступы к камере и микрофону"
        } else {
            Calls.onPermissionsResult(map.values.all { it })
        }
    }
    LaunchedEffect(chatId) {
        ChatSession.activeId.value = chatId
        ChatSession.messages.value = emptyList()
        ChatSession.pinned.value = null
        if (chat.type == "group") {
            channels = Supa.loadChannels(chatId)
            ChatSession.channelId.value = channels.firstOrNull()?.id
        } else {
            ChatSession.channelId.value = null
        }
        try {
            ChatSession.messages.value = Supa.loadMessages(chatId, ChatSession.channelId.value)
            Supa.loadReactions(ChatSession.messages.value.map { it.id })
            chat.pinned_message_id?.let { pid ->
                ChatSession.pinned.value = ChatSession.messages.value.firstOrNull { it.id == pid }
            }
            Supa.markRead(chatId)
            Supa.markDelivered(chatId)
        } catch (e: Exception) { err = e.message ?: "Ошибка загрузки" }
        Realtime.join("typing-$chatId")
    }
    DisposableEffect(chatId) {
        onDispose {
            Realtime.leave("typing-$chatId")
            ChatSession.activeId.value = null
        }
    }
    BackHandler { onBack() }

    fun sendTyping() {
        Realtime.sendBroadcast(
            "typing-$chatId", "typing",
            """{"uid":"${Supa.userId}","name":"${Supa.me?.name?.replace("\"", "") ?: "Я"}"}""",
        )
    }

    val canPost = Supa.canPostIn(chat)

    Column(Modifier.fillMaxSize().background(DarkBg)) {
        // ---------- шапка: .chat-head (panel, линия снизу) ----------
        Column(Modifier.fillMaxWidth().background(DarkSurface).border(1.dp, LineC).padding(vertical = 8.dp)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconBtn("←", size = 20) { onBack() }
            Row(Modifier.weight(1f).clickable {
                if (chat.type == "direct") {
                    chat.otherMember(me.id)?.let { ProfileSheet.open(it.id) }
                } else {
                    infoOpen = true
                }
            }) {
                Avatar(chat.titleFor(me.id), 40.dp, chat.avatar_url ?: chat.otherMember(me.id)?.avatar_url,
                    presence = if (chat.type == "direct") Supa.presenceOf(chat.otherMember(me.id)) else null)
                Spacer(Modifier.width(10.dp))
                Column {
                    Text(chat.titleFor(me.id), color = TextC, fontWeight = FontWeight.Bold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val sub = ChatSession.typingText().ifBlank {
                        if (chat.type == "direct") {
                            val o = chat.otherMember(me.id)
                            relLastSeen(o?.last_seen, Supa.presenceOf(o))
                        } else {
                            "${chat.members.size} ${pluralRu(chat.members.size)} · ${channels.size} канал(ов)"
                        }
                    }
                    Text(sub, color = if (ChatSession.typingText().isNotEmpty()) acc else MutedText, fontSize = 11.5.sp, maxLines = 1)
                }
            }
            // каналы сервера — пилюля в шапке (#channel-pill)
            if (chat.type == "group" && channels.size > 1) {
                Text(
                    "#${channels.firstOrNull { it.id == ChatSession.channelId.value }?.name ?: "общий"}",
                    fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = TextC,
                    modifier = Modifier.background(DarkSurface2, RoundedCornerShape(50))
                        .clickable { infoOpen = true }.padding(horizontal = 10.dp, vertical = 5.dp),
                )
            }
            // icon-btn справа: звонки / ИИ / поиск / инфо
            if (chat.type == "direct" && !chat.isSaved()) {
                IconBtn("📞") { Calls.startCall(chat, false, ctx) { p -> callPerms.launch(p.toTypedArray()) } }
                IconBtn("📹") { Calls.startCall(chat, true, ctx) { p -> callPerms.launch(p.toTypedArray()) } }
            } else if (chat.type == "group") {
                IconBtn(if (Calls.state.inVoice.value) "🎙" else "🎙") { askMic { Calls.joinVoice(chat, ctx) {} } }
            }
            IconBtn("✨") { aiSummarize = true }
            IconBtn("🔍", size = 17) { searchOpen = true }
            IconBtn("⋯", size = 19) { infoOpen = true }
        }
        }

        // закреплённое сообщение
        ChatSession.pinned.value?.let { pm ->
            Row(Modifier.fillMaxWidth().background(DarkSurface2).padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Text("📌", fontSize = 13.sp)
                Spacer(Modifier.width(6.dp))
                Column(Modifier.weight(1f)) {
                    Text(previewOf(pm), color = Color.White, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Text("✕", color = MutedText, fontSize = 13.sp, modifier = Modifier.clickable {
                    scope.launch { runCatching { Supa.unpinMessage(chatId) } }
                })
            }
        }

        // поиск в чате
        if (searchOpen) {
            var sq by remember { mutableStateOf("") }
            val hits = ChatSession.messages.value.filter { (it.body ?: "").lowercase().contains(sq.lowercase()) && sq.isNotBlank() }
            Column(Modifier.background(DarkSurface2).padding(8.dp)) {
                OutlinedTextField(value = sq, onValueChange = { sq = it }, placeholder = { Text("Искать в этом чате…", color = MutedText) },
                    modifier = Modifier.fillMaxWidth(), singleLine = true)
                hits.take(8).forEach { hit ->
                    Text("• ${hit.body?.take(80)}", color = Color.White, fontSize = 12.sp,
                        modifier = Modifier.clickable { searchOpen = false }.padding(vertical = 4.dp))
                }
            }
        }

        // ---------- сообщения (обои v19) ----------
        val listState = rememberLazyListState()
        LaunchedEffect(ChatSession.messages.value.size, ChatSession.version.value) {
            if (ChatSession.messages.value.isNotEmpty()) {
                listState.animateScrollToItem(ChatSession.messages.value.size - 1)
            }
        }
        ChatWall(Modifier.weight(1f).fillMaxWidth()) {
        LazyColumn(Modifier.fillMaxSize().padding(horizontal = 8.dp), state = listState) {
            items(ChatSession.messages.value) { m ->
                val prev = ChatSession.messages.value.getOrNull(ChatSession.messages.value.indexOf(m) - 1)
                if (prev == null || dayKey(prev.created_at) != dayKey(m.created_at)) {
                    DaySep(fmtDay(m.created_at))
                }
                MsgRow(me, chat, m,
                    revVersion = ChatSession.version.value,
                    onOpenMenu = { menuMsg = m },
                    onOpenImage = { viewerImg = it },
                    onPlayVoice = { playerVoice = m },
                    onOpenFile = { url ->
                        runCatching {
                            ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                        }
                    },
                    onSwipeReply = { replyTo = m },
                )
            }
            item {
                val t = ChatSession.typingText()
                if (t.isNotEmpty()) Text(t, color = acc, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp))
                Spacer(Modifier.size(8.dp))
            }
        }
        }

        if (err.isNotEmpty()) Text(err, color = DangerColor, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 12.dp))

        // ---------- композер ----------
        replyTo?.let { rt ->
            Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                // reply-bar-inner: панелька с акцентной полосой слева (border-left 3px)
                Row(Modifier.weight(1f).background(DarkSurface2, RoundedCornerShape(10.dp))
                    .border(1.dp, LineC, RoundedCornerShape(10.dp))
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Ответ ${senderName(chat, rt)}", color = acc, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        Text(previewOf(rt), color = MutedText, fontSize = 12.5.sp, maxLines = 1)
                    }
                    Text("✕", color = MutedText, fontSize = 13.sp, modifier = Modifier.clickable { replyTo = null }.padding(4.dp))
                }
            }
        }
        editing?.let { ed ->
            Row(Modifier.fillMaxWidth().background(DarkSurface2).padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("✏️ Изменение сообщения", color = acc, fontSize = 12.sp, modifier = Modifier.weight(1f))
                Text("✕", color = MutedText, modifier = Modifier.clickable { editing = null })
            }
        }

        // подсказки @упоминаний (v19)
        mentionQuery?.let { mq ->
            val people = chat.members.mapNotNull { it.profiles }
                .filter { it.id != me.id && it.nickname.contains(mq, ignoreCase = true) }
                .take(6)
            if (people.isNotEmpty()) {
                Row(Modifier.fillMaxWidth().background(DarkSurface2).padding(horizontal = 8.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    people.forEach { pr ->
                        Column(horizontalAlignment = Alignment.CenterHorizontally,
                            modifier = Modifier.clickable {
                                val at = input.lastIndexOf('@')
                                if (at >= 0) {
                                    input = input.substring(0, at) + "@" + pr.nickname + " "
                                    DraftStore.set(chatId, input)
                                }
                                mentionQuery = null
                            }) {
                            Avatar(pr.name, 34.dp, pr.avatar_url)
                            Text("@${pr.nickname}", color = Color.White, fontSize = 10.sp, maxLines = 1)
                        }
                    }
                }
            }
        }

        // панели стикеров/GIF
        if (stickersOpen) StickerPanel { emoji, packId ->
            stickersOpen = false
            scope.launch {
                runCatching {
                    Supa.sendMessageFull(MsgPayload(
                        chat_id = chatId, sender_id = Supa.userId ?: "",
                        body = null, channel_id = ChatSession.channelId.value,
                        attachment_type = "sticker", attachment_name = "$emoji|$packId",
                    )).let { ChatSession.onNewMessage(it) }
                }
            }
        }
        if (gifsOpen) GifPanel(
            onPick = { url ->
                gifsOpen = false
                scope.launch {
                    runCatching {
                        Supa.sendMessageFull(MsgPayload(
                            chat_id = chatId, sender_id = Supa.userId ?: "",
                            body = null, channel_id = ChatSession.channelId.value,
                            attachment_type = "gif", attachment_url = url, attachment_name = "GIF",
                        )).let { ChatSession.onNewMessage(it) }
                    }
                }
            },
        )

        // запись голоса/видео
        val voiceRecorder = remember { VoiceRecorder(ctx) }
        var recording by remember { mutableStateOf(false) }
        var recSec by remember { mutableStateOf(0) }
        LaunchedEffect(recording) {
            while (recording) { delay(1000); recSec += 1 }
        }

        val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            if (uri != null) scope.launch {
                try {
                    val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: throw Exception("Файл не читается")
                    val name = uri.lastPathSegment ?: "file"
                    val mime = ctx.contentResolver.getType(uri) ?: "application/octet-stream"
                    val (url, size) = Supa.uploadChatFile(chatId, bytes, mime, name)
                    val type = if (mime.startsWith("image/")) "image" else if (mime.startsWith("video/")) "video" else "file"
                    Supa.sendMessageFull(MsgPayload(
                        chat_id = chatId, sender_id = Supa.userId ?: "", channel_id = ChatSession.channelId.value,
                        attachment_type = type, attachment_url = url, attachment_name = name, attachment_size = size,
                    )).let { ChatSession.onNewMessage(it) }
                } catch (e: Exception) { err = e.message ?: "Ошибка" }
            }
        }

        Row(
            Modifier.fillMaxWidth().background(DarkSurface)
                .border(1.dp, LineC, RectangleShape)
                .padding(horizontal = 6.dp, vertical = 8.dp)
                .imePadding(),
            verticalAlignment = Alignment.Bottom,
        ) {
            if (!canPost) {
                Text("🔒 В этом чате писать могут только администраторы", color = MutedText, fontSize = 13.sp, modifier = Modifier.weight(1f).padding(horizontal = 8.dp))
            } else {
                IconBtn("📎", size = 19) { pickFile.launch("*/*") }
                IconBtn("🙂", size = 19) { stickersOpen = !stickersOpen; gifsOpen = false }
                IconBtn("GIF", size = 14) { gifsOpen = !gifsOpen; stickersOpen = false }
                IconBtn("🪄", size = 18) { aiWrite = true }
                OutlinedTextField(
                    value = input, onValueChange = { v ->
                        input = v; DraftStore.set(chatId, v); sendTyping()
                        val at = v.lastIndexOf('@')
                        mentionQuery = if (at >= 0 && v.indexOf(' ', at) < 0) v.substring(at + 1) else null
                    },
                    placeholder = { Text("Сообщение…", color = Color(0xFF5C688A), fontSize = 15.sp) },
                    modifier = Modifier.weight(1f), maxLines = 4,
                    shape = RoundedCornerShape(22.dp),
                    colors = androidx.compose.material3.OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = acc,
                        unfocusedBorderColor = LineC,
                        focusedContainerColor = DarkSurface2,
                        unfocusedContainerColor = DarkSurface2,
                        focusedTextColor = TextC,
                        unfocusedTextColor = TextC,
                        cursorColor = acc,
                    ),
                )
                if (input.isNotBlank()) {
                    // send-btn: круг 44, градиент, glow
                    Box(
                        Modifier.size(44.dp).background(
                            Brush.linearGradient(listOf(acc, Accent2)), CircleShape,
                        ).clickable {
                            val text = input.trim()
                            val isEdit = editing
                            input = ""
                            DraftStore.clear(chatId)
                            mentionQuery = null
                            scope.launch {
                                try {
                                    if (isEdit != null) {
                                        val m = Supa.editMessage(isEdit.id, text)
                                        ChatSession.onEditMessage(m)
                                        editing = null
                                    } else {
                                        val m = Supa.sendMessage(chatId, ChatSession.channelId.value, text, replyTo?.id)
                                        replyTo = null
                                        ChatSession.onNewMessage(m)
                                    }
                                } catch (e: Exception) { err = e.message ?: "Не отправилось"; input = text }
                            }
                        },
                        contentAlignment = Alignment.Center,
                    ) { Text("➤", fontSize = 17.sp, color = Color.White) }
                } else {
                    // голосовое (тап → записать → тап → отправить) — icon-btn
                    Text(if (recording) "⏹" else "🎤", fontSize = 19.sp,
                        color = if (recording) DangerColor else MutedText,
                        modifier = Modifier.clickable {
                            if (!recording) {
                                askMic {
                                    voiceRecorder.start()
                                    recording = true; recSec = 0
                                }
                            } else {
                                val (file, durMs) = voiceRecorder.stop()
                                recording = false
                                scope.launch {
                                    try {
                                        val bytes = file.readBytes()
                                        val (url, size) = Supa.uploadChatFile(chatId, bytes, "audio/mp4", "voice.m4a")
                                        Supa.sendMessageFull(MsgPayload(
                                            chat_id = chatId, sender_id = Supa.userId ?: "", channel_id = ChatSession.channelId.value,
                                            attachment_type = "voice", attachment_url = url, attachment_name = "voice.m4a",
                                            attachment_size = size, duration_ms = durMs,
                                        )).let { ChatSession.onNewMessage(it) }
                                    } catch (e: Exception) { err = e.message ?: "Ошибка" }
                                }
                            }
                        }.padding(horizontal = 8.dp))
                    // видео-кружок (круглая запись, как circles.js)
                    Text("🎥", fontSize = 19.sp, modifier = Modifier.clickable {
                        val need = listOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
                        callPerms.launch(need.toTypedArray())
                        circlePending = true
                    }.padding(horizontal = 5.dp))
                }
            }
        }
    }

    // сервер-инфо (chatview.js chat-info): участники, роли, инвайт, права, каналы
    if (infoOpen) {
        ServerInfoDialog(
            me = me, chat = chat, channels = channels,
            inviteCode = inviteCode,
            onClose = { infoOpen = false; inviteCode = null },
            onChannel = { ch ->
                infoOpen = false; inviteCode = null
                ChatSession.channelId.value = ch.id
                scope.launch {
                    try {
                        ChatSession.messages.value = Supa.loadMessages(chatId, ch.id)
                        Supa.loadReactions(ChatSession.messages.value.map { it.id })
                    } catch (_: Exception) { }
                }
            },
            onChanged = {
                scope.launch {
                    channels = Supa.loadChannels(chatId)
                    Supa.loadChats()
                }
            },
            onDeleted = { infoOpen = false; onBack() },
            onInvite = { code -> inviteCode = code },
        )
    }

    // меню сообщения (длинное нажатие) — как openMsgMenu на сайте
    menuMsg?.let { mm ->
        MsgMenuSheet(
            me = me, chat = chat, m = mm,
            onClose = { menuMsg = null },
            onReply = { replyTo = mm; menuMsg = null },
            onEdit = { editing = mm; input = mm.body ?: ""; menuMsg = null },
            onPin = {
                scope.launch {
                    runCatching {
                        if (chat.pinned_message_id == mm.id) Supa.unpinMessage(chatId)
                        else Supa.pinMessage(chatId, mm.id)
                    }
                    ChatSession.pinned.value = if (chat.pinned_message_id != mm.id) mm else null
                }
                menuMsg = null
            },
            onForward = { forwardMsg = mm; menuMsg = null },
            onDelete = {
                scope.launch {
                    runCatching { Supa.deleteMessage(mm.id) }
                    ChatSession.onDeleteMessage(mm.id)
                }
                menuMsg = null
            },
            onTranslate = {
                menuMsg = null
                scope.launch {
                    try {
                        val t = Ai.translate(mm.body ?: "")
                        ChatSession.onNewMessage(
                            Supa.sendMessage(chatId, ChatSession.channelId.value, "🌐 Перевод:\n$t"),
                        )
                    } catch (e: Exception) { err = e.message ?: "" }
                }
            },
            onSuggest = {
                menuMsg = null
                scope.launch {
                    try {
                        val s = Ai.suggestReplies(mm.body ?: "")
                        input = s.split("\n").firstOrNull() ?: ""
                    } catch (e: Exception) { err = e.message ?: "" }
                }
            },
            onReact = { emoji ->
                scope.launch {
                    runCatching { Supa.toggleReaction(mm.id, emoji) }
                }
            },
        )
    }

    // пересылка — выбор чата
    forwardMsg?.let { fm ->
        ForwardSheet(chatList = Supa.chats, onPick = { target ->
            scope.launch {
                runCatching { Supa.forwardMessage(target.id, fm, senderName(chat, fm)) }
                forwardMsg = null
            }
        }, onClose = { forwardMsg = null })
    }

    // круглая запись кружка
    if (circleOpen) {
        CircleRecorderOverlay(
            onDone = { file, durMs ->
                circleOpen = false
                scope.launch {
                    try {
                        val bytes = file.readBytes()
                        val (url, size) = Supa.uploadChatFile(chatId, bytes, "video/mp4", file.name)
                        Supa.sendMessageFull(MsgPayload(
                            chat_id = chatId, sender_id = Supa.userId ?: "", channel_id = ChatSession.channelId.value,
                            attachment_type = "video", attachment_url = url,
                            attachment_name = file.name, attachment_size = size, duration_ms = durMs,
                        )).let { ChatSession.onNewMessage(it) }
                    } catch (e: Exception) { err = e.message ?: "Ошибка" }
                }
            },
            onCancel = { circleOpen = false },
        )
    }

    // просмотр картинки
    viewerImg?.let { url ->
        ImageViewer(url) { viewerImg = null }
    }

    // голосовой плеер
    playerVoice?.let { m ->
        VoicePlayerDialog(m) { playerVoice = null }
    }

    // ИИ: пересказ переписки
    if (aiSummarize) {
        AlertDialog(
            onDismissRequest = { aiSummarize = false },
            containerColor = DarkSurface,
            titleContentColor = Color.White,
            title = { Text("✨ Кратко о переписке") },
            text = {
                var loading by remember { mutableStateOf(true) }
                var text by remember { mutableStateOf("…") }
                LaunchedEffect(Unit) {
                    try { text = Ai.summarize(chat.titleFor(me.id), ChatSession.messages.value) }
                    catch (e: Exception) { text = "Ошибка: ${e.message}" }
                    loading = false
                }
                if (loading) CircularProgressIndicator(color = acc) else Text(text, color = Color.White, fontSize = 14.sp)
            },
            confirmButton = { TextButton(onClick = { aiSummarize = false }) { Text("Закрыть", color = MutedText) } },
        )
    }

    // ИИ: помощь в написании
    if (aiWrite) {
        var prompt by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { aiWrite = false },
            containerColor = DarkSurface,
            titleContentColor = Color.White,
            title = { Text("🪄 ИИ поможет с текстом") },
            text = {
                Column {
                    OutlinedTextField(value = prompt, onValueChange = { prompt = it },
                        label = { Text("Что написать? (можно пусто — улучшу твой текст)") })
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val p = prompt
                    aiWrite = false
                    scope.launch {
                        try {
                            input = Ai.helpWrite(p, input)
                        } catch (e: Exception) { err = e.message ?: "" }
                    }
                }) { Text("Сгенерировать", color = acc) }
            },
            dismissButton = { TextButton(onClick = { aiWrite = false }) { Text("Отмена", color = MutedText) } },
        )
    }
}

fun senderName(chat: Chat, m: Message): String =
    chat.members.firstOrNull { it.user_id == m.sender_id }?.profiles?.name ?: "Кто-то"

// ---------- строка сообщения ----------

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun MsgRow(
    me: Profile,
    chat: Chat,
    m: Message,
    revVersion: Int = 0, // версия реакций — форсирует рекомпозицию
    onOpenMenu: () -> Unit = {},
    onOpenImage: (String) -> Unit = {},
    onPlayVoice: () -> Unit = {},
    onOpenFile: (String) -> Unit = {},
    onSwipeReply: () -> Unit = {},
) {
    val own = m.sender_id == me.id
    val acc = accentColor(Prefs.get().accent)
    val reactions = Supa.reactions[m.id] ?: emptyList()

    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp), horizontalAlignment = if (own) Alignment.End else Alignment.Start) {
        // день-разделитель рисуется вызывающим кодом
        if (!own && chat.type == "group") {
            Text(senderName(chat, m), color = acc, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 4.dp, top = 6.dp))
        }
        // свайп влево = ответить (v19)
    var swipeX by remember { mutableStateOf(0f) }
    Row(
        Modifier.fillMaxWidth(0.92f),
        horizontalArrangement = if (own) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Bottom,
    ) {
        // хвост пузыря с противоположной стороны (msg::before/::after, clip-path)
        if (!own) Box(Modifier.width(10.dp).height(12.dp)) {
            Canvas(Modifier.fillMaxSize()) {
                val path = androidx.compose.ui.graphics.Path().apply {
                    moveTo(size.width, 0f); lineTo(size.width, size.height); lineTo(0f, size.height); close()
                }
                drawPath(path, InBubble)
            }
        }
        Box(Modifier.weight(1f, fill = false)
            .offset(x = swipeX.dp)
            .pointerInput(m.id) {
                detectHorizontalDragGestures(
                    onDragEnd = {
                        if (swipeX < -100f) onSwipeReply()
                        swipeX = 0f
                    },
                    onDragCancel = { swipeX = 0f },
                ) { change, drag ->
                    change.consume()
                    swipeX = (swipeX + drag).coerceIn(-140f, 0f)
                }
            }
            .combinedClickable(onClick = {}, onLongClick = onOpenMenu)) {
            // .msg: radius 16; свой — градиент --out, чужой — --in; угол у хвоста 6
            Box(
                Modifier.background(
                    if (own) outBubbleBrush() else Brush.linearGradient(listOf(InBubble, InBubble)),
                    RoundedCornerShape(
                        topStart = 16.dp, topEnd = 16.dp,
                        bottomStart = if (!own) 6.dp else 16.dp,
                        bottomEnd = if (own) 6.dp else 16.dp,
                    ),
                ),
            ) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                    if (m.forwarded_from != null) {
                        Text("↪ Переслано от ${m.forwarded_from}", color = MutedText, fontSize = 11.sp)
                    }
                    // цитата (ответ)
                    m.reply_to?.let { rid ->
                        val orig = ChatSession.messages.value.firstOrNull { it.id == rid }
                        Surface(color = DarkSurface2, shape = RoundedCornerShape(8.dp), modifier = Modifier.padding(bottom = 4.dp)) {
                            Column(Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) {
                                Text(orig?.let { senderName(chat, it) } ?: "Сообщение", color = acc, fontSize = 11.sp)
                                Text(orig?.let { previewOf(it) } ?: "сообщение удалено", color = MutedText, fontSize = 11.sp, maxLines = 1)
                            }
                        }
                    }
                    when (m.attachment_type) {
                        "sticker" -> {
                            val (emoji, pack) = Stickers.stickerOf(m.attachment_name ?: "")
                            Text(emoji, fontSize = 64.sp)
                        }
                        "image", "gif" -> {
                            if (!m.attachment_url.isNullOrBlank()) {
                                coil.compose.AsyncImage(
                                    model = m.attachment_url,
                                    contentDescription = "Фото",
                                    modifier = Modifier.fillMaxWidth().heightIn(max = 320.dp).clickable {
                                        if (m.attachment_type == "image") onOpenImage(m.attachment_url!!)
                                    },
                                )
                            }
                        }
                        "voice" -> {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("▶", color = acc, fontSize = 18.sp, modifier = Modifier.clickable { onPlayVoice() })
                                Spacer(Modifier.width(8.dp))
                                // волна-полоска
                                Box(Modifier.width(120.dp).height(4.dp).background(MutedText.copy(alpha = 0.4f), RoundedCornerShape(2.dp)))
                                Spacer(Modifier.width(8.dp))
                                Text(fmtDur(m.duration_ms), color = MutedText, fontSize = 12.sp)
                            }
                        }
                        "video" -> {
                            if (!m.attachment_url.isNullOrBlank()) {
                                Text("🎥 Видеосообщение — открыть", color = acc, fontSize = 13.sp,
                                    modifier = Modifier.clickable { onOpenFile(m.attachment_url!!) })
                            }
                        }
                        "file" -> {
                            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable {
                                if (!m.attachment_url.isNullOrBlank()) onOpenFile(m.attachment_url!!)
                            }) {
                                Text("📎", fontSize = 16.sp)
                                Spacer(Modifier.width(6.dp))
                                Column {
                                    Text(m.attachment_name ?: "Файл", color = Color.White, fontSize = 13.sp)
                                    Text(fmtBytes(m.attachment_size), color = MutedText, fontSize = 11.sp)
                                }
                            }
                        }
                    }
                    if (!m.body.isNullOrBlank()) {
                        SpoilerText(m.body!!, scale = msgFontScale())
                    }
                    // реакции
                    if (reactions.isNotEmpty()) {
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 3.dp)) {
                            reactions.groupBy { it.emoji }.forEach { (emoji, rows) ->
                                Surface(color = acc.copy(alpha = 0.2f), shape = RoundedCornerShape(10.dp)) {
                                    Text("$emoji${rows.size}", fontSize = 12.sp, color = Color.White,
                                        modifier = Modifier.clickable {
                                            if (rows.any { it.user_id == me.id }) {
                                                kotlinx.coroutines.CoroutineScope(Dispatchers.IO).launch {
                                                    runCatching { Supa.toggleReaction(m.id, emoji) }
                                                }
                                            }
                                        }.padding(horizontal = 6.dp, vertical = 2.dp))
                                }
                            }
                        }
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        if (m.edited_at != null) Text("изм. ", color = if (own) Color(0xFFE6ECFF).copy(alpha = 0.7f) else MutedText, fontSize = 10.sp)
                        Text(fmtTime(m.created_at), color = if (own) Color(0xFFE6ECFF).copy(alpha = 0.7f) else MutedText, fontSize = 10.sp)
                        if (own) {
                            val othersRead = chat.members.any { x ->
                                x.user_id != me.id && x.last_read_at != null && x.last_read_at!! >= m.created_at
                            }
                            Text(if (othersRead) " ✓✓" else " ✓", color = if (othersRead) Color.White else Color(0xFFE6ECFF).copy(alpha = 0.7f), fontSize = 10.sp)
                        }
                    }
                }
            }
        }
        // хвост своего пузыря (правый, #4d43d8)
        if (own) Box(Modifier.width(10.dp).height(12.dp)) {
            Canvas(Modifier.fillMaxSize()) {
                val path = androidx.compose.ui.graphics.Path().apply {
                    moveTo(0f, 0f); lineTo(size.width, size.height); lineTo(0f, size.height); close()
                }
                drawPath(path, Color(OUT_TAIL))
            }
        }
    }
}
}

private fun Modifier.align2(): Modifier = this.then(
    Modifier.fillMaxWidth().padding(vertical = 4.dp),
)

// ---------- меню сообщения ----------

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun MsgMenuSheet(
    me: Profile,
    chat: Chat,
    m: Message,
    onClose: () -> Unit,
    onReply: () -> Unit,
    onEdit: () -> Unit,
    onPin: () -> Unit,
    onForward: () -> Unit,
    onDelete: () -> Unit,
    onTranslate: () -> Unit,
    onSuggest: () -> Unit,
    onReact: (String) -> Unit,
) {
    val acc = accentColor(Prefs.get().accent)
    val own = m.sender_id == me.id
    val isMod = (chat.myFlags(me.id)?.role ?: "member") in listOf("owner", "admin")
    ModalBottomSheet(onDismissRequest = onClose, containerColor = DarkSurface) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            QUICK_EMOJI.forEach { e ->
                Surface(color = DarkSurface2, shape = CircleShape, modifier = Modifier.size(42.dp)) {
                    Box(contentAlignment = Alignment.Center) {
                        Text(e, fontSize = 20.sp, modifier = Modifier.clickable { onReact(e); onClose() })
                    }
                }
            }
        }
        Spacer(Modifier.size(10.dp))
        MenuItem("↩ Ответить") { onReply() }
        if (own) MenuItem("✏️ Изменить") { onEdit() }
        MenuItem("📌 ${if (chat.pinned_message_id == m.id) "Открепить" else "Закрепить"}") { onPin() }
        MenuItem("↪ Переслать") { onForward() }
        if (!m.body.isNullOrBlank()) {
            MenuItem("🌐 Перевести") { onTranslate() }
            MenuItem("✨ Предложить ответы") { onSuggest() }
        }
        if (own || isMod || me.is_admin) MenuItem("🗑 Удалить") { onDelete() }
        Spacer(Modifier.size(30.dp))
    }
}

@Composable
fun MenuItem(label: String, onClick: () -> Unit) {
    Text(
        label, color = Color.White, fontSize = 15.sp,
        modifier = Modifier.fillMaxWidth().clickable { onClick() }.padding(horizontal = 20.dp, vertical = 11.dp),
    )
}

// ---------- пересылка ----------

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun ForwardSheet(chatList: List<Chat>, onPick: (Chat) -> Unit, onClose: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onClose, containerColor = DarkSurface) {
        Text("↪ Переслать в…", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 16.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
        LazyColumn(Modifier.size(height = 340.dp, width = 10_000.dp)) {
            items(chatList) { c ->
                ListItem2(c.titleFor(Supa.userId ?: ""), "переслать сюда", avatarUrl = c.otherMember(Supa.userId ?: "")?.avatar_url) {
                    onPick(c)
                }
            }
        }
        Spacer(Modifier.size(30.dp))
    }
}

// ---------- просмотр картинки ----------

@Composable
fun ImageViewer(url: String, onClose: () -> Unit) {
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onClose,
        containerColor = Color.Black,
        confirmButton = {},
        text = {
            coil.compose.AsyncImage(model = url, contentDescription = "Фото", modifier = Modifier.fillMaxWidth())
        },
    )
}

// ---------- голосовой плеер ----------

@Composable
fun VoicePlayerDialog(m: Message, onClose: () -> Unit) {
    var player by remember { mutableStateOf<MediaPlayer?>(null) }
    var playing by remember { mutableStateOf(false) }
    DisposableEffect(m.id) {
        onDispose {
            player?.release()
            player = null
        }
    }
    AlertDialog(
        onDismissRequest = {
            player?.release(); player = null
            onClose()
        },
        containerColor = DarkSurface,
        titleContentColor = Color.White,
        title = { Text("🎤 Голосовое сообщение") },
        text = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (playing) "⏸" else "▶", color = accentColor(Prefs.get().accent), fontSize = 26.sp,
                    modifier = Modifier.clickable {
                        if (player == null) {
                            try {
                                val p = MediaPlayer()
                                p.setDataSource(m.attachment_url ?: throw Exception("Нет файла"))
                                p.prepare()
                                p.setOnCompletionListener { playing = false }
                                p.start()
                                player = p
                                playing = true
                            } catch (_: Exception) { }
                        } else if (playing) {
                            player?.pause(); playing = false
                        } else {
                            player?.start(); playing = true
                        }
                    })
                Spacer(Modifier.width(12.dp))
                Text(fmtDur(m.duration_ms), color = MutedText)
            }
        },
        confirmButton = { TextButton(onClick = { player?.release(); player = null; onClose() }) { Text("Закрыть", color = MutedText) } },
    )
}

// ---------- запись голосовых ----------

class VoiceRecorder(private val ctx: android.content.Context) {
    private var recorder: MediaRecorder? = null
    private var file: File? = null
    private var startedAt = 0L

    fun start() {
        try {
            file = File(ctx.cacheDir, "voice-${System.currentTimeMillis()}.m4a")
            recorder = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(ctx) else @Suppress("DEPRECATION") MediaRecorder()
            recorder?.apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioSamplingRate(44100)
                setOutputFile(file!!.absolutePath)
                prepare()
                start()
            }
            startedAt = System.currentTimeMillis()
        } catch (_: Exception) {
            recorder = null
        }
    }

    fun stop(): Pair<File, Long> {
        val dur = System.currentTimeMillis() - startedAt
        try { recorder?.stop() } catch (_: Exception) { }
        try { recorder?.release() } catch (_: Exception) { }
        recorder = null
        return (file ?: File(ctx.cacheDir, "empty.m4a")) to dur
    }
}


// ---------- спойлеры ||текст|| (v19) ----------

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun SpoilerText(text: String, scale: Float = 1f) {
    if (!text.contains("||")) {
        Text(text, color = Color.White, fontSize = (15 * scale).sp)
        return
    }
    val parts = text.split("||")
    androidx.compose.foundation.layout.FlowRow {
        parts.forEachIndexed { i, part ->
            if (part.isEmpty()) return@forEachIndexed
            if (i % 2 == 1) {
                // спойлер: скрыт до тапа
                var revealed by remember(part) { mutableStateOf(false) }
                Surface(
                    color = if (revealed) Color.Transparent else MutedText.copy(alpha = 0.55f),
                    shape = RoundedCornerShape(6.dp),
                ) {
                    Text(
                        if (revealed) part else part.map { '█' }.joinToString(""),
                        color = if (revealed) Color.White else Color.Transparent,
                        fontSize = (15 * scale).sp,
                        modifier = Modifier.clickable { revealed = true }.padding(horizontal = 5.dp, vertical = 1.dp),
                    )
                }
            } else {
                Text(part, color = Color.White, fontSize = (15 * scale).sp)
            }
        }
    }
}

// ============================================================
//  Сервер-инфо (chatview.js chat-info + extras.js openGroupSettings)
// ============================================================

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun ServerInfoDialog(
    me: Profile,
    chat: Chat,
    channels: List<Channel>,
    inviteCode: String?,
    onClose: () -> Unit,
    onChannel: (Channel) -> Unit,
    onChanged: () -> Unit,
    onDeleted: () -> Unit,
    onInvite: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val acc = accentColor(Prefs.get().accent)
    var permsMode by remember { mutableStateOf(false) }
    var desc by remember(chat.id) { mutableStateOf(chat.description ?: "") }
    var onlyAdmins by remember(chat.id) { mutableStateOf(chat.only_admins_post) }
    var allowMedia by remember(chat.id) { mutableStateOf(chat.allow_media) }
    var newChannel by remember { mutableStateOf(false) }
    var addNick by remember { mutableStateOf("") }
    var found by remember { mutableStateOf<List<Profile>>(emptyList()) }
    var msg by remember { mutableStateOf("") }
    val meId = me.id
    val myRole = chat.myFlags(meId)?.role ?: "member"
    val isOwner = myRole == "owner"
    val isMod = isOwner || myRole == "admin" || me.is_admin

    AlertDialog(
        onDismissRequest = onClose,
        containerColor = DarkSurface,
        titleContentColor = Color.White,
        title = { Text("# ${chat.title ?: "Сервер"}") },
        text = {
            if (permsMode) {
                // ---------- права и описание (owner) ----------
                Column {
                    OutlinedTextField(value = desc, onValueChange = { desc = it.take(300) },
                        label = { Text("Описание") }, modifier = Modifier.fillMaxWidth(), maxLines = 3)
                    Spacer(Modifier.size(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Режим канала", color = Color.White, fontSize = 13.sp)
                            Text("Писать могут только владелец и админы", color = MutedText, fontSize = 11.sp)
                        }
                        Switch(checked = onlyAdmins, onCheckedChange = { onlyAdmins = it })
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Участники могут слать медиа", color = Color.White, fontSize = 13.sp)
                            Text("Фото, видео, файлы, голосовые, GIF", color = MutedText, fontSize = 11.sp)
                        }
                        Switch(checked = allowMedia, onCheckedChange = { allowMedia = it })
                    }
                    Spacer(Modifier.size(8.dp))
                    Text("Роли участников", color = MutedText, fontSize = 12.sp)
                    chat.members.filter { it.user_id != meId }.forEach { mm ->
                        val p = mm.profiles
                        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Avatar(p?.name ?: "?", 30.dp, p?.avatar_url)
                            Spacer(Modifier.width(8.dp))
                            Column(Modifier.weight(1f)) {
                                Text(p?.name ?: "Участник", color = Color.White, fontSize = 13.sp)
                                Text("@${p?.nickname ?: ""}", color = MutedText, fontSize = 11.sp)
                            }
                            if (mm.role != "owner") {
                                val admin = mm.role == "admin"
                                TextButton(onClick = {
                                    scope.launch {
                                        runCatching { Supa.setMemberRole(chat.id, mm.user_id, if (admin) "member" else "admin") }
                                        onChanged()
                                    }
                                }) { Text(if (admin) "Админ ✓" else "Сделать админом", color = if (admin) acc else MutedText, fontSize = 12.sp) }
                            } else Text("владелец", color = acc, fontSize = 11.sp)
                        }
                    }
                    if (msg.isNotEmpty()) Text(msg, color = DangerColor, fontSize = 12.sp)
                }
            } else {
                // ---------- основной вид ----------
                LaunchedEffect(addNick) {
                    if (addNick.length < 2) { found = emptyList(); return@LaunchedEffect }
                    delay(500)
                    found = runCatching { Supa.searchUsers(addNick) }.getOrDefault(emptyList())
                }
                LazyColumn(Modifier.size(width = 320.dp, height = 340.dp)) {
                    // каналы
                    item { Text("${channels.size} канал(ов)", color = MutedText, fontSize = 11.sp, modifier = Modifier.padding(vertical = 4.dp)) }
                    items(channels) { ch ->
                        Row(Modifier.fillMaxWidth().combinedClickable(
                            onClick = { onChannel(ch) },
                            onLongClick = {
                                if (isMod && channels.size > 1) {
                                    scope.launch {
                                        runCatching { Supa.deleteChannel(ch.id) }
                                        if (ChatSession.channelId.value == ch.id) ChatSession.channelId.value = null
                                        onChanged()
                                    }
                                }
                            },
                        ).padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("#${ch.name}", color = if (ch.id == ChatSession.channelId.value) acc else Color.White, fontSize = 14.sp)
                            Spacer(Modifier.weight(1f))
                            if (isMod) Text("🗑", fontSize = 12.sp, color = MutedText)
                        }
                    }
                    if (isMod) {
                        item {
                            Text("＋ Новый канал", color = acc, fontSize = 13.sp,
                                modifier = Modifier.clickable { newChannel = true }.padding(vertical = 4.dp))
                        }
                    }
                    // участники
                    item { Text("${chat.members.size} участник(ов)", color = MutedText, fontSize = 11.sp,
                        modifier = Modifier.padding(top = 8.dp, bottom = 4.dp)) }
                    items(chat.members) { mm ->
                        val p = mm.profiles
                        Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                            Avatar(p?.name ?: "?", 30.dp, p?.avatar_url, presence = Supa.presenceOf(p))
                            Spacer(Modifier.width(8.dp))
                            Column(Modifier.weight(1f)) {
                                Text(p?.name ?: "Участник", color = Color.White, fontSize = 13.sp)
                                Text("@${p?.nickname ?: ""}", color = MutedText, fontSize = 11.sp)
                            }
                            if (mm.role == "owner") Text("владелец", color = acc, fontSize = 10.sp)
                            if (mm.role == "admin") Text("админ", color = OkColor, fontSize = 10.sp)
                            if (isOwner && mm.role == "member") {
                                Text("↑", color = acc, fontSize = 15.sp, modifier = Modifier.clickable {
                                    scope.launch {
                                        runCatching { Supa.setMemberRole(chat.id, mm.user_id, "admin") }
                                        onChanged()
                                    }
                                }.padding(horizontal = 5.dp))
                            }
                            if (isMod && mm.user_id != meId && mm.role != "owner") {
                                Text("✕", color = DangerColor, fontSize = 13.sp, modifier = Modifier.clickable {
                                    scope.launch {
                                        runCatching { Supa.kickMember(chat.id, mm.user_id) }
                                        onChanged()
                                    }
                                }.padding(horizontal = 5.dp))
                            }
                        }
                    }
                    // пригласить по нику
                    item {
                        Spacer(Modifier.size(6.dp))
                        Text("Пригласить по нику", color = MutedText, fontSize = 11.sp)
                        OutlinedTextField(
                            value = addNick, onValueChange = { addNick = it },
                            placeholder = { Text("Поиск по нику", color = MutedText) },
                            modifier = Modifier.fillMaxWidth(), singleLine = true,
                        )
                    }
                    items(found.take(5)) { pr ->
                        if (chat.members.none { it.user_id == pr.id }) {
                            Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                                Avatar(pr.name, 28.dp, pr.avatar_url)
                                Spacer(Modifier.width(8.dp))
                                Text("@${pr.nickname}", color = Color.White, fontSize = 13.sp, modifier = Modifier.weight(1f))
                                Text("＋", color = acc, fontSize = 16.sp, modifier = Modifier.clickable {
                                    scope.launch {
                                        runCatching { Supa.addMembers(chat.id, listOf(pr.id)) }
                                        found = emptyList(); addNick = ""
                                        onChanged()
                                    }
                                })
                            }
                        }
                    }
                    // флаги чата
                    item {
                        Spacer(Modifier.size(8.dp))
                        val mine = chat.myFlags(meId)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf("pinned" to "📌", "muted" to "🔕", "archived" to "🗄").forEach { (flag, icon) ->
                                val on = when (flag) { "pinned" -> mine?.pinned == true; "muted" -> mine?.muted == true; else -> mine?.archived == true }
                                Text(icon + if (on) " ✓" else "", fontSize = 16.sp,
                                    color = if (on) acc else MutedText,
                                    modifier = Modifier.clickable {
                                        scope.launch {
                                            runCatching {
                                                Supa.setChatFlags(chat.id, MemberFlagPayload(
                                                    pinned = if (flag == "pinned") !(mine?.pinned == true) else null,
                                                    muted = if (flag == "muted") !(mine?.muted == true) else null,
                                                    archived = if (flag == "archived") !(mine?.archived == true) else null,
                                                ))
                                            }
                                            onChanged()
                                        }
                                    })
                            }
                            if (isOwner) {
                                val pub = chat.is_public
                                Text(if (pub) "🌐 ✓" else "🌐", fontSize = 16.sp,
                                    color = if (pub) acc else MutedText,
                                    modifier = Modifier.clickable {
                                        scope.launch { runCatching { Supa.setServerPublic(chat.id, !pub) }; onChanged() }
                                    })
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            Row {
                if (permsMode) {
                    TextButton(onClick = {
                        scope.launch {
                            try {
                                Supa.updateChatSettings(
                                    chat.id,
                                    desc.trim().ifBlank { null },
                                    onlyAdmins,
                                    allowMedia,
                                )
                                onChanged()
                                msg = "Сохранено ✓"
                            } catch (e: Exception) { msg = e.message ?: "" }
                        }
                    }) { Text("Сохранить", color = acc) }
                    TextButton(onClick = { permsMode = false }) { Text("Назад", color = MutedText) }
                } else {
                    if (isMod && inviteCode == null) {
                        TextButton(onClick = {
                            scope.launch {
                                try { onInvite(Supa.createInvite(chat.id, null, 168)) }
                                catch (e: Exception) { msg = e.message ?: "" }
                            }
                        }) { Text("🔗 Ссылка", color = acc) }
                    }
                    if (isOwner) {
                        TextButton(onClick = { permsMode = true }) { Text("⚙️ Права", color = MutedText) }
                        TextButton(onClick = {
                            scope.launch {
                                runCatching { Supa.deleteChat(chat.id) }
                                onDeleted()
                            }
                        }) { Text("Удалить", color = DangerColor) }
                    } else {
                        TextButton(onClick = {
                            scope.launch {
                                runCatching { Supa.leaveChat(chat.id) }
                                onDeleted()
                            }
                        }) { Text("Покинуть", color = DangerColor) }
                    }
                }
            }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("Закрыть", color = MutedText) } },
    )

    // приглашение создано — показать код
    if (inviteCode != null) {
        val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
        AlertDialog(
            onDismissRequest = { onInvite("") ; onClose() },
            containerColor = DarkSurface,
            titleContentColor = Color.White,
            title = { Text("🔗 Приглашение") },
            text = {
                Column {
                    Text(inviteCode, color = acc, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.size(6.dp))
                    Text("Работает 7 дней, без лимита входов. Друг вводит этот код в поиске приложения (или открывает ссылку сайта ?join=код).",
                        color = MutedText, fontSize = 12.sp)
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    clipboard.setText(androidx.compose.ui.text.AnnotatedString(inviteCode))
                    Calls.toastMsg("Код скопирован ✓")
                }) { Text("Скопировать", color = acc) }
            },
            dismissButton = { TextButton(onClick = { onInvite(""); onClose() }) { Text("Закрыть", color = MutedText) } },
        )
    }

    // новый канал
    if (newChannel) {
        var chName by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { newChannel = false },
            containerColor = DarkSurface,
            titleContentColor = Color.White,
            title = { Text("Новый канал") },
            text = {
                OutlinedTextField(value = chName, onValueChange = { chName = it },
                    label = { Text("Название канала") }, singleLine = true)
            },
            confirmButton = {
                TextButton(enabled = chName.isNotBlank(), onClick = {
                    scope.launch {
                        runCatching { Supa.createChannel(chat.id, chName.trim()) }
                        newChannel = false
                        onChanged()
                    }
                }) { Text("Создать", color = acc) }
            },
            dismissButton = { TextButton(onClick = { newChannel = false }) { Text("Отмена", color = MutedText) } },
        )
    }
}
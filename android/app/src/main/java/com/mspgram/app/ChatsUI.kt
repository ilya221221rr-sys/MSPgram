package com.mspgram.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// ============================================================
//  Список чатов: фильтры (Все/Личные/Серверы/Архив), папки,
//  закреплённые, 🔕, поиск по всем (люди/чаты/сообщества),
//  новый сервер — всё как в chatlist.js + folders.js
// ============================================================

data class Folder(val id: String, val name: String, val emoji: String, val ids: List<String>)

object ServerCreation {
    // Запрос на создание сервера из боковой панели.
    val open = mutableStateOf(false)
}

object FolderStore {
    fun get(): List<Folder> = try {
        Prefs.get().folders.map { raw ->
            val p = raw.split("::")
            Folder(p[0], p[1], p.getOrElse(2) { "📁" }, p.getOrElse(3) { "" }.split(",").filter { it.isNotBlank() })
        }
    } catch (_: Exception) { emptyList() }

    fun save(list: List<Folder>) {
        Prefs.setFolders(list.map { "${it.id}::${it.name}::${it.emoji}::${it.ids.joinToString(",")}" })
        Supa.chatListVersion.value++
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun ChatsScreen(me: Profile, onOpen: (String) -> Unit) {
    val version by Supa.chatListVersion.collectAsState()
    val onlineUsers by Realtime.online.collectAsState()
    val liveStatuses by Realtime.presenceStatus.collectAsState()
    LaunchedEffect(onlineUsers, liveStatuses) { Supa.chatListVersion.value++ }
    var filter by remember { mutableStateOf("all") } // all | unread | direct | groups | archive | f:<id>
    var searchQ by remember { mutableStateOf("") }
    var showSearch by remember { mutableStateOf(false) }
    var showNewServer by remember { mutableStateOf(false) }
    var editingFolder by remember { mutableStateOf<Folder?>(null) }
    var newFolder by remember { mutableStateOf(false) }

    LaunchedEffect(version) { }

    Column(Modifier.fillMaxSize().background(DarkSurface)) {
        // sidebar-head (style.css): аватар-профиль, заголовок, ＋
        Row(
            Modifier.fillMaxWidth().background(DarkSurface).padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Avatar(me.name, 34.dp, me.avatar_url, circle = true,
                presence = if (Calls.state.inVoice.value) "online" else null)
            Spacer(Modifier.width(10.dp))
            Column(verticalArrangement = Arrangement.Center) {
                Text(
                    "MSPgram",
                    fontSize = 16.sp, fontWeight = FontWeight.ExtraBold,
                    style = androidx.compose.ui.text.TextStyle(
                        brush = androidx.compose.ui.graphics.Brush.horizontalGradient(listOf(Color(0xFFDFE8FF), Color(0xFF9DB4FF))),
                    ),
                )
                Text("v24", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.background(
                        Brush.linearGradient(listOf(accentColor(Prefs.get().accent), Accent2)),
                        RoundedCornerShape(50),
                    ).padding(horizontal = 6.dp, vertical = 1.dp))
            }
            Spacer(Modifier.weight(1f))
            IconBtn("＋") { showNewServer = true }
            IconBtn("🔍") { showSearch = true }
        }

        // search-wrap: поле в panel2, radius 12
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
            OutlinedTextField(
                value = searchQ, onValueChange = { searchQ = it },
                placeholder = { Text("Поиск: люди, чаты, сообщения, @ник", color = Color(0xFF5C688A), fontSize = 13.sp, maxLines = 1) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                shape = RoundedCornerShape(12.dp),
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
        }

        // list-filters (v18.css lf-chip): Все/Непрочитанные/Личные/Группы + папки
        val totalUnread = Supa.unread.values.sum()
        Row(
            Modifier.fillMaxWidth().background(DarkBg).horizontalScroll(rememberScrollState())
                .padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            LfChip("Все", filter == "all") { filter = "all" }
            LfChip("Непрочитанные", filter == "unread", badge = totalUnread.toInt()) { filter = "unread" }
            LfChip("Личные", filter == "direct") { filter = "direct" }
            LfChip("Группы", filter == "groups") { filter = "groups" }
        }
        val folders = FolderStore.get()
        if (folders.isNotEmpty() || true) {
            Row(
                Modifier.fillMaxWidth().background(DarkBg).horizontalScroll(rememberScrollState())
                    .padding(horizontal = 12.dp).padding(bottom = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                folders.forEach { f ->
                    val on = filter == "f:${f.id}"
                    Box(
                        Modifier.background(
                            if (on) Brush.linearGradient(listOf(accentColor(Prefs.get().accent), Accent2)) else Brush.linearGradient(listOf(DarkSurface2, DarkSurface2)),
                            RoundedCornerShape(50),
                        ).combinedClickable(
                                onClick = { filter = "f:${f.id}" },
                                onLongClick = { editingFolder = f },
                            )
                            .padding(horizontal = 12.dp, vertical = 6.dp),
                    ) {
                        Text("${f.emoji} ${f.name}", fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold,
                            color = if (on) Color.White else MutedText)
                    }
                }
                Text("＋ Папка", fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold, color = MutedText,
                    modifier = Modifier.background(DarkSurface2, RoundedCornerShape(50))
                        .clickable { newFolder = true }.padding(horizontal = 12.dp, vertical = 6.dp))
            }
        }

        // список (как renderChatList: 📌 закреплённые, чаты, 🗄 архив)
        val meId = me.id
        val all = Supa.chats.filter { q2 ->
            searchQ.isBlank() || q2.titleFor(meId).lowercase().contains(searchQ.lowercase())
        }
        val flags = { c: Chat -> c.myFlags(meId) }
        val active = all.filter { flags(it)?.archived != true }
        val archived = all.filter { flags(it)?.archived == true }
        val pinned = active.filter { flags(it)?.pinned == true }
        val filteredBase = when (filter) {
            "unread" -> active.filter { c -> (Supa.unread[c.id] ?: 0L) > 0 }
            "direct" -> active.filter { it.type != "group" }
            "groups" -> active.filter { it.type == "group" }
            "archive" -> archived
            else -> if (filter.startsWith("f:")) {
                val f = folders.firstOrNull { "f:${it.id}" == filter }
                active.filter { c -> f?.ids?.contains(c.id) == true }
            } else active
        }
        val rest = filteredBase.filter { c -> pinned.none { it.id == c.id } }
            .sortedByDescending { it.last_message_at ?: "" }

        LazyColumn(Modifier.fillMaxSize().padding(horizontal = 0.dp)) {
            if (filter == "all" && pinned.isNotEmpty()) {
                item { Section("📌") }
                items(pinned) { c -> ChatRow(meId, c, onOpen, unreadIn = (Supa.unread[c.id] ?: 0L).toInt(), typingIn = ChatSession.typingIn(c.id)) }
            }
            items(rest) { c ->
                ChatRow(meId, c, onOpen, unreadIn = (Supa.unread[c.id] ?: 0L).toInt(), typingIn = ChatSession.typingIn(c.id))
            }
            if (filter == "all" && archived.isNotEmpty()) {
                item { Section("🗄 Архив (${archived.size})") }
                items(archived) { c -> ChatRow(meId, c, onOpen, unreadIn = (Supa.unread[c.id] ?: 0L).toInt(), typingIn = ChatSession.typingIn(c.id)) }
            }
            if (all.isEmpty() && searchQ.isBlank()) item {
                Empty("Пока пусто 🙁\n\nНайди друзей через 🔍 — поиск людей,\nсообществ и сообщений.")
            }
            item { Spacer(Modifier.size(90.dp)) } // место под док
        }
    }

    // поиск (глобальный)
    if (showSearch) {
        GlobalSearch(me, onClose = { showSearch = false }, onOpen = { showSearch = false; onOpen(it) })
    }
    if (showNewServer || ServerCreation.open.value) {
        NewServerDialog(
            onClose = { showNewServer = false; ServerCreation.open.value = false },
            onOpen = { showNewServer = false; ServerCreation.open.value = false; onOpen(it) },
        )
    }
    editingFolder?.let { f ->
        FolderEditorDialog(folder = f, onClose = { editingFolder = null })
    }
    if (newFolder) {
        FolderEditorDialog(folder = null, onClose = { newFolder = false })
    }
}

@Composable
fun FilterChip2(label: String, value: String, current: String, onClick: (String) -> Unit) {
    Surface(
        color = if (current == value) accentColor(Prefs.get().accent) else DarkSurface2,
        shape = RoundedCornerShape(8.dp),
    ) {
        Text(
            label, fontSize = 12.sp,
            color = if (current == value) Color.White else MutedText,
            modifier = Modifier.clickable { onClick(value) }.padding(horizontal = 12.dp, vertical = 6.dp),
        )
    }
}

@Composable
fun Section(label: String) {
    Text(label, color = MutedText, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
}

@Composable
fun Empty(text: String) {
    Text(text, color = MutedText, fontSize = 14.sp, modifier = Modifier.padding(24.dp))
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun ChatRow(meId: String, chat: Chat, onOpen: (String) -> Unit, unreadIn: Int = 0, typingIn: String = "") {
    val other = chat.otherMember(meId)
    val presence = if (chat.type == "direct") Supa.presenceOf(other) else null
    val title = chat.titleFor(meId)
    val mine = chat.last_message_sender == meId
    var preview = chat.last_message_text ?: ""
    val unreadCnt = unreadIn
    val muted = chat.myFlags(meId)?.muted == true
    val typing = typingIn

    // chat-row (style.css + v18.css): radius 14, padding 10/11, title 15/600,
    // Вы: акцентным, бейдж — градиентная пилюля
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(16.dp))
            .clickable { onOpen(chat.id) }
            .padding(horizontal = 10.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (chat.isSaved()) {
            Box(Modifier.size(46.dp).background(DarkSurface2, RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
                Text("🔖", fontSize = 19.sp)
            }
        } else {
            Avatar(title, 46.dp, chat.avatar_url ?: other?.avatar_url, presence = if (chat.type == "direct") presence else null, circle = chat.type != "group")
        }
        Spacer(Modifier.width(11.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    (if (chat.flagsPinned(meId)) "📌 " else "") + title,
                    color = TextC,
                    fontWeight = if (unreadCnt > 0) FontWeight.ExtraBold else FontWeight.SemiBold,
                    fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                if (muted) { Spacer(Modifier.width(4.dp)); Text("🔕", fontSize = 11.sp) }
                Spacer(Modifier.weight(1f))
                val time = fmtTime(chat.last_message_at ?: "")
                if (time.isNotEmpty()) {
                    Text(time, color = if (unreadCnt > 0) accentColor(Prefs.get().accent) else MutedText,
                        fontSize = 11.sp, fontWeight = if (unreadCnt > 0) FontWeight.Bold else FontWeight.Normal)
                }
            }
            Spacer(Modifier.height(3.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (typing.isNotEmpty()) {
                    Text(typing, color = accentColor(Prefs.get().accent), fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                } else {
                    Row {
                        if (mine && chat.last_message_text != null) {
                            Text("Вы: ", color = accentColor(Prefs.get().accent), fontSize = 13.sp)
                        }
                        Text(
                            preview.ifBlank { if (chat.last_message_text == null) "Напиши первое сообщение" else "" },
                            color = if (unreadCnt > 0) TextC else MutedText,
                            fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                Spacer(Modifier.weight(1f))
                if (unreadCnt > 0) {
                    Box(
                        Modifier.background(
                            if (muted) androidx.compose.ui.graphics.SolidColor(MutedText) else Brush.linearGradient(listOf(accentColor(Prefs.get().accent), Accent2)),
                            RoundedCornerShape(10.dp),
                        ).padding(horizontal = 7.dp, vertical = 1.dp),
                    ) {
                        Text(if (unreadCnt > 99) "99+" else "$unreadCnt", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}

fun pluralRu(n: Int): String {
    val m10 = n % 10; val m100 = n % 100
    return when {
        m10 == 1 && m100 != 11 -> ""
        m10 in 2..4 && (m100 < 12 || m100 > 14) -> "а"
        else -> "ов"
    }
}

// ---------- глобальный поиск (gsearch.js) ----------

@Composable
fun GlobalSearch(me: Profile, onClose: () -> Unit, onOpen: (String) -> Unit) {
    androidx.activity.compose.BackHandler { onClose() }
    var q by remember { mutableStateOf("") }
    var people by remember { mutableStateOf<List<Profile>>(emptyList()) }
    var chatsF by remember { mutableStateOf<List<Chat>>(emptyList()) }
    var publics by remember { mutableStateOf<List<PublicChatRow>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    androidx.compose.material3.Surface(Modifier.fillMaxSize().background(DarkBg)) {
        Column(Modifier.fillMaxSize().background(DarkBg)) {
            Row(Modifier.fillMaxWidth().padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onClose) { Text("←", color = accentColor(Prefs.get().accent), fontSize = 20.sp) }
                OutlinedTextField(
                    value = q, onValueChange = { q = it },
                    placeholder = { Text("Люди, чаты, @ник…", color = MutedText) },
                    modifier = Modifier.weight(1f), singleLine = true,
                )
            }
            // вход по коду приглашения (app.js joinCode)
            var joinCode by remember { mutableStateOf("") }
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = joinCode, onValueChange = { joinCode = it },
                    placeholder = { Text("Код приглашения в сервер…", color = MutedText) },
                    modifier = Modifier.weight(1f), singleLine = true,
                )
                TextButton(enabled = joinCode.isNotBlank(), onClick = {
                    val code = joinCode.trim().substringAfter("join=").trim('"')
                    scope.launch {
                        try {
                            val id = Supa.joinByInvite(code)
                            Supa.loadChats()
                            joinCode = ""
                            onOpen(id)
                        } catch (e: Exception) { Calls.toastMsg(e.message ?: "Не удалось присоединиться") }
                    }
                }) { Text("Войти", color = accentColor(Prefs.get().accent)) }
            }
            // недавние запросы (история, как на сайте)
            val hist = remember { getSearchHistory() }
            if (q.isBlank() && hist.isNotEmpty()) {
                Text("🕘 Недавние", color = MutedText, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
                Row(Modifier.padding(horizontal = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    hist.take(6).forEach { h ->
                        Surface(color = DarkSurface2, shape = RoundedCornerShape(8.dp)) {
                            Text(h, fontSize = 12.sp, color = Color.White,
                                modifier = Modifier.clickable { q = h }.padding(horizontal = 10.dp, vertical = 6.dp))
                        }
                    }
                }
            }
            LaunchedEffect(q) {
                if (q.length < 2) { people = emptyList(); chatsF = emptyList(); publics = emptyList(); return@LaunchedEffect }
                delay(600) // дебаунс, чтобы не дёргать API на каждую букву
                busy = true
                pushSearchHistory(q)
                try {
                    people = Supa.searchUsers(q)
                    chatsF = Supa.chats.filter { it.titleFor(me.id).lowercase().contains(q.lowercase()) }
                    publics = Supa.searchPublicChats(q)
                } catch (_: Exception) { }
                busy = false
            }
            LazyColumn(Modifier.weight(1f)) {
                if (chatsF.isNotEmpty()) { item { Section("Чаты и серверы") } }
                items(chatsF) { c ->
                    ListItem2(title = c.titleFor(me.id), sub = "твой чат", onClick = { onOpen(c.id) })
                }
                if (people.isNotEmpty()) { item { Section("Люди") } }
                items(people) { p ->
                    val isFriend = Supa.friends.any { it.profile?.id == p.id }
                    ListItem2(
                        title = p.name,
                        sub = "@${p.nickname}${if (isFriend) " · друг" else ""}",
                        avatarUrl = p.avatar_url,
                        onClick = { ProfileSheet.open(p.id) },
                    )
                }
                if (publics.isNotEmpty()) { item { Section("🌐 Сообщества") } }
                items(publics) { pc ->
                    ListItem2(
                        title = pc.title ?: "Без названия",
                        sub = "${pc.members ?: 0} участник${pluralRu((pc.members ?: 0).toInt())} · публичный",
                        onClick = {
                            scope.launch {
                                try {
                                    Supa.joinPublic(pc.id)
                                    onOpen(pc.id)
                                } catch (_: Exception) { }
                            }
                        },
                    )
                }
                if (q.length >= 2 && people.isEmpty() && chatsF.isEmpty() && publics.isEmpty() && !busy) {
                    item { Empty("Ничего не нашлось по «$q»") }
                }
            }
        }
    }
}

object SearchHistoryStore {
    private var list: List<String> = emptyList()
    fun get(): List<String> = list
    fun push(q: String) { list = (listOf(q) + list.filter { it != q }).take(8) }
}

fun getSearchHistory(): List<String> = SearchHistoryStore.get()
fun pushSearchHistory(q: String) = SearchHistoryStore.push(q)

@Composable
fun ListItem2(title: String, sub: String, avatarUrl: String? = null, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(DarkBg).clickable { onClick() }
            .padding(horizontal = 14.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(title, 42.dp, avatarUrl)
        Spacer(Modifier.width(12.dp))
        Column {
            Text(title, color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            Text(sub, color = MutedText, fontSize = 12.sp)
        }
    }
}

// ---------- создание сервера ----------

@Composable
fun NewServerDialog(onClose: () -> Unit, onOpen: (String) -> Unit) {
    var title by remember { mutableStateOf("") }
    var err by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val selected = remember { mutableStateListOf<String>() }
    val scope = rememberCoroutineScope()

    AlertDialog(
        onDismissRequest = onClose,
        containerColor = DarkSurface,
        titleContentColor = Color.White,
        title = { Text("Новый сервер") },
        text = {
            Column {
                OutlinedTextField(value = title, onValueChange = { title = it }, label = { Text("Название") }, singleLine = true)
                Spacer(Modifier.size(8.dp))
                Text("Пригласить друзей:", color = MutedText, fontSize = 12.sp)
                LazyColumn(Modifier.size(width = 280.dp, height = 150.dp)) {
                    items(Supa.friends) { fe ->
                        val p = fe.profile ?: return@items
                        Row(Modifier.fillMaxWidth().clickable {
                            if (selected.contains(p.id)) selected.remove(p.id) else selected.add(p.id)
                        }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Avatar(p.name, 28.dp, p.avatar_url)
                            Spacer(Modifier.width(8.dp))
                            Text(p.name, color = Color.White, fontSize = 13.sp, modifier = Modifier.weight(1f))
                            Text(if (selected.contains(p.id)) "☑" else "☐", color = accentColor(Prefs.get().accent))
                        }
                    }
                }
                if (err.isNotEmpty()) { Spacer(Modifier.size(8.dp)); Text(err, color = DangerColor, fontSize = 12.sp) }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && title.isNotBlank(), onClick = {
                busy = true
                scope.launch {
                    try {
                        val id = Supa.createServer(title.trim(), selected.toList())
                        onClose(); onOpen(id)
                    } catch (e: Exception) { err = e.message ?: "Ошибка" }
                    busy = false
                }
            }) { Text("Создать", color = accentColor(Prefs.get().accent)) }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("Отмена", color = MutedText) } },
    )
}

// ---------- редактор папок (folders.js) ----------

@Composable
fun FolderEditorDialog(folder: Folder?, onClose: () -> Unit) {
    var name by remember { mutableStateOf(folder?.name ?: "") }
    var emoji by remember { mutableStateOf(folder?.emoji ?: "📁") }
    val selected = remember { mutableStateListOf<String>().apply { addAll(folder?.ids ?: emptyList()) } }
    val scope = rememberCoroutineScope()
    var q by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onClose,
        containerColor = DarkSurface,
        titleContentColor = Color.White,
        title = { Text(if (folder == null) "Новая папка" else "Изменить папку") },
        text = {
            Column {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Название папки") }, singleLine = true)
                Spacer(Modifier.size(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("📁", "💬", "🎮", "👨‍👩‍👧", "💼", "🔥").forEach { e ->
                        Text(e, fontSize = 18.sp,
                            modifier = Modifier.clickable { emoji = e }.padding(4.dp),
                            color = if (emoji == e) accentColor(Prefs.get().accent) else MutedText)
                    }
                }
                Spacer(Modifier.size(8.dp))
                Text("Выбери чаты:", color = MutedText, fontSize = 12.sp)
                LazyColumn(Modifier.size(width = 300.dp, height = 200.dp)) {
                    items(Supa.chats) { c ->
                        val title = c.titleFor(Supa.userId ?: "")
                        if (q.isBlank() || title.lowercase().contains(q.lowercase())) {
                            Row(
                                Modifier.fillMaxWidth().clickable {
                                    if (selected.contains(c.id)) selected.remove(c.id) else selected.add(c.id)
                                }.padding(vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(if (selected.contains(c.id)) "☑" else "☐", color = accentColor(Prefs.get().accent), fontSize = 16.sp)
                                Spacer(Modifier.width(8.dp))
                                Text(title, color = Color.White, fontSize = 14.sp)
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(enabled = name.isNotBlank(), onClick = {
                val f = Folder(folder?.id ?: java.util.UUID.randomUUID().toString().take(7), name.trim(), emoji, selected.toList())
                val others = FolderStore.get().filter { it.id != (folder?.id ?: "") }
                FolderStore.save(others + f)
                onClose()
            }) { Text("Сохранить", color = accentColor(Prefs.get().accent)) }
        },
        dismissButton = {
            Row {
                if (folder != null) {
                    TextButton(onClick = {
                        FolderStore.save(FolderStore.get().filter { it.id != folder.id })
                        onClose()
                    }) { Text("Удалить", color = DangerColor) }
                }
                TextButton(onClick = onClose) { Text("Отмена", color = MutedText) }
            }
        },
    )
}

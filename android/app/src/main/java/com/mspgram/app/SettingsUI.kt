package com.mspgram.app

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

// ============================================================
//  Настройки (extras.js + sessions + privacy + AI/Giphy ключи)
//  и Админка (admin.js/admin2.js: юзеры/жалобы/статистика)
// ============================================================

@Composable
fun SettingsScreen(me: Profile, onLogout: () -> Unit, onOpenAdmin: () -> Unit) {
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val acc = accentColor(Prefs.get().accent)
    val prefs = Prefs.get()
    var editingProfile by remember { mutableStateOf(false) }
    var sessionsOpen by remember { mutableStateOf(false) }
    var aiOpen by remember { mutableStateOf(false) }

    LazyColumn(Modifier.fillMaxSize().background(DarkBg)) {
        item {
            // профиль-карточка
            Row(
                Modifier.fillMaxWidth().clickable { editingProfile = true }
                    .padding(horizontal = 16.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Avatar(me.name, 56.dp, me.avatar_url, presence = Supa.presenceOf(me))
                Spacer(Modifier.width(14.dp))
                Column {
                    Text(me.name, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                    Text("@${me.nickname}", color = acc, fontSize = 13.sp)
                    Text("Изменить профиль ›", color = MutedText, fontSize = 12.sp)
                }
            }
        }

        item { Section("Внешний вид") }
        item {
            Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("blue" to Accent, "purple" to Color(0xFF9C6BFF), "green" to Color(0xFF3DD68C), "pink" to Color(0xFFFF6BA9), "orange" to Color(0xFFFF8A4C)).forEach { (name, c) ->
                    Box(
                        Modifier.size(34.dp).background(c, CircleShape)
                            .clickable { Prefs.set(mapOf("accent" to name)); Realtime.presenceTrack(Supa.userId ?: "", Supa.me?.presence_status ?: "online") },
                        contentAlignment = Alignment.Center,
                    ) {
                        if (prefs.accent == name) Text("✓", color = Color.White, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }

        item { Section("Оформление (v19)") }
        item {
            // скины — те же 6 тем, что в appearance.js SKINS
            Column(Modifier.padding(horizontal = 16.dp)) {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SKINS.forEach { (key, label) ->
                        Column(horizontalAlignment = Alignment.CenterHorizontally,
                            modifier = Modifier.clickable {
                                Prefs.set(mapOf("skin" to key))
                                refreshTheme()
                            }) {
                            Box(Modifier.size(40.dp).background(skinBg(key), CircleShape), contentAlignment = Alignment.Center) {
                                Box(Modifier.size(14.dp).background(skinAccent(key), CircleShape))
                                if (prefs.skin == key) {
                                    Box(Modifier.size(46.dp).border(2.dp, accentColor(Prefs.get().accent), CircleShape))
                                }
                            }
                            Text(label, color = if (prefs.skin == key) Color.White else MutedText, fontSize = 10.sp)
                        }
                    }
                }
                Spacer(Modifier.size(10.dp))
                // обои чата
                Text("Обои чата", color = MutedText, fontSize = 11.sp)
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    WALLS.take(4).forEach { (key, label) ->
                        val on = prefs.wall == key
                        Text(label, fontSize = 11.sp,
                            color = if (on) Color.White else MutedText,
                            modifier = Modifier
                                .background(if (on) accentColor(Prefs.get().accent) else DarkSurface2, RoundedCornerShape(8.dp))
                                .clickable { Prefs.set(mapOf("wall" to key)) }
                                .padding(horizontal = 8.dp, vertical = 6.dp))
                    }
                }
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    WALLS.drop(4).forEach { (key, label) ->
                        val on = prefs.wall == key
                        Text(label, fontSize = 11.sp,
                            color = if (on) Color.White else MutedText,
                            modifier = Modifier
                                .background(if (on) accentColor(Prefs.get().accent) else DarkSurface2, RoundedCornerShape(8.dp))
                                .clickable { Prefs.set(mapOf("wall" to key)) }
                                .padding(horizontal = 8.dp, vertical = 6.dp))
                    }
                }
                Spacer(Modifier.size(10.dp))
                // плотность и пузыри
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Размер текста:", color = MutedText, fontSize = 11.sp, modifier = Modifier.weight(1f))
                    listOf("compact" to "Мелкий", "normal" to "Обычный", "large" to "Крупный").forEach { (key, label) ->
                        val on = prefs.density == key
                        Text(label, fontSize = 11.sp,
                            color = if (on) Color.White else MutedText,
                            modifier = Modifier
                                .background(if (on) accentColor(Prefs.get().accent) else DarkSurface2, RoundedCornerShape(8.dp))
                                .clickable { Prefs.set(mapOf("density" to key)) }
                                .padding(horizontal = 6.dp, vertical = 5.dp))
                        Spacer(Modifier.width(4.dp))
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Пузыри:", color = MutedText, fontSize = 11.sp, modifier = Modifier.weight(1f))
                    listOf("soft" to "Мягкие", "round" to "Круглые").forEach { (key, label) ->
                        val on = prefs.bubble == key
                        Text(label, fontSize = 11.sp,
                            color = if (on) Color.White else MutedText,
                            modifier = Modifier
                                .background(if (on) accentColor(Prefs.get().accent) else DarkSurface2, RoundedCornerShape(8.dp))
                                .clickable { Prefs.set(mapOf("bubble" to key)) }
                                .padding(horizontal = 6.dp, vertical = 5.dp))
                        Spacer(Modifier.width(4.dp))
                    }
                }
            }
        }

        item { Section("Уведомления и звук") }
        item {
            SwitchRow("🔊 Звук сообщений", prefs.sound) { Prefs.set(mapOf("sound" to it)) }
            SwitchRow("🌙 Не беспокоить (DND)", prefs.dnd) { Prefs.set(mapOf("dnd" to it)) }
            SwitchRow("💬 Уведомления о реакциях", prefs.notifyReaction) { Prefs.set(mapOf("notifyReaction" to it)) }
            SwitchRow("📢 Уведомления об упоминаниях", prefs.notifyMention) { Prefs.set(mapOf("notifyMention" to it)) }
        }

        item { Section("Приватность") }
        item {
            var expanded by remember { mutableStateOf(false) }
            Column(Modifier.padding(horizontal = 16.dp)) {
                Text("Кто видит «когда я был(а)»: ${PRIVACY_OPTIONS.firstOrNull { it.first == (me.privacy_last_seen ?: "everyone") }?.second}",
                    color = Color.White, fontSize = 14.sp, modifier = Modifier.clickable { expanded = !expanded })
                if (expanded) {
                    PRIVACY_OPTIONS.forEach { (v, label) ->
                        Text("   $label", color = if ((me.privacy_last_seen ?: "everyone") == v) acc else MutedText,
                            fontSize = 13.sp, modifier = Modifier.clickable {
                                scope.launch {
                                    runCatching { Supa.updateMe(ProfilePatch(privacy_last_seen = v)) }
                                    Supa.me = Supa.me?.copy(privacy_last_seen = v)
                                }
                            }.padding(vertical = 4.dp))
                    }
                }
                Spacer(Modifier.size(8.dp))
                Text("Статус присутствия: ${PRESENCE_STATUSES.firstOrNull { it.first == (me.presence_status ?: "online") }?.second ?: "Онлайн"}",
                    color = Color.White, fontSize = 14.sp, modifier = Modifier.clickable { expanded = !expanded })
            }
        }

        item { Section("Устройства и сессии") }
        item {
            Text("💻 Активные сессии ›", color = Color.White, fontSize = 14.sp,
                modifier = Modifier.clickable { sessionsOpen = true }.padding(horizontal = 16.dp, vertical = 8.dp))
        }

        item { Section("ИИ и стикеры") }
        item {
            Text("✨ Настройки MSP AI ›", color = Color.White, fontSize = 14.sp,
                modifier = Modifier.clickable { aiOpen = true }.padding(horizontal = 16.dp, vertical = 8.dp))
        }

        if (me.is_admin || me.is_moderator) {
            item { Section("Администрирование") }
            item {
                Text("🛡 Админ-панель ›", color = acc, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.clickable { onOpenAdmin() }.padding(horizontal = 16.dp, vertical = 8.dp))
            }
        }

        item { Section("Аккаунт") }
        item {
            Text("🚪 Выйти", color = DangerColor, fontSize = 15.sp,
                modifier = Modifier.clickable { onLogout() }.padding(horizontal = 16.dp, vertical = 10.dp))
        }
        item {
            Text("MSPgram Android · нативное приложение", color = MutedText, fontSize = 11.sp,
                modifier = Modifier.padding(16.dp))
        }
        item { Spacer(Modifier.size(80.dp)) }
    }

    if (editingProfile) ProfileEditSheet(me, onClose = { editingProfile = false })
    if (sessionsOpen) SessionsSheet(onClose = { sessionsOpen = false })
    if (aiOpen) AiSettingsSheet(onClose = { aiOpen = false })
}

@Composable
fun SwitchRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = Color.White, fontSize = 14.sp, modifier = Modifier.weight(1f))
        androidx.compose.material3.Switch(checked = checked, onCheckedChange = onChange)
    }
}

// ---------- редактирование профиля (profile.js) ----------

@Composable
fun ProfileEditSheet(me: Profile, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val acc = accentColor(Prefs.get().accent)
    var nickname by remember { mutableStateOf(me.nickname) }
    var display by remember { mutableStateOf(me.display_name ?: "") }
    var bio by remember { mutableStateOf(me.bio ?: "") }
    var statusText by remember { mutableStateOf(me.status_text ?: "") }
    var statusEmoji by remember { mutableStateOf(me.status_emoji ?: "") }
    var presence by remember { mutableStateOf(me.presence_status ?: "online") }
    var err by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val pickAvatar = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) scope.launch {
            try {
                Supa.uploadAvatar(ctx, uri)
                Supa.me = Supa.me?.copy(avatar_url = Supa.loadMe(Supa.userId ?: "").avatar_url)
                Calls.toastMsg("Аватар обновлён ✓")
            } catch (e: Exception) { err = e.message ?: "Ошибка" }
        }
    }

    androidx.compose.material3.Surface(Modifier.fillMaxSize(), color = DarkBg.copy(alpha = 0.9f)) {
        LazyColumn(Modifier.fillMaxWidth().padding(16.dp).background(DarkSurface, RoundedCornerShape(16.dp)).padding(16.dp)) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Avatar(me.name, 52.dp, me.avatar_url)
                    Spacer(Modifier.width(12.dp))
                    TextButton(onClick = { pickAvatar.launch("image/*") }) { Text("📷 Сменить аватар", color = acc) }
                }
                Spacer(Modifier.size(10.dp))
                OutlinedTextField(value = nickname, onValueChange = { nickname = it }, label = { Text("Ник (@nick)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.size(8.dp))
                OutlinedTextField(value = display, onValueChange = { display = it }, label = { Text("Отображаемое имя") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.size(8.dp))
                OutlinedTextField(value = bio, onValueChange = { bio = it }, label = { Text("О себе") }, modifier = Modifier.fillMaxWidth(), maxLines = 3)
                Spacer(Modifier.size(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(value = statusEmoji, onValueChange = { statusEmoji = it.take(2) }, label = { Text("Эмодзи") }, singleLine = true, modifier = Modifier.width(80.dp))
                    Spacer(Modifier.width(8.dp))
                    OutlinedTextField(value = statusText, onValueChange = { statusText = it }, label = { Text("Статус") }, singleLine = true, modifier = Modifier.weight(1f))
                }
                Spacer(Modifier.size(10.dp))
                Text("Статус присутствия:", color = MutedText, fontSize = 12.sp)
                PRESENCE_STATUSES.forEach { (v, label) ->
                    Text(
                        (if (presence == v) "● " else "○ ") + label,
                        color = if (presence == v) acc else MutedText, fontSize = 13.sp,
                        modifier = Modifier.clickable { presence = v }.padding(vertical = 3.dp),
                    )
                }
                if (err.isNotEmpty()) Text(err, color = DangerColor, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
                Spacer(Modifier.size(12.dp))
                Row {
                    TextButton(enabled = !busy && nickname.isNotBlank(), onClick = {
                        busy = true
                        scope.launch {
                            try {
                                Supa.updateMe(ProfilePatch(
                                    nickname = nickname.trim(),
                                    display_name = display.trim().ifBlank { null },
                                    bio = bio.trim().ifBlank { null },
                                    status_text = statusText.trim().ifBlank { null },
                                    status_emoji = statusEmoji.trim().ifBlank { null },
                                    presence_status = presence,
                                ))
                                Supa.me = Supa.loadMe(Supa.userId ?: "")
                                Realtime.presenceTrack(Supa.userId ?: "", presence)
                                onClose()
                            } catch (e: Exception) { err = e.message ?: "Ошибка" }
                            busy = false
                        }
                    }) { Text("Сохранить", color = acc) }
                    TextButton(onClick = onClose) { Text("Отмена", color = MutedText) }
                }
                Spacer(Modifier.size(30.dp))
            }
        }
    }
}

// ---------- сессии (settings sessions.js) ----------

@Composable
fun SessionsSheet(onClose: () -> Unit) {
    var sessions by remember { mutableStateOf<List<SessionRow>>(emptyList()) }
    var err by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val acc = accentColor(Prefs.get().accent)

    LaunchedEffect(Unit) {
        try { sessions = Supa.listSessions() } catch (e: Exception) { err = e.message ?: "" }
    }
    androidx.compose.material3.Surface(Modifier.fillMaxSize(), color = DarkBg.copy(alpha = 0.9f)) {
        Column(Modifier.fillMaxWidth().padding(16.dp).background(DarkSurface, RoundedCornerShape(16.dp)).padding(16.dp)) {
            Text("💻 Активные сессии", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 17.sp)
            Spacer(Modifier.size(8.dp))
            TextButton(onClick = {
                scope.launch {
                    runCatching { Supa.revokeOtherSessions() }
                    sessions = runCatching { Supa.listSessions() }.getOrDefault(sessions)
                }
            }) { Text("Завершить все другие", color = DangerColor) }
            LazyColumn {
                items(sessions) { s ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("${s.device ?: "Устройство"}${if (s.id == Supa.sid) "  · это ты" else ""}",
                                color = Color.White, fontSize = 14.sp)
                            Text("${s.user_agent?.take(40) ?: ""} · ${fmtTime(s.last_active ?: s.created_at ?: "")}",
                                color = MutedText, fontSize = 11.sp)
                        }
                        if (s.revoked) {
                            Text("отозвана", color = MutedText, fontSize = 11.sp)
                        } else if (s.id != Supa.sid) {
                            Text("✕", color = DangerColor, fontSize = 14.sp, modifier = Modifier.clickable {
                                scope.launch {
                                    runCatching { Supa.revokeSession(s.id) }
                                    sessions = runCatching { Supa.listSessions() }.getOrDefault(sessions)
                                }
                            })
                        }
                    }
                }
            }
            if (err.isNotEmpty()) Text(err, color = DangerColor, fontSize = 12.sp)
            TextButton(onClick = onClose) { Text("Закрыть", color = acc) }
        }
    }
}

// ---------- настройки ИИ (ai-core.js: url/model/key + Giphy) ----------

@Composable
fun AiSettingsSheet(onClose: () -> Unit) {
    val acc = accentColor(Prefs.get().accent)
    val p = Prefs.get()
    var url by remember { mutableStateOf(p.aiUrl) }
    var model by remember { mutableStateOf(p.aiModel) }
    var key by remember { mutableStateOf(p.aiKey) }
    var giphy by remember { mutableStateOf(p.giphyKey) }
    var saved by remember { mutableStateOf("") }

    androidx.compose.material3.Surface(Modifier.fillMaxSize(), color = DarkBg.copy(alpha = 0.9f)) {
        Column(Modifier.fillMaxWidth().padding(16.dp).background(DarkSurface, RoundedCornerShape(16.dp)).padding(16.dp)) {
            Text("✨ MSP AI", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 17.sp)
            Spacer(Modifier.size(10.dp))
            OutlinedTextField(value = url, onValueChange = { url = it }, label = { Text("URL (по умолчанию: Pollinations)") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            Spacer(Modifier.size(8.dp))
            OutlinedTextField(value = model, onValueChange = { model = it }, label = { Text("Модель (openai-fast)") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            Spacer(Modifier.size(8.dp))
            OutlinedTextField(value = key, onValueChange = { key = it }, label = { Text("Ключ (опционально)") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            Spacer(Modifier.size(12.dp))
            Text("GIF (Giphy)", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 15.sp)
            Spacer(Modifier.size(6.dp))
            OutlinedTextField(value = giphy, onValueChange = { giphy = it }, label = { Text("Giphy API-ключ") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            Spacer(Modifier.size(12.dp))
            Row {
                TextButton(onClick = {
                    Prefs.set(mapOf("aiUrl" to url, "aiModel" to model, "aiKey" to key, "giphyKey" to giphy))
                    saved = "✓ Сохранено"
                }) { Text("Сохранить", color = acc) }
                TextButton(onClick = {
                    Prefs.set(mapOf("aiUrl" to "", "aiModel" to ""))
                    saved = "✓ Сброшено на значения по умолчанию"
                }) { Text("Сбросить ИИ", color = MutedText) }
                TextButton(onClick = onClose) { Text("Закрыть", color = acc) }
            }
            if (saved.isNotEmpty()) Text(saved, color = OkColor, fontSize = 12.sp)
        }
    }
}

// ============================================================
//  Админ-панель (admin.js/admin2.js: юзеры / жалобы / статистика)
// ============================================================

@Composable
fun AdminScreen(me: Profile, onClose: () -> Unit, onOpenChat: (String) -> Unit) {
    androidx.activity.compose.BackHandler { onClose() }
    var tab by remember { mutableStateOf("users") }
    val acc = accentColor(Prefs.get().accent)
    val scope = rememberCoroutineScope()

    Column(Modifier.fillMaxSize().background(DarkBg)) {
        Row(Modifier.fillMaxWidth().background(DarkSurface).padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onClose) { Text("←", color = acc, fontSize = 20.sp) }
            Text("🛡 Админка", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 16.sp)
            Spacer(Modifier.weight(1f))
            listOf("users" to "Юзеры", "reports" to "Жалобы", "stats" to "Статистика").forEach { (v, l) ->
                Text(l, fontSize = 12.sp,
                    color = if (tab == v) acc else MutedText,
                    modifier = Modifier.clickable { tab = v }.padding(horizontal = 8.dp, vertical = 4.dp))
            }
        }
        when (tab) {
            "users" -> AdminUsers(me, onOpenChat)
            "reports" -> AdminReports()
            "stats" -> AdminStats()
        }
    }
}

@Composable
fun AdminUsers(me: Profile, onOpenChat: (String) -> Unit) {
    var users by remember { mutableStateOf<List<Profile>>(emptyList()) }
    var roleFor by remember { mutableStateOf<Profile?>(null) }
    var editFor by remember { mutableStateOf<Profile?>(null) }
    var q by remember { mutableStateOf("") }
    var err by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val acc = accentColor(Prefs.get().accent)

    LaunchedEffect(Unit) {
        try { users = Supa.adminListUsers() } catch (e: Exception) { err = e.message ?: "" }
    }
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            value = q, onValueChange = { q = it },
            placeholder = { Text("Поиск по нику…", color = MutedText) },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), singleLine = true,
        )
        LazyColumn(Modifier.weight(1f)) {
            val list = users.filter { q.isBlank() || it.nickname.contains(q, ignoreCase = true) || (it.display_name ?: "").contains(q, ignoreCase = true) }
            items(list) { p ->
                val banned = p.isBannedNow()
                Column(Modifier.fillMaxWidth().background(DarkBg).padding(horizontal = 14.dp, vertical = 8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Avatar(p.name, 36.dp, p.avatar_url)
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(p.name, color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                                if (p.is_admin) { Spacer(Modifier.width(4.dp)); Text("АДМИН", color = acc, fontSize = 9.sp, fontWeight = FontWeight.Bold) }
                                if (p.is_moderator) { Spacer(Modifier.width(4.dp)); Text("МОДЕР", color = OkColor, fontSize = 9.sp, fontWeight = FontWeight.Bold) }
                                if (banned) { Spacer(Modifier.width(4.dp)); Text("БАН", color = DangerColor, fontSize = 9.sp, fontWeight = FontWeight.Bold) }
                            }
                            Text("@${p.nickname} · ${p.id.take(8)}", color = MutedText, fontSize = 11.sp)
                            if (banned) {
                                Text("Причина: ${p.ban_reason ?: "не указана"}${p.banned_until?.let { " · до ${it.take(10)}" } ?: " · навсегда"}",
                                    color = DangerColor, fontSize = 11.sp)
                            }
                        }
                        if (me.is_admin) {
                            Text("✏", fontSize = 15.sp, modifier = Modifier.clickable {
                                editFor = p
                            }.padding(horizontal = 6.dp))
                        }
                        Text("✉", fontSize = 15.sp, modifier = Modifier.clickable {
                            scope.launch {
                                runCatching { onOpenChat(Supa.startDirect(p.id)) }
                            }
                        }.padding(horizontal = 6.dp))
                        Text(if (banned) "✅" else "🚫", fontSize = 15.sp, modifier = Modifier.clickable {
                            scope.launch {
                                try {
                                    if (banned) Supa.adminSetBan(p.id, false, null, null)
                                    else Supa.adminSetBan(p.id, true, "Нарушение правил", null)
                                    users = Supa.adminListUsers()
                                } catch (e: Exception) { err = e.message ?: "" }
                            }
                        }.padding(horizontal = 6.dp))
                        // роли — только для админов (как admin2.js roleOf)
                        if (me.is_admin) {
                            Text("🔑", fontSize = 15.sp, modifier = Modifier.clickable {
                                roleFor = p
                            }.padding(horizontal = 6.dp))
                        }
                    }
                }
            }
        }
        if (err.isNotEmpty()) Text(err, color = DangerColor, fontSize = 12.sp, modifier = Modifier.padding(8.dp))
    }
    editFor?.let { p ->
        var nick2 by remember(p.id) { mutableStateOf(p.nickname) }
        var disp2 by remember(p.id) { mutableStateOf(p.display_name ?: "") }
        AlertDialog(
            onDismissRequest = { editFor = null },
            containerColor = DarkSurface,
            titleContentColor = Color.White,
            title = { Text("Имя и юзернейм") },
            text = {
                Column {
                    OutlinedTextField(value = nick2, onValueChange = { nick2 = it }, label = { Text("Юзернейм") }, singleLine = true)
                    Spacer(Modifier.size(8.dp))
                    OutlinedTextField(value = disp2, onValueChange = { disp2 = it }, label = { Text("Отображаемое имя") }, singleLine = true)
                }
            },
            confirmButton = {
                TextButton(enabled = nick2.isNotBlank(), onClick = {
                    val n = nick2.trim(); val d = disp2.trim(); editFor = null
                    scope.launch {
                        runCatching { Supa.adminUpdateProfile(p.id, ProfilePatch(nickname = n, display_name = d.ifBlank { null })) }
                        users = runCatching { Supa.adminListUsers() }.getOrDefault(users)
                    }
                }) { Text("Сохранить", color = accentColor(Prefs.get().accent)) }
            },
            dismissButton = { TextButton(onClick = { editFor = null }) { Text("Отмена", color = MutedText) } },
        )
    }
    roleFor?.let { p ->
        val cur = if (p.is_admin) 3 else if (p.is_moderator) 2 else 1
        var sel by remember(p.id) { mutableStateOf(cur) }
        AlertDialog(
            onDismissRequest = { roleFor = null },
            containerColor = DarkSurface,
            titleContentColor = Color.White,
            title = { Text("Роль @${p.nickname}") },
            text = {
                Column {
                    listOf(1 to "Пользователь", 2 to "Модератор", 3 to "Администратор").forEach { (v, l) ->
                        Text((if (sel == v) "● " else "○ ") + l,
                            color = if (sel == v) accentColor(Prefs.get().accent) else MutedText,
                            fontSize = 14.sp, modifier = Modifier.clickable { sel = v }.padding(vertical = 6.dp))
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val n = sel; roleFor = null
                    scope.launch {
                        runCatching { Supa.adminUpdateProfile(p.id, ProfilePatch(is_admin = n == 3, is_moderator = n == 2)) }
                        users = runCatching { Supa.adminListUsers() }.getOrDefault(users)
                    }
                }) { Text("OK", color = accentColor(Prefs.get().accent)) }
            },
            dismissButton = { TextButton(onClick = { roleFor = null }) { Text("Отмена", color = MutedText) } },
        )
    }
}

@Composable
fun AdminReports() {
    var reports by remember { mutableStateOf<List<ReportRow>>(emptyList()) }
    var err by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val acc = accentColor(Prefs.get().accent)

    LaunchedEffect(Unit) {
        try { reports = Supa.adminReports() } catch (e: Exception) { err = e.message ?: "" }
    }
    LazyColumn(Modifier.fillMaxSize()) {
        items(reports) { r ->
            Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp)) {
                Text("Жалоба на профиль ${r.target_profile.take(8)}", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                Text("От ${r.reporter.take(8)} · ${r.reason ?: "—"} · статус: ${r.status}", color = MutedText, fontSize = 12.sp)
                Row {
                    TextButton(onClick = {
                        scope.launch { runCatching { Supa.adminSetReportStatus(r.id, "resolved") }; reports = runCatching { Supa.adminReports() }.getOrDefault(reports) }
                    }) { Text("✓ Решено", color = OkColor, fontSize = 12.sp) }
                    TextButton(onClick = {
                        scope.launch { runCatching { Supa.adminSetReportStatus(r.id, "rejected") }; reports = runCatching { Supa.adminReports() }.getOrDefault(reports) }
                    }) { Text("✕ Отклонить", color = MutedText, fontSize = 12.sp) }
                }
            }
        }
        if (reports.isEmpty()) item { Empty(if (err.isNotEmpty()) err else "Жалоб нет 🙂") }
    }
}

@Composable
fun AdminStats() {
    var stats by remember { mutableStateOf<Map<String, Long>?>(null) }
    var err by remember { mutableStateOf("") }
    LaunchedEffect(Unit) {
        try { stats = Supa.adminStats() } catch (e: Exception) { err = e.message ?: "" }
    }
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        val s = stats
        if (s == null) {
            if (err.isNotEmpty()) Text(err, color = DangerColor) else CircularProgressIndicator(color = accentColor(Prefs.get().accent))
        } else {
            val labels = mapOf(
                "users" to "Пользователей", "chats" to "Чатов", "messages" to "Сообщений",
                "reports" to "Жалоб", "friends" to "Дружб", "online" to "Онлайн",
            )
            s.forEach { (k, v) ->
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                    Text(labels[k] ?: k, color = MutedText, fontSize = 14.sp, modifier = Modifier.weight(1f))
                    Text("$v", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

package com.mspgram.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

// ============================================================
//  Друзья (как api.js friendships) + профиль-шит (как profile.js)
// ============================================================

@Composable
fun FriendsScreen(me: Profile, onOpenChat: (String) -> Unit, onOpenProfile: (String) -> Unit) {
    val onlineUsers by Realtime.online.collectAsState()
    val liveStatuses by Realtime.presenceStatus.collectAsState()
    LaunchedEffect(onlineUsers, liveStatuses) { }
    var search by remember { mutableStateOf("") }
    var addNick by remember { mutableStateOf("") }
    var addErr by remember { mutableStateOf("") }
    var addBusy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val acc = accentColor(Prefs.get().accent)

    Column(Modifier.fillMaxSize().background(DarkBg)) {
        Text(
            "Друзья", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 20.sp,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
        )

        // добавить по нику (friend_request RPC)
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = addNick, onValueChange = { addNick = it; addErr = "" },
                placeholder = { Text("Ник друга (@nick)", color = MutedText) },
                modifier = Modifier.weight(1f), singleLine = true,
            )
            TextButton(enabled = !addBusy && addNick.isNotBlank(), onClick = {
                addBusy = true
                scope.launch {
                    try {
                        val target = addNick.removePrefix("@").trim()
                        val p = Supa.searchUsers(target).firstOrNull { it.nickname.equals(target, ignoreCase = true) }
                            ?: throw Exception("Пользователь не найден")
                        if (p.id == Supa.userId) throw Exception("Это ты 🙂")
                        Supa.friendRequest(p.id)
                        addNick = ""
                        addErr = "✓ Заявка отправлена ${p.name}"
                    } catch (e: Exception) { addErr = e.message ?: "Ошибка" }
                    addBusy = false
                }
            }) { Text(if (addBusy) "…" else "＋ Добавить", color = acc) }
        }
        if (addErr.isNotEmpty()) Text(addErr, color = if (addErr.startsWith("✓")) OkColor else DangerColor, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 14.dp))

        Spacer(Modifier.size(8.dp))
        OutlinedTextField(
            value = search, onValueChange = { search = it },
            placeholder = { Text("Поиск в друзьях…", color = MutedText) },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp), singleLine = true,
        )
        Spacer(Modifier.size(6.dp))

        LazyColumn(Modifier.weight(1f)) {
            // входящие заявки
            if (Supa.friendReqs.isNotEmpty()) {
                item { Section("📨 Заявки (${Supa.friendReqs.size})") }
                items(Supa.friendReqs) { fe ->
                    val p = fe.profile
                    Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Avatar(p?.name ?: "?", 42.dp, p?.avatar_url)
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(p?.name ?: "?", color = Color.White, fontSize = 15.sp)
                            Text("@${p?.nickname}", color = MutedText, fontSize = 12.sp)
                        }
                        TextButton(onClick = { scope.launch { runCatching { Supa.friendRespond(fe.id, true) }; Supa.loadFriends() } }) {
                            Text("✓ Принять", color = OkColor)
                        }
                        TextButton(onClick = { scope.launch { runCatching { Supa.friendRespond(fe.id, false) }; Supa.loadFriends() } }) {
                            Text("✕", color = DangerColor)
                        }
                    }
                }
            }
            // исходящие
            if (Supa.friendOut.isNotEmpty()) {
                item { Section("⏳ Отправленные (${Supa.friendOut.size})") }
                items(Supa.friendOut) { fe ->
                    Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Avatar(fe.profile?.name ?: "?", 36.dp, fe.profile?.avatar_url)
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(fe.profile?.name ?: "?", color = Color.White, fontSize = 14.sp)
                            Text("ожидает ответа", color = MutedText, fontSize = 11.sp)
                        }
                        TextButton(onClick = { scope.launch { runCatching { Supa.friendRemove(fe.id) }; Supa.loadFriends() } }) {
                            Text("Отменить", color = MutedText, fontSize = 12.sp)
                        }
                    }
                }
            }
            // друзья
            val friends = Supa.friends.filter {
                search.isBlank() || (it.profile?.name ?: "").lowercase().contains(search.lowercase()) ||
                    (it.profile?.nickname ?: "").lowercase().contains(search.lowercase())
            }
            if (Supa.friends.isNotEmpty()) item { Section("Друзья (${Supa.friends.size})") }
            items(friends) { fe ->
                val p = fe.profile ?: return@items
                val presence = Supa.presenceOf(p)
                Row(
                    Modifier.fillMaxWidth().clickable { onOpenProfile(p.id) }
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Avatar(p.name, 44.dp, p.avatar_url, presence = presence)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(p.name, color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                        Text("@${p.nickname} · ${lastSeenShort(p.last_seen, presence)}", color = MutedText, fontSize = 12.sp)
                    }
                    Text("💬", fontSize = 18.sp, modifier = Modifier.clickable {
                        scope.launch {
                            try {
                                onOpenChat(Supa.startDirect(p.id))
                            } catch (e: Exception) {
                                Calls.toastMsg(e.message ?: "Ошибка")
                            }
                        }
                    })
                }
            }
            if (Supa.friends.isEmpty() && Supa.friendReqs.isEmpty()) {
                item { Empty("Пока нет друзей.\n\nДобавь друга по нику выше или найди через 🔍 поиск.") }
            }
            item { Spacer(Modifier.size(80.dp)) }
        }
    }
}

// ---------- профиль (модальный, как profile.js) ----------

object ProfileSheet {
    val visible = mutableStateOf(false)
    val userId = mutableStateOf<String?>(null)

    fun open(id: String) { userId.value = id; visible.value = true }
    fun close() { visible.value = false }
}

@Composable
fun ProfileSheetView(me: Profile, onOpenChat: (String) -> Unit) {
    val acc = accentColor(Prefs.get().accent)
    var p by remember(ProfileSheet.userId.value) { mutableStateOf<Profile?>(null) }
    var err by remember { mutableStateOf("") }
    var reportOpen by remember { mutableStateOf(false) }
    var qrOpen by remember { mutableStateOf(false) }
    var friendState by remember { mutableStateOf("none") } // none | friends | pending_in | pending_out
    var friendRowId by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(ProfileSheet.userId.value) {
        val id = ProfileSheet.userId.value ?: return@LaunchedEffect
        try {
            p = if (id == Supa.userId) Supa.me else Supa.loadProfile(id)
            friendState = when {
                Supa.friends.any { it.profile?.id == id } -> "friends"
                Supa.friendReqs.any { it.profile?.id == id } -> "pending_in"
                Supa.friendOut.any { it.profile?.id == id } -> "pending_out"
                else -> "none"
            }
            friendRowId = (Supa.friends + Supa.friendReqs + Supa.friendOut).firstOrNull { it.profile?.id == id }?.id
        } catch (e: Exception) { err = e.message ?: "" }
    }

    androidx.compose.material3.Surface(
        Modifier.fillMaxSize().background(DarkBg.copy(alpha = 0.75f)),
        color = Color.Transparent,
    ) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(Modifier.fillMaxWidth().padding(20.dp)
            .background(DarkSurface, RoundedCornerShape(18.dp)).padding(20.dp)) {
            val prof = p
            if (prof == null) {
                Box(Modifier.fillMaxWidth().padding(30.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = acc)
                }
            } else {
                // обложка профиля (profile.js: pm-cover)
                if (prof.cover_url != null) {
                    coil.compose.AsyncImage(
                        model = prof.cover_url,
                        contentDescription = "Обложка",
                        contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                        modifier = Modifier.fillMaxWidth().height(90.dp).background(DarkSurface2, RoundedCornerShape(12.dp)),
                    )
                    Spacer(Modifier.size(10.dp))
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Avatar(prof.name, 64.dp, prof.avatar_url, presence = Supa.presenceOf(prof))
                    Spacer(Modifier.width(14.dp))
                    Column {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(prof.name, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 19.sp)
                            if (prof.is_admin) { Spacer(Modifier.width(6.dp)); Text("👑", fontSize = 14.sp) }
                        }
                        Text("@${prof.nickname}", color = acc, fontSize = 13.sp)
                        Text(relLastSeen(prof.last_seen, Supa.presenceOf(prof)), color = MutedText, fontSize = 12.sp)
                    }
                }
                prof.status_text?.let { Text("${prof.status_emoji ?: ""} ${it}", color = Color.White, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp)) }
                prof.bio?.let { Text(it, color = MutedText, fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp)) }
                if (prof.isBannedNow()) {
                    Text("🚫 Аккаунт заблокирован${prof.ban_reason?.let { ": $it" } ?: ""}", color = DangerColor, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
                }
                Spacer(Modifier.size(16.dp))

                if (prof.id == Supa.userId) {
                    TextButton(onClick = { ProfileSheet.close() }, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                        Text("Закрыть", color = MutedText)
                    }
                } else {
                    // кнопки действий (как в profile.js)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                        Button(onClick = {
                            ProfileSheet.close()
                            scope.launch {
                                try { onOpenChat(Supa.startDirect(prof.id)) }
                                catch (e: Exception) { Calls.toastMsg(e.message ?: "Ошибка") }
                            }
                        }, colors = ButtonDefaults.buttonColors(containerColor = acc)) {
                            Text("💬 Написать")
                        }
                        when (friendState) {
                            "none" -> TextButton(onClick = {
                                scope.launch {
                                    runCatching { Supa.friendRequest(prof.id) }
                                    friendState = "pending_out"
                                }
                            }) { Text("＋ В друзья", color = acc) }
                            "pending_out" -> TextButton(onClick = {
                                scope.launch {
                                    runCatching { friendRowId?.let { Supa.friendRemove(it) } }
                                    friendState = "none"
                                }
                            }) { Text("⏳ Отменить заявку", color = MutedText) }
                            "pending_in" -> TextButton(onClick = {
                                scope.launch {
                                    runCatching { friendRowId?.let { Supa.friendRespond(it, true) } }
                                    friendState = "friends"
                                }
                            }) { Text("✓ Принять", color = OkColor) }
                            "friends" -> TextButton(onClick = {
                                scope.launch {
                                    runCatching { friendRowId?.let { Supa.friendRemove(it) } }
                                    friendState = "none"
                                }
                            }) { Text("💔 Удалить из друзей", color = DangerColor) }
                        }
                    }
                    Spacer(Modifier.size(6.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        val blocked = Supa.myBlocks.contains(prof.id)
                        Text(
                            if (blocked) "🔓 Разблокировать" else "🚫 Заблокировать",
                            color = if (blocked) OkColor else DangerColor, fontSize = 13.sp,
                            modifier = Modifier.clickable {
                                scope.launch {
                                    runCatching { Supa.setBlock(prof.id, !blocked) }
                                    if (!blocked) ProfileSheet.close()
                                }
                            },
                        )
                        Text("⚠️ Пожаловаться", color = MutedText, fontSize = 13.sp,
                            modifier = Modifier.clickable { reportOpen = true })
                        Text("🔲 QR", color = accentColor(Prefs.get().accent), fontSize = 13.sp,
                            modifier = Modifier.clickable { qrOpen = true })
                    }
                    if (err.isNotEmpty()) Text(err, color = DangerColor, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
                }
                Spacer(Modifier.size(8.dp))
                Text("✕", color = MutedText, fontSize = 16.sp, modifier = Modifier.align(Alignment.CenterHorizontally).clickable { ProfileSheet.close() }.padding(8.dp))
            }
        }
    }

        }

    p?.let { pr -> if (qrOpen) QrDialog(pr, onClose = { qrOpen = false }) }

    if (reportOpen) {
        var reason by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { reportOpen = false },
            containerColor = DarkSurface,
            titleContentColor = Color.White,
            title = { Text("⚠️ Жалоба на ${p?.name}") },
            text = {
                Column {
                    Text("Причина:", color = MutedText, fontSize = 12.sp)
                    Spacer(Modifier.size(6.dp))
                    OutlinedTextField(value = reason, onValueChange = { reason = it }, label = { Text("Опиши проблему") })
                }
            },
            confirmButton = {
                TextButton(enabled = reason.isNotBlank(), onClick = {
                    val r = reason; reportOpen = false
                    scope.launch { runCatching { Supa.createReport(p?.id ?: "", r) }; Calls.toastMsg("Жалоба отправлена") }
                }) { Text("Отправить", color = acc) }
            },
            dismissButton = { TextButton(onClick = { reportOpen = false }) { Text("Отмена", color = MutedText) } },
        )
    }
}

// ---------- QR-код профиля (profile.js showQr) ----------
@Composable
fun QrDialog(prof: Profile, onClose: () -> Unit) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val cm = androidx.compose.ui.platform.LocalClipboardManager.current
    val link = remember(prof.id) { "https://ilya221221rr-sys.github.io/MSPgram/?add=${prof.id}" }
    val bitmap = remember(prof.id) {
        runCatching {
            val bits = com.google.zxing.qrcode.QRCodeWriter().encode(
                link, com.google.zxing.BarcodeFormat.QR_CODE, 512, 512,
                mapOf(com.google.zxing.EncodeHintType.MARGIN to 1),
            )
            val bmp = android.graphics.Bitmap.createBitmap(512, 512, android.graphics.Bitmap.Config.RGB_565)
            for (x in 0 until 512) for (y in 0 until 512) {
                bmp.setPixel(x, y, if (bits.get(x, y)) android.graphics.Color.BLACK else android.graphics.Color.WHITE)
            }
            bmp
        }.getOrNull()
    }
    AlertDialog(
        onDismissRequest = onClose,
        containerColor = DarkSurface,
        titleContentColor = TextC,
        title = { Text("QR-код профиля") },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                if (bitmap != null) {
                    androidx.compose.foundation.Image(
                        bitmap.asImageBitmap(), contentDescription = "QR",
                        modifier = Modifier.size(220.dp).background(Color.White, RoundedCornerShape(12.dp)).padding(8.dp),
                    )
                }
                Spacer(Modifier.size(8.dp))
                Text(
                    link, color = MutedText, fontSize = 11.sp,
                    modifier = Modifier.clickable {
                        cm.setText(androidx.compose.ui.text.AnnotatedString(link))
                        Calls.toastMsg("Ссылка скопирована")
                    },
                )
                Text("Другой сканирует код и добавится к тебе в друзья", color = MutedText, fontSize = 11.sp)
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("Готово", color = MutedText) } },
    )
}

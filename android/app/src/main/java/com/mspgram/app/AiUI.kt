package com.mspgram.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
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
import coil.compose.AsyncImage
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.launch

// ============================================================
//  MSP AI (ai-core.js): чат с ассистентом. Стикеры/GIF-панели.
// ============================================================

/** Фото → data-URL (ai-vision.js: JPEG, сторона ≤1280, качество 0.82) */
fun imageToDataUrl(ctx: android.content.Context, uri: android.net.Uri, max: Int = 1280, quality: Int = 82): String {
    val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: throw Exception("Файл не читается")
    var bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: throw Exception("Это не картинка")
    val w = bmp.width; val h = bmp.height
    val scale = maxOf(1, maxOf(w, h) / max)
    if (scale > 1) bmp = Bitmap.createScaledBitmap(bmp, w / scale, h / scale, true)
    val out = ByteArrayOutputStream()
    bmp.compress(Bitmap.CompressFormat.JPEG, quality, out)
    return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
}

@Composable
fun AiScreen(me: Profile) {
    val acc = accentColor(Prefs.get().accent)
    val ctx = androidx.compose.ui.platform.LocalContext.current
    var input by remember { mutableStateOf("") }
    var history by remember { mutableStateOf(listOf<Pair<String, String>>()) } // (role, text)
    var busy by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf("") }
    var pendingImg by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    val pickImage = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) {
            try { pendingImg = imageToDataUrl(ctx, uri) } catch (e: Exception) { err = e.message ?: "Ошибка" }
        }
    }

    Column(Modifier.fillMaxSize().background(DarkBg)) {
        Row(Modifier.fillMaxWidth().background(DarkSurface).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("✨", fontSize = 20.sp)
            Spacer(Modifier.width(8.dp))
            Column {
                Text("MSP AI", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                Text("ассистент · ${if (Prefs.get().aiModel.isBlank()) "openai-fast" else Prefs.get().aiModel}",
                    color = MutedText, fontSize = 11.sp)
            }
        }

        LazyColumn(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 10.dp), reverseLayout = false) {
            if (history.isEmpty()) {
                item {
                    Column(Modifier.padding(vertical = 30.dp)) {
                        Text("Привет, ${me.name}! Я MSP AI 🤖", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.size(6.dp))
                        Text("Спроси что угодно, попроси написать текст, перевести или придумать идеи. ИИ работает через Pollinations, ключ не нужен (но можно задать свой в настройках).",
                            color = MutedText, fontSize = 13.sp)
                    }
                }
            }
            items(history) { (role, text) ->
                val own = role == "user"
                Box(Modifier.fillMaxWidth().padding(vertical = 3.dp), contentAlignment = if (own) Alignment.CenterEnd else Alignment.CenterStart) {
                    Surface(
                        color = if (own) acc.copy(alpha = 0.26f) else DarkSurface,
                        shape = RoundedCornerShape(14.dp),
                    ) {
                        Text(text, color = Color.White, fontSize = 14.sp,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp).widthIn(max = 300.dp))
                    }
                }
            }
            if (busy) item { Text("MSP AI печатает…", color = acc, fontSize = 12.sp, modifier = Modifier.padding(8.dp)) }
            item { Spacer(Modifier.size(10.dp)) }
        }

        if (err.isNotEmpty()) Text(err, color = DangerColor, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 12.dp))

        pendingImg?.let { img ->
            Row(Modifier.padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                AsyncImage(model = img, contentDescription = "Фото для ИИ",
                    modifier = Modifier.size(64.dp).background(DarkSurface2, RoundedCornerShape(10.dp)))
                Spacer(Modifier.width(8.dp))
                Text("✕ убрать", color = MutedText, fontSize = 12.sp,
                    modifier = Modifier.clickable { pendingImg = null })
            }
        }
        Row(Modifier.fillMaxWidth().background(DarkSurface).padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("📷", fontSize = 19.sp, modifier = Modifier.clickable { pickImage.launch("image/*") }.padding(horizontal = 4.dp))
            OutlinedTextField(
                value = input, onValueChange = { input = it },
                placeholder = { Text(if (pendingImg != null) "Опиши фото…" else "Спроси MSP AI…", color = MutedText) },
                modifier = Modifier.weight(1f), maxLines = 4,
            )
            Text("➤", fontSize = 22.sp, color = if (input.isNotBlank() || pendingImg != null) acc else MutedText,
                modifier = Modifier.clickable(enabled = !busy && (input.isNotBlank() || pendingImg != null)) {
                val text = input.trim()
                val img = pendingImg
                input = ""
                pendingImg = null
                history = history + ("user" to (if (img != null && text.isBlank()) "🖼 Фото" else text))
                busy = true; err = ""
                scope.launch {
                    try {
                        val answer = Ai.assistant(history.filter { it.first != "err" }, text, img)
                        history = history + ("ai" to answer)
                    } catch (e: Exception) { err = e.message ?: "Ошибка ИИ" }
                    busy = false
                }
            }.padding(horizontal = 10.dp))
        }
    }
}

// ---------- панель стикеров (stickers.js: 4 пака) ----------

@Composable
fun StickerPanel(onPick: (emoji: String, packId: String) -> Unit) {
    var pack by remember { mutableStateOf(Stickers.PACKS.first().id) }
    Surface(color = DarkSurface2, modifier = Modifier.fillMaxWidth().height(230.dp)) {
        Column {
            Row(Modifier.padding(horizontal = 10.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Stickers.PACKS.forEach { p ->
                    val cur = Stickers.PACKS.first { it.id == pack }
                    Text(
                        cur.name, fontSize = 12.sp,
                        color = if (pack == p.id) accentColor(Prefs.get().accent) else MutedText,
                        modifier = Modifier.clickable { pack = p.id },
                    )
                }
            }
            val items = Stickers.PACKS.first { it.id == pack }.items
            LazyRow(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                items(items) { e ->
                    Text(e, fontSize = 34.sp, modifier = Modifier.clickable { onPick(e, pack) }.padding(horizontal = 6.dp))
                }
            }
        }
    }
}

// ---------- панель GIF (gif.js: Giphy) ----------

@Composable
fun GifPanel(onPick: (String) -> Unit) {
    var q by remember { mutableStateOf("") }
    var gifs by remember { mutableStateOf<List<String>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val key = Prefs.get().giphyKey

    fun doSearch(query: String) {
        if (key.isBlank()) { err = "Задай Giphy-ключ в настройках (Настройки → MSP AI)"; return }
        busy = true; err = ""
        scope.launch {
            try {
                gifs = if (query.isBlank()) Giphy.trending(key) else Giphy.search(key, query)
            } catch (e: Exception) { err = e.message ?: "Ошибка" }
            busy = false
        }
    }

    Surface(color = DarkSurface2, modifier = Modifier.fillMaxWidth().height(230.dp)) {
        Column {
            Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = q, onValueChange = { q = it },
                    placeholder = { Text("Поиск GIF…", color = MutedText) },
                    modifier = Modifier.weight(1f), singleLine = true,
                )
                Text("🔍", fontSize = 16.sp, modifier = Modifier.clickable { doSearch(q) }.padding(horizontal = 8.dp))
            }
            if (err.isNotEmpty()) Text(err, color = DangerColor, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 10.dp))
            if (gifs.isEmpty() && !busy && err.isBlank()) {
                Text("GIF от Giphy. Введи запрос или нажми 🔍 для популярных.",
                    color = MutedText, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 12.dp))
            }
            LazyRow(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                items(gifs) { url ->
                    AsyncImage(
                        model = url, contentDescription = "GIF",
                        modifier = Modifier.height(150.dp).width(160.dp)
                            .clickable { onPick(url) }
                            .background(DarkBg, RoundedCornerShape(8.dp)),
                    )
                }
            }
        }
    }
}

package com.mspgram.app

import androidx.compose.foundation.background
import kotlinx.serialization.encodeToString
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// ============================================================
//  Общие элементы UI (тема = тёмная, как var(--bg) на сайте)
// ============================================================

// скины v19 (appearance.js: SKINS — те же 6 тем с их цветами)
val SKINS = listOf(
    "nova" to "Nova",
    "amoled" to "AMOLED",
    "midnight" to "Midnight",
    "graphite" to "Graphite",
    "plum" to "Plum",
    "forest" to "Forest",
)
val WALLS = listOf(
    "none" to "Без обоев", "aurora" to "Аврора", "dusk" to "Закат", "ocean" to "Океан",
    "mint" to "Мята", "doodle" to "Узор", "stars" to "Звёзды", "grid" to "Сетка",
)

// палитра скина: bg / panel / panel2 / hover / line / in — ТОЧНЫЕ значения css/v19.css
data class SkinPalette(val bg: Color, val panel: Color, val panel2: Color, val hover: Color, val line: Color, val bubbleIn: Color, val accent: Color)

fun skinPalette(name: String): SkinPalette = when (name) {
    "amoled" -> SkinPalette(Color(0xFF000000), Color(0xFF0A0A0C), Color(0xFF141418), Color(0xFF1A1A20), Color(0xFF212127), Color(0xFF15151A), Color(0xFF7C5BFF))
    "midnight" -> SkinPalette(Color(0xFF07101F), Color(0xFF0B1B30), Color(0xFF112440), Color(0xFF163052), Color(0xFF1A3355), Color(0xFF12294A), Color(0xFF38BDF8))
    "graphite" -> SkinPalette(Color(0xFF101216), Color(0xFF16181D), Color(0xFF1E2128), Color(0xFF262A33), Color(0xFF2A2E38), Color(0xFF1F232B), Color(0xFF34D399))
    "plum" -> SkinPalette(Color(0xFF0F0A18), Color(0xFF170F26), Color(0xFF21153A), Color(0xFF2A1B49), Color(0xFF33225A), Color(0xFF25173F), Color(0xFFE879F9))
    "forest" -> SkinPalette(Color(0xFF07120E), Color(0xFF0C1B16), Color(0xFF12291F), Color(0xFF173828), Color(0xFF1C4030), Color(0xFF12281F), Color(0xFF4ADE80))
    else -> SkinPalette(Color(0xFF0B1020), Color(0xFF111827), Color(0xFF18203A), Color(0xFF1D2745), Color(0xFF232E4E), Color(0xFF1A2340), Color(0xFF5B8CFF)) // nova = style.css :root
}

// совместимость со старыми вызовами (SettingsUI-превью)
fun skinBg(name: String): Color = skinPalette(name).bg
fun skinAccent(name: String): Color = skinPalette(name).accent

// динамическая тема: обновляется refreshTheme() при смене скина
object ThemeState { val version = androidx.compose.runtime.mutableStateOf(0) }

val Accent = Color(0xFF5B8CFF)        // --accent nova
var DarkBg = Color(0xFF0B1020)        // --bg
var DarkSurface = Color(0xFF111827)   // --panel
var DarkSurface2 = Color(0xFF18203A)  // --panel2
var HoverC = Color(0xFF1D2745)        // --hover
var LineC = Color(0xFF232E4E)         // --line
var InBubble = Color(0xFF1A2340)      // --in (чужие пузыри)
val TextC = Color(0xFFE8EDF8)         // --text
val MutedText = Color(0xFF8F9AB8)     // --muted
val DangerColor = Color(0xFFE5484D)   // --danger
val OkColor = Color(0xFF3DD68C)       // --ok
val Accent2 = Color(0xFF7C5BFF)       // --accent2
val RailBg = Color(0xFF070B16)        // фон сервер-рейла

// пузырь своих: --out = linear-gradient(135deg,#3e63dd,#4d43d8); хвост #4d43d8
fun outBubbleBrush(): androidx.compose.ui.graphics.Brush =
    androidx.compose.ui.graphics.Brush.linearGradient(listOf(Color(0xFF3E63DD), Color(0xFF4D43D8)))
const val OUT_TAIL = 0xFF4D43D8

fun refreshTheme() {
    val pal = skinPalette(Prefs.get().skin)
    DarkBg = pal.bg
    DarkSurface = pal.panel
    DarkSurface2 = pal.panel2
    HoverC = pal.hover
    LineC = pal.line
    InBubble = pal.bubbleIn
    ThemeState.version.value++
}

fun accentColor(name: String): Color = when (name) {
    "purple" -> Color(0xFF9C6BFF)
    "green" -> Color(0xFF3DD68C)
    "pink" -> Color(0xFFFF6BA9)
    "orange" -> Color(0xFFFF8A4C)
    else -> skinPalette(Prefs.get().skin).accent
}

fun accentGradient(name: String): List<Color> = when (name) {
    "purple" -> listOf(Color(0xFF9C6BFF), Color(0xFF6B5BFF))
    "green" -> listOf(Color(0xFF3DD68C), Color(0xFF2BA3D8))
    "pink" -> listOf(Color(0xFFFF6BA9), Color(0xFFFF8A4C))
    "orange" -> listOf(Color(0xFFFF8A4C), Color(0xFFFF5B5B))
    else -> listOf(Accent, Accent2)
}

@Composable
fun MspTheme(content: @Composable () -> Unit) {
    val a = accentColor(Prefs.get().accent)
    // чтение версии темы — смена скина перерисовывает всё приложение
    ThemeState.version.value
    MaterialTheme(
        colorScheme = darkColorScheme(primary = a, secondary = Accent2, background = DarkBg, surface = DarkSurface),
        content = content,
    )
}

// обои чата (appearance.js: WALLS)
@Composable
fun ChatWall(modifier: Modifier = Modifier, content: @Composable androidx.compose.foundation.layout.BoxScope.() -> Unit) {
    val wall = Prefs.get().wall
    val hasGradient = wall in listOf("aurora", "dusk", "ocean", "mint")
    if (wall == "none" || hasGradient) {
        val brush = when (wall) {
            "aurora" -> Brush.verticalGradient(listOf(Color(0x337C5BFF), Color(0x1A5B8CFF), Color.Transparent))
            "dusk" -> Brush.verticalGradient(listOf(Color(0x33FF8A4C), Color(0x1AFF6BA9), Color.Transparent))
            "ocean" -> Brush.verticalGradient(listOf(Color(0x3338BDF8), Color(0x1A2BA3D8), Color.Transparent))
            "mint" -> Brush.verticalGradient(listOf(Color(0x334ADE80), Color(0x1A3DD68C), Color.Transparent))
            else -> Brush.verticalGradient(listOf(Color.Transparent, Color.Transparent))
        }
        Box(modifier.background(brush), contentAlignment = Alignment.TopStart, content = content)
    } else {
        // узоры: точки (doodle), звёзды (stars), сетка (grid)
        Box(modifier.drawBehind {
            val dot = Color.White.copy(alpha = 0.05f)
            when (wall) {
                "grid" -> {
                    val step = 44.dp.toPx()
                    var x = 0f
                    while (x < size.width) { drawLine(dot, Offset(x, 0f), Offset(x, size.height), 1f); x += step }
                    var y = 0f
                    while (y < size.height) { drawLine(dot, Offset(0f, y), Offset(size.width, y), 1f); y += step }
                }
                "doodle" -> {
                    val step = 60.dp.toPx()
                    var y = 0f
                    while (y < size.height) {
                        var x = 0f
                        while (x < size.width) {
                            drawCircle(dot, 6.dp.toPx() / 2, Offset(x + step / 2, y + step / 2))
                            x += step
                        }
                        y += step
                    }
                }
                else -> {
                    val rnd = kotlin.random.Random(42L)
                    for (i in 0 until 60) {
                        drawCircle(
                            dot, ((2..5).randomOrNull(rnd) ?: 3).dp.toPx(),
                            Offset(rnd.nextFloat() * size.width, rnd.nextFloat() * size.height),
                        )
                    }
                }
            }
        }, contentAlignment = Alignment.TopStart) { content() }
    }
}


// avatarColor(utils.js): стабильный цвет по нику, hsl(h 55% 42%)
fun avatarColor(seed: String): Color {
    var h = 0
    for (ch in seed) h = (h * 31 + ch.code) % 360
    return Color.hsl(h.toFloat(), 0.55f, 0.42f)
}

// initials(utils.js): 2 буквы если 2 слова
fun initials(name: String): String {
    val parts = name.trim().split(" ").filter { it.isNotBlank() }
    if (parts.size >= 2) return (parts[0][0] + parts[1][0].toString()).uppercase()
    return (parts.firstOrNull() ?: "?").take(1).uppercase()
}

@Composable
fun Avatar(name: String, dpSize: Dp, imageUrl: String? = null, presence: String? = null, circle: Boolean = false) {
    val shape = if (circle) CircleShape else RoundedCornerShape(dpSize * 0.26f) // .avatar radius 12/46
    androidx.compose.foundation.layout.BoxWithConstraints(Modifier.size(dpSize)) {
        if (imageUrl != null) {
            coil.compose.AsyncImage(
                model = imageUrl,
                contentDescription = null,
                contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                modifier = Modifier.size(dpSize).background(DarkSurface2, shape),
            )
        } else {
            Box(
                Modifier.size(dpSize).background(avatarColor(name), shape),
                contentAlignment = Alignment.Center,
            ) {
                Text(initials(name), color = Color.White, fontWeight = FontWeight.Bold, fontSize = (dpSize.value / 2.9f).sp)
            }
        }
        if (presence != null) {
            val c = when (presence) {
                "online" -> OkColor
                "away" -> Color(0xFFF5B73D)
                "dnd" -> DangerColor
                else -> MutedText
            }
            // online-dot: 12px, граница 2.5 panel
            Box(
                Modifier.size(dpSize / 3.4f).align(Alignment.BottomEnd)
                    .background(c, CircleShape)
                    .border((dpSize.value / 14f).dp, DarkSurface, CircleShape),
            )
        }
    }
}

// «онлайн / был(а) N мин назад» — как relLastSeen на сайте
fun relLastSeen(lastSeen: String?, presence: String?): String {
    if (presence == "online") return "онлайн"
    if (lastSeen.isNullOrBlank()) return "не в сети"
    val t = try {
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).parse(lastSeen.take(19))?.time ?: return "не в сети"
    } catch (_: Exception) { return "не в сети" }
    val diff = System.currentTimeMillis() - t
    val min = diff / 60000
    if (min < 1) return "был(а) только что"
    if (min < 60) return "был(а) $min мин назад"
    val h = min / 60
    if (h < 24) return "был(а) $h ч назад"
    val d = h / 24
    if (d == 1L) return "был(а) вчера"
    if (d < 30) return "был(а) $d дн назад"
    return "был(а) давно"
}

fun lastSeenShort(lastSeen: String?, presence: String?): String {
    if (presence == "online") return "онлайн"
    if (lastSeen.isNullOrBlank()) return "был(а) давно"
    val t = try {
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).parse(lastSeen.take(19))?.time ?: return "давно"
    } catch (_: Exception) { return "давно" }
    val diff = System.currentTimeMillis() - t
    val min = diff / 60000
    if (min < 1) return "только что"
    if (min < 60) return "$min мин назад"
    val h = min / 60
    if (h < 24) return "$h ч назад"
    val d = h / 24
    if (d == 1L) return "вчера"
    if (d < 30) return "$d дн назад"
    return "давно"
}

fun fmtTime(iso: String): String = try {
    val src = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).parse(iso.take(19))!!
    SimpleDateFormat("HH:mm", Locale.getDefault()).format(src)
} catch (_: Exception) { "" }

fun fmtDay(iso: String): String = try {
    val src = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).parse(iso.take(19))!!
    val today = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())
    val d = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(src)
    when (d) {
        today -> "Сегодня"
        SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(System.currentTimeMillis() - 86400000)) -> "Вчера"
        else -> SimpleDateFormat("d MMMM yyyy", newRu()).format(src)
    }
} catch (_: Exception) { "" }

private fun newRu(): java.text.DateFormatSymbols {
    val s = java.text.DateFormatSymbols(Locale.getDefault())
    s.months = arrayOf("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря")
    return s
}

fun dayKey(iso: String): String = iso.take(10)

fun fmtBytes(n: Long?): String {
    if (n == null || n <= 0) return ""
    val kb = n / 1024.0
    if (kb < 1024) return "%.0f КБ".format(kb)
    return "%.1f МБ".format(kb / 1024)
}

fun fmtDur(ms: Long?): String {
    val s = ((ms ?: 0) / 1000).toInt()
    return "%d:%02d".format(s / 60, s % 60)
}

@Composable
fun ConfirmDialog(
    title: String,
    text: String = "",
    okLabel: String = "Удалить",
    danger: Boolean = true,
    onOk: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = DarkSurface,
        titleContentColor = Color.White,
        textContentColor = MutedText,
        title = { Text(title) },
        text = { if (text.isNotEmpty()) Text(text) },
        confirmButton = {
            TextButton(onClick = onOk) {
                Text(okLabel, color = if (danger) DangerColor else accentColor(Prefs.get().accent))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Отмена", color = MutedText) } },
    )
}

fun beep() {
    try {
        val tg = android.media.ToneGenerator(android.media.AudioManager.STREAM_NOTIFICATION, 80)
        tg.startTone(android.media.ToneGenerator.TONE_PROP_BEEP, 150)
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ tg.release() }, 400)
    } catch (_: Exception) { }
}


// плотность сообщений (v19: density)
fun msgFontScale(): Float = when (Prefs.get().density) {
    "compact" -> 0.88f
    "large" -> 1.15f
    else -> 1f
}


// ---------- черновики сообщений (v19: как в Telegram) ----------
object DraftStore {
    private fun map(): MutableMap<String, String> = try {
        val m = kotlinx.serialization.json.Json.decodeFromString<Map<String, String>>(Prefs.get().drafts)
        m.toMutableMap()
    } catch (_: Exception) { mutableMapOf() }

    private fun save(m: Map<String, String>) {
        Prefs.set(mapOf("drafts" to kotlinx.serialization.json.Json.encodeToString(m)))
    }

    fun get(chatId: String): String = map()[chatId] ?: ""
    fun set(chatId: String, text: String) {
        val m = map()
        if (text.isBlank()) m.remove(chatId) else m[chatId] = text
        save(m)
    }
    fun clear(chatId: String) = set(chatId, "")
    fun anyIn(chatId: String): Boolean = get(chatId).isNotBlank()
}


// ============================================================
//  Виджеты в стиле сайта (style.css / v18.css / v20.css)
// ============================================================

// lf-chip: пилюля-фильтр списка (v18.css): panel2, 12.5px 600; on — градиент
@Composable
fun LfChip(label: String, on: Boolean, badge: Int = 0, onClick: () -> Unit) {
    Box(
        Modifier
            .then(
                if (on) Modifier.background(
                    Brush.linearGradient(listOf(accentColor(Prefs.get().accent), Accent2)),
                    RoundedCornerShape(50),
                ) else Modifier.background(DarkSurface2, RoundedCornerShape(50)),
            )
            .clickable { onClick() }
            .padding(horizontal = 13.dp, vertical = 6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(label, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold,
                color = if (on) Color.White else MutedText)
            if (badge > 0) {
                Spacer(Modifier.width(4.dp))
                Box(Modifier.background(
                    if (on) Color.White.copy(alpha = 0.25f) else DangerColor,
                    RoundedCornerShape(8.dp),
                ).padding(horizontal = 6.dp, vertical = 0.dp)) {
                    Text(if (badge > 99) "99+" else "$badge", fontSize = 10.5.sp, color = Color.White)
                }
            }
        }
    }
}

// .btn.primary: градиент, radius 10, glow
@Composable
fun PrimaryBtn(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        Modifier
            .background(
                if (enabled) Brush.linearGradient(listOf(accentColor(Prefs.get().accent), Accent2))
                else androidx.compose.ui.graphics.SolidColor(DarkSurface2),
                RoundedCornerShape(10.dp),
            )
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = 18.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, color = if (enabled) Color.White else MutedText, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
    }
}

// day-sep: пилюля-дата по центру (style.css)
@Composable
fun DaySep(text: String) {
    Box(Modifier.fillMaxWidth().padding(vertical = 6.dp), contentAlignment = Alignment.Center) {
        Text(
            text, fontSize = 11.5.sp, color = MutedText,
            modifier = Modifier.background(DarkSurface2, RoundedCornerShape(50))
                .border(1.dp, LineC, RoundedCornerShape(50))
                .padding(horizontal = 12.dp, vertical = 4.dp),
        )
    }
}

// ---------- сервер-рейл (style.css .server-rail, ширина 58 на телефоне) ----------

@Composable
fun ServerRail(
    servers: List<Chat>,
    activeChatId: String?,
    unread: Map<String, Int> = emptyMap(),
    onHome: () -> Unit,
    onServer: (Chat) -> Unit,
    onAdd: () -> Unit,
) {
    Column(
        Modifier.width(58.dp).fillMaxHeight().background(RailBg),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(10.dp))
        // rail-btn.home: градиент + логотип
        Box(
            Modifier.size(42.dp).background(
                Brush.linearGradient(listOf(accentColor(Prefs.get().accent), Accent2)),
                RoundedCornerShape(13.dp),
            ).clickable { onHome() },
            contentAlignment = Alignment.Center,
        ) { Text("✈️", fontSize = 20.sp) }
        Spacer(Modifier.height(6.dp))
        Box(Modifier.width(32.dp).height(2.dp).background(LineC, RoundedCornerShape(1.dp)))
        Spacer(Modifier.height(6.dp))
        // серверы: сквиркл 42, активный — кольцо акцента, badge непрочитанных (rail-badge)
        servers.forEach { c ->
            val active = activeChatId == c.id
            val cnt = unread[c.id] ?: 0
            Box {
                Box(
                    Modifier.size(42.dp).background(DarkSurface2, RoundedCornerShape(13.dp))
                        .then(if (active) Modifier.border(2.dp, accentColor(Prefs.get().accent), RoundedCornerShape(13.dp)) else Modifier)
                        .clickable { onServer(c) },
                    contentAlignment = Alignment.Center,
                ) {
                    if (c.avatar_url != null) {
                        coil.compose.AsyncImage(model = c.avatar_url, contentDescription = null,
                            contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                            modifier = Modifier.size(42.dp).background(DarkSurface2, RoundedCornerShape(13.dp)))
                    } else {
                        Text((c.title ?: "С").take(1).uppercase(), color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 16.sp)
                    }
                }
                if (cnt > 0) {
                    // rail-badge: 18dp круг danger, граница 2px цветом рейла
                    Box(Modifier.align(Alignment.TopEnd).offset(x = 2.dp, y = (-2).dp)
                        .size(18.dp).background(DangerColor, CircleShape)
                        .border(2.dp, RailBg, CircleShape), contentAlignment = Alignment.Center) {
                        Text(if (cnt > 9) "9+" else "$cnt", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
            Spacer(Modifier.height(6.dp))
        }
        // rail-btn.add: пунктирная рамка, зелёный ＋
        Box(
            Modifier.size(42.dp).background(Color.Transparent, RoundedCornerShape(13.dp))
                .border(1.dp, LineC, RoundedCornerShape(13.dp))
                .clickable { onAdd() },
            contentAlignment = Alignment.Center,
        ) { Text("＋", color = OkColor, fontSize = 20.sp, fontWeight = FontWeight.Bold) }
    }
}

// ---------- нижний док (v20.css .side-nav.dock) ----------

@Composable
fun Dock(
    tab: Int,
    me: Profile,
    onChats: () -> Unit,
    onFriends: () -> Unit,
    onAi: () -> Unit,
    onSaved: () -> Unit,
    onProfile: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(modifier.fillMaxWidth(), contentAlignment = Alignment.BottomCenter) {
        Row(
            Modifier.padding(start = 10.dp, end = 10.dp, bottom = 10.dp)
                .background(
                    Brush.verticalGradient(listOf(DarkSurface2.copy(alpha = 0.96f), DarkSurface.copy(alpha = 0.96f))),
                    RoundedCornerShape(28.dp),
                )
                .border(1.dp, Color.White.copy(alpha = 0.08f), RoundedCornerShape(28.dp))
                .padding(horizontal = 6.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            DockItem("💬", "Чаты", tab == 0, onChats)
            DockItem("👥", "Друзья", tab == 1, onFriends)
            // MSP AI — особая кнопка (dock .nav-ai)
            Column(horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.clickable { onAi() }.padding(horizontal = 2.dp)) {
                Box(
                    Modifier.width(52.dp).height(34.dp)
                        .background(
                            Brush.linearGradient(listOf(Color(0xFF7C5BFF), Color(0xFF5B8CFF), Color(0xFF38D6FF))),
                            RoundedCornerShape(17.dp),
                        ).then(if (tab == 2) Modifier.border(2.dp, Color.White.copy(alpha = 0.6f), RoundedCornerShape(17.dp)) else Modifier),
                    contentAlignment = Alignment.Center,
                ) { Text("✨", fontSize = 15.sp) }
                Text("MSP AI", fontSize = 10.5.sp, color = accentColor(Prefs.get().accent), fontWeight = FontWeight.Bold)
            }
            DockItem("🔖", "Избранное", false, onSaved)
            // профиль — аватар круглый 28 (dock .nav-me)
            Column(horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.clickable { onProfile() }.padding(horizontal = 2.dp)) {
                Box(Modifier.width(46.dp).height(30.dp), contentAlignment = Alignment.Center) {
                    Avatar(me.name, 28.dp, me.avatar_url, circle = true)
                }
                Text("Профиль", fontSize = 10.5.sp,
                    color = if (tab == 3) TextC else MutedText)
            }
        }
    }
}

@Composable
private fun DockItem(icon: String, label: String, active: Boolean, onClick: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.clickable { onClick() }.padding(horizontal = 2.dp)) {
        Box(
            Modifier.width(46.dp).height(30.dp)
                .background(
                    if (active) Brush.linearGradient(listOf(accentColor(Prefs.get().accent), Accent2)) else Brush.linearGradient(listOf(Color.Transparent, Color.Transparent)),
                    RoundedCornerShape(15.dp),
                ),
            contentAlignment = Alignment.Center,
        ) { Text(icon, fontSize = 14.sp) }
        Text(label, fontSize = 10.5.sp, color = if (active) TextC else MutedText)
    }
}


// icon-btn сайта: круглая 38, muted, hover фон
@Composable
fun IconBtn(symbol: String, size: Int = 18, onClick: () -> Unit) {
    Box(
        Modifier.size(38.dp).clickable { onClick() },
        contentAlignment = Alignment.Center,
    ) { Text(symbol, fontSize = size.sp, color = MutedText) }
}

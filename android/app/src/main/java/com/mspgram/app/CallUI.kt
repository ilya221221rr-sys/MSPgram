package com.mspgram.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer

// ============================================================
//  Звонки UI (calls.js): входящий экран, активный звонок
//  с видео (local+remote), кнопки 🎤📷🔄📞; голосовой канал.
// ============================================================

@Composable
fun CallOverlay(me: Profile) {
    val ctx = LocalContext.current
    val phase by Calls.state.phase.collectAsState()
    val incoming by Calls.state.incoming.collectAsState()
    val video by Calls.state.video.collectAsState()
    val micMuted by Calls.state.micMuted.collectAsState()
    val camOff by Calls.state.camOff.collectAsState()
    val status by Calls.state.statusText.collectAsState()
    val timer by Calls.state.timer.collectAsState()
    val acc = accentColor(Prefs.get().accent)

    // ---------- входящий звонок ----------
    val ring = incoming
    if (phase == "ringing-in" && ring != null) {
        Box(Modifier.fillMaxSize().background(Color(0xEE0D1220)), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Avatar(incomingName(me, ring), 96.dp, ring.avatar)
                Spacer(Modifier.size(16.dp))
                Text(incomingName(me, ring), color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                Text(if (ring.video) "📹 Видеозвонок…" else "📞 Звонит…", color = MutedText, fontSize = 14.sp)
                Spacer(Modifier.size(40.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(60.dp)) {
                    // отклонить
                    Box(Modifier.size(70.dp).background(DangerColor, CircleShape).clickable { Calls.rejectIncoming() }, contentAlignment = Alignment.Center) {
                        Text("📞", fontSize = 26.sp, color = Color.White)
                    }
                    // принять
                    Box(Modifier.size(70.dp).background(OkColor, CircleShape).clickable { Calls.acceptIncoming(ctx) }, contentAlignment = Alignment.Center) {
                        Text(if (ring.video) "📹" else "📞", fontSize = 26.sp, color = Color.White)
                    }
                }
            }
        }
        return
    }

    // ---------- активный звонок ----------
    if (phase in listOf("ringing-out", "connecting", "connected")) {
        Box(Modifier.fillMaxSize().background(Color(0xF20D1220))) {
            // удалённое видео на весь экран
            if (video && !camOff) {
                AndroidView(
                    factory = { c ->
                        SurfaceViewRenderer(c).apply {
                            init(Calls.egl.eglBaseContext, null)
                            setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
                            Calls.attachRenderers(this, null)
                        }
                    },
                    modifier = Modifier.fillMaxSize(),
                )
            }
            Column(Modifier.fillMaxSize().padding(bottom = 40.dp), verticalArrangement = Arrangement.Bottom, horizontalAlignment = Alignment.CenterHorizontally) {
                if (!(video && !camOff)) {
                    Avatar(Calls.state.remoteName.value, 90.dp, Calls.state.remoteAvatar.value)
                    Spacer(Modifier.size(10.dp))
                }
                Text(Calls.state.remoteName.value, color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                Text(
                    if (phase == "connected") fmtDur(timer * 1000L) else status.ifBlank { "Соединение…" },
                    color = MutedText, fontSize = 14.sp,
                )
                Spacer(Modifier.size(26.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                    CallBtn(if (micMuted) "🔇" else "🎤", micMuted) { Calls.toggleMic() }
                    if (video) CallBtn(if (camOff) "📴" else "📷", camOff) { Calls.toggleCam() }
                    if (video) CallBtn("🔄", false) { Calls.switchCamera() }
                    CallBtn("📞", true, danger = true) { Calls.hangup() }
                }
            }
            // своё видео маленьким окном
            if (video && !camOff) {
                AndroidView(
                    factory = { c ->
                        SurfaceViewRenderer(c).apply {
                            init(Calls.egl.eglBaseContext, null)
                            setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
                            Calls.attachRenderers(null, this)
                        }
                    },
                    modifier = Modifier.align(Alignment.TopEnd).padding(14.dp).size(110.dp, 150.dp)
                        .background(DarkSurface2, RoundedCornerShape(12.dp)),
                )
            }
        }
    }
}

@Composable
private fun CallBtn(label: String, active: Boolean, danger: Boolean = false, onClick: () -> Unit) {
    val bg = when {
        danger -> DangerColor
        active -> Color(0xFF2A3245)
        else -> accentColor(Prefs.get().accent)
    }
    Box(Modifier.size(60.dp).background(bg, CircleShape).clickable { onClick() }, contentAlignment = Alignment.Center) {
        Text(label, fontSize = 22.sp)
    }
}

private fun incomingName(me: Profile, ring: InRing): String =
    Calls.state.remoteName.value.ifBlank {
        Supa.chats.firstOrNull { it.id == ring.chatId }
            ?.members?.firstOrNull { it.user_id == ring.from }?.profiles?.name
            ?: ring.from
    }

// ---------- голосовой канал (голосовая комната сервера) ----------

@Composable
fun VoiceBar(me: Profile) {
    val members by Calls.state.voiceMembers.collectAsState()
    val acc = accentColor(Prefs.get().accent)
    Surface(color = DarkSurface2, shape = RoundedCornerShape(12.dp), modifier = Modifier.padding(10.dp)) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("🎙", fontSize = 16.sp)
                Spacer(Modifier.width(8.dp))
                Text("Голосовой канал", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.weight(1f))
                Text("Выйти", color = DangerColor, fontSize = 12.sp,
                    modifier = Modifier.clickable { Calls.leaveVoice() }.padding(4.dp))
            }
            Spacer(Modifier.size(6.dp))
            LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                items(members) { m ->
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Avatar(m.name, 40.dp, m.avatar)
                        Spacer(Modifier.size(3.dp))
                        Text(m.name, color = MutedText, fontSize = 10.sp, maxLines = 1)
                    }
                }
            }
        }
    }
}

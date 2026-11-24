package com.mspgram.app

import android.media.MediaMetadataRetriever
import android.media.MediaPlayer
import android.view.TextureView
import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.compose.ui.platform.LocalLifecycleOwner
import java.io.File
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

// ============================================================
//  Видеокружки — полный порт js/circles.js:
//  • запись: круглое превью (передняя камера зеркально), кольцо-таймер
//    до 60 сек, ✕ отмена, ● запись/стоп, 🔄 переворот камеры,
//    «Слишком короткий кружок» (<700 мс), 480p / ~0.6 Мбит/с
//  • лента: круглое видео с кольцом прогресса, бейдж оставшегося
//    времени, ▶ при паузе; тап — пуск/пауза со звуком; один за раз.
//  Хранится как видео-сообщение, имя файла начинается с «circle-».
// ============================================================

private const val CAP_MS = 60_000L

@Composable
fun CircleRecorderOverlay(
    onDone: (File, Long) -> Unit,
    onCancel: () -> Unit,
) {
    val ctx = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val acc = accentColor(Prefs.get().accent)

    var facing by remember { mutableStateOf(CameraSelector.LENS_FACING_FRONT) }
    var recording by remember { mutableStateOf<androidx.camera.video.Recording?>(null) }
    var recordingNow by remember { mutableStateOf(false) }
    var cancelled by remember { mutableStateOf(false) }
    var finished by remember { mutableStateOf(false) }
    var elapsedMs by remember { mutableStateOf(0L) }
    var outFile by remember { mutableStateOf<File?>(null) }
    var cameraProvider by remember { mutableStateOf<ProcessCameraProvider?>(null) }
    var flipTick by remember { mutableStateOf(0) }
    var err by remember { mutableStateOf("") }

    val mainExecutor = ContextCompat.getMainExecutor(ctx)

    // камера
    LaunchedEffect(Unit) {
        try {
            val future = ProcessCameraProvider.getInstance(ctx)
            future.addListener({
                try {
                    cameraProvider = future.get()
                } catch (e: Exception) {
                    err = "Камера недоступна на этом устройстве"
                }
            }, mainExecutor)
        } catch (e: Exception) {
            err = "Камера недоступна"
        }
    }

    fun finish(file: File?, durMs: Long, wasCancelled: Boolean) {
        if (finished) return
        finished = true
        recording = null
        if (file != null && !wasCancelled && durMs >= 700) {
            onDone(file, durMs)
        } else {
            file?.delete()
            if (!wasCancelled && durMs in 1..699) Calls.toastMsg("Слишком короткий кружок")
            onCancel()
        }
    }

    fun startRec() {
        val file = File(ctx.cacheDir, "circle-${System.currentTimeMillis()}.mp4")
        outFile = file
        try {
            val recorder = androidx.camera.video.Recorder.Builder()
                .setExecutor(mainExecutor)
                .setQualitySelector(androidx.camera.video.QualitySelector.from(androidx.camera.video.Quality.SD))
                .setTargetVideoEncodingBitRate(600_000) // ~0.6 Мбит/с, как на сайте
                .build()
            val pending = recorder
                .prepareRecording(ctx, androidx.camera.video.FileOutputOptions.Builder(file).build())
                .withAudioEnabled()
            recording = pending.start(mainExecutor) { ev ->
                when (ev) {
                    is androidx.camera.video.VideoRecordEvent.Status ->
                        elapsedMs = ev.recordingStats.recordedDurationNanos / 1_000_000
                    is androidx.camera.video.VideoRecordEvent.Finalize -> {
                        // реальная длительность из события, если доступна
                        val dur = try {
                            ev.recordingStats.recordedDurationNanos / 1_000_000
                        } catch (_: Exception) { elapsedMs }
                        finish(if (ev.hasError()) null else outFile, dur, cancelled)
                    }
                    else -> { }
                }
            }
            recordingNow = true
        } catch (e: Exception) {
            Calls.toastMsg("Запись видео не поддерживается этим устройством")
            finish(null, 0, true)
        }
    }

    fun stopRec() {
        try { recording?.stop() } catch (_: Exception) {
            finish(outFile, elapsedMs, cancelled)
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            try { recording?.stop() } catch (_: Exception) { }
            cameraProvider?.unbindAll()
        }
    }

    androidx.compose.ui.window.Dialog(
        onDismissRequest = { cancelled = true; stopRec() },
        properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            Modifier.fillMaxSize().background(Color(0xF2000000)),
            contentAlignment = Alignment.Center,
        ) {
            if (err.isNotEmpty()) {
                Text(err, color = Color.White)
                LaunchedEffect(Unit) { delay(1200); onCancel() }
            } else {
                // круглое превью камеры
                Box(contentAlignment = Alignment.Center) {
                    val previewView = remember { PreviewView(ctx) }
                    if (facing == CameraSelector.LENS_FACING_FRONT) previewView.scaleX = -1f

                    // привязка камеры (перепривязка при перевороте)
                    LaunchedEffect(cameraProvider, facing) {
                        val provider = cameraProvider ?: return@LaunchedEffect
                        try {
                            provider.unbindAll()
                            val preview = Preview.Builder().build()
                            preview.setSurfaceProvider(previewView.surfaceProvider)
                            provider.bindToLifecycle(
                                owner,
                                CameraSelector.Builder().requireLensFacing(facing).build(),
                                preview,
                            )
                        } catch (_: Exception) { }
                    }

                    AndroidView(
                        factory = { previewView },
                        modifier = Modifier.size(280.dp).clip(CircleShape).background(DarkSurface2),
                    )
                    // кольцо-таймер (как circ-ring / rg-fg)
                    Canvas(Modifier.size(300.dp)) {
                        val stroke = 4.dp.toPx()
                        val r = size.minDimension / 2 - stroke
                        drawCircle(Color.White.copy(alpha = 0.25f), r, style = Stroke(stroke))
                        val frac = (elapsedMs.toFloat() / CAP_MS).coerceIn(0f, 1f)
                        if (frac > 0f) {
                            drawArc(
                                if (recordingNow) DangerColor else acc,
                                startAngle = -90f, sweepAngle = 360f * frac, useCenter = false,
                                style = Stroke(stroke, cap = StrokeCap.Round),
                            )
                        }
                    }
                    // красная точка + таймер сверху (circ-top)
                    Row(
                        Modifier.align(Alignment.TopCenter).padding(top = 24.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        if (recordingNow) Box(Modifier.size(10.dp).background(DangerColor, CircleShape))
                        Text(fmtDur(elapsedMs), color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                    }
                }

                Spacer(Modifier.size(18.dp))
                Text(
                    if (!recordingNow) "Нажми красную кнопку, чтобы записать кружок (до 60 сек)"
                    else "Идёт запись… нажми ■, чтобы отправить",
                    color = MutedText, fontSize = 13.sp,
                )
                Spacer(Modifier.size(24.dp))

                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(34.dp)) {
                    // ✕ отмена
                    Box(
                        Modifier.size(52.dp).background(Color(0xFF2A3245), CircleShape).clickable {
                            cancelled = true
                            if (recordingNow) stopRec() else finish(null, 0, true)
                        },
                        contentAlignment = Alignment.Center,
                    ) { Text("✕", color = Color.White, fontSize = 19.sp) }

                    // ● запись / ■ стоп (circ-rec)
                    Box(
                        Modifier.size(76.dp).background(
                            if (recordingNow) OkColor else DangerColor, CircleShape,
                        ).clickable { if (!recordingNow) startRec() else stopRec() },
                        contentAlignment = Alignment.Center,
                    ) { Text(if (recordingNow) "■" else "●", color = Color.White, fontSize = 26.sp) }

                    // 🔄 переворот камеры (виден только до записи, как на сайте)
                    Box(
                        Modifier.size(52.dp).background(Color(0xFF2A3245), CircleShape)
                            .clickable(enabled = !recordingNow) {
                                facing = if (facing == CameraSelector.LENS_FACING_FRONT)
                                    CameraSelector.LENS_FACING_BACK else CameraSelector.LENS_FACING_FRONT
                                flipTick++
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text("🔄", fontSize = 19.sp, color = if (recordingNow) Color.Transparent else Color.White)
                    }
                }
            }
        }
    }
}

// ---------- кружок в ленте (circleHTML / vcircle) ----------

@Composable
fun CircleMessage(url: String, durMs: Long) {
    val ctx = LocalContext.current
    val acc = accentColor(Prefs.get().accent)
    var player by remember { mutableStateOf<MediaPlayer?>(null) }
    var textureReady by remember { mutableStateOf<TextureView?>(null) }
    var playing by remember { mutableStateOf(false) }
    var posMs by remember { mutableStateOf(0L) }
    var totalMs by remember { mutableStateOf(if (durMs > 0) durMs else 1L) }
    val id = url

    DisposableEffect(Unit) {
        onDispose {
            if (ChatSession.playingCircleId.value == id) ChatSession.playingCircleId.value = null
            try { player?.release() } catch (_: Exception) { }
            player = null
        }
    }
    // «один кружок за раз»: другой начал играть — останавливаем себя
    LaunchedEffect(ChatSession.playingCircleId.value) {
        if (ChatSession.playingCircleId.value != id && player != null && playing) {
            try { player?.pause() } catch (_: Exception) { }
            playing = false
        }
    }

    fun toggle() {
        if (player == null) {
            try {
                val p = MediaPlayer()
                p.setDataSource(url)
                p.prepare()
                totalMs = if (p.duration > 0) p.duration.toLong() else durMs
                textureReady?.let { tv -> tv.surfaceTexture?.let { st -> p.setSurface(android.view.Surface(st)) } }
                p.setOnCompletionListener {
                    playing = false
                    posMs = 0
                    ChatSession.playingCircleId.value = null
                }
                p.start()
                player = p
                playing = true
                ChatSession.playingCircleId.value = id
            } catch (_: Exception) { Calls.toastMsg("Не удалось воспроизвести") }
        } else if (playing) {
            try { player?.pause() } catch (_: Exception) { }
            playing = false
            ChatSession.playingCircleId.value = null
        } else {
            try { player?.start() } catch (_: Exception) { }
            playing = true
            ChatSession.playingCircleId.value = id
        }
    }

    LaunchedEffect(playing) {
        while (playing) {
            delay(100)
            try {
                val p = player ?: break
                posMs = p.currentPosition.toLong()
            } catch (_: Exception) { }
        }
    }

    val remain = ((totalMs - posMs).coerceAtLeast(0) + 999) / 1000

    Box(contentAlignment = Alignment.Center, modifier = Modifier.clickable { toggle() }) {
        // видео или кадр-превью (ffmpeg-замена: MediaMetadataRetriever, кадр на 0.1с — как #t=0.1 на сайте)
        if (playing) {
            AndroidView(
                factory = { tv ->
                    TextureView(tv).also { t ->
                        textureReady = t
                        t.surfaceTextureListener = object : android.view.TextureView.SurfaceTextureListener {
                            override fun onSurfaceTextureAvailable(st: android.graphics.SurfaceTexture, w: Int, h: Int) {
                                player?.setSurface(android.view.Surface(st))
                            }
                            override fun onSurfaceTextureSizeChanged(st: android.graphics.SurfaceTexture, w: Int, h: Int) { }
                            override fun onSurfaceTextureDestroyed(st: android.graphics.SurfaceTexture): Boolean = true
                            override fun onSurfaceTextureUpdated(st: android.graphics.SurfaceTexture) { }
                        }
                    }
                },
                modifier = Modifier.size(150.dp).clip(CircleShape).background(Color.Black),
            )
        } else {
            val thumb = remember(url) { mutableStateOf<android.graphics.Bitmap?>(null) }
            LaunchedEffect(url) {
                withContext(kotlinx.coroutines.Dispatchers.IO) {
                    try {
                        val mmr = MediaMetadataRetriever()
                        mmr.setDataSource(url, mapOf())
                        thumb.value = mmr.getFrameAtTime(100_000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                        mmr.release()
                    } catch (_: Exception) { }
                }
            }
            val bmp = thumb.value
            if (bmp != null) {
                androidx.compose.foundation.Image(
                    bitmap = androidx.compose.ui.graphics.asImageBitmap(bmp),
                    contentDescription = "Кружок",
                    contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                    modifier = Modifier.size(150.dp).clip(CircleShape).background(Color.Black),
                )
            } else {
                Box(Modifier.size(150.dp).clip(CircleShape).background(Color.Black))
            }
        }

        // кольцо прогресса (vc-ring / rg-fg): заполняется по мере проигрывания
        Canvas(Modifier.size(160.dp)) {
            val stroke = 3.dp.toPx()
            val r = size.minDimension / 2 - stroke
            drawCircle(Color.White.copy(alpha = 0.30f), r, style = Stroke(stroke))
            val frac = if (totalMs > 0) (posMs.toFloat() / totalMs).coerceIn(0f, 1f) else 0f
            drawArc(
                acc, startAngle = -90f, sweepAngle = 360f * frac, useCenter = false,
                style = Stroke(stroke, cap = StrokeCap.Round),
            )
        }
        // бейдж оставшегося времени
        Surface(color = Color(0x99000000), shape = RoundedCornerShape(20.dp),
            modifier = Modifier.align(Alignment.BottomCenter).offset(y = 0.dp)) {
            Text(fmtDur(remain * 1000), color = Color.White, fontSize = 10.sp,
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
        }
        if (!playing) {
            Text("▶", color = Color.White, fontSize = 26.sp,
                modifier = Modifier.offset(y = (-8).dp).background(Color(0x55000000), CircleShape).padding(12.dp))
        }
    }
}

// ---------- голосовые с «волнами» и прогрессом (barsHTML + voice-bars) ----------

/** Детерминированные «волны» по seed (id сообщения), как barsHTML(seed) на сайте */
fun voiceBarHeights(seed: String, count: Int = 18): List<Int> {
    var h = 2166136261L
    seed.forEach { c -> h = (h xor c.code) * 16777619L }
    return List(count) { i ->
        h = (h * 1103515245L + 12345L) and 0x7FFFFFFFL
        3 + ((h ushr (i % 13)) % 9).toInt() // высота 3..11
    }
}

@Composable
fun VoiceBars(seed: String, progress: Float) {
    val acc = accentColor(Prefs.get().accent)
    val bars = remember(seed) { voiceBarHeights(seed) }
    val onCount = (progress.coerceIn(0f, 1f) * bars.size).toInt()
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        bars.forEachIndexed { i, h ->
            Box(
                Modifier.width(3.dp).height(h.dp)
                    .background(if (i < onCount) acc else MutedText.copy(alpha = 0.55f), RoundedCornerShape(2.dp)),
            )
        }
    }
}

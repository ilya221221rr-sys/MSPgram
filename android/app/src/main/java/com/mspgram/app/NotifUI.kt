package com.mspgram.app

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

// ============================================================
//  Локальные уведомления (extras.js: notifyMention / notifyReaction)
// ============================================================

object Notifs {
    private val json = Json { ignoreUnknownKeys = true }

    fun ensureChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
            nm.createNotificationChannel(
                android.app.NotificationChannel("msgs", "Сообщения", android.app.NotificationManager.IMPORTANCE_HIGH),
            )
            nm.createNotificationChannel(
                android.app.NotificationChannel("events", "События", android.app.NotificationManager.IMPORTANCE_DEFAULT),
            )
        }
    }

    fun push(ctx: Context, title: String, body: String, chatId: String? = null) {
        try {
            ensureChannels(ctx)
            if (Build.VERSION.SDK_INT >= 33 &&
                ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) return
            val b = android.app.Notification.Builder(ctx, if (chatId != null) "msgs" else "events")
                .setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setAutoCancel(true)
            if (chatId != null) {
                val it = Intent(ctx, MainActivity::class.java).putExtra("chatId", chatId)
                b.setContentIntent(
                    PendingIntent.getActivity(ctx, chatId.hashCode(), it,
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE),
                )
            }
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
            nm.notify((chatId ?: title).hashCode(), b.build())
        } catch (_: Exception) { }
    }

    // «N лайкнул(а) твоё сообщение 👍» — как на сайте
    fun onReaction(r: ReactionRow) {
        if (r.user_id == Supa.userId) return
        if (Prefs.get().notifyReaction == false) return
        val ctx = MspApp.instance ?: return
        push(ctx, "Новая реакция", "Твоё сообщение оценили ${r.emoji}", r.message_id)
    }
}

package com.mspgram.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

// Push при ЗАКРЫТОМ приложении: сервер (send-fcm) шлёт data-сообщение
// через FCM → Android будит этот сервис → показываем уведомление.
// Компаньон: kind=message — новое сообщение, kind=call — входящий звонок.
class PushService : FirebaseMessagingService() {

    companion object {
        const val SITE_URL = "https://ilya221221rr-sys.github.io/MSPgram/"
    }

    override fun onMessageReceived(msg: RemoteMessage) {
        val d = msg.data
        val isCall = d["kind"] == "call"
        val title = d["title"] ?: (if (isCall) "Входящий звонок" else "MSPgram")
        val body = d["body"] ?: ""
        val tag = d["tag"] ?: (if (isCall) "msp-call" else "msp")

        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        val channelId = if (isCall) "calls" else "messages"
        val channelName = if (isCall) "Звонки" else "Сообщения"
        nm.createNotificationChannel(NotificationChannel(channelId, channelName, NotificationManager.IMPORTANCE_HIGH))

        // приложение-компаньон: тап открывает сайт (мессенджер живёт в браузере)
        val intent = Intent(Intent.ACTION_VIEW, android.net.Uri.parse(SITE_URL))
        intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        val pi = PendingIntent.getActivity(
            this, tag.hashCode(), intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val n = NotificationCompat.Builder(this, channelId)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(if (isCall) NotificationCompat.CATEGORY_CALL else NotificationCompat.CATEGORY_MESSAGE)
            .setVibrate(if (isCall) longArrayOf(400, 200, 400, 200, 400) else longArrayOf(200, 100, 200))
            .build()
        nm.notify(tag.hashCode(), n)
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        // привязываем токен устройства к аккаунту (если вход был выполнен)
        CoroutineScope(Dispatchers.IO).launch {
            try { Supa.registerFcm(token) } catch (_: Exception) { }
        }
    }
}

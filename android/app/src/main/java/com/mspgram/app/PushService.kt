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
class PushService : FirebaseMessagingService() {

    override fun onMessageReceived(msg: RemoteMessage) {
        val d = msg.data
        val title = d["title"] ?: "MSPgram"
        val body = d["body"] ?: ""
        val chatId = d["chatId"]
        val tag = d["tag"] ?: "msp"

        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel("messages", "Сообщения", NotificationManager.IMPORTANCE_HIGH)
        nm.createNotificationChannel(channel)

        val intent = Intent(this, MainActivity::class.java)
        if (chatId != null) intent.putExtra("chatId", chatId)
        intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        val pi = PendingIntent.getActivity(
            this,
            (chatId ?: "root").hashCode(),
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val n = NotificationCompat.Builder(this, "messages")
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVibrate(longArrayOf(200, 100, 200))
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

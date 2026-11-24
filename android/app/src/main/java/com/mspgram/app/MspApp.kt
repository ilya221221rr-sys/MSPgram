package com.mspgram.app

import android.app.Application
import org.json.JSONObject

// Application-класс: вручную инициализирует Firebase (без google-services.json).
// Значения берутся из assets/firebase-config.json — их нужно подставить
// из google-services.json твоего Firebase-проекта (см. НАСТРОЙКА-ANDROID.md).
class MspApp : Application() {
    companion object { var instance: Application? = null }
    override fun onCreate() {
        super.onCreate()
        instance = this
        try {
            val cfg = assets.open("firebase-config.json").bufferedReader().readText()
            val j = JSONObject(cfg)
            val appId = j.optString("applicationId", "")
            if (appId.contains("PLACEHOLDER")) return // push ещё не настроен — приложение работает без него
            com.google.firebase.FirebaseApp.initializeApp(
                this,
                com.google.firebase.FirebaseOptions.Builder()
                    .setApplicationId(appId)
                    .setApiKey(j.getString("apiKey"))
                    .setProjectId(j.getString("projectId"))
                    .setGcmSenderId(j.getString("senderId"))
                    .build(),
            )
        } catch (_: Exception) {
            // без Firebase приложение продолжает работать (push не придёт)
        }
    }
}

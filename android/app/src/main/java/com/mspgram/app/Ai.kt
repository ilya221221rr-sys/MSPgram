package com.mspgram.app

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

// ============================================================
//  MSP AI — как js/ai-core.js: бесплатный шлюз Pollinations
//  (OpenAI-совместимый, без ключа). Endpoint/модель можно
//  переопределить в настройках (prefs aiUrl/aiModel/aiKey).
// ============================================================

object Ai {
    const val DEFAULT_URL = "https://text.pollinations.ai/openai"
    const val DEFAULT_MODEL = "openai-fast"

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .build()
    private val json = Json { ignoreUnknownKeys = true }

    private fun url(): String = Prefs.get().aiUrl.ifBlank { DEFAULT_URL }
    private fun model(): String = Prefs.get().aiModel.ifBlank { DEFAULT_MODEL }

    private data class AiMsg(val role: String, val content: String, val image: String? = null)

    private suspend fun chat(messages: List<AiMsg>): String = withContext(Dispatchers.IO) {
        val key = Prefs.get().aiKey
        val payload = buildString {
            append("""{"model":"${model()}","messages":[""")
            append(messages.joinToString(",") { m ->
                if (m.image != null) {
                    // vision: content = [{type:text},{type:image_url}] (как ai.js)
                    """{"role":"${m.role}","content":[{"type":"text","text":${jsonStr(m.content)}},{"type":"image_url","image_url":{"url":${jsonStr(m.image)}}}]}"""
                } else {
                    """{"role":"${m.role}","content":${jsonStr(m.content)}}"""
                }
            })
            append("]}")
        }
        val rb = Request.Builder().url(url())
            .post(payload.toRequestBody("application/json".toMediaType()))
        if (key.isNotBlank()) rb.header("Authorization", "Bearer $key")
        http.newCall(rb.build()).execute().use { r ->
            val body = r.body?.string() ?: ""
            if (r.code != 200) throw Exception("ИИ недоступен (HTTP ${r.code})")
            // формат OpenAI: choices[0].message.content
            val j = json.parseToJsonElement(body).jsonObject
            val choices = j["choices"]?.jsonArray ?: throw Exception("Пустой ответ ИИ")
            val msg = (choices.first().jsonObject["message"] as? kotlinx.serialization.json.JsonObject)
            (msg?.get("content") as? kotlinx.serialization.json.JsonPrimitive)?.content
                ?: (choices.first().jsonObject["text"] as? kotlinx.serialization.json.JsonPrimitive)?.content
                ?: throw Exception("ИИ вернул пусто")
        }
    }

    /** Болтовня с ассистентом (экран MSP AI) */
    suspend fun assistant(history: List<Pair<String, String>>, userText: String, imageDataUrl: String? = null): String {
        val msgs = mutableListOf(AiMsg(
            "system",
            "Ты — MSP AI, дружелюбный умный ассистент внутри мессенджера MSPgram. " +
                "Отвечай кратко, по делу, на русском (если не попросили иначе).",
        ))
        history.takeLast(12).forEach { (role, text) -> msgs.add(AiMsg(role, text)) }
        msgs.add(AiMsg("user", userText.ifBlank { "Опиши, что на фото." }, image = imageDataUrl))
        return chat(msgs)
    }

    /** Краткий пересказ переписки (кнопка ✨ в шапке чата) */
    suspend fun summarize(chatTitle: String, msgs: List<Message>): String {
        val text = msgs.takeLast(40).joinToString("\n") { m ->
            val who = Supa.chatById(m.chat_id)?.members?.firstOrNull { it.user_id == m.sender_id }?.profiles?.name ?: "Кто-то"
            "$who: ${m.body ?: m.attachment_name ?: ""}"
        }
        return chat(listOf(
            AiMsg("system", "Ты помощник в мессенджере. Перескажи переписку в 3–5 коротких пунктах, по-русски."),
            AiMsg("user", "Чат «$chatTitle»:\n$text"),
        ))
    }

    /** Перевод сообщения (контекстное меню) */
    suspend fun translate(text: String, lang: String = "русский"): String =
        chat(listOf(
            AiMsg("system", "Переведи текст на $lang. Верни только перевод без пояснений."),
            AiMsg("user", text),
        ))

    /** Умные ответы (контекстное меню) */
    suspend fun suggestReplies(lastMsg: String): String =
        chat(listOf(
            AiMsg("system", "Предложи 3 коротких варианта ответа на сообщение, по одному в строке, без нумерации."),
            AiMsg("user", lastMsg),
        ))

    /** Помощь в написании (кнопка 🪄 в композере) */
    suspend fun helpWrite(prompt: String, draft: String): String =
        chat(listOf(
            AiMsg("system", "Ты помогаешь писать сообщения в мессенджере. Перепиши/допиши текст пользователя: грамотно, живо, в его тональности. Верни только готовое сообщение."),
            AiMsg("user", "Задание: $prompt\n\nТекущий текст: ${draft.ifBlank { "(пусто)" }}"),
        ))

    private fun jsonStr(s: String): String {
        val esc = s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
        return "\"$esc\""
    }
}

// ============================================================
//  Стикеры — те же 4 пака, что в js/stickers.js
//  attachment_type='sticker', attachment_name="<эмодзи>|<packId>"
// ============================================================

data class StickerPack(val id: String, val name: String, val items: List<String>)

object Stickers {
    val PACKS = listOf(
        StickerPack("cats", "Котики", listOf("😺", "😸", "😹", "😻", "😽", "😼", "🙀", "😿", "😾", "🐱", "🐈", "🐈‍⬛")),
        StickerPack("emotions", "Эмоции", listOf("😀", "😂", "🥹", "😍", "🤯", "😎", "🥳", "😴", "🤬", "🫠", "🤗", "🫡")),
        StickerPack("party", "Праздник", listOf("🎉", "🎊", "🥂", "🎆", "🎁", "🎂", "🕺", "💃", "✨", "🔥", "💯", "🚀")),
        StickerPack("life", "Жизнь", listOf("👍", "👎", "👋", "🙏", "💪", "🤝", "👀", "💀", "🤡", "🍕", "☕", "🌙")),
    )

    fun stickerOf(name: String): Pair<String, String> {
        val parts = name.split("|")
        return (parts.getOrNull(0) ?: "🙂") to (parts.getOrNull(1) ?: "emotions")
    }
}

// ============================================================
//  GIF — Giphy (ключ из настроек, как js/gif.js)
// ============================================================

object Giphy {
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun search(key: String, q: String, limit: Int = 24): List<String> = withContext(Dispatchers.IO) {
        val u = "https://api.giphy.com/v1/gifs/search?api_key=$key&q=${android.net.Uri.encode(q)}&limit=$limit&rating=pg"
        val r = http.newCall(Request.Builder().url(u).build()).execute()
        r.use {
            if (it.code != 200) return@use emptyList()
            val body = it.body?.string() ?: return@use emptyList()
            val arr = json.parseToJsonElement(body).jsonObject["data"]?.jsonArray ?: return@use emptyList()
            arr.mapNotNull { el ->
                val d = el.jsonObject
                val images = d["images"]?.jsonObject ?: return@mapNotNull null
                (images["fixed_width"]?.jsonObject ?: images["downsized"]?.jsonObject)
                    ?.get("url")?.jsonPrimitive?.contentOrNull
            }
        }
    }

    suspend fun trending(key: String): List<String> = withContext(Dispatchers.IO) {
        val u = "https://api.giphy.com/v1/gifs/trending?api_key=$key&limit=20&rating=pg"
        val r = http.newCall(Request.Builder().url(u).build()).execute()
        r.use {
            if (it.code != 200) return@use emptyList()
            val body = it.body?.string() ?: return@use emptyList()
            val arr = json.parseToJsonElement(body).jsonObject["data"]?.jsonArray ?: return@use emptyList()
            arr.mapNotNull { el ->
                val images = el.jsonObject["images"]?.jsonObject ?: return@mapNotNull null
                (images["fixed_width"]?.jsonObject ?: images["downsized"]?.jsonObject)
                    ?.get("url")?.jsonPrimitive?.contentOrNull
            }
        }
    }
}

// ============================================================
//  Prefs — те же пользовательские настройки, что getPrefs/setPrefs
// ============================================================

object Prefs {
    private lateinit var prefs: android.content.SharedPreferences
    fun init(ctx: android.content.Context) {
        prefs = ctx.getSharedPreferences("msp_prefs", android.content.Context.MODE_PRIVATE)
    }

    data class Data(
        val sound: Boolean = true,
        val dnd: Boolean = false,
        val notifyMention: Boolean = true,
        val notifyReaction: Boolean = true,
        val skin: String = "nova",
        val wall: String = "aurora",
        val bubble: String = "tail",
        val density: String = "cozy",
        val drafts: String = "{}",
        val annDismissed: String = "[]",
        val accent: String = "blue",
        val aiUrl: String = "",
        val aiModel: String = "",
        val aiKey: String = "",
        val giphyKey: String = "",
        val folders: List<String> = emptyList(), // JSON папок
        val lastSeenPrivacyEcho: String = "",
    )

    fun get(): Data {
        if (!Prefs::prefs.isInitialized) return Data()
        return Data(
            sound = prefs.getBoolean("sound", true),
            dnd = prefs.getBoolean("dnd", false),
            notifyMention = prefs.getBoolean("notifyMention", true),
            notifyReaction = prefs.getBoolean("notifyReaction", true),
            skin = prefs.getString("skin", "nova") ?: "nova",
            wall = prefs.getString("wall", "none") ?: "none",
            bubble = prefs.getString("bubble", "soft") ?: "soft",
            density = prefs.getString("density", "normal") ?: "normal",
            drafts = prefs.getString("drafts", "{}") ?: "{}",
            annDismissed = prefs.getString("annDismissed", "[]") ?: "[]",
            accent = prefs.getString("accent", "blue") ?: "blue",
            aiUrl = prefs.getString("aiUrl", "") ?: "",
            aiModel = prefs.getString("aiModel", "") ?: "",
            aiKey = prefs.getString("aiKey", "") ?: "",
            giphyKey = prefs.getString("giphyKey", "") ?: "",
            folders = (prefs.getString("folders", "[]") ?: "[]").let {
                try { Json.decodeFromString<List<String>>(it) } catch (_: Exception) { emptyList() }
            },
        )
    }

    fun set(patch: Map<String, Any?>) {
        if (!Prefs::prefs.isInitialized) return
        val e = prefs.edit()
        patch.forEach { (k, v) ->
            when (v) {
                is Boolean -> e.putBoolean(k, v)
                is String -> e.putString(k, v)
                is Int -> e.putInt(k, v)
            }
        }
        e.apply()
    }

    fun setFolders(list: List<String>) {
        prefs.edit().putString("folders", Json.encodeToString(list)).apply()
    }
}

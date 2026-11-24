package com.mspgram.app

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// ============================================================
//  Модели данных MSPgram (совпадают с таблицами Supabase)
// ============================================================

@Serializable
data class Profile(
    val id: String = "",
    val nickname: String = "",
    val display_name: String? = null,
    val avatar_url: String? = null,
    val bio: String? = null,
    val status_text: String? = null,
    val last_seen: String? = null,
    val is_admin: Boolean = false,
    val is_banned: Boolean = false,
    val banned_until: String? = null,
    val ban_reason: String? = null,
) {
    val name: String get() = display_name ?: nickname
}

@Serializable
data class Member(
    val chat_id: String = "",
    val user_id: String = "",
    val role: String = "member",
    val last_read_at: String? = null,
    val muted: Boolean = false,
    val pinned: Boolean = false,
    val archived: Boolean = false,
    val profiles: Profile? = null,
)

@Serializable
data class Chat(
    val id: String = "",
    val type: String = "direct",
    val title: String? = null,
    val is_saved: Boolean = false,
    val created_by: String? = null,
    val avatar_url: String? = null,
    val last_message_at: String? = null,
    val last_message_text: String? = null,
    val last_message_sender: String? = null,
    val members: List<Member> = emptyList(),
) {
    fun isSaved() = is_saved || (type == "direct" && members.size == 1)
    fun otherMember(meId: String): Profile? =
        members.firstOrNull { it.user_id != meId }?.profiles

    fun titleFor(meId: String): String = when {
        isSaved() -> "🔖 Избранное"
        type == "group" -> title ?: "Сервер"
        else -> otherMember(meId)?.name ?: "Чат"
    }
}

@Serializable
data class Channel(
    val id: String = "",
    val chat_id: String = "",
    val name: String = "общий",
)

@Serializable
data class Message(
    val id: String = "",
    val chat_id: String = "",
    val sender_id: String = "",
    val body: String? = null,
    val attachment_type: String? = null,
    val attachment_url: String? = null,
    val attachment_name: String? = null,
    val created_at: String = "",
    val edited_at: String? = null,
    val reply_to: String? = null,
    val channel_id: String? = null,
)

@Serializable
data class UnreadRow(
    val chat_id: String = "",
    val cnt: Long = 0,
)

@Serializable
data class AuthResp(
    val access_token: String? = null,
    val refresh_token: String? = null,
    val expires_in: Long = 0,
    val user: AuthUser? = null,
    val msg: String? = null,
)

@Serializable
data class AuthUser(
    val id: String = "",
    val email: String? = null,
)

// ---------- события Realtime (WebSocket) ----------

@Serializable
data class RtEvent(
    val event: String? = null,
    val topic: String? = null,
    val payload: RtPayload? = null,
)

@Serializable
data class RtPayload(
    val data: RtData? = null,
)

@Serializable
data class RtData(
    val event: String? = null,
    val table: String? = null,
    val record: JsonElement? = null,
)

// ---------- самодельная сессия (не сериализуется) ----------

data class Session(
    val access: String,
    val refresh: String,
    val expAt: Long,
)

// ---------- payload-ы запросов (типизированные) ----------

@Serializable
data class SignInBody(val email: String, val password: String)

@Serializable
data class SignUpData(val nickname: String, val display_name: String)

@Serializable
data class SignUpBody(val email: String, val password: String, val data: SignUpData)

@Serializable
data class RefreshBody(val refresh_token: String)

@Serializable
data class MsgPayload(
    val chat_id: String,
    val sender_id: String,
    val body: String? = null,
    val channel_id: String? = null,
    val attachment_type: String? = null,
    val attachment_url: String? = null,
    val attachment_name: String? = null,
    val attachment_size: Long? = null,
)

@Serializable
data class EditPayload(val body: String, val edited_at: String)

@Serializable
data class MarkReadPayload(val last_read_at: String)

@Serializable
data class FcmRegisterPayload(val p_token: String, val p_ua: String)

package com.mspgram.app

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// ============================================================
//  Модели данных — ТОЧНО как в веб-версии (js/api.js, api-v18.js)
// ============================================================

@Serializable
data class Profile(
    val id: String = "",
    val nickname: String = "",
    val display_name: String? = null,
    val avatar_url: String? = null,
    val cover_url: String? = null,
    val bio: String? = null,
    val status_text: String? = null,
    val status_emoji: String? = null,
    val presence_status: String? = null,
    val privacy_last_seen: String? = null,
    val privacy_messages: String? = null,
    val privacy_profile: String? = null,
    val last_seen: String? = null,
    val is_admin: Boolean = false,
    val is_moderator: Boolean = false,
    val is_banned: Boolean = false,
    val banned_until: String? = null,
    val ban_reason: String? = null,
    val created_at: String? = null,
) {
    val name: String get() = display_name ?: nickname
    fun isBannedNow(): Boolean = is_banned && (banned_until == null || runCatching {
        java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US)
            .parse(banned_until!!.take(19))?.time ?: 0L > System.currentTimeMillis()
    }.getOrDefault(false))
}

@Serializable
data class Member(
    val chat_id: String = "",
    val user_id: String = "",
    val role: String = "member",
    val last_read_at: String? = null,
    val last_delivered_at: String? = null,
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
    val is_public: Boolean = false,
    val created_by: String? = null,
    val avatar_url: String? = null,
    val only_admins_post: Boolean = false,
    val allow_media: Boolean = true,
    val description: String? = null,
    val pinned_message_id: String? = null,
    val last_message_at: String? = null,
    val last_message_text: String? = null,
    val last_message_sender: String? = null,
    @SerialName("chat_members") val members: List<Member> = emptyList(),
) {
    fun isSaved() = is_saved || (type == "direct" && members.size == 1)
    fun myFlags(meId: String): Member? = members.firstOrNull { it.user_id == meId }
    fun flagsPinned(meId: String): Boolean = myFlags(meId)?.pinned == true
    fun otherMember(meId: String): Profile? =
        members.firstOrNull { it.user_id != meId }?.profiles
    fun titleFor(meId: String): String = when {
        isSaved() -> "🔖 Избранное"
        type == "group" -> title ?: "Сервер"
        else -> otherMember(meId)?.name ?: "Чат"
    }
}

@Serializable
data class Channel(val id: String = "", val chat_id: String = "", val name: String = "общий")

@Serializable
data class Message(
    val id: String = "",
    val chat_id: String = "",
    val sender_id: String = "",
    val body: String? = null,
    val attachment_type: String? = null,
    val attachment_url: String? = null,
    val attachment_name: String? = null,
    val attachment_size: Long? = null,
    val duration_ms: Long? = null,
    val created_at: String = "",
    val edited_at: String? = null,
    val reply_to: String? = null,
    val forwarded_from: String? = null,
    val channel_id: String? = null,
)

@Serializable
data class ReactionRow(
    val message_id: String = "",
    val user_id: String = "",
    val emoji: String = "",
)

@Serializable
data class UnreadRow(val chat_id: String = "", val cnt: Long = 0)

// ---------- дружба (migration-9) ----------

@Serializable
data class Friendship(
    val id: String = "",
    val requester: String = "",
    val addressee: String = "",
    val status: String = "pending",
    val created_at: String? = null,
)

@Serializable
data class FriendEntry(
    val id: String = "",
    val status: String = "",
    val profile: Profile? = null,
    val created_at: String? = null,
)

// ---------- сессии ----------

@Serializable
data class SessionRow(
    val id: String = "",
    val device: String? = null,
    val user_agent: String? = null,
    val last_active: String? = null,
    val created_at: String? = null,
    val revoked: Boolean = false,
)

// ---------- объявления от админов (v19) ----------

@Serializable
data class Announcement(
    val id: String = "",
    val title: String = "",
    val body: String? = null,
    val level: String = "info",
    val created_by: String? = null,
    val created_at: String? = null,
    val expires_at: String? = null,
)

// ---------- жалобы / админ ----------

@Serializable
data class ReportRow(
    val id: String = "",
    val reporter: String = "",
    val target_profile: String = "",
    val target_message: String? = null,
    val reason: String? = null,
    val status: String = "open",
    val created_at: String? = null,
)

@Serializable
data class PublicChatRow(
    val id: String = "",
    val title: String? = null,
    val avatar_url: String? = null,
    val members: Long? = null,
)

// ---------- auth ----------

@Serializable
data class AuthResp(
    val access_token: String? = null,
    val refresh_token: String? = null,
    val expires_in: Long = 0,
    val user: AuthUser? = null,
)

@Serializable
data class AuthUser(val id: String = "", val email: String? = null)

// ---------- 2FA (supabase mfa) ----------
@Serializable
data class MfaFactor(
    val id: String = "",
    val factor_type: String = "totp",
    val status: String = "",
)

@Serializable
data class MfaChallengeBody(val factor_id: String)

@Serializable
data class MfaChallengeResp(val id: String = "")

@Serializable
data class MfaVerifyBody(val factor_id: String, val challenge_id: String, val code: String)

// ---------- realtime события (Phoenix) ----------

@Serializable
data class RtEnvelope(
    val topic: String? = null,
    val event: String? = null,
    val ref: String? = null,
    val payload: JsonObject? = null,
)

// ---------- payload-ы запросов ----------

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
    val duration_ms: Long? = null,
    val reply_to: String? = null,
    val forwarded_from: String? = null,
)

@Serializable
data class EditPayload(val body: String, val edited_at: String)

@Serializable
data class MemberFlagPayload(
    val muted: Boolean? = null,
    val pinned: Boolean? = null,
    val archived: Boolean? = null,
    val last_read_at: String? = null,
    val last_delivered_at: String? = null,
)

@Serializable
data class ProfilePatch(
    val nickname: String? = null,
    val display_name: String? = null,
    val bio: String? = null,
    val status_text: String? = null,
    val status_emoji: String? = null,
    val presence_status: String? = null,
    val privacy_last_seen: String? = null,
    val privacy_messages: String? = null,
    val privacy_profile: String? = null,
    val avatar_url: String? = null,
    val is_banned: Boolean? = null,
    val banned_until: String? = null,
    val ban_reason: String? = null,
    val is_moderator: Boolean? = null,
    val is_admin: Boolean? = null,
)

@Serializable
data class PinPayload(val pinned_message_id: String? = null)

@Serializable
data class BanPayload(
    val is_banned: Boolean,
    val ban_reason: String? = null,
    val banned_until: String? = null,
)

@Serializable
data class SessionInsert(
    val id: String,
    val user_id: String,
    val device: String,
    val user_agent: String,
)

@Serializable
data class ReportInsert(
    val reporter: String,
    val target_profile: String,
    val reason: String,
)

data class Session(
    val access: String,
    val refresh: String,
    val expAt: Long,
)

// ---------- быстрые эмодзи-реакции (как QUICK_EMOJI на сайте) ----------

val QUICK_EMOJI = listOf("👍", "❤️", "🔥", "😂", "😮", "😢", "🎉")

// статусы (как extras.js)
val PRESENCE_STATUSES = listOf(
    "online" to "🟢 В сети",
    "away" to "🟡 Отошёл",
    "dnd" to "🔴 Не беспокоить",
    "invisible" to "⚪ Невидимка",
)

// приватность (как extras.js)
val PRIVACY_OPTIONS = listOf("everyone" to "Все", "friends" to "Друзья", "nobody" to "Никто")

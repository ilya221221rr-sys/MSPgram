// ============================================================
//  Слой работы с Supabase: клиент, состояние, все запросы
// ============================================================
import { bus, uuid } from './utils.js';

// ---------- глобальное состояние приложения ----------
export const state = {
  me: null,                // мой профиль (строка из profiles)
  chats: new Map(),        // chatId -> чат с members
  activeChatId: null,      // открытый чат
  online: new Set(),       // user_id всех, кто сейчас онлайн
  unread: new Map(),       // chatId -> кол-во непрочитанных
  typing: new Map(),       // chatId -> Map(userId -> {name, until})
};

let _sb = null;
export function getSb() { return _sb; }

const isPlaceholder = (v) => !v || /ПОМЕНЯЙ|ВАШ_/.test(v);

// Конфиг: сперва js/config.js, иначе — сохранённый в localStorage (экран настройки)
export function resolveConfig() {
  const c = window.MSP_CONFIG || {};
  if (!isPlaceholder(c.supabaseUrl) && !isPlaceholder(c.supabaseAnonKey)) {
    return { supabaseUrl: String(c.supabaseUrl).trim(), supabaseAnonKey: String(c.supabaseAnonKey).trim(), fromFile: true };
  }
  try {
    const s = JSON.parse(localStorage.getItem('msp_config') || 'null');
    if (s && s.supabaseUrl && s.supabaseAnonKey) return { ...s, fromFile: false };
  } catch { /* игнорируем */ }
  return null;
}

export function saveConfig(cfg) {
  localStorage.setItem('msp_config', JSON.stringify(cfg));
}

export function initClient(cfg) {
  _sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return _sb;
}

// ---------- авторизация ----------
export const authApi = {
  async getSession() {
    const { data } = await _sb.auth.getSession();
    return data.session || null;
  },
  onAuth(cb) {
    const { data } = _sb.auth.onAuthStateChange((_event, session) => cb(session));
    return data.subscription;
  },
  async signUp(email, password, nickname, displayName) {
    return await _sb.auth.signUp({
      email,
      password,
      options: { data: { nickname, display_name: displayName || nickname } },
    });
  },
  async signIn(email, password) {
    return await _sb.auth.signInWithPassword({ email, password });
  },
  // Письмо «восстановление пароля»: после клика по ссылке откроется наш сайт
  // с формой нового пароля (событие PASSWORD_RECOVERY)
  async resetPassword(email) {
    const redirectTo = location.origin + location.pathname;
    return await _sb.auth.resetPasswordForEmail(email, { redirectTo });
  },
  // Смена пароля (в том числе после перехода по ссылке восстановления)
  async updatePassword(password) {
    return await _sb.auth.updateUser({ password });
  },
  // Повторная отправка письма подтверждения регистрации
  async resendConfirmation(email) {
    return await _sb.auth.resend({ type: 'signup', email });
  },
  async signOut() {
    await _sb.auth.signOut();
    _sb.removeAllChannels();
  },
};

// ---------- helpers ----------
export function otherMember(chat, meId = state.me?.id) {
  const m = (chat.members || []).find((x) => x.user_id !== meId);
  return m ? m.profiles : null;
}

export function chatTitleFor(chat, meId = state.me?.id) {
  if (chat.type === 'group') return chat.title || 'Группа';
  const other = otherMember(chat, meId);
  return other ? (other.display_name || `@${other.nickname}`) : 'Чат';
}

export function memberProfile(chat, userId) {
  const m = (chat.members || []).find((x) => x.user_id === userId);
  return m ? m.profiles : null;
}

function handleErr(error, fallbackMsg) {
  const e = new Error(error?.message || fallbackMsg);
  e.raw = error;
  throw e;
}

// ---------- база данных ----------
export const dbApi = {
  async loadMe(id) {
    const { data, error } = await _sb.from('profiles').select('*').eq('id', id).maybeSingle();
    if (error) handleErr(error, 'Не удалось загрузить профиль');
    return data;
  },

  // Профиль обязан существовать (его создаёт триггер), но на всякий случай — создаём сами
  async ensureMe(id) {
    let me = await this.loadMe(id);
    if (!me) {
      const nick = 'user_' + uuid().slice(0, 6);
      const { data, error } = await _sb.from('profiles')
        .insert({ id, nickname: nick, display_name: nick }).select().single();
      if (error) handleErr(error, 'Не удалось создать профиль');
      me = data;
    }
    state.me = me;
    bus.emit('me');
    return me;
  },

  async updateMe(patch) {
    const { data, error } = await _sb.from('profiles')
      .update(patch).eq('id', state.me.id).select().single();
    if (error) handleErr(error, 'Не удалось сохранить профиль');
    state.me = data;
    bus.emit('me');
    return data;
  },

  async checkNickname(nick) {
    const { data, error } = await _sb.from('profiles')
      .select('id').ilike('nickname', nick).maybeSingle();
    if (error) return false;
    return !data;
  },

  async searchUsers(q) {
    q = q.trim();
    if (!q) return [];
    const safe = q.replace(/[,()%\\]/g, ' ').trim();
    if (!safe) return [];
    const { data, error } = await _sb.from('profiles')
      .select('id,nickname,display_name,avatar_url,last_seen')
      .neq('id', state.me.id)
      .or(`nickname.ilike.%${safe}%,display_name.ilike.%${safe}%`)
      .limit(20);
    if (error) handleErr(error, 'Ошибка поиска');
    return data || [];
  },

  async loadChats() {
    const { data, error } = await _sb.from('chats')
      .select('*, chat_members(*, profiles(*))')
      .order('last_message_at', { ascending: false });
    if (error) handleErr(error, 'Не удалось загрузить чаты');
    for (const c of data || []) state.chats.set(c.id, c);
    return [...state.chats.values()];
  },

  async loadChatRow(chatId) {
    const { data, error } = await _sb.from('chats')
      .select('*, chat_members(*, profiles(*))')
      .eq('id', chatId).maybeSingle();
    if (error) handleErr(error, 'Не удалось загрузить чат');
    if (data) state.chats.set(data.id, data);
    return data;
  },

  async unreadCounts() {
    const { data, error } = await _sb.rpc('unread_counts');
    if (error) return new Map();
    const m = new Map();
    for (const r of data || []) m.set(r.chat_id, Number(r.cnt));
    return m;
  },

  async loadMessages(chatId, limit = 50) {
    const { data, error } = await _sb.from('messages')
      .select('*').eq('chat_id', chatId)
      .order('created_at', { ascending: false }).limit(limit);
    if (error) handleErr(error, 'Не удалось загрузить сообщения');
    return (data || []).slice().reverse();
  },

  async loadEarlier(chatId, beforeIso) {
    const { data, error } = await _sb.from('messages')
      .select('*').eq('chat_id', chatId)
      .lt('created_at', beforeIso)
      .order('created_at', { ascending: false }).limit(30);
    if (error) handleErr(error, 'Не удалось загрузить историю');
    return (data || []).slice().reverse();
  },

  async sendMessage(chatId, { body = '', attachment = null, replyToId = null }) {
    const row = { chat_id: chatId, sender_id: state.me.id, body };
    if (replyToId) row.reply_to = replyToId;
    if (attachment) Object.assign(row, attachment);
    const { data, error } = await _sb.from('messages').insert(row).select().single();
    if (error) handleErr(error, 'Не удалось отправить сообщение');
    return data;
  },

  async deleteMessage(id) {
    const { error } = await _sb.from('messages').delete().eq('id', id);
    if (error) handleErr(error, 'Не удалось удалить сообщение');
  },

  async markRead(chatId) {
    const { error } = await _sb.from('chat_members')
      .update({ last_read_at: new Date().toISOString() })
      .eq('chat_id', chatId).eq('user_id', state.me.id);
    if (error) console.warn('markRead:', error.message);
  },

  async startDirect(userId) {
    const { data, error } = await _sb.rpc('get_or_create_direct_chat', { other_user: userId });
    if (error) handleErr(error, 'Не удалось открыть чат');
    if (!state.chats.has(data)) await this.loadChatRow(data);
    return data;
  },

  async createGroup(title, userIds) {
    const { data: chat, error: e1 } = await _sb.from('chats')
      .insert({ type: 'group', title, created_by: state.me.id }).select().single();
    if (e1) handleErr(e1, 'Не удалось создать группу');
    const rows = [
      { chat_id: chat.id, user_id: state.me.id, role: 'owner' },
      ...userIds.map((id) => ({ chat_id: chat.id, user_id: id, role: 'member' })),
    ];
    const { error: e2 } = await _sb.from('chat_members').insert(rows);
    if (e2) handleErr(e2, 'Не удалось добавить участников');
    await this.loadChatRow(chat.id);
    return chat.id;
  },

  async addMembers(chatId, userIds) {
    const rows = userIds.map((id) => ({ chat_id: chatId, user_id: id, role: 'member' }));
    const { error } = await _sb.from('chat_members').insert(rows);
    if (error) handleErr(error, 'Не удалось добавить участников');
    await this.loadChatRow(chatId);
  },

  async leaveChat(chatId) {
    const { error } = await _sb.from('chat_members')
      .delete().eq('chat_id', chatId).eq('user_id', state.me.id);
    if (error) handleErr(error, 'Не удалось выйти из чата');
  },

  async deleteChat(chatId) {
    const { error } = await _sb.from('chats').delete().eq('id', chatId);
    if (error) handleErr(error, 'Не удалось удалить чат');
    state.chats.delete(chatId);
  },
};

// ---------- файлы (Storage) ----------
export const storeApi = {
  async uploadAvatar(file) {
    if (!/^image\//.test(file.type)) throw new Error('Нужна картинка (PNG, JPG, WEBP или GIF)');
    if (file.size > 5 * 1024 * 1024) throw new Error('Аватар должен быть не больше 5 МБ');
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const path = `${state.me.id}/${uuid()}.${ext}`;
    const { error } = await _sb.storage.from('avatars').upload(path, file, { upsert: false, cacheControl: '31536000' });
    if (error) handleErr(error, 'Не удалось загрузить аватар');
    const { data } = _sb.storage.from('avatars').getPublicUrl(path);
    return data.publicUrl;
  },

  async uploadChatFile(chatId, file, opts = {}) {
    if (file.size > 20 * 1024 * 1024) throw new Error('Файл должен быть не больше 20 МБ');
    const clean = file.name.replace(/[\\/#?&%"\']/g, '_');
    const path = `${chatId}/${uuid()}__${clean}`;
    const { error } = await _sb.storage.from('chat-files').upload(path, file, { upsert: false });
    if (error) handleErr(error, 'Не удалось загрузить файл');
    const { data } = _sb.storage.from('chat-files').getPublicUrl(path);
    let type = 'file';
    if (/^image\//.test(file.type)) type = 'image';
    else if (/^video\//.test(file.type)) type = 'video';
    const att = {
      attachment_url: data.publicUrl,
      attachment_type: type,
      attachment_name: file.name,
      attachment_size: file.size,
    };
    if (opts.durationMs) att.duration_ms = Math.round(opts.durationMs);
    return att;
  },
};

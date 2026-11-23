// ============================================================
//  MSPgram v18: расширение слоя данных (друзья, сессии, статусы,
//  права групп, доставка, поиск, починка списка чатов)
//  Все вызовы терпимы к отсутствию миграции №9 — не ломают приложение.
// ============================================================
import { getSb, state, dbApi, otherMember } from './api.js';
import { bus, getPrefs, setPrefs, uuid } from './utils.js';

const sb = () => getSb();
const fail = (error, msg) => { const e = new Error(error?.message || msg); e.raw = error; throw e; };
const MIGRATION_HINT = 'Нужно применить supabase/migration-9-v18.sql в Supabase (SQL Editor)';
const isMissing = (error) => /does not exist|schema cache|42P01|42883|not find/i.test(String(error?.message || error?.code || ''));

state.friends = state.friends || new Set();          // id принятых друзей
state.friendReqs = state.friendReqs || [];           // входящие заявки
state.presence = state.presence || new Map();        // uid -> 'online' | 'away' | 'dnd'

// ---------- ИСПРАВЛЕНИЕ: heartbeat last_seen (раньше функции не было) ----------
dbApi.touchLastSeen = async function touchLastSeen() {
  if (!state.me) return;
  const { error } = await sb().rpc('touch_last_seen');
  if (error) {
    // запасной путь: обычный update своей строки
    await sb().from('profiles').update({ last_seen: new Date().toISOString() }).eq('id', state.me.id);
  }
};

// ---------- ИСПРАВЛЕНИЕ: список чатов показывает имя и аватар собеседника ----------
// Корень бага: запрос отдавал поле chat_members, а весь код читал chat.members.
// Теперь запросы в api.js возвращают members; здесь — страховка для редких случаев.
async function repairChats(chats) {
  const me = state.me?.id;
  if (!me) return;
  const need = new Set();
  for (const c of chats) for (const m of c.members || []) if (!m.profiles) need.add(m.user_id);
  // личный чат, где собеседник «потерялся» (не вставилась вторая строка участника) —
  // берём автора чужих сообщений
  const orphan = chats.filter((c) => c.type === 'direct' && !c.is_saved
    && (c.members || []).length < 2 && c.last_message_sender && c.last_message_sender !== me);
  orphan.forEach((c) => need.add(c.last_message_sender));
  if (!need.size) return;
  const { data } = await sb().from('profiles').select('*').in('id', [...need]);
  const byId = new Map((data || []).map((p) => [p.id, p]));
  for (const c of chats) {
    for (const m of c.members || []) if (!m.profiles && byId.has(m.user_id)) m.profiles = byId.get(m.user_id);
    if (orphan.includes(c) && byId.has(c.last_message_sender)) {
      c.members = [...(c.members || []), {
        chat_id: c.id, user_id: c.last_message_sender, profiles: byId.get(c.last_message_sender), _virtual: true,
      }];
    }
  }
}

const origLoadChats = dbApi.loadChats.bind(dbApi);
dbApi.loadChats = async function loadChatsV18() {
  const res = await origLoadChats();
  try { await repairChats([...state.chats.values()]); } catch (e) { console.warn('repairChats:', e.message); }
  return res;
};
const origLoadChatRow = dbApi.loadChatRow.bind(dbApi);
dbApi.loadChatRow = async function loadChatRowV18(id) {
  const row = await origLoadChatRow(id);
  if (row) { try { await repairChats([row]); } catch { /* ignore */ } }
  return row;
};

// ---------- друзья ----------
Object.assign(dbApi, {
  async loadFriends() {
    const me = state.me.id;
    const { data, error } = await sb().from('friendships').select('*');
    if (error) { if (!isMissing(error)) console.warn('friends:', error.message); return { friends: [], incoming: [], outgoing: [] }; }
    const rows = data || [];
    const ids = [...new Set(rows.map((r) => (r.requester === me ? r.addressee : r.requester)))];
    let profs = [];
    if (ids.length) {
      const r = await sb().from('profiles').select('*').in('id', ids);
      profs = r.data || [];
    }
    const byId = new Map(profs.map((p) => [p.id, p]));
    const wrap = (r) => ({ id: r.id, status: r.status, profile: byId.get(r.requester === me ? r.addressee : r.requester), created_at: r.created_at });
    const friends = rows.filter((r) => r.status === 'accepted').map(wrap).filter((x) => x.profile);
    const incoming = rows.filter((r) => r.status === 'pending' && r.addressee === me).map(wrap).filter((x) => x.profile);
    const outgoing = rows.filter((r) => r.status === 'pending' && r.requester === me).map(wrap).filter((x) => x.profile);
    state.friends = new Set(friends.map((f) => f.profile.id));
    state.friendReqs = incoming;
    bus.emit('friends-changed');
    return { friends, incoming, outgoing };
  },
  async friendStatus(userId) {
    const me = state.me.id;
    const { data } = await sb().from('friendships').select('*')
      .or(`and(requester.eq.${me},addressee.eq.${userId}),and(requester.eq.${userId},addressee.eq.${me})`).limit(1);
    const r = data && data[0];
    if (!r) return { state: 'none' };
    if (r.status === 'accepted') return { state: 'friends', id: r.id };
    return { state: r.requester === me ? 'outgoing' : 'incoming', id: r.id };
  },
  async friendRequest(userId) {
    const { data, error } = await sb().rpc('friend_request', { target: userId });
    if (error) fail(error, isMissing(error) ? MIGRATION_HINT : 'Не удалось отправить заявку');
    await this.loadFriends();
    return data;
  },
  async friendRespond(reqId, accept) {
    const { error } = await sb().rpc('friend_respond', { req: reqId, accept });
    if (error) fail(error, 'Не удалось ответить на заявку');
    await this.loadFriends();
  },
  async friendRemove(userId) {
    const me = state.me.id;
    const { error } = await sb().from('friendships').delete()
      .or(`and(requester.eq.${me},addressee.eq.${userId}),and(requester.eq.${userId},addressee.eq.${me})`);
    if (error) fail(error, 'Не удалось удалить из друзей');
    await this.loadFriends();
  },

  // ---------- статус присутствия ----------
  async setPresenceStatus(presence_status, status_emoji) {
    const patch = { presence_status };
    if (status_emoji !== undefined) patch.status_emoji = status_emoji;
    const { data, error } = await sb().from('profiles').update(patch).eq('id', state.me.id).select().single();
    if (error) fail(error, isMissing(error) ? MIGRATION_HINT : 'Не удалось сменить статус');
    state.me = data;
    bus.emit('me');
    return data;
  },
  async savePrivacy(patch) {
    const { data, error } = await sb().from('profiles').update(patch).eq('id', state.me.id).select().single();
    if (error) fail(error, isMissing(error) ? MIGRATION_HINT : 'Не удалось сохранить приватность');
    state.me = data;
    bus.emit('me');
    return data;
  },

  // ---------- доставка ----------
  async markDelivered(chatId = null) {
    if (!state.me) return;
    let q = sb().from('chat_members').update({ last_delivered_at: new Date().toISOString() }).eq('user_id', state.me.id);
    if (chatId) q = q.eq('chat_id', chatId);
    const { error } = await q;
    if (error && !isMissing(error)) console.warn('delivered:', error.message);
  },

  // ---------- права групп ----------
  async updateChatSettings(chatId, patch) {
    const { data, error } = await sb().from('chats').update(patch).eq('id', chatId).select().single();
    if (error) fail(error, isMissing(error) ? MIGRATION_HINT : 'Не удалось сохранить настройки');
    const c = state.chats.get(chatId);
    if (c) Object.assign(c, patch);
    return data;
  },
  async setMemberRole(chatId, userId, role) {
    const { error } = await sb().from('chat_members').update({ role }).eq('chat_id', chatId).eq('user_id', userId);
    if (error) fail(error, 'Не удалось сменить роль');
    await this.loadChatRow(chatId);
  },

  // ---------- поиск ----------
  async searchPublicChats(q) {
    const { data, error } = await sb().rpc('search_public_chats', { q });
    if (!error) return data || [];
    const r = await sb().from('chats').select('id,title,avatar_url').eq('is_public', true).eq('type', 'group')
      .ilike('title', `%${q.replace(/[%_,()]/g, ' ')}%`).limit(20);
    return (r.data || []).map((c) => ({ ...c, members: null }));
  },
  async adminSetRole(userId, patch) {
    const { error } = await sb().from('profiles').update(patch).eq('id', userId);
    if (error) fail(error, isMissing(error) ? MIGRATION_HINT : 'Не удалось сменить роль');
  },
  async adminDeleteChat(chatId) {
    const { error } = await sb().from('chats').delete().eq('id', chatId);
    if (error) fail(error, 'Не удалось удалить чат');
  },

  // ---------- активные сессии ----------
  sessionId() { return localStorage.getItem('msp_sid'); },
  async registerSession() {
    const ua = navigator.userAgent || '';
    const device = guessDevice(ua);
    let sid = this.sessionId();
    if (sid) {
      const { data, error } = await sb().from('user_sessions').select('id,revoked').eq('id', sid).maybeSingle();
      if (error) return;                       // миграции нет — тихо пропускаем
      if (data && data.revoked) { await forceLogout(); return; }
      if (data) { await sb().from('user_sessions').update({ last_active: new Date().toISOString() }).eq('id', sid); return; }
    }
    sid = uuid();
    const { error } = await sb().from('user_sessions').insert({ id: sid, user_id: state.me.id, device, user_agent: ua.slice(0, 300) });
    if (!error) localStorage.setItem('msp_sid', sid);
  },
  async listSessions() {
    const { data, error } = await sb().from('user_sessions').select('*').eq('revoked', false).order('last_active', { ascending: false });
    if (error) fail(error, isMissing(error) ? MIGRATION_HINT : 'Не удалось получить сессии');
    return data || [];
  },
  async revokeSession(id) {
    const { error } = await sb().from('user_sessions').update({ revoked: true }).eq('id', id);
    if (error) fail(error, 'Не удалось завершить сессию');
  },
  async revokeOtherSessions() {
    const sid = this.sessionId();
    let q = sb().from('user_sessions').update({ revoked: true }).eq('user_id', state.me.id);
    if (sid) q = q.neq('id', sid);
    const { error } = await q;
    if (error) fail(error, 'Не удалось завершить сессии');
  },
  async endSession() {
    const sid = this.sessionId();
    if (!sid) return;
    await sb().from('user_sessions').delete().eq('id', sid);
    localStorage.removeItem('msp_sid');
  },
  async pingSession() {
    const sid = this.sessionId();
    if (!sid) return;
    const { data, error } = await sb().from('user_sessions').select('revoked').eq('id', sid).maybeSingle();
    if (error) return;
    if (data && data.revoked) { await forceLogout(); return; }
    await sb().from('user_sessions').update({ last_active: new Date().toISOString() }).eq('id', sid);
  },
});

export async function forceLogout() {
  try { localStorage.removeItem('msp_sid'); } catch { /* */ }
  const { authApi } = await import('./api.js');
  await authApi.signOut();
  const { toast } = await import('./utils.js');
  toast('Эта сессия была завершена с другого устройства');
}

function guessDevice(ua) {
  const os = /Windows/i.test(ua) ? 'Windows' : /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iOS/i.test(ua) ? 'iOS'
    : /Mac OS/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'Устройство';
  const br = /Edg\//i.test(ua) ? 'Edge' : /OPR\//i.test(ua) ? 'Opera' : /YaBrowser/i.test(ua) ? 'Яндекс' : /Chrome\//i.test(ua) ? 'Chrome'
    : /Firefox\//i.test(ua) ? 'Firefox' : /Safari\//i.test(ua) ? 'Safari' : 'Браузер';
  return `${br} · ${os}`;
}

// ---------- приватность: что можно показывать ----------
export function isFriend(userId) { return state.friends.has(userId); }

function allowed(rule, userId) {
  if (!rule || rule === 'everyone') return true;
  if (rule === 'friends') return isFriend(userId);
  return false;
}

// строка «онлайн / был(а) …» с учётом приватности и статуса присутствия
export function presenceLabel(p, relLastSeen) {
  if (!p) return '';
  const showSeen = allowed(p.privacy_last_seen, p.id) || p.id === state.me?.id;
  if (!showSeen) return 'был(а) недавно';
  const st = state.presence.get(p.id);
  if (state.online.has(p.id)) {
    if (st === 'dnd') return 'не беспокоить';
    if (st === 'away') return 'отошёл(а)';
    return 'онлайн';
  }
  return relLastSeen(p.last_seen, false);
}
export function isShownOnline(p) {
  if (!p) return false;
  const showSeen = allowed(p.privacy_last_seen, p.id) || p.id === state.me?.id;
  return showSeen && state.online.has(p.id);
}
export function presenceKind(p) {
  if (!isShownOnline(p)) return null;
  return state.presence.get(p.id) || 'online';
}
export { otherMember, getPrefs, setPrefs };

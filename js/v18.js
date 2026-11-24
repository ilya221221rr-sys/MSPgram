// ============================================================
//  MSPgram v18 «Aurora»: точка подключения новых модулей
// ============================================================
import { getSb, state, dbApi, memberProfile, chatTitleFor } from './api.js?v=26';
import './api-v18.js';
import { bus, qs, toast, getPrefs, esc, avatarHTML } from './utils.js';
import { mountIcons } from './icons.js';
import { initNotices, pushNotice, openNotifCenter } from './notify.js';
import { initAI, openAssistant } from './ai.js';
import { initGifs } from './gif.js';
import { openFriends } from './friends.js';
import { forceLogout } from './api-v18.js';
import { v19Boot, v19Enter, v19Leave } from './v19.js';

let chan = null;
let timers = [];
let wired = false;

// один раз при запуске страницы
export function v18Boot() {
  mountIcons();
  try { v19Boot(); } catch (e) { console.error('v19Boot:', e); }
  if (wired) return;
  wired = true;
  qs('#nav-friends')?.addEventListener('click', () => openFriends('friends'));
  qs('#nav-ai')?.addEventListener('click', openAssistant);
  qs('#notif-btn')?.addEventListener('click', openNotifCenter);
  qs('#nav-chats')?.addEventListener('click', () => {
    const si = qs('#search-input'); if (si) { si.value = ''; si.dispatchEvent(new Event('input')); si.blur(); }
    qs('#chat-list')?.scrollTo({ top: 0, behavior: 'smooth' });
  });
  initAI();
  initGifs();
  bus.on('friends-changed', () => {
    const b = qs('#friends-badge');
    if (b) { b.textContent = state.friendReqs.length; b.classList.toggle('hidden', !state.friendReqs.length); }
    import('./chatlist.js').then((m) => m.renderChatList());
  });
}

const throttle = new Map();
export function ackDelivered(chatId) {
  if (throttle.has(chatId)) return;
  throttle.set(chatId, setTimeout(() => { throttle.delete(chatId); dbApi.markDelivered(chatId); }, 1200));
}

// при входе в аккаунт
export async function v18Enter() {
  initNotices();
  try { v19Enter(); } catch (e) { console.warn('v19Enter:', e); }
  dbApi.loadFriends().catch(() => {});
  dbApi.registerSession().catch(() => {});
  dbApi.markDelivered().catch(() => {});
  timers.push(setInterval(() => dbApi.pingSession().catch(() => {}), 120000));
  timers.push(setInterval(() => refreshPeers().catch(() => {}), 150000));
  window.addEventListener('focus', onFocus);

  const sb = getSb();
  chan = sb.channel('msp-v18')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, (p) => onFriendship(p).catch(() => {}))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'user_sessions' }, (p) => {
      if (p.new && p.new.id === dbApi.sessionId() && p.new.revoked) forceLogout();
    })
    .subscribe();
}

export function v18Leave() {
  try { v19Leave(); } catch { /* */ }
  timers.forEach(clearInterval); timers = [];
  window.removeEventListener('focus', onFocus);
  if (chan) { getSb().removeChannel(chan).catch(() => {}); chan = null; }
}
function onFocus() { refreshPeers().catch(() => {}); dbApi.pingSession().catch(() => {}); }

async function onFriendship(p) {
  const me = state.me?.id; if (!me) return;
  const row = p.new && p.new.id ? p.new : p.old;
  await dbApi.loadFriends();
  if (p.eventType === 'INSERT' && row.addressee === me && row.status === 'pending') {
    const prof = await dbApi.loadProfile(row.requester);
    pushNotice({ kind: 'friend', title: `${prof?.display_name || prof?.nickname || 'Кто-то'} хочет дружить`, body: 'Открой «Друзья», чтобы принять заявку',
      avatarUrl: prof?.avatar_url, name: prof?.display_name || prof?.nickname, action: 'requests' });
  }
  if (p.eventType === 'UPDATE' && row.status === 'accepted' && row.requester === me) {
    const prof = await dbApi.loadProfile(row.addressee);
    pushNotice({ kind: 'friend', title: `${prof?.display_name || prof?.nickname || 'Пользователь'} принял(а) заявку`, body: 'Теперь вы друзья 🎉',
      avatarUrl: prof?.avatar_url, name: prof?.display_name || prof?.nickname });
  }
}

// периодически обновляем профили собеседников (имя, аватар, статус, приватность)
async function refreshPeers() {
  if (!state.me) return;
  const ids = new Set();
  for (const c of state.chats.values()) for (const m of c.members || []) if (m.user_id !== state.me.id) ids.add(m.user_id);
  if (!ids.size) return;
  const { data } = await getSb().from('profiles').select('*').in('id', [...ids].slice(0, 200));
  if (!data) return;
  const by = new Map(data.map((p) => [p.id, p]));
  for (const c of state.chats.values()) for (const m of c.members || []) if (by.has(m.user_id)) m.profiles = by.get(m.user_id);
  import('./chatlist.js').then((x) => x.renderChatList());
  bus.emit('presence');
}

// ---------- события, которые вызывает app.js ----------
const mentionRe = () => {
  const n = (state.me?.nickname || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return n ? new RegExp(`(?<![\\p{L}\\p{N}_])@${n}(?![\\p{L}\\p{N}_])`, 'iu') : null;
};

export function onIncomingMessage(chat, m) {
  if (m.sender_id === state.me.id) return;
  ackDelivered(m.chat_id);
  const mine = (chat.members || []).find((x) => x.user_id === state.me.id);
  const sender = memberProfile(chat, m.sender_id);
  const name = sender ? (sender.display_name || `@${sender.nickname}`) : 'Новое сообщение';
  const re = mentionRe();
  const mentioned = re && m.body && re.test(m.body);
  const watching = state.activeChatId === m.chat_id && document.hasFocus() && document.visibilityState === 'visible';
  if (watching || mine?.muted && !mentioned) return;
  if (mentioned && getPrefs().notifyMention !== false && !getPrefs()._dnd) {
    pushNotice({ kind: 'mention', title: `${name} упомянул(а) тебя`, body: m.body, avatarUrl: sender?.avatar_url, name, chatId: m.chat_id, silent: !mine?.muted });
    return;
  }
  // обычная плашка внутри приложения (если вкладка в фокусе)
  if (document.visibilityState === 'visible' && !getPrefs()._dnd) {
    const title = chat.type === 'group' ? `${chatTitleFor(chat)} · ${name}` : name;
    const body = m.body || ({ image: '📷 Фото', video: '🎥 Видео', voice: '🎤 Голосовое', file: '📎 Файл', sticker: 'Стикер' }[m.attachment_type] || '');
    toast(title, 4200, {
      kind: 'rich', onClick: () => bus.emit('open-chat', m.chat_id),
      html: `<span class="toast-ic">${avatarHTML(sender?.avatar_url, name, 'sm')}</span><span class="toast-tx"><b>${esc(title)}</b><span>${esc(body).slice(0, 110)}</span></span>`,
    });
  }
}

export async function onIncomingReaction(row) {
  if (!row || !state.me || row.user_id === state.me.id || getPrefs().notifyReaction === false) return;
  const { data } = await getSb().from('messages').select('sender_id,chat_id,body').eq('id', row.message_id).maybeSingle();
  if (!data || data.sender_id !== state.me.id) return;
  const chat = state.chats.get(data.chat_id);
  const p = chat ? memberProfile(chat, row.user_id) : null;
  const name = p ? (p.display_name || p.nickname) : 'Кто-то';
  pushNotice({ kind: 'reaction', title: `${name} отреагировал(а) ${row.emoji}`, body: data.body || 'на твоё сообщение',
    avatarUrl: p?.avatar_url, name, chatId: data.chat_id, silent: !!getPrefs()._dnd });
}

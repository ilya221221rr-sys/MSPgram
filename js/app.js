// ============================================================
//  MSPgram — точка входа: запуск, realtime, уведомления
// ============================================================
import {
  resolveConfig, saveConfig, initClient, state, dbApi, authApi, getSb, chatTitleFor, memberProfile,
} from './api.js';
import { qs, bus, toast, beep } from './utils.js';
import { initAuth, showAuth, showApp, showSetup } from './auth.js';
import { initChatListUI, renderChatList, renderSidebarMe } from './chatlist.js';
import {
  initChatViewUI, openChat, closeChat, onNewMessage, onMessageDeleted,
  onMembersUpdated, onPresenceChanged, initLightboxUI,
} from './chatview.js';
import { startPresence, stopPresence } from './presence.js';

let realtimeChan = null;
let enterPromise = null;

// ================== ЗАПУСК ==================

async function boot() {
  // 1. Конфигурация Supabase
  const cfg = resolveConfig();
  if (!cfg) {
    showSetup();
    initSetupScreen();
    return;
  }
  try {
    initClient(cfg);
  } catch (e) {
    showSetup();
    initSetupScreen(e.message);
    return;
  }

  // 2. Экраны и глобальные события
  initAuth();
  initChatListUI();
  initChatViewUI();
  initLightboxUI();
  wireBusEvents();

  // 3. Сессия
  authApi.onAuth(async (session) => {
    if (session && session.user) {
      await enterApp(session);
    } else {
      await leaveApp();
    }
  });
  const session = await authApi.getSession();
  if (session) await enterApp(session);
  else showAuth();

  // 4. Service Worker (PWA)
  if ('serviceWorker' in navigator && location.protocol === 'https:' || location.hostname === 'localhost') {
    navigator.serviceWorker.register('./service-worker.js').catch((e) => console.warn('SW:', e.message));
  }
}

// ================== ВОЙТИ В ПРИЛОЖЕНИЕ ==================

async function enterApp(session) {
  if (enterPromise) return enterPromise; // защита от двойного запуска
  enterPromise = doEnter(session).catch((e) => { enterPromise = null; throw e; });
  return enterPromise;
}

async function doEnter(session) {
  showApp();
  try {
    await dbApi.ensureMe(session.user.id);
  } catch (e) {
    toast('Ошибка профиля: ' + e.message);
    return;
  }
  renderSidebarMe();

  // чаты + непрочитанные
  try {
    await dbApi.loadChats();
    state.unread = await dbApi.unreadCounts();
    renderChatList();
  } catch (e) {
    toast('Ошибка загрузки чатов: ' + e.message);
  }

  startPresence();
  startRealtime();
  requestNotificationsOnFirstClick();
}

async function leaveApp() {
  enterPromise = null;
  state.me = null;
  state.chats.clear();
  state.unread.clear();
  state.online.clear();
  state.activeChatId = null;
  closeChat();
  renderChatList();
  stopPresence();
  stopRealtime();
  showAuth();
}

// ================== REALTIME (мгновенные события) ==================

function startRealtime() {
  if (realtimeChan) return;
  const sb = getSb();
  realtimeChan = sb.channel('msp-db')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => onDbMessage(payload.new))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, (payload) => {
      if (payload.old && payload.old.id) {
        bus.emit('message:deleted', payload.old.id);
        onMessageDeleted(payload.old.id);
      }
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_members' }, (payload) => onDbMemberUpdate(payload.new))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'chat_members' }, () => onDbMemberChange())
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chats' }, (payload) => onDbNewChat(payload.new))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'chats' }, (payload) => {
      if (payload.old && payload.old.id) {
        const had = state.chats.delete(payload.old.id);
        if (state.activeChatId === payload.old.id && had) {
          closeChat();
          toast('Чат был удалён');
        }
        renderChatList();
      }
    })
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR') {
        // переподключение через 5 секунд
        setTimeout(() => { stopRealtime(); if (state.me) startRealtime(); }, 5000);
      }
    });
}

function stopRealtime() {
  if (realtimeChan) {
    getSb().removeChannel(realtimeChan).catch(() => {});
    realtimeChan = null;
  }
}

async function onDbMessage(m) {
  const chat = state.chats.get(m.chat_id);
  if (!chat) {
    try { await dbApi.loadChatRow(m.chat_id); renderChatList(); } catch { /* нет доступа */ }
    return;
  }

  // обновить превью в списке чатов
  chat.last_message_at = m.created_at;
  chat.last_message_sender = m.sender_id;
  chat.last_message_text = m.body
    || (m.attachment_type === 'image' ? '📷 Фото' : m.attachment_type === 'file' ? '📎 Файл' : '');

  bus.emit('message:new', m);
  onNewMessage(m); // окно чата

  if (m.sender_id !== state.me.id) {
    const isActiveVisible = state.activeChatId === m.chat_id
      && document.hasFocus() && document.visibilityState === 'visible';
    if (isActiveVisible) {
      dbApi.markRead(m.chat_id);
    } else {
      state.unread.set(m.chat_id, (state.unread.get(m.chat_id) || 0) + 1);
      beep();
      showNotification(chat, m);
    }
  }
  renderChatList();
}

async function onDbMemberUpdate(row) {
  if (!row || !row.chat_id) return;
  const chat = state.chats.get(row.chat_id);
  if (chat && chat.members) {
    const mem = chat.members.find((x) => x.user_id === row.user_id);
    if (mem) mem.last_read_at = row.last_read_at;
    bus.emit('members-updated', row.chat_id);
    onMembersUpdated();
  }
}

async function onDbMemberChange() {
  // кто-то вышел или его исключили — обновляем участников
  try {
    await dbApi.loadChats();
    renderChatList();
    onMembersUpdated();
  } catch { /* игнор */ }
}

async function onDbNewChat(row) {
  if (!row || state.chats.has(row.id)) return;
  try {
    await dbApi.loadChatRow(row.id);
    renderChatList();
    const title = chatTitleFor(row);
    toast(`Новый чат: ${title}`);
  } catch { /* нет доступа — не наш чат */ }
}

// ================== УВЕДОМЛЕНИЯ ==================

function showNotification(chat, m) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const sender = memberProfile(chat, m.sender_id);
  const senderName = sender ? (sender.display_name || `@${sender.nickname}`) : 'Новое сообщение';
  const title = chat.type === 'group' ? `${chatTitleFor(chat)} · ${senderName}` : senderName;
  const body = m.body || (m.attachment_type === 'image' ? '📷 Фото' : '📎 Файл');
  try {
    const n = new Notification(title, {
      body,
      icon: 'icons/icon-192.png',
      tag: 'msp-' + m.chat_id,
    });
    n.onclick = () => {
      window.focus();
      openChat(m.chat_id);
      n.close();
    };
  } catch { /* уведомления недоступны */ }
}

function requestNotificationsOnFirstClick() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  const ask = () => {
    document.removeEventListener('click', ask);
    Notification.requestPermission().catch(() => {});
  };
  document.addEventListener('click', ask, { once: true });
}

// ================== СОБЫТИЯ ИНТЕРФЕЙСА ==================

function wireBusEvents() {
  bus.on('open-chat', (chatId) => openChat(chatId));
  bus.on('presence', () => onPresenceChanged());
  bus.on('me', () => renderSidebarMe());
}

// ================== ЭКРАН ПЕРВОНАСТРОЙКИ ==================

function initSetupScreen(prefillError) {
  const err = qs('#setup-error');
  if (prefillError && err) err.textContent = 'Не удалось подключиться: ' + prefillError;
  const form = qs('#setup-form');
  if (!form) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = qs('#setup-url').value.trim().replace(/\/+$/, '');
    const key = qs('#setup-key').value.trim();
    const errBox = qs('#setup-error');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co/i.test(url)) {
      errBox.textContent = 'URL должен быть вида https://xxxx.supabase.co';
      return;
    }
    if (key.length < 30) {
      errBox.textContent = 'Похоже, ключ скопирован не полностью.';
      return;
    }
    saveConfig({ supabaseUrl: url, supabaseAnonKey: key });
    location.reload();
  });
}

// ================== ПОЕХАЛИ ==================
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

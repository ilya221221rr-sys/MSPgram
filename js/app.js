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
  onMessageUpdated, onReactionChange, onChatUpdated, onMembersUpdated,
  onPresenceChanged, initLightboxUI,
} from './chatview.js';
import { applyPrefs } from './settings.js';
import { initCallsUI, ensureCallsReady, stopCalls } from './calls.js';
import { startPresence, stopPresence } from './presence.js';

let realtimeChan = null;
let enterPromise = null;
let pendingJoin = null;

// ================== ГЛОБАЛЬНЫЕ ОШИБКИ (чтобы видеть, что сломалось) ==================

window.addEventListener('error', (e) => {
  toast('Ошибка: ' + (e.message || 'неизвестно'), 4500);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  toast('Ошибка: ' + (r && r.message ? r.message : String(r || 'неизвестно')), 4500);
});

// ================== ЗАПУСК ==================

async function boot() {
  // 0. Пользовательские настройки внешнего вида и звука
  applyPrefs();

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
  // Каждый блок в своей защите: одна ошибка не должна ронять весь запуск
  const safe = (name, fn) => {
    try { fn(); } catch (e) { console.error(`init ${name}:`, e); toast(`Модуль ${name} не запустился: ` + e.message); }
  };
  safe('auth', initAuth);
  safe('chatlist', initChatListUI);
  safe('chatview', initChatViewUI);
  safe('lightbox', initLightboxUI);
  safe('calls', initCallsUI);
  safe('stickers', () => {}); // инициализируется внутри chatview
  wireBusEvents();

  // при изменении профиля — перерисовать чаты (имена и аватарки)
  bus.on('profile-synced', () => import('./chatlist.js').then((m) => {
    m.renderChatList();
    m.renderServerRail();
  }));

  // 3. Ссылка-приглашение (?join=КОД) — обработаем после входа
  pendingJoin = new URLSearchParams(location.search).get('join');
  if (pendingJoin) {
    history.replaceState(null, '', location.pathname);
    localStorage.setItem('msp_join', pendingJoin);
  }

  // 4. Сессия
  // Ссылка восстановления пароля содержит type=recovery — пока пользователь
  // не задал новый пароль, в приложение НЕ входим ни при каких событиях.
  const params = new URLSearchParams(location.search);
  const hashParams = new URLSearchParams(location.hash.slice(1));
  const urlError = params.has('error') || params.has('error_description')
    || hashParams.has('error') || hashParams.has('error_description');
  const isRecovery = hashParams.get('type') === 'recovery' || params.get('type') === 'recovery';
  const hasAuthCode = params.has('code');

  authApi.onAuth(async (session, event) => {
    // перешли по ссылке «восстановить пароль» — открываем форму нового пароля
    if (event === 'PASSWORD_RECOVERY') {
      showAuth('newpass');
      return;
    }
    // резервная копия сессии — чтобы вход не слетал между визитами
    if (session) {
      try {
        localStorage.setItem('msp_session_backup', JSON.stringify({
          access_token: session.access_token,
          refresh_token: session.refresh_token,
        }));
      } catch { /* */ }
    }
    if (session && session.user && !isRecovery) {
      await enterApp(session);
    } else if (!session && event === 'SIGNED_OUT') {
      try { localStorage.removeItem('msp_session_backup'); } catch { /* */ }
      await leaveApp();
    }
    // токен обновился (примерно раз в час) — realtime должен переподключиться
    // на свежем токене, иначе канал умирает молча и лайв-сообщения пропадают
    if (event === 'TOKEN_REFRESHED' && state.me && realtimeChan) {
      scheduleRejoin();
    }
  });

  // ошибка в ссылке из письма (просрочена или уже использована)
  if (urlError) {
    history.replaceState(null, '', location.pathname + location.search);
    showAuth();
    const box = qs('#login-error');
    if (box) box.textContent = 'Ссылка недействительна или уже использована. Просто войди обычным способом.';
    return;
  }

  // если в ссылке есть одноразовый код (подтверждение/восстановление) —
  // библиотека сама обменяет его, а сессию подхватит onAuthStateChange
  const session = await authApi.getSession();
  if (isRecovery) {
    showAuth('newpass'); // ждём сессию восстановления, вход блокируем до смены пароля
  } else if (session && !hasAuthCode) {
    await enterApp(session);
  } else if (!session) {
    // сессия потерялась (сброс кэша, смена ключей) — пробуем резервную копию
    let restored = false;
    try {
      const backup = JSON.parse(localStorage.getItem('msp_session_backup') || 'null');
      if (backup && backup.refresh_token && backup.access_token) {
        const { data, error } = await getSb().auth.setSession({
          access_token: backup.access_token,
          refresh_token: backup.refresh_token,
        });
        if (!error && data && data.user) restored = true;
      }
    } catch { /* обычный вход */ }
    if (!restored) showAuth();
  }

  // после смены пароля по ссылке — чистим URL и входим в приложение
  bus.on('password-updated', async () => {
    history.replaceState(null, '', location.pathname + location.search);
    const s = await authApi.getSession();
    if (s) await enterApp(s);
  });

  // 4. Service Worker (PWA) + автообновление
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./service-worker.js').catch((e) => console.warn('SW:', e.message));
    // новый SW активировался (skipWaiting) — перезагружаемся один раз, чтобы
    // пользователь всегда был на свежем коде без Ctrl+Shift+R
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (sessionStorage.getItem('msp_reloaded') !== '1') {
        sessionStorage.setItem('msp_reloaded', '1');
        location.reload();
      }
    });
    // проверка обновлений каждые 5 минут
    const bumpSw = () => navigator.serviceWorker.getRegistration()
      .then((r) => r && r.update().catch(() => {})).catch(() => {});
    bumpSw();
    setInterval(bumpSw, 300000);
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
  ensureCallsReady(); // входящие звонки: профиль готов — подписываемся

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

  // вступление по ссылке-приглашению после входа
  const joinCode = pendingJoin || localStorage.getItem('msp_join');
  pendingJoin = null;
  if (joinCode) {
    localStorage.removeItem('msp_join');
    try {
      const chatId = await dbApi.joinByInvite(joinCode);
      renderChatList();
      bus.emit('open-chat', chatId);
      const chat = state.chats.get(chatId);
      toast(`Ты вступил(а) в «${chat ? chatTitleFor(chat) : 'сервер'}» 🎉`);
    } catch (e) {
      toast('Не удалось вступить: ' + e.message, 5000);
    }
  }
}

async function leaveApp() {
  enterPromise = null;
  stopCalls();
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
  // защита: ошибка в одном обработчике не должна ронять весь поток событий
  const rt = (fn) => (...args) => {
    try { const r = fn(...args); if (r && typeof r.catch === 'function') r.catch((e) => console.error('[rt]', e)); } catch (e) { console.error('[rt]', e); }
  };
  realtimeChan = sb.channel('msp-db')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, rt((p) => onDbMessage(p.new)))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, rt((p) => {
      if (p.new) {
        bus.emit('message:updated', p.new);
        onMessageUpdated(p.new);
      }
    }))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, rt((p) => {
      if (p.old && p.old.id) {
        bus.emit('message:deleted', p.old.id);
        onMessageDeleted(p.old.id);
      }
    }))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'reactions' }, rt((p) => onReactionChange(p, false)))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'reactions' }, rt((p) => onReactionChange(p, true)))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chats' }, rt((p) => {
      if (p.new) {
        onChatUpdated(p.new);
        renderChatList();
      }
    }))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_members' }, rt((p) => onDbMemberUpdate(p.new)))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'chat_members' }, rt(() => onDbMemberChange()))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chats' }, rt((p) => onDbNewChat(p.new)))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'chats' }, rt((p) => {
      if (p.old && p.old.id) {
        const had = state.chats.delete(p.old.id);
        if (state.activeChatId === p.old.id && had) {
          closeChat();
          toast('Чат был удалён');
        }
        renderChatList();
      }
    }))
    .subscribe((status) => {
      console.info('[realtime]', status);
      if (status === 'SUBSCRIBED') { rtRetries = 0; return; }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        scheduleRejoin();
      }
    });
}

// ---------- автовоссоединение realtime ----------
let rtRetries = 0;
let rtRejoinTimer = null;
let rtRejoinInFlight = false;

async function rejoinRealtime() {
  if (!state.me || rtRejoinInFlight) return;
  rtRejoinInFlight = true;
  const sb = getSb();
  if (realtimeChan) {
    const old = realtimeChan;
    realtimeChan = null;
    try { await sb.removeChannel(old); } catch { /* уже удалён */ }
  }
  rtRejoinInFlight = false;
  if (!state.me) return;
  startRealtime();
}

function scheduleRejoin() {
  rtRetries += 1;
  if (rtRetries === 3) toast('Связь realtime пропала — переподключаюсь…');
  if (rtRejoinTimer) return;
  const delay = Math.min(3000 * rtRetries, 10000);
  rtRejoinTimer = setTimeout(() => {
    rtRejoinTimer = null;
    rejoinRealtime();
  }, delay);
}

// watchdog: раз в 30 сек проверяем, жив ли канал
setInterval(() => {
  if (!state.me) return;
  if (rtRejoinInFlight || rtRejoinTimer) return;
  if (!realtimeChan || ['closed', 'errored'].includes(realtimeChan.state)) {
    scheduleRejoin();
  }
}, 30000);

function stopRealtime() {
  if (realtimeChan) {
    getSb().removeChannel(realtimeChan).catch(() => {});
    realtimeChan = null;
  }
}

async function onDbMessage(m) {
  if (!state.me) return; // вышли из аккаунта — события игнорируем
  const chat = state.chats.get(m.chat_id);
  if (!chat) {
    try { await dbApi.loadChatRow(m.chat_id); renderChatList(); } catch { /* нет доступа */ }
    return;
  }

  // обновить превью в списке чатов
  chat.last_message_at = m.created_at;
  chat.last_message_sender = m.sender_id;
  chat.last_message_text = m.body
    || ({ image: '📷 Фото', video: '🎥 Видеосообщение', voice: '🎤 Голосовое сообщение', file: '📎 Файл' }[m.attachment_type] || '');

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
  const body = m.body
    || ({ image: '📷 Фото', video: '🎥 Видеосообщение', voice: '🎤 Голосовое сообщение', file: '📎 Файл' }[m.attachment_type] || '');
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

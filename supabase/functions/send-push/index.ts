// ============================================================
//  MSPgram v22 — Edge Function «send-push»: настоящий Web Push
//
//  Вызывается тремя способами:
//   1) Триггер БД на таблице messages (заголовок x-webhook-secret) → push о новом сообщении
//   2) Приложение при исходящем звонке (JWT пользователя)          → push «звонит…»
//   3) Приложение из Настроек (JWT пользователя)                   → тестовый push себе
//  v23: {type:'diag'} — проверка настроек (для окна «Диагностика push»)
//  Плюс {type:'vapid'} — отдаёт публичный VAPID-ключ (приложению не нужно его вписывать).
//
//  Секреты (Edge Functions → Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:you@mail.com), PUSH_WEBHOOK_SECRET
//  SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY Supabase подставляет сам.
//
//  Деплой: функция должна быть БЕЗ проверки JWT на входе (проверка выполняется внутри):
//   supabase functions deploy send-push --no-verify-jwt
//   (в панели: Edge Functions → send-push → Details → выключить «Verify JWT»)
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC = (Deno.env.get('VAPID_PUBLIC_KEY') || '').trim();
const VAPID_PRIVATE = (Deno.env.get('VAPID_PRIVATE_KEY') || '').trim();
const VAPID_SUBJECT = (Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com').trim();
const WEBHOOK_SECRET = (Deno.env.get('PUSH_WEBHOOK_SECRET') || '').trim();

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

let vapidReady = false;
try {
  if (VAPID_PUBLIC && VAPID_PRIVATE) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    vapidReady = true;
  }
} catch (e) {
  console.error('VAPID init failed:', (e as Error).message);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

type Payload = {
  kind: 'message' | 'call' | 'test';
  title: string;
  body: string;
  tag: string;
  chatId?: string | null;
  callId?: string | null;
};

const ATTACH_LABEL: Record<string, string> = {
  image: '📷 Фото', video: '🎥 Видеосообщение', voice: '🎤 Голосовое сообщение', file: '📎 Файл',
  sticker: 'Стикер', gif: 'GIF',
};

function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function userFromRequest(req: Request) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

/** Отправка push всем устройствам указанных пользователей. Мёртвые подписки удаляются. */
async function sendTo(userIds: string[], payload: Payload, opts: { ttl: number; urgency: 'very-low' | 'low' | 'normal' | 'high' }) {
  if (!userIds.length) return { sent: 0, failed: 0, devices: 0 };
  const { data: subs, error } = await admin
    .from('push_subscriptions').select('id, endpoint, p256dh, auth').in('user_id', userIds);
  if (error) throw error;
  const text = JSON.stringify(payload);
  const dead: number[] = [];
  let sent = 0;
  let failed = 0;
  await Promise.all((subs || []).map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        text,
        { TTL: opts.ttl, urgency: opts.urgency },
      );
      sent++;
    } catch (e) {
      failed++;
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) dead.push(s.id);
      else console.warn('push error', code, (e as Error).message);
    }
  }));
  if (dead.length) await admin.from('push_subscriptions').delete().in('id', dead);
  return { sent, failed, devices: subs?.length || 0 };
}

/** Кому из участников чата можно слать: не заглушившие чат и не заблокировавшие отправителя */
async function recipientsOf(chatId: string, senderId: string) {
  const { data: members } = await admin
    .from('chat_members').select('user_id, muted').eq('chat_id', chatId).neq('user_id', senderId);
  let ids = (members || []).filter((m) => !m.muted).map((m) => m.user_id as string);
  if (!ids.length) return ids;
  const { data: blocks } = await admin
    .from('blocks').select('blocker').eq('blocked', senderId).in('blocker', ids);
  const blockedBy = new Set((blocks || []).map((b) => b.blocker as string));
  ids = ids.filter((id) => !blockedBy.has(id));
  return ids;
}

async function nameOf(userId: string) {
  const { data } = await admin.from('profiles').select('display_name, nickname').eq('id', userId).maybeSingle();
  return data?.display_name || (data?.nickname ? '@' + data.nickname : 'Кто-то');
}

// ---------- 1. новое сообщение (из триггера БД) ----------
async function handleMessage(messageId: string) {
  const { data: m } = await admin.from('messages')
    .select('id, chat_id, sender_id, body, attachment_type, attachment_name').eq('id', messageId).maybeSingle();
  if (!m) return { skipped: 'no message' };

  // записи о звонках: пушим только пропущенные/отменённые (остальное — шум)
  const isCall = m.attachment_type === 'call';
  if (isCall) {
    const outcome = String(m.attachment_name || '').split(':')[0];
    if (outcome !== 'missed' && outcome !== 'cancelled') return { skipped: 'call log' };
  }

  const { data: chat } = await admin.from('chats').select('id, type, title').eq('id', m.chat_id).maybeSingle();
  if (!chat) return { skipped: 'no chat' };

  const ids = await recipientsOf(chat.id, m.sender_id);
  if (!ids.length) return { skipped: 'no recipients' };

  const sender = await nameOf(m.sender_id);
  const title = chat.type === 'group' ? `${chat.title || 'Группа'} · ${sender}` : sender;
  const body = String(m.body || ATTACH_LABEL[m.attachment_type] || (isCall ? '📞 Пропущенный звонок' : 'Новое сообщение')).slice(0, 160);

  return await sendTo(ids, { kind: 'message', title, body, tag: 'msp-' + chat.id, chatId: chat.id },
    { ttl: 60 * 60 * 24, urgency: 'high' });
}

// ---------- 2. входящий звонок (из приложения звонящего) ----------
async function handleCall(userId: string, b: { chatId?: string; callId?: string; video?: boolean }) {
  if (!b.chatId) return { error: 'chatId required' };
  const { data: me } = await admin.from('chat_members').select('user_id')
    .eq('chat_id', b.chatId).eq('user_id', userId).maybeSingle();
  if (!me) return { error: 'not a member' };
  const { data: chat } = await admin.from('chats').select('type').eq('id', b.chatId).maybeSingle();
  if (!chat || chat.type !== 'direct') return { skipped: 'only direct calls' };

  const ids = await recipientsOf(b.chatId, userId);
  if (!ids.length) return { skipped: 'no recipients' };

  // «звонок» живёт недолго: через 45 сек старый push уже не нужен
  const who = await nameOf(userId);
  return await sendTo(ids, {
    kind: 'call',
    title: b.video ? `📹 ${who} звонит (видео)` : `📞 ${who} звонит`,
    body: 'Открой MSPgram, чтобы ответить',
    tag: 'msp-call', chatId: b.chatId, callId: b.callId || null,
  }, { ttl: 45, urgency: 'high' });
}

// ---------- 3. тест ----------
async function handleTest(userId: string) {
  return await sendTo([userId], {
    kind: 'test', title: 'MSPgram', body: 'Push с сервера работает ✓ Это уведомление пришло, даже если приложение закрыто',
    tag: 'msp-test',
  }, { ttl: 300, urgency: 'normal' });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  let body: Record<string, unknown> = {};
  if (req.method === 'POST') {
    try { body = await req.json(); } catch { body = {}; }
  }
  const type = String(body.type || (req.method === 'GET' ? 'vapid' : ''));

  try {
    // публичный ключ — не секрет
    if (type === 'vapid') return json({ publicKey: VAPID_PUBLIC, ready: vapidReady });

    // v23: диагностика для окна «Диагностика push» (нужен вход в аккаунт)
    if (type === 'diag') {
      const u = await userFromRequest(req);
      if (!u) return json({ error: 'unauthorized' }, 401);
      const { data: st } = await admin.from('push_settings').select('key, value');
      const cfg: Record<string, string> = Object.fromEntries((st || []).map((r) => [r.key as string, r.value as string]));
      const { count } = await admin.from('push_subscriptions').select('*', { count: 'exact', head: true }).eq('user_id', u.id);
      return json({
        vapid: vapidReady,
        secretSet: !!WEBHOOK_SECRET,
        urlSet: !!cfg.function_url,
        dbSecretSet: !!cfg.webhook_secret,
        secretMatches: safeEqual(cfg.webhook_secret || '', WEBHOOK_SECRET),
        urlLooksOk: (cfg.function_url || '').includes('/functions/v1/send-push'),
        myDevices: count || 0,
      });
    }

    if (!vapidReady) return json({ error: 'VAPID-ключи не настроены в секретах функции' }, 500);

    if (type === 'message') {
      if (!safeEqual(req.headers.get('x-webhook-secret') || '', WEBHOOK_SECRET)) return json({ error: 'forbidden' }, 403);
      return json(await handleMessage(String(body.message_id || '')));
    }

    const user = await userFromRequest(req);
    if (!user) return json({ error: 'unauthorized' }, 401);

    if (type === 'call') return json(await handleCall(user.id, body as { chatId?: string; callId?: string; video?: boolean }));
    if (type === 'test') return json(await handleTest(user.id));
    return json({ error: 'unknown type' }, 400);
  } catch (e) {
    console.error('send-push error:', (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});

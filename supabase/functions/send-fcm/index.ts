// ============================================================
//  Edge Function «send-fcm»: push для нативного Android (FCM v1)
//
//  Вызывается:
//   1) Триггером БД (x-webhook-secret)   { type:'message', message_id }
//   2) Проверкой из workflow             { type:'ping' }
//
//  Секреты Edge Functions:
//   FCM_SERVICE_ACCOUNT_JSON — содержимое JSON-ключа сервисного аккаунта
//                              Firebase (Project settings → Service accounts)
//   FCM_WEBHOOK_SECRET       — та же строка, что в push_settings.fcm_webhook_secret
//
//  Деплой: supabase functions deploy send-fcm --no-verify-jwt
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SA_JSON = (Deno.env.get('FCM_SERVICE_ACCOUNT_JSON') || '').trim();
const WEBHOOK_SECRET = (Deno.env.get('FCM_WEBHOOK_SECRET') || '').trim();

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- OAuth-токен Google из сервисного аккаунта (RS256 JWT) ----------

let cachedToken: { token: string; exp: number } | null = null;

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  if (!SA_JSON) throw new Error('FCM_SERVICE_ACCOUNT_JSON не задан');
  const sa = JSON.parse(SA_JSON);
  const pem: string = sa.private_key
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  const raw = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8', raw,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign'],
  );
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(new TextEncoder().encode(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${claims}`));
  const jwt = `${head}.${claims}.${b64url(new Uint8Array(sig))}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!resp.ok) throw new Error(`OAuth failed: HTTP ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  cachedToken = { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.token;
}

async function fcmSend(projectId: string, token: string, payload: Record<string, unknown>): Promise<boolean> {
  const access = await getAccessToken();
  const resp = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${access}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: { token, ...payload } }),
  });
  if (!resp.ok) console.error('FCM error', resp.status, await resp.text());
  return resp.ok;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  let body: { type?: string; message_id?: string } = {};
  try { body = await req.json(); } catch { /* пустое тело */ }
  const secret = req.headers.get('x-webhook-secret') || '';

  const saOk = !!SA_JSON && SA_JSON.includes('private_key') && SA_JSON.includes('project_id');
  const projectId = saOk ? JSON.parse(SA_JSON).project_id : '';

  // ping — проверка из workflow/диагностики
  if (body.type === 'ping') {
    return json({
      ready: saOk && !!WEBHOOK_SECRET,
      hasServiceAccount: saOk,
      hasWebhookSecret: !!WEBHOOK_SECRET,
      project: projectId,
    });
  }

  // call — пуш о входящем звонке. Вызывается САЙТОМ от имени пользователя
  // (Authorization: Bearer <JWT>), поэтому стоит ДО проверки webhook-секрета.
  if (body.type === 'call') {
    try {
      const auth = req.headers.get('Authorization') || '';
      const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!jwt) return json({ error: 'unauthorized' }, 401);
      const { data: udata, error: uerr } = await admin.auth.getUser(jwt);
      if (uerr || !udata?.user) return json({ error: 'unauthorized' }, 401);
      const callerId = udata.user.id;
      const to = String(body.to_user_id || '');
      if (!to || to === callerId) return json({ error: 'bad to_user_id' }, 400);

      // отправитель и получатель должны состоять в одном общем чате
      const { data: shared } = await admin.from('chat_members')
        .select('chat_id, user_id').in('user_id', [callerId, to]);
      const mine = new Set((shared || []).filter((x: { user_id: string }) => x.user_id === callerId).map((x: { chat_id: string }) => x.chat_id));
      const hasCommon = (shared || []).some((y: { user_id: string; chat_id: string }) => y.user_id === to && mine.has(y.chat_id));
      if (!hasCommon) return json({ error: 'no shared chat' }, 403);

      const { data: tokens } = await admin.from('fcm_tokens').select('token').eq('user_id', to);
      if (!tokens || !tokens.length) return json({ sent: 0 });

      const payload = {
        data: {
          kind: 'call',
          title: '📞 Входящий звонок',
          body: String(body.caller_name || ''),
          chatId: '',
          tag: `msp-call-${to}`,
        },
        android: { priority: 'HIGH', ttl: '30s' },
      };
      let sent = 0;
      await Promise.all(tokens.map(async (t: { token: string }) => {
        try { if (await fcmSend(projectId, t.token, payload)) sent++; } catch { /* устройство не должно ронять остальные */ }
      }));
      return json({ sent, devices: tokens.length });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  }

  if (!WEBHOOK_SECRET || !safeEqual(secret, WEBHOOK_SECRET)) {
    return json({ error: 'bad webhook secret' }, 403);
  }
  if (!saOk) return json({ error: 'FCM_SERVICE_ACCOUNT_JSON не задан' }, 500);

  try {
    if (body.type === 'message' && body.message_id) {
      const { data: msg, error: e1 } = await admin.from('messages')
        .select('id, chat_id, sender_id, body, attachment_type, created_at')
        .eq('id', body.message_id).maybeSingle();
      if (e1 || !msg) return json({ error: 'message not found' }, 404);

      const { data: members } = await admin.from('chat_members')
        .select('user_id, muted').eq('chat_id', msg.chat_id).neq('user_id', msg.sender_id);
      const recipients = (members || []).filter((m: { muted?: boolean }) => !m.muted).map((m: { user_id: string }) => m.user_id);
      if (!recipients.length) return json({ sent: 0 });

      const { data: tokens } = await admin.from('fcm_tokens')
        .select('token').in('user_id', recipients);
      if (!tokens || !tokens.length) return json({ sent: 0, devices: 0 });

      const senderRow = await admin.from('profiles')
        .select('display_name, nickname').eq('id', msg.sender_id).maybeSingle();
      const senderName = senderRow.data?.display_name || senderRow.data?.nickname || 'Новое сообщение';
      const chatRow = await admin.from('chats')
        .select('type, title').eq('id', msg.chat_id).maybeSingle();
      const isGroup = chatRow.data?.type === 'group';
      const label = isGroup ? `${chatRow.data?.title || 'Сервер'} · ${senderName}` : senderName;
      const bodyText = msg.body
        || ({ image: '📷 Фото', video: '🎥 Видео', voice: '🎤 Голосовое', file: '📎 Файл', sticker: 'Стикер' } as Record<string, string>)[msg.attachment_type || '']
        || '';

      const payload = {
        data: {
          title: label,
          body: bodyText,
          chatId: msg.chat_id,
          tag: `msp-${msg.chat_id}`,
          kind: 'message',
        },
        android: { priority: 'HIGH', ttl: '3600s' },
      };

      let sent = 0;
      await Promise.all(tokens.map(async (t: { token: string }) => {
        try { if (await fcmSend(projectId, t.token, payload)) sent++; } catch { /* одно устройство не должно ронять остальные */ }
      }));
      return json({ sent, devices: tokens.length });
    }

    return json({ error: 'unknown type' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

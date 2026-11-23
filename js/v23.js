// ============================================================
//  MSPgram v23 «Always On»
//  • Диагностика push: показывает, на каком шаге сломана доставка при закрытом приложении
//  • Автопереподписка на push при каждом возвращении в приложение
//  • Админ: нормальное окно «Имя и юзернейм» (вместо window.prompt, который в APK не работает)
// ============================================================
import { getSb, state } from './api.js';
import { qs, esc, el, toast } from './utils.js';
import { pushSupported, subscribePush, sendTestPush, syncPushSilently } from './webpush.js';

export const VERSION = 'v23';
let booted = false;

// ---------- 1. автопереподписка ----------
let lastSync = 0;
function resync() {
  const now = Date.now();
  if (now - lastSync < 60000) return;   // не чаще раза в минуту
  lastSync = now;
  syncPushSilently();
}

export function v23Boot() {
  window.MSP_VERSION = VERSION;
  const v = document.querySelector('#app-version');
  if (v) v.textContent = VERSION;
  if (booted) return;
  booted = true;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.me) resync(); });
  window.addEventListener('online', () => { if (state.me) resync(); });
}

// ---------- 2. диагностика push ----------
const OK = '✅', BAD = '❌', WARN = '⚠️';

function isWebView() {
  const ua = navigator.userAgent || '';
  return /; wv\)/.test(ua);
}
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function statusHint(code) {
  if (code == null) return 'ответа ещё нет';
  if (code >= 200 && code < 300) return 'ОК';
  if (code === 401) return 'у функции включён «Verify JWT» — выключи его (Edge Functions → send-push → Details)';
  if (code === 403) return 'секрет в SQL (push_settings) и PUSH_WEBHOOK_SECRET не совпадают';
  if (code === 404) return 'функция send-push не задеплоена или неверный function_url';
  if (code >= 500) return 'ошибка в функции — проверь секреты VAPID и логи функции';
  return 'неожиданный ответ';
}

async function runChecks() {
  const rows = [];
  const add = (ok, title, text) => rows.push({ ok, title, text });
  const sb = getSb();

  if (!pushSupported()) {
    add(false, 'Браузер', 'Не поддерживает Web Push. На iPhone добавь сайт «На экран Домой» (iOS 16.4+).');
    return rows;
  }
  if (isWebView()) {
    add(false, 'Оболочка приложения', 'Похоже, это APK-обёртка (WebView). В ней Web Push не работает вообще — так устроен Android. Открой сайт в Chrome и нажми «Установить приложение», либо собери APK через PWABuilder / Bubblewrap (TWA).');
  } else {
    add(true, 'Оболочка', isStandalone() ? 'Установлено как приложение (PWA)' : 'Обычная вкладка браузера — надёжнее «Установить приложение»');
  }

  const perm = Notification.permission;
  add(perm === 'granted', 'Разрешение на уведомления',
    perm === 'granted' ? 'Выдано' : perm === 'denied' ? 'Заблокировано — разреши в настройках сайта/приложения Android' : 'Ещё не выдано — нажми «Подключить»');

  let reg = null;
  try {
    reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 5000))]);
  } catch { /* */ }
  add(!!reg, 'Service Worker', reg ? 'Запущен' : 'Не запущен — закрой приложение полностью и открой снова');

  let sub = null;
  try { sub = reg ? await reg.pushManager.getSubscription() : null; } catch { /* */ }
  add(!!sub, 'Подписка устройства', sub ? 'Есть (' + new URL(sub.endpoint).host + ')' : 'Нет — нажми «Подключить»');

  let fn = null;
  try {
    const { data, error } = await sb.functions.invoke('send-push', { body: { type: 'vapid' } });
    if (error) throw error;
    fn = data;
  } catch (e) {
    add(false, 'Функция send-push', 'Недоступна: не задеплоена, либо включён Verify JWT. ' + (e && e.message ? '(' + e.message + ')' : ''));
  }
  if (fn) {
    add(!!fn.ready, 'Ключи VAPID на сервере', fn.ready ? 'Заданы' : 'Не заданы: добавь VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY в Edge Functions → Secrets');
    try {
      const { data, error } = await sb.functions.invoke('send-push', { body: { type: 'diag' } });
      if (error || !data || data.error) throw new Error('old');
      add(data.secretSet, 'Секрет PUSH_WEBHOOK_SECRET', data.secretSet ? 'Задан в секретах функции' : 'Не задан в секретах функции');
      add(data.urlSet && data.dbSecretSet, 'Настройки в базе (push_settings)',
        data.urlSet && data.dbSecretSet ? 'function_url и webhook_secret записаны' : 'Не записаны — выполни SQL-запрос insert into push_settings (см. UPDATE-v23.md)');
      if (data.secretSet && data.dbSecretSet) {
        add(data.secretMatches, 'Секреты совпадают', data.secretMatches ? 'Да' : 'НЕТ — секрет в SQL отличается от PUSH_WEBHOOK_SECRET. Из-за этого сообщения молча не отправляются.');
      }
      add(data.myDevices > 0, 'Мои устройства на сервере', data.myDevices > 0 ? 'Подключено: ' + data.myDevices : 'Ни одного — нажми «Подключить»');
    } catch {
      add(null, 'Расширенная проверка', 'Обнови функцию send-push до версии v23 (supabase/functions/send-push/index.ts)');
    }
  }

  try {
    const { data, error } = await sb.rpc('push_diag');
    if (error) throw error;
    add(!!data.pg_net, 'Расширение pg_net', data.pg_net ? 'Включено' : 'Нет — выполни migration-11-webpush.sql');
    add(!!data.trigger, 'Триггер на новые сообщения', data.trigger ? 'Есть' : 'Нет — выполни migration-11-webpush.sql');
    if (Array.isArray(data.last_calls)) {
      if (!data.last_calls.length) add(null, 'Последние вызовы функции', 'Пока не было — отправь кому-нибудь сообщение и открой диагностику снова');
      else {
        const last = data.last_calls[0];
        add(last.status_code >= 200 && last.status_code < 300, 'Последний вызов из базы',
          'HTTP ' + (last.status_code == null ? '—' : last.status_code) + ': ' + statusHint(last.status_code) + (last.error ? ' · ' + last.error : ''));
      }
    }
  } catch {
    add(null, 'Проверка базы', 'Выполни supabase/migration-12-v23.sql — тогда здесь появится статус триггера и ответы функции');
  }
  return rows;
}

export function openPushDiag() {
  const m = el(`<div class="modal-overlay" style="z-index:1300"><div class="modal diag-modal">
    <h3>🔔 Диагностика push</h3>
    <div class="muted small" style="margin-bottom:8px">Проверяю весь путь: устройство → база → функция → уведомление</div>
    <div class="diag-card" id="pd-list"><div class="adm-empty">Проверяю…</div></div>
    <div class="modal-actions" style="flex-wrap:wrap;gap:8px">
      <button class="btn ghost" data-a="close">Закрыть</button>
      <button class="btn ghost" data-a="recheck">↻ Снова</button>
      <button class="btn ghost" data-a="connect">🔗 Подключить</button>
      <button class="btn primary" data-a="test">📨 Тест с сервера</button>
    </div></div></div>`);
  document.querySelector('#modal-root').appendChild(m);
  const list = qs('#pd-list', m);

  const draw = async () => {
    list.innerHTML = '<div class="adm-empty">Проверяю…</div>';
    let rows;
    try { rows = await runChecks(); } catch (e) { rows = [{ ok: false, title: 'Ошибка', text: e.message }]; }
    list.innerHTML = rows.map((r) => `<div class="pd-row ${r.ok === false ? 'bad' : ''}">
      <span class="pd-ic">${r.ok === true ? OK : r.ok === false ? BAD : WARN}</span>
      <div><div class="pd-t">${esc(r.title)}</div><div class="pd-s">${esc(r.text)}</div></div></div>`).join('');
    if (!rows.some((r) => r.ok === false)) {
      list.insertAdjacentHTML('beforeend', '<div class="pd-final">Всё настроено. Нажми «Тест с сервера», закрой приложение — уведомление должно прийти.</div>');
    }
  };
  draw();

  m.addEventListener('click', async (e) => {
    if (e.target === m) { m.remove(); return; }
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'close') { m.remove(); return; }
    if (a === 'recheck') { draw(); return; }
    b.disabled = true;
    try {
      if (a === 'connect') {
        const sub = await subscribePush();
        toast(sub ? 'Устройство подключено 🔔' : 'Разрешение не выдано');
      }
      if (a === 'test') {
        const r = await sendTestPush();
        toast(r && r.devices === 0 ? 'На сервере нет твоих устройств — нажми «Подключить»' : 'Тест отправлен. Закрой приложение — придёт уведомление 🔔', 5000);
      }
    } catch (err) { toast('Push: ' + (err.message || err), 6000); }
    b.disabled = false;
    if (a === 'connect') draw();
  });
}

// ---------- 3. админ: имя и юзернейм ----------
const NICK_RE = /^[a-z0-9_]{3,20}$/;

function friendlyRenameError(err) {
  const msg = (err && (err.message || err.details)) || String(err);
  if (/23505|duplicate|unique|уже занят/i.test(msg + ' ' + ((err && err.code) || ''))) return 'Такой юзернейм уже занят';
  if (/23514|check constraint/i.test(msg)) return 'Юзернейм: 3–20 символов, без пробелов';
  if (/PGRST116|0 rows|no rows/i.test(msg)) return 'Нет прав: менять юзернеймы может только администратор';
  return msg;
}

async function saveProfileNames(p, nickname, display) {
  const sb = getSb();
  const r = await sb.rpc('admin_set_username', { p_user: p.id, p_nickname: nickname || null, p_display: display || null });
  if (!r.error) return r.data;
  // миграция v23 ещё не применена — обычное обновление (админу оно разрешено политикой)
  if (/PGRST202|42883|Could not find the function/i.test((r.error.code || '') + ' ' + (r.error.message || ''))) {
    const patch = {};
    if (nickname) patch.nickname = nickname;
    if (display) patch.display_name = display;
    const u = await sb.from('profiles').update(patch).eq('id', p.id).select().single();
    if (u.error) throw u.error;
    return u.data;
  }
  throw r.error;
}

/** Окно смены имени и юзернейма игрока. onDone(patch, profile) вызывается после сохранения. */
export function openRenameDialog(p, onDone) {
  if (!state.me || !state.me.is_admin) { toast('Менять юзернеймы может только администратор'); return; }
  const m = el(`<div class="modal-overlay" style="z-index:1300"><div class="modal">
    <h3>✏️ Имя и юзернейм</h3>
    <div class="muted small" style="margin-bottom:10px">Игрок: <b>${esc(p.display_name || p.nickname)}</b> · сейчас @${esc(p.nickname)}</div>
    <label class="field">Отображаемое имя
      <input id="rn-name" maxlength="40" value="${esc(p.display_name || '')}" placeholder="Имя"></label>
    <label class="field">Юзернейм
      <div class="rn-nick"><span>@</span><input id="rn-nick" maxlength="20" autocapitalize="off" autocomplete="off" spellcheck="false" value="${esc(p.nickname || '')}" placeholder="username"></div>
    </label>
    <div class="rn-hint" id="rn-hint">Латиница, цифры и _, от 3 до 20 символов</div>
    <div class="modal-actions">
      <button class="btn ghost" data-a="cancel">Отмена</button>
      <button class="btn primary" data-a="save">Сохранить</button>
    </div></div></div>`);
  document.querySelector('#modal-root').appendChild(m);
  const nick = qs('#rn-nick', m), name = qs('#rn-name', m), hint = qs('#rn-hint', m);
  const validate = () => {
    nick.value = nick.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
    const ok = NICK_RE.test(nick.value);
    hint.textContent = ok ? 'Юзернейм подходит ✓' : 'Латиница, цифры и _, от 3 до 20 символов';
    hint.classList.toggle('bad', !ok);
    return ok;
  };
  nick.addEventListener('input', validate);
  setTimeout(() => nick.focus(), 50);

  m.addEventListener('click', async (e) => {
    if (e.target === m) { m.remove(); return; }
    const b = e.target.closest('[data-a]'); if (!b) return;
    if (b.dataset.a === 'cancel') { m.remove(); return; }
    if (b.dataset.a !== 'save') return;
    if (!validate()) { toast('Юзернейм: латиница, цифры и _, 3–20 символов'); return; }
    const nk = nick.value, dn = name.value.trim();
    const patch = {};
    if (nk !== p.nickname) patch.nickname = nk;
    if (dn && dn !== (p.display_name || '')) patch.display_name = dn;
    if (!Object.keys(patch).length) { m.remove(); return; }
    b.disabled = true;
    try {
      const upd = await saveProfileNames(p, patch.nickname, patch.display_name);
      if (p.id === state.me.id && upd) Object.assign(state.me, { nickname: upd.nickname, display_name: upd.display_name });
      toast(patch.nickname ? 'Юзернейм изменён: @' + nk + ' ✓' : 'Имя обновлено ✓');
      m.remove();
      if (onDone) onDone(patch, upd);
    } catch (err) {
      toast('Ошибка: ' + friendlyRenameError(err), 5000);
      b.disabled = false;
    }
  });
}

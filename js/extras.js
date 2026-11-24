// ============================================================
//  v18: расширенные настройки (статус, приватность, звук, ИИ, безопасность),
//  двухфакторная защита (TOTP), активные сессии, права групп
// ============================================================
import { getSb, state, dbApi, authApi, memberProfile } from './api.js?v=26';
import { qs, esc, el, toast, getPrefs, setPrefs, confirmDialog, SOUNDS, beep, avatarHTML } from './utils.js';
import { applyPrefs } from './settings.js';
import { trackMe } from './presence.js';
import { showQr } from './profile.js';
import { openAiDiag, AI_PRESETS } from './ai-diag.js';
import { normalizeAiUrl } from './ai-core.js';

const STATUSES = [
  ['online', 'В сети', '#3dd68c'], ['away', 'Отошёл', '#f5b73d'],
  ['dnd', 'Не беспокоить', '#e5484d'], ['invisible', 'Невидимка', '#8f9ab8'],
];
const sel = (id, val, opts) => `<select class="sel" id="${id}">${opts.map(([v, l]) => `<option value="${v}" ${v === val ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
const relTime = (iso) => {
  const d = Math.max(0, Date.now() - new Date(iso).getTime());
  if (d < 120000) return 'только что';
  if (d < 3600000) return `${Math.round(d / 60000)} мин назад`;
  if (d < 86400000) return `${Math.round(d / 3600000)} ч назад`;
  return new Date(iso).toLocaleDateString('ru');
};

export function mountExtraSettings(m) {
  const host = qs('#st-extra', m);
  if (!host) return;
  const me = state.me; const prefs = getPrefs();
  host.innerHTML = `
    <div class="settings-sec">Статус</div>
    <div class="seg stat-seg" id="x-presence">
      ${STATUSES.map(([k, l, c]) => `<button data-s="${k}" class="${(me.presence_status || 'online') === k ? 'active' : ''}"><i style="background:${c}"></i>${l}</button>`).join('')}
    </div>
    <label class="field">Эмодзи рядом с именем
      <input id="x-emoji" maxlength="4" value="${esc(me.status_emoji || '')}" placeholder="например 🚀"></label>

    <div class="settings-sec">Приватность</div>
    <div class="settings-row"><div><div class="settings-row-title">Кто видит «был(а) в сети»</div></div>
      ${sel('x-pl', me.privacy_last_seen || 'everyone', [['everyone', 'Все'], ['friends', 'Друзья'], ['nobody', 'Никто']])}</div>
    <div class="settings-row"><div><div class="settings-row-title">Кто может писать мне</div>
      <div class="settings-row-sub">Остальным сервер не даст отправить сообщение</div></div>
      ${sel('x-pm', me.privacy_messages || 'everyone', [['everyone', 'Все'], ['friends', 'Только друзья']])}</div>
    <div class="settings-row"><div><div class="settings-row-title">Кто видит «О себе» и статус</div></div>
      ${sel('x-pp', me.privacy_profile || 'everyone', [['everyone', 'Все'], ['friends', 'Друзья']])}</div>

    <div class="settings-sec">Звуки и уведомления</div>
    <div class="settings-row"><div class="settings-row-title">Мелодия</div>
      <div class="inline">${sel('x-snd', prefs.soundType || 'pop', [...Object.entries(SOUNDS).map(([k, v]) => [k, v.label]), ['off', 'Без звука']])}
      <button class="btn ghost sm" id="x-snd-test">▶</button></div></div>
    <div class="settings-row"><div class="settings-row-title">Громкость</div>
      <input type="range" id="x-vol" min="5" max="100" value="${prefs.soundVol ?? 60}"></div>
    <div class="settings-row"><div><div class="settings-row-title">Упоминания @ник</div></div>
      <label class="switch"><input type="checkbox" id="x-nm" ${prefs.notifyMention === false ? '' : 'checked'}><span></span></label></div>
    <div class="settings-row"><div><div class="settings-row-title">Реакции на мои сообщения</div></div>
      <label class="switch"><input type="checkbox" id="x-nr" ${prefs.notifyReaction === false ? '' : 'checked'}><span></span></label></div>

    <div class="settings-sec">Свой цвет интерфейса</div>
    <div class="settings-row"><div class="settings-row-title">Любой цвет акцента</div>
      <div class="inline"><input type="color" id="x-color" value="${prefs.accentCustom || '#5b8cff'}">
      <button class="btn ghost sm" id="x-color-reset">Сбросить</button></div></div>

    <div class="settings-sec">ИИ и GIF</div>
    <div class="field-hint">По умолчанию ИИ работает бесплатно. Можно подключить свой OpenAI-совместимый сервис.</div>
    <div class="inline wrap" style="margin:6px 0 4px">
      <button class="btn ghost sm" id="x-ai-or" type="button">⚡ OpenRouter Free</button>
      <button class="btn ghost sm" id="x-ai-pl" type="button">Pollinations</button>
      <button class="btn ghost sm" id="x-ai-diag" type="button">🩺 Диагностика</button>
    </div>
    <label class="field">Адрес API (необязательно)<input id="x-aiurl" value="${esc(prefs.aiUrl || '')}" placeholder="https://openrouter.ai/api/v1/chat/completions"></label>
    <label class="field">Ключ API<input id="x-aikey" type="password" value="${esc(prefs.aiKey || '')}" placeholder="sk-or-v1-… / sk-…"></label>
    <label class="field">Модель<input id="x-aimodel" value="${esc(prefs.aiModel || '')}" placeholder="openrouter/free"></label>
    <label class="field">Ключ Giphy (для GIF)<input id="x-giphy" value="${esc(prefs.giphyKey || '')}" placeholder="бесплатно на developers.giphy.com"></label>
    <button class="btn ghost sm" id="x-ai-save" style="margin-top:8px">Сохранить</button>

    <div class="settings-sec">Безопасность</div>
    <div class="settings-row col"><div class="settings-row-title">Сменить пароль</div>
      <div class="inline wide"><input type="password" id="x-pw" placeholder="Новый пароль (от 6 символов)" autocomplete="new-password">
      <button class="btn ghost sm" id="x-pw-save">Сменить</button></div></div>
    <div class="settings-row col" id="x-mfa"><div class="settings-row-title">Двухфакторная защита</div><div class="muted">Загружаю…</div></div>
    <div class="settings-row"><div><div class="settings-row-title">Мой QR-код</div><div class="settings-row-sub">Чтобы тебя быстро добавили</div></div>
      <button class="btn ghost sm" id="x-qr">Показать</button></div>
    <div class="settings-row col"><div class="settings-row-title">Активные сессии</div><div id="x-sessions" class="sess-list"><div class="muted">Загружаю…</div></div></div>`;

  // --- статус
  host.querySelector('#x-presence').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-s]'); if (!b) return;
    try {
      await dbApi.setPresenceStatus(b.dataset.s);
      host.querySelectorAll('#x-presence button').forEach((x) => x.classList.toggle('active', x === b));
      trackMe(); toast(`Статус: ${b.textContent.trim()} ✓`);
      import('./chatlist.js').then((c) => c.renderSidebarMe());
    } catch (err) { toast('Ошибка: ' + err.message, 4500); }
  });
  qs('#x-emoji', host).addEventListener('change', async (e) => {
    try { await dbApi.setPresenceStatus(state.me.presence_status || 'online', e.target.value.trim() || null); toast('Сохранено ✓'); import('./chatlist.js').then((c) => c.renderSidebarMe()); }
    catch (err) { toast('Ошибка: ' + err.message, 4500); }
  });
  // --- приватность
  const savePriv = (id, col) => qs(id, host).addEventListener('change', async (e) => {
    try { await dbApi.savePrivacy({ [col]: e.target.value }); toast('Приватность сохранена ✓'); }
    catch (err) { toast('Ошибка: ' + err.message, 4500); }
  });
  savePriv('#x-pl', 'privacy_last_seen'); savePriv('#x-pm', 'privacy_messages'); savePriv('#x-pp', 'privacy_profile');
  // --- звук
  qs('#x-snd', host).addEventListener('change', (e) => { setPrefs({ soundType: e.target.value }); beep(); });
  qs('#x-snd-test', host).addEventListener('click', () => beep());
  qs('#x-vol', host).addEventListener('change', (e) => { setPrefs({ soundVol: Number(e.target.value) }); beep(); });
  qs('#x-nm', host).addEventListener('change', (e) => setPrefs({ notifyMention: e.target.checked }));
  qs('#x-nr', host).addEventListener('change', (e) => setPrefs({ notifyReaction: e.target.checked }));
  // --- цвет
  qs('#x-color', host).addEventListener('input', (e) => { setPrefs({ accentCustom: e.target.value }); applyPrefs(); });
  qs('#x-color-reset', host).addEventListener('click', () => { setPrefs({ accentCustom: '' }); applyPrefs(); toast('Цвет сброшен'); });
  // --- ИИ / GIF
  qs('#x-ai-save', host).addEventListener('click', () => {
    setPrefs({ aiUrl: qs('#x-aiurl', host).value.trim(), aiKey: qs('#x-aikey', host).value.trim(),
      aiModel: qs('#x-aimodel', host).value.trim(), giphyKey: qs('#x-giphy', host).value.trim() });
    const n = normalizeAiUrl(qs('#x-aiurl', host).value);
    if (n.fixed) { qs('#x-aiurl', host).value = n.url; setPrefs({ aiUrl: n.url }); toast('Сохранено. ' + n.note, 5000); } else toast('Сохранено ✓');
  });
  const applyPreset = (k) => {
    const pr = AI_PRESETS[k];
    qs('#x-aiurl', host).value = pr.aiUrl; qs('#x-aimodel', host).value = pr.aiModel;
    if (pr.clearKey) qs('#x-aikey', host).value = '';
    setPrefs({ aiUrl: pr.aiUrl, aiModel: pr.aiModel, ...(pr.clearKey ? { aiKey: '' } : {}) });
    toast(k === 'openrouter' && !qs('#x-aikey', host).value ? 'Вставь ключ sk-or-v1-… и нажми «Сохранить»' : `${pr.label} ✓`, 4500);
  };
  qs('#x-ai-or', host).addEventListener('click', () => applyPreset('openrouter'));
  qs('#x-ai-pl', host).addEventListener('click', () => applyPreset('pollinations'));
  qs('#x-ai-diag', host).addEventListener('click', openAiDiag);
  // --- пароль
  qs('#x-pw-save', host).addEventListener('click', async () => {
    const pw = qs('#x-pw', host).value;
    if (pw.length < 6) { toast('Пароль — минимум 6 символов'); return; }
    const { error } = await authApi.updatePassword(pw);
    if (error) toast('Ошибка: ' + error.message, 4500); else { qs('#x-pw', host).value = ''; toast('Пароль изменён ✓'); }
  });
  qs('#x-qr', host).addEventListener('click', () => showQr(state.me, m));
  renderMfa(qs('#x-mfa', host));
  renderSessions(qs('#x-sessions', host));
}

// ---------- активные сессии ----------
async function renderSessions(box) {
  try {
    const list = await dbApi.listSessions();
    const mine = dbApi.sessionId();
    if (!list.length) { box.innerHTML = '<div class="muted">Нет данных</div>'; return; }
    box.innerHTML = list.map((s) => `
      <div class="sess-row"><div class="sess-ic">${/Android|iOS/.test(s.device || '') ? '📱' : '💻'}</div>
        <div class="sess-main"><b>${esc(s.device || 'Устройство')}${s.id === mine ? ' <span class="role-badge">это устройство</span>' : ''}</b>
        <span>активность: ${esc(relTime(s.last_active))}</span></div>
        ${s.id === mine ? '' : `<button class="btn ghost sm" data-end="${s.id}">Завершить</button>`}</div>`).join('')
      + (list.length > 1 ? '<button class="btn danger sm" id="x-end-all" style="margin-top:8px">Завершить все остальные</button>' : '');
    box.onclick = async (e) => {
      const one = e.target.closest('[data-end]');
      try {
        if (one) { await dbApi.revokeSession(one.dataset.end); toast('Сессия завершена ✓'); renderSessions(box); }
        if (e.target.closest('#x-end-all')) {
          if (!await confirmDialog({ title: 'Завершить все остальные сессии?', text: 'На других устройствах придётся войти заново.', okLabel: 'Завершить' })) return;
          await dbApi.revokeOtherSessions(); toast('Готово ✓'); renderSessions(box);
        }
      } catch (err) { toast('Ошибка: ' + err.message, 4500); }
    };
  } catch (err) { box.innerHTML = `<div class="muted">${esc(err.message)}</div>`; }
}

// ---------- 2FA (TOTP) ----------
async function renderMfa(box) {
  const sb = getSb();
  const title = '<div class="settings-row-title">Двухфакторная защита (2FA)</div>';
  try {
    const { data, error } = await sb.auth.mfa.listFactors();
    if (error) throw error;
    const ok = (data.totp || []).find((f) => f.status === 'verified');
    if (ok) {
      box.innerHTML = `${title}<div class="settings-row-sub">Включена ✓ При входе нужен код из приложения-аутентификатора.</div>
        <button class="btn danger sm" id="mfa-off">Отключить</button>`;
      qs('#mfa-off', box).addEventListener('click', async () => {
        if (!await confirmDialog({ title: 'Отключить 2FA?', text: 'Аккаунт станет менее защищён.', okLabel: 'Отключить' })) return;
        const r = await sb.auth.mfa.unenroll({ factorId: ok.id });
        if (r.error) toast('Ошибка: ' + r.error.message, 4500); else { toast('2FA отключена'); renderMfa(box); }
      });
      return;
    }
    box.innerHTML = `${title}<div class="settings-row-sub">Защити вход кодом из Google Authenticator, Authy или 1Password.</div>
      <button class="btn primary sm" id="mfa-on">Включить</button>`;
    qs('#mfa-on', box).addEventListener('click', async () => {
      for (const f of data.all || []) if (f.status !== 'verified') await sb.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
      const en = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'MSPgram ' + Date.now().toString(36) });
      if (en.error) { toast('Ошибка: ' + en.error.message, 5000); return; }
      box.innerHTML = `${title}<div class="settings-row-sub">1) Отсканируй QR в приложении-аутентификаторе 2) введи 6-значный код</div>
        <img class="mfa-qr" src="${esc(en.data.totp.qr_code)}" alt="QR">
        <div class="field-hint">Или введи ключ вручную: <b class="mono">${esc(en.data.totp.secret)}</b></div>
        <div class="inline wide"><input id="mfa-code" inputmode="numeric" maxlength="6" placeholder="000000"><button class="btn primary sm" id="mfa-ok">Подтвердить</button></div>`;
      qs('#mfa-ok', box).addEventListener('click', async () => {
        const code = qs('#mfa-code', box).value.trim();
        const ch = await sb.auth.mfa.challenge({ factorId: en.data.id });
        if (ch.error) { toast('Ошибка: ' + ch.error.message, 4500); return; }
        const v = await sb.auth.mfa.verify({ factorId: en.data.id, challengeId: ch.data.id, code });
        if (v.error) { toast('Неверный код', 3500); return; }
        toast('2FA включена ✓ 🔐'); renderMfa(box);
      });
    });
  } catch (err) {
    box.innerHTML = `${title}<div class="muted">Недоступно: ${esc(err.message || 'MFA выключена в проекте Supabase')}</div>`;
  }
}

// Экран ввода кода 2FA при входе. true — можно входить.
export async function ensureMfa() {
  const sb = getSb();
  try {
    const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (!data || data.nextLevel !== 'aal2' || data.currentLevel === 'aal2') return true;
    const f = await sb.auth.mfa.listFactors();
    const factor = (f.data?.totp || []).find((x) => x.status === 'verified');
    if (!factor) return true;
    return await new Promise((resolve) => {
      const o = el(`<div class="ban-overlay mfa-gate"><div class="ban-card">
        <div class="ban-emoji">🔐</div><h2>Код подтверждения</h2>
        <p class="ban-hint">Введи 6-значный код из приложения-аутентификатора.</p>
        <input id="gate-code" class="gate-code" inputmode="numeric" maxlength="6" placeholder="000000" autofocus>
        <div class="form-error" id="gate-err"></div>
        <button class="btn primary" id="gate-ok">Войти</button>
        <button class="btn ghost" id="gate-out" style="margin-top:8px">Выйти</button></div></div>`);
      document.body.appendChild(o);
      const go = async () => {
        const code = qs('#gate-code', o).value.trim();
        const ch = await sb.auth.mfa.challenge({ factorId: factor.id });
        if (ch.error) { qs('#gate-err', o).textContent = ch.error.message; return; }
        const v = await sb.auth.mfa.verify({ factorId: factor.id, challengeId: ch.data.id, code });
        if (v.error) { qs('#gate-err', o).textContent = 'Неверный код'; return; }
        o.remove(); resolve(true);
      };
      qs('#gate-ok', o).addEventListener('click', go);
      qs('#gate-code', o).addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      qs('#gate-out', o).addEventListener('click', async () => { o.remove(); await authApi.signOut(); resolve(false); });
    });
  } catch { return true; }
}

// ---------- права группы ----------
export function openGroupSettings(chat, onDone) {
  const meId = state.me.id;
  const members = (chat.members || []).filter((x) => x.user_id !== meId);
  const m = el(`
    <div class="modal-overlay"><div class="modal gperm-modal">
      <h3>Права и описание</h3>
      <label class="field">Описание<textarea id="g-desc" rows="3" maxlength="300" placeholder="О чём это сообщество">${esc(chat.description || '')}</textarea></label>
      <div class="settings-row"><div><div class="settings-row-title">Режим канала</div>
        <div class="settings-row-sub">Писать могут только владелец и админы</div></div>
        <label class="switch"><input type="checkbox" id="g-only" ${chat.only_admins_post ? 'checked' : ''}><span></span></label></div>
      <div class="settings-row"><div><div class="settings-row-title">Участники могут слать медиа</div>
        <div class="settings-row-sub">Фото, видео, файлы, голосовые, GIF</div></div>
        <label class="switch"><input type="checkbox" id="g-media" ${chat.allow_media === false ? '' : 'checked'}><span></span></label></div>
      <div class="settings-sec">Роли участников</div>
      <div class="gperm-members">${members.length ? members.map((x) => {
        const p = memberProfile(chat, x.user_id) || {};
        const admin = x.role === 'admin';
        return `<div class="person-row sm">${avatarHTML(p.avatar_url, p.display_name || p.nickname, 'sm')}
          <div class="chat-row-main"><span class="chat-row-title">${esc(p.display_name || p.nickname || 'Участник')}</span>
          <span class="chat-row-preview">@${esc(p.nickname || '')}</span></div>
          <button class="btn ${admin ? 'primary' : 'ghost'} sm" data-role="${x.user_id}" data-admin="${admin ? 1 : 0}">${admin ? 'Админ ✓' : 'Сделать админом'}</button></div>`;
      }).join('') : '<div class="list-empty">Пока нет других участников</div>'}</div>
      <div class="form-error" id="g-err"></div>
      <div class="modal-actions"><button class="btn ghost" data-act="close">Закрыть</button><button class="btn primary" id="g-save">Сохранить</button></div>
    </div></div>`);
  document.querySelector('#modal-root').appendChild(m);
  m.addEventListener('click', async (e) => {
    if (e.target === m || e.target.closest('[data-act=close]')) m.remove();
    const rb = e.target.closest('[data-role]');
    if (rb) {
      const makeAdmin = rb.dataset.admin !== '1';
      try {
        await dbApi.setMemberRole(chat.id, rb.dataset.role, makeAdmin ? 'admin' : 'member');
        rb.dataset.admin = makeAdmin ? '1' : '0';
        rb.textContent = makeAdmin ? 'Админ ✓' : 'Сделать админом';
        rb.className = `btn ${makeAdmin ? 'primary' : 'ghost'} sm`;
      } catch (err) { qs('#g-err', m).textContent = err.message; }
    }
    if (e.target.closest('#g-save')) {
      try {
        await dbApi.updateChatSettings(chat.id, {
          description: qs('#g-desc', m).value.trim() || null,
          only_admins_post: qs('#g-only', m).checked,
          allow_media: qs('#g-media', m).checked,
        });
        toast('Права сохранены ✓'); m.remove(); if (onDone) onDone();
      } catch (err) { qs('#g-err', m).textContent = err.message; }
    }
  });
}

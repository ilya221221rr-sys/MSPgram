// Настройки: профиль, уведомления, внешний вид (как в Telegram — свой раздел)
import { state, dbApi, storeApi, authApi } from './api.js';
import { openAdminPanel } from './admin.js';
import { mountExtraSettings } from './extras.js';
import { mountAppearance } from './appearance.js';
import {
  qs, esc, el, toast, avatarHTML, getPrefs, setPrefs, confirmDialog,
} from './utils.js';
import { previewRingtone } from './ringtone.js';
import { showSystemNotification } from './push.js';
import { getPushState, subscribePush, sendTestPush } from './webpush.js';
import { openPushDiag } from './v23.js';

const ACCENTS = {
  ocean: { label: 'Океан', a: '#5b8cff', b: '#7c5bff', out: 'linear-gradient(135deg,#3e63dd,#4d43d8)' },
  emerald: { label: 'Изумруд', a: '#2dd4a0', b: '#14b8a6', out: 'linear-gradient(135deg,#0f9d6f,#0d9488)' },
  sunset: { label: 'Закат', a: '#ff8a5c', b: '#f65c7a', out: 'linear-gradient(135deg,#f97316,#ef4444)' },
  royal: { label: 'Лазурь', a: '#818cf8', b: '#c084fc', out: 'linear-gradient(135deg,#6366f1,#a855f7)' },
};

const MSG_SIZES = { s: { label: 'S', px: '13.5px' }, m: { label: 'M', px: '14.5px' }, l: { label: 'L', px: '16px' } };

// Применить сохранённые настройки к интерфейсу (вызывается при старте)
export function applyPrefs() {
  const p = getPrefs();
  const r = document.documentElement.style;
  const accent = ACCENTS[p.accent] || ACCENTS.ocean;
  if (p.accentCustom) {
    // свой цвет: производные оттенки считаем сами
    r.setProperty('--accent', p.accentCustom);
    r.setProperty('--accent2', `color-mix(in srgb, ${p.accentCustom} 62%, #8b5cf6)`);
    r.setProperty('--out', `linear-gradient(135deg, color-mix(in srgb, ${p.accentCustom} 82%, #000), color-mix(in srgb, ${p.accentCustom} 55%, #4338ca))`);
  } else {
    r.setProperty('--accent', accent.a);
    r.setProperty('--accent2', accent.b);
    r.setProperty('--out', accent.out);
  }
  r.setProperty('--msg-font', (MSG_SIZES[p.msgSize] || MSG_SIZES.m).px);
  const auto = p.theme === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.dataset.theme = (p.theme === 'light' || auto) ? 'light' : 'dark';
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = document.documentElement.dataset.theme === 'light' ? '#f3f5fb' : '#0d1220';
}

export function openSettingsModal() {
  if (!state.me) return;
  const me = state.me;
  const prefs = getPrefs();
  const email = getPrefs()._email || '';

  const m = el(`
    <div class="modal-overlay">
      <div class="modal settings-modal">
        <h3>Настройки</h3>

        <div class="settings-sec">Профиль</div>
        <div class="avatar-edit">
          <div id="st-avatar-preview">${avatarHTML(me.avatar_url, me.display_name || me.nickname, 'xl')}</div>
          <div>
            <button class="btn ghost sm" id="st-avatar-btn">Сменить аватар</button>
            <button class="btn ghost sm" id="st-cover-btn">Сменить обложку</button>
            <div class="field-hint">PNG/JPG/WEBP, до 5 МБ</div>
          </div>
          <input type="file" id="st-avatar-file" accept="image/*" class="hidden">
          <input type="file" id="st-cover-file" accept="image/*" class="hidden">
        </div>
        <label class="field">Имя (видно в чатах)
          <input id="st-display" type="text" maxlength="40" value="${esc(me.display_name)}" placeholder="Как тебя зовут">
        </label>
        <label class="field">Ник (по нему тебя найдут)
          <input id="st-nick" type="text" maxlength="20" value="${esc(me.nickname)}">
        </label>
        <div class="field-hint" id="st-nick-hint"></div>
        <label class="field">Свой статус (виден в профиле)
          <input id="st-status" type="text" maxlength="80" value="${esc(me.status_text || '')}" placeholder="Например: Кодю новый MSPgram 🚀">
        </label>
        <label class="field">О себе
          <input id="st-bio" type="text" maxlength="120" value="${esc(me.bio)}" placeholder="Пара слов о себе">
        </label>
        <button class="btn primary" id="st-save" style="margin-top:14px">Сохранить профиль</button>
        <div class="form-error" id="st-error"></div>

        <div class="settings-sec">Уведомления</div>
        <div class="settings-row">
          <div>
            <div class="settings-row-title">Звук сообщений</div>
            <div class="settings-row-sub">Короткий сигнал при новом сообщении</div>
          </div>
          <label class="switch"><input type="checkbox" id="st-sound" ${prefs.sound === false ? '' : 'checked'}><span></span></label>
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-row-title">Рингтон звонка 🔔</div>
            <div class="settings-row-sub">Мелодия, когда тебе звонят, и гудки, когда звонишь ты</div>
          </div>
          <div style="display:flex;gap:10px;align-items:center;flex:none">
            <button class="btn ghost sm" id="st-ring-test" type="button">▶</button>
            <label class="switch"><input type="checkbox" id="st-ringtone" ${prefs.ringtone === false ? '' : 'checked'}><span></span></label>
          </div>
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-row-title">Push-уведомления браузера</div>
            <div class="settings-row-sub" id="st-push-sub"></div>
          </div>
          <button class="btn ghost sm" id="st-push-btn">Включить</button>
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-row-title">Диагностика push</div>
            <div class="settings-row-sub">Если сообщения не приходят при закрытом приложении — тут видно, что именно сломано</div>
          </div>
          <button class="btn ghost sm" id="st-push-diag" type="button">Проверить</button>
        </div>

        <div class="settings-sec">Внешний вид</div>
        <div class="settings-row col">
          <div class="settings-row-title">Тема</div>
          <div class="chip-row" id="st-themes"></div>
        </div>
        <div class="settings-row col">
          <div class="settings-row-title">Цвет акцента</div>
          <div class="chip-row" id="st-accents"></div>
        </div>
        <div class="settings-row col">
          <div class="settings-row-title">Размер текста сообщений</div>
          <div class="chip-row" id="st-sizes"></div>
        </div>

        <div id="st-extra"></div>

        <div class="settings-sec">Аккаунт</div>
        ${(me.is_admin || me.is_moderator) ? `
        <div class="settings-row">
          <div>
            <div class="settings-row-title">🛡 ${me.is_admin ? 'Админ-панель' : 'Панель модератора'}</div>
            <div class="settings-row-sub">Пользователи, жалобы, сообщества, статистика</div>
          </div>
          <button class="btn primary sm" id="st-admin">Открыть</button>
        </div>` : ''}
        <div class="settings-row">
          <div>
            <div class="settings-row-title" id="st-email">${esc(email || 'Email скрыт')}</div>
            <div class="settings-row-sub">Твой адрес для входа</div>
          </div>
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-row-title">📱 Приложение (APK)</div>
            <div class="settings-row-sub">Push-уведомления о сообщениях и звонках на телефоне</div>
          </div>
          <a class="btn ghost sm" href="https://github.com/ilya221221rr-sys/MSPgram/releases/latest/download/app-debug.apk" download>Скачать</a>
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-row-title">Выйти из аккаунта</div>
            <div class="settings-row-sub">Сессия на этом устройстве завершится</div>
          </div>
          <button class="btn danger sm" id="st-logout">Выйти</button>
        </div>

        <div class="modal-actions">
          <button class="btn ghost" data-act="close">Закрыть</button>
        </div>
      </div>
    </div>`);

  document.querySelector('#modal-root').appendChild(m);
  try { mountExtraSettings(m); } catch (e) { console.warn('extras:', e); }
  try { mountAppearance(m); } catch (e) { console.warn('appearance:', e); }
  const close = () => m.remove();
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-act=close]')) close(); });

  // ---------- профиль ----------
  const fileInput = qs('#st-avatar-file', m);
  let newAvatarUrl = null;
  qs('#st-avatar-btn', m).addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      toast('Загружаю аватар…');
      newAvatarUrl = await storeApi.uploadAvatar(file);
      qs('#st-avatar-preview', m).innerHTML = avatarHTML(newAvatarUrl, me.nickname, 'xl');
    } catch (e) {
      qs('#st-error', m).textContent = e.message;
    }
  });

  // ---------- обложка профиля ----------
  const coverInput = qs('#st-cover-file', m);
  qs('#st-cover-btn', m).addEventListener('click', () => coverInput.click());
  coverInput.addEventListener('change', async () => {
    const file = coverInput.files[0];
    if (!file) return;
    try {
      toast('Загружаю обложку…');
      await dbApi.uploadCover(file);
      toast('Обложка обновлена ✓');
    } catch (e) {
      qs('#st-error', m).textContent = e.message;
    }
  });

  const nickInput = qs('#st-nick', m);
  const nickHint = qs('#st-nick-hint', m);
  nickInput.addEventListener('blur', async () => {
    const nick = nickInput.value.trim();
    nickHint.textContent = '';
    nickHint.className = 'field-hint';
    if (!nick || nick === me.nickname) return;
    const free = await dbApi.checkNickname(nick);
    nickHint.textContent = free ? 'Ник свободен ✓' : 'Такой ник уже занят';
    nickHint.className = `field-hint ${free ? 'ok' : 'warn'}`;
  });

  qs('#st-save', m).addEventListener('click', async () => {
    const nick = nickInput.value.trim();
    const errBox = qs('#st-error', m);
    errBox.textContent = '';
    if (!/^[A-Za-z0-9_А-Яа-яЁё]{3,20}$/.test(nick)) {
      errBox.textContent = 'Ник: 3–20 символов, без пробелов.';
      return;
    }
    try {
      const patch = {
        nickname: nick,
        display_name: qs('#st-display', m).value.trim(),
        bio: qs('#st-bio', m).value.trim(),
        status_text: qs('#st-status', m).value.trim(),
      };
      if (newAvatarUrl) patch.avatar_url = newAvatarUrl;
      await dbApi.updateMe(patch);
      import('./chatlist.js').then((mm) => { mm.renderChatList(); mm.renderSidebarMe(); });
      toast('Профиль сохранён ✓');
    } catch (e) {
      errBox.textContent = e.message.includes('duplicate') || e.message.includes('unique')
        ? 'Такой ник уже занят.' : e.message;
    }
  });

  // ---------- уведомления ----------
  qs('#st-sound', m).addEventListener('change', (e) => {
    setPrefs({ sound: e.target.checked });
    toast(e.target.checked ? 'Звук включён 🔊' : 'Звук выключен 🔇');
  });

  qs('#st-ringtone', m).addEventListener('change', (e) => {
    setPrefs({ ringtone: e.target.checked });
    toast(e.target.checked ? 'Рингтон включён 🔔' : 'Рингтон выключен 🔕');
  });
  qs('#st-ring-test', m).addEventListener('click', () => previewRingtone());

  const pushBtn = qs('#st-push-btn', m);
  const pushSub = qs('#st-push-sub', m);
  const renderPush = async () => {
    const st = await getPushState();
    pushBtn.disabled = false;
    pushBtn.classList.remove('hidden');
    if (st === 'unsupported') {
      pushSub.textContent = 'Браузер не поддерживает уведомления';
      pushBtn.classList.add('hidden');
    } else if (st === 'denied') {
      pushSub.textContent = 'Заблокированы — разреши их в настройках сайта/приложения';
      pushBtn.textContent = 'Недоступно';
      pushBtn.disabled = true;
    } else if (st === 'on') {
      pushSub.textContent = 'Включены ✓ Сообщения и звонки приходят, даже когда приложение закрыто';
      pushBtn.textContent = 'Проверить';
    } else if (st === 'off') {
      pushSub.textContent = 'Разрешены, но это устройство не подключено к серверу push — нажми «Подключить»';
      pushBtn.textContent = 'Подключить';
    } else {
      pushSub.textContent = 'Разреши — и сообщения будут приходить даже при закрытом приложении';
      pushBtn.textContent = 'Включить';
    }
  };
  renderPush();
  qs('#st-push-diag', m).addEventListener('click', () => openPushDiag());
  pushBtn.addEventListener('click', async () => {
    pushBtn.disabled = true;
    try {
      const st = await getPushState();
      if (st === 'on') {
        await sendTestPush();
        toast('Тестовый push отправлен — он придёт с сервера 🔔');
      } else {
        const sub = await subscribePush();
        if (!sub) { toast('Разрешение не выдано'); }
        else {
          toast('Push подключён 🔔');
          await sendTestPush().catch(() => {});
        }
      }
    } catch (e) {
      toast('Push: ' + e.message, 6000);
      // хотя бы локальные уведомления (когда приложение открыто)
      if ('Notification' in window && Notification.permission === 'granted') {
        showSystemNotification({ title: 'MSPgram', body: 'Локальные уведомления работают ✓', tag: 'msp-test' });
      }
    }
    renderPush();
  });

  // ---------- внешний вид ----------
  const themeRow = qs('#st-themes', m);
  const THEMES = [
    { key: 'dark', label: '🌙 Тёмная' },
    { key: 'light', label: '☀️ Светлая' },
    { key: 'auto', label: '🖥 Как в системе' },
  ];
  THEMES.forEach((t) => {
    const chip = el(`<button class="size-chip ${((prefs.theme || 'dark') === t.key) ? 'sel' : ''}" data-theme-key="${t.key}">${t.label}</button>`);
    chip.addEventListener('click', () => {
      setPrefs({ theme: t.key });
      applyPrefs();
      themeRow.querySelectorAll('.size-chip').forEach((c) => c.classList.toggle('sel', c === chip));
    });
    themeRow.appendChild(chip);
  });

  const accentRow = qs('#st-accents', m);
  Object.entries(ACCENTS).forEach(([key, a]) => {
    const chip = el(`
      <button class="accent-chip ${((prefs.accent || 'ocean') === key) ? 'sel' : ''}" data-accent="${key}" title="${a.label}">
        <span style="background:linear-gradient(135deg,${a.a},${a.b})"></span>${a.label}
      </button>`);
    chip.addEventListener('click', () => {
      setPrefs({ accent: key });
      applyPrefs();
      accentRow.querySelectorAll('.accent-chip').forEach((c) => c.classList.toggle('sel', c === chip));
    });
    accentRow.appendChild(chip);
  });

  const sizeRow = qs('#st-sizes', m);
  Object.entries(MSG_SIZES).forEach(([key, s]) => {
    const chip = el(`
      <button class="size-chip ${((prefs.msgSize || 'm') === key) ? 'sel' : ''}" data-size="${key}">${s.label}</button>`);
    chip.addEventListener('click', () => {
      setPrefs({ msgSize: key });
      applyPrefs();
      sizeRow.querySelectorAll('.size-chip').forEach((c) => c.classList.toggle('sel', c === chip));
    });
    sizeRow.appendChild(chip);
  });

  // ---------- аккаунт ----------
  const adminBtn = qs('#st-admin', m);
  if (adminBtn) adminBtn.addEventListener('click', async () => {
    m.remove();
    await openAdminPanel();
  });
  qs('#st-logout', m).addEventListener('click', async () => {
    close();
    const ok = await confirmDialog({ title: 'Выйти из аккаунта?', text: '', okLabel: 'Выйти', danger: false });
    if (ok) await authApi.signOut();
  });

  // показать email (берём из сессии)
  (async () => {
    try {
      const s = await authApi.getSession();
      if (s && s.user && s.user.email) {
        setPrefs({ _email: s.user.email });
        const row = qs('#st-email', m);
        if (row) row.textContent = s.user.email;
      }
    } catch { /* не критично */ }
  })();
}

// Экраны входа: вход, регистрация, подтверждение почты, восстановление пароля
import { authApi, dbApi } from './api.js';
import { qs, qsa, toast, bus } from './utils.js';

const ERRORS = [
  [/invalid login credentials/i, 'Неверный email или пароль.'],
  [/user already registered/i, 'Этот email уже зарегистрирован. Попробуй войти.'],
  [/at least 6 characters/i, 'Пароль должен быть минимум 6 символов.'],
  [/invalid format|validate email/i, 'Некорректный email.'],
  [/rate limit|too many/i, 'Слишком много попыток. Подожди минуту.'],
  [/not confirmed/i, 'Сначала подтверди email — открой письмо и нажми кнопку.'],
  [/same password|different/i, 'Новый пароль совпадает со старым — придумай другой.'],
  [/password/i, 'Придумай пароль (минимум 6 символов).'],
];

export function authErrorText(err) {
  const s = String((err && err.message) || err || '');
  for (const [re, msg] of ERRORS) if (re.test(s)) return msg;
  return 'Ошибка: ' + (s || 'неизвестная');
}

const NICK_RE = /^[A-Za-z0-9_А-Яа-яЁё]{3,20}$/;

export function initAuth() {
  const tabLogin = qs('#tab-login');
  const tabReg = qs('#tab-register');

  // ---- переключение панелей: login / register / forgot / check / newpass ----
  function switchPane(name) {
    qsa('.auth-pane').forEach((n) => n.classList.toggle('hidden', n.dataset.pane !== name));
    const isTab = name === 'login' || name === 'register';
    qs('#auth-tabs').classList.toggle('hidden', !isTab);
    tabLogin.classList.toggle('active', name === 'login');
    tabReg.classList.toggle('active', name === 'register');
    qsa('.form-error').forEach((n) => { n.textContent = ''; });
    qs('#login-resend').classList.add('hidden');
  }

  function showCheck(title, text) {
    qs('#check-title').textContent = title;
    qs('#check-text').textContent = text;
    switchPane('check');
  }

  tabLogin.addEventListener('click', () => switchPane('login'));
  tabReg.addEventListener('click', () => switchPane('register'));
  qs('#forgot-link').addEventListener('click', () => switchPane('forgot'));
  qs('#forgot-back').addEventListener('click', () => switchPane('login'));
  qs('#check-done').addEventListener('click', () => switchPane('login'));

  // ---- вход ----
  qs('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = qs('#login-error');
    errBox.textContent = '';
    const email = qs('#login-email').value.trim();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Входим…';
    try {
      const { error } = await authApi.signIn(email, qs('#login-password').value);
      if (error) throw error;
      // дальше всё сделает onAuthStateChange в app.js
    } catch (err) {
      errBox.textContent = authErrorText(err);
      if (/not confirmed/i.test(String((err && err.message) || err))) {
        qs('#login-resend').classList.remove('hidden');
        qs('#login-resend').dataset.email = email;
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Войти';
    }
  });

  // повторная отправка письма подтверждения
  qs('#login-resend').addEventListener('click', async (e) => {
    const email = e.target.dataset.email || qs('#login-email').value.trim();
    try {
      const { error } = await authApi.resendConfirmation(email);
      if (error) throw error;
      showCheck('Письмо отправлено ещё раз',
        `Открой почту ${email} и нажми кнопку подтверждения. Письмо может попасть в «Спам».`);
    } catch (err) {
      qs('#login-error').textContent = authErrorText(err);
    }
  });

  // ---- регистрация ----
  const nickInput = qs('#reg-nickname');
  const nickHint = qs('#reg-nick-hint');
  nickInput.addEventListener('input', () => {
    nickHint.textContent = '';
    nickHint.className = 'field-hint';
  });
  nickInput.addEventListener('blur', async () => {
    const nick = nickInput.value.trim();
    if (!nick || !NICK_RE.test(nick)) return;
    const free = await dbApi.checkNickname(nick);
    if (!free) {
      nickHint.textContent = 'Такой ник уже занят — при регистрации он может стать чуть другим.';
      nickHint.className = 'field-hint warn';
    } else {
      nickHint.textContent = 'Ник свободен ✓';
      nickHint.className = 'field-hint ok';
    }
  });

  qs('#register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = qs('#reg-error');
    errBox.textContent = '';
    const nick = nickInput.value.trim();
    if (!NICK_RE.test(nick)) {
      errBox.textContent = 'Ник: 3–20 символов, без пробелов (буквы, цифры, _).';
      return;
    }
    const email = qs('#reg-email').value.trim();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Создаём…';
    try {
      const { data, error } = await authApi.signUp(
        email,
        qs('#reg-password').value,
        nick,
        qs('#reg-display').value.trim(),
      );
      if (error) throw error;
      if (data && !data.session) {
        // включено подтверждение email — показываем красивый экран
        showCheck('Осталось подтвердить почту',
          `Мы отправили письмо на ${email}. ` +
          'Открой его и нажми кнопку подтверждения, затем вернись и войди. ' +
          'Не нашёл письмо? Загляни в «Спам».');
      }
      // если сессия создана (подтверждение отключено) — дальше всё сделает onAuthStateChange
    } catch (err) {
      errBox.textContent = authErrorText(err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Создать аккаунт';
    }
  });

  // ---- забыл пароль: отправка письма ----
  qs('#forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = qs('#forgot-error');
    errBox.textContent = '';
    const email = qs('#forgot-email').value.trim();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Отправляем…';
    try {
      const { error } = await authApi.resetPassword(email);
      if (error) throw error;
      showCheck('Письмо для смены пароля отправлено',
        `Отправили ссылку на ${email}. Ссылка работает один раз и действует 1 час. ` +
        'Открой письмо на этом же устройстве — откроется форма нового пароля.');
    } catch (err) {
      errBox.textContent = authErrorText(err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Отправить ссылку';
    }
  });

  // ---- новый пароль (после перехода по ссылке) ----
  qs('#newpass-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = qs('#newpass-error');
    errBox.textContent = '';
    const p1 = qs('#newpass-pw').value;
    const p2 = qs('#newpass-pw2').value;
    if (p1.length < 6) { errBox.textContent = 'Пароль: минимум 6 символов.'; return; }
    if (p1 !== p2) { errBox.textContent = 'Пароли не совпадают.'; return; }
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Сохраняем…';
    try {
      const { error } = await authApi.updatePassword(p1);
      if (error) throw error;
      qs('#newpass-pw').value = '';
      qs('#newpass-pw2').value = '';
      toast('Пароль изменён ✓');
      bus.emit('password-updated'); // app.js войдёт в приложение
    } catch (err) {
      errBox.textContent = authErrorText(err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Сохранить пароль';
    }
  });
}

// ---- переключение видимых экранов ----
export function showAuth(pane = 'login') {
  qs('#auth-screen').classList.remove('hidden');
  qs('#app').classList.add('hidden');
  qs('#setup-screen').classList.add('hidden');
  document.body.classList.remove('chat-open');
  if (pane !== 'login') {
    // открыть конкретную панель (например newpass после ссылки из письма)
    qsa('.auth-pane').forEach((n) => n.classList.toggle('hidden', n.dataset.pane !== pane));
    qs('#auth-tabs').classList.toggle('hidden', true);
  }
}

export function showSetup() {
  qs('#setup-screen').classList.remove('hidden');
  qs('#app').classList.add('hidden');
  qs('#auth-screen').classList.add('hidden');
}

export function showApp() {
  qs('#app').classList.remove('hidden');
  qs('#auth-screen').classList.add('hidden');
  qs('#setup-screen').classList.add('hidden');
  document.body.classList.remove('chat-open');
}

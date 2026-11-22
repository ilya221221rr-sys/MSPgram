// Экран входа и регистрации
import { authApi, dbApi } from './api.js';
import { qs, toast } from './utils.js';

const ERRORS = [
  [/invalid login credentials/i, 'Неверный email или пароль.'],
  [/user already registered/i, 'Этот email уже зарегистрирован. Попробуй войти.'],
  [/at least 6 characters/i, 'Пароль должен быть минимум 6 символов.'],
  [/invalid format|validate email/i, 'Некорректный email.'],
  [/rate limit|too many/i, 'Слишком много попыток. Подожди минуту.'],
  [/not confirmed/i, 'Сначала подтверди email — проверь почту.'],
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
  const loginForm = qs('#login-form');
  const regForm = qs('#register-form');

  const switchTab = (reg) => {
    tabLogin.classList.toggle('active', !reg);
    tabReg.classList.toggle('active', reg);
    loginForm.classList.toggle('hidden', reg);
    regForm.classList.toggle('hidden', !reg);
  };
  tabLogin.addEventListener('click', () => switchTab(false));
  tabReg.addEventListener('click', () => switchTab(true));

  // ---- вход ----
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = qs('#login-error');
    errBox.textContent = '';
    const btn = loginForm.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Входим…';
    try {
      const { error } = await authApi.signIn(
        qs('#login-email').value.trim(),
        qs('#login-password').value,
      );
      if (error) throw error;
      // дальше всё сделает onAuthStateChange в app.js
    } catch (err) {
      errBox.textContent = authErrorText(err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Войти';
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

  regForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = qs('#reg-error');
    errBox.textContent = '';
    const nick = nickInput.value.trim();
    if (!NICK_RE.test(nick)) {
      errBox.textContent = 'Ник: 3–20 символов, без пробелов (буквы, цифры, _).';
      return;
    }
    const btn = regForm.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Создаём…';
    try {
      const { data, error } = await authApi.signUp(
        qs('#reg-email').value.trim(),
        qs('#reg-password').value,
        nick,
        qs('#reg-display').value.trim(),
      );
      if (error) throw error;
      if (data && !data.session) {
        // включено подтверждение email
        toast('Аккаунт создан! Если включено подтверждение почты — проверь письмо, затем войди.', 5000);
        switchTab(false);
        qs('#login-email').value = qs('#reg-email').value.trim();
      }
      // если сессия создана — дальше всё сделает onAuthStateChange
    } catch (err) {
      errBox.textContent = authErrorText(err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Создать аккаунт';
    }
  });
}

export function showAuth() {
  qs('#auth-screen').classList.remove('hidden');
  qs('#app').classList.add('hidden');
  qs('#setup-screen').classList.add('hidden');
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

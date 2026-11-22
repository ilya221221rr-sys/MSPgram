# 📧 Шаблоны писем для Supabase (на русском)

Куда вставлять: панель Supabase → **Authentication** → **Emails** → **Templates**.

1. Открой шаблон **Confirm signup** («Подтверждение регистрации»)
2. Замени всё содержимое поля **Message** на шаблон №1 ниже → **Save**
3. Открой шаблон **Reset Password** («Сброс пароля») → вставь шаблон №2 → **Save**

Перед этим убедись, что настроен **URL Configuration** (Site URL = адрес сайта)
и SMTP — см. SETUP.md.

---

## Шаблон №1 — Confirm signup (подтверждение регистрации)

```html
<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#f4f6fb;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#1f2430;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e3e7f0;border-radius:16px;padding:32px;">
    <div style="font-size:20px;font-weight:700;">✈️ MSPgram</div>
    <h2 style="font-size:18px;margin:14px 0 8px;">Подтвердите почту</h2>
    <p style="font-size:14px;line-height:1.6;color:#4a5160;margin:0 0 20px;">
      Спасибо за регистрацию в MSPgram! Остался последний шаг —
      подтвердите адрес электронной почты, нажав кнопку ниже.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 20px;">
      <tr>
        <td style="background:#4d43d8;border-radius:10px;text-align:center;">
          <a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:12px 30px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;">Подтвердить почту</a>
        </td>
      </tr>
    </table>
    <p style="font-size:13px;line-height:1.6;color:#4a5160;margin:0 0 4px;">
      Если кнопка не работает, скопируйте ссылку в браузер:
    </p>
    <p style="font-size:12px;margin:0 0 18px;">
      <a href="{{ .ConfirmationURL }}" style="color:#4d43d8;word-break:break-all;">{{ .ConfirmationURL }}</a>
    </p>
    <p style="font-size:12px;color:#9aa1b0;margin:0;line-height:1.6;">
      Вы не регистрировались в MSPgram? Просто проигнорируйте это письмо —
      аккаунт не активируется.
    </p>
  </div>
</body>
</html>
```

---

## Шаблон №2 — Reset Password (сброс пароля)

```html
<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#f4f6fb;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#1f2430;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e3e7f0;border-radius:16px;padding:32px;">
    <div style="font-size:20px;font-weight:700;">✈️ MSPgram</div>
    <h2 style="font-size:18px;margin:14px 0 8px;">Сброс пароля</h2>
    <p style="font-size:14px;line-height:1.6;color:#4a5160;margin:0 0 20px;">
      Мы получили запрос на сброс пароля вашего аккаунта MSPgram.
      Нажмите кнопку ниже, чтобы задать новый пароль.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 20px;">
      <tr>
        <td style="background:#4d43d8;border-radius:10px;text-align:center;">
          <a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:12px 30px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;">Задать новый пароль</a>
        </td>
      </tr>
    </table>
    <p style="font-size:13px;line-height:1.6;color:#4a5160;margin:0 0 4px;">
      Если кнопка не работает, скопируйте ссылку в браузер:
    </p>
    <p style="font-size:12px;margin:0 0 18px;">
      <a href="{{ .ConfirmationURL }}" style="color:#4d43d8;word-break:break-all;">{{ .ConfirmationURL }}</a>
    </p>
    <p style="font-size:12px;color:#9aa1b0;margin:0;line-height:1.6;">
      Ссылка работает один раз и действует 1 час.<br>
      Вы не запрашивали сброс пароля? Просто проигнорируйте письмо —
      текущий пароль останется прежним.
    </p>
  </div>
</body>
</html>
```

---

## Примечания

- `{{ .ConfirmationURL }}` — подставит одноразовую ссылку. Наш сайт уже умеет
  принимать такие ссылки: подтверждение покажет «ко входу», а сброс — сразу
  форму нового пароля.
- Проверить шаблоны проще всего: зарегистрируй новый аккаунт и запроси
  сброс пароля на своей второй почте.
- Если письма не приходят — проверь раздел «Лимит писем» в SETUP.md
  (нужен свой SMTP).

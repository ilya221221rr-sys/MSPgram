// ============================================================
//  Профиль 2.0: обложка, статус, дата регистрации, QR-код,
//  блокировка и жалобы. Открывается кликом на имя/аватарку.
// ============================================================
import { state, dbApi } from './api.js';
import { esc, el, toast, relLastSeen, bus, MONTHS_RU } from './utils.js';
import { presenceLabel, isShownOnline, isFriend } from './api-v18.js';

function regDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `В MSPgram с ${MONTHS_RU[d.getMonth()]} ${d.getFullYear()}`;
}

export async function openProfile(userId) {
  if (!userId || !state.me) return;
  if (userId === state.me.id) return; // свой профиль — через настройки

  let p = null;
  try {
    p = await dbApi.loadProfile(userId);
  } catch { /* показываем ниже */ }
  if (!p) { toast('Профиль недоступен'); return; }

  const online = isShownOnline(p);
  const status = presenceLabel(p, relLastSeen);
  // приватность: «О себе», статус и обложка — только друзьям, если так выбрал человек
  const hidden = p.privacy_profile === 'friends' && !isFriend(p.id);
  const initials = (p.display_name || p.nickname || '?')[0].toUpperCase();
  const av = p.avatar_url
    ? `<img class="avatar xl pm-av" src="${esc(p.avatar_url)}" alt="">`
    : `<span class="avatar xl pm-av" style="background:linear-gradient(135deg,var(--accent),var(--accent2))">${esc(initials)}</span>`;
  const cover = (p.cover_url && !hidden)
    ? `<div class="pm-cover" style="background-image:url('${esc(p.cover_url)}')"></div>`
    : `<div class="pm-cover pm-cover-grad"></div>`;

  const m = el(`
    <div class="modal-overlay">
      <div class="modal profile-modal">
        <button class="pm-close" data-act="close" title="Закрыть">✕</button>
        ${cover}
        <div class="pm-top">
          ${av}
          <div class="pm-name">${esc(p.display_name || p.nickname)}${p.status_emoji ? ` <span class="pm-emoji">${esc(p.status_emoji)}</span>` : ''}</div>
          <div class="pm-nick">@${esc(p.nickname || '')}</div>
          ${p.status_text && !hidden ? `<div class="pm-status-text">«${esc(p.status_text)}»</div>` : ''}
          ${p.bio && !hidden ? `<div class="pm-bio">${esc(p.bio)}</div>` : ''}
          ${hidden ? '<div class="pm-bio muted">🔒 Профиль виден только друзьям</div>' : ''}
          <div class="pm-status ${online ? 'on' : ''}">${esc(status)}</div>
          <div class="pm-reg">${esc(regDate(p.created_at))}</div>
        </div>
        <div class="pm-actions">
          <button class="btn primary" data-act="msg">💬 Написать</button>
          <button class="btn ghost" data-act="friend">＋ В друзья</button>
          <button class="btn ghost" data-act="qr" title="QR-код профиля">🔲 QR</button>
        </div>
        <div class="pm-sub-actions">
          <button class="pm-link" data-act="block">🚫 Заблокировать</button>
          <span class="pm-sep">·</span>
          <button class="pm-link" data-act="report">🚩 Пожаловаться</button>
        </div>
        <div class="form-error" id="pm-error"></div>
      </div>
    </div>`);

  document.querySelector('#modal-root').appendChild(m);
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-act=close]')) m.remove();
  });

  m.querySelector('[data-act=msg]').addEventListener('click', async () => {
    try {
      const chatId = await dbApi.startDirect(userId);
      m.remove();
      bus.emit('open-chat', chatId);
      import('./chatlist.js').then((mod) => mod.renderChatList()).catch(() => {});
    } catch (e) {
      qs2('#pm-error', m).textContent = e.message;
    }
  });

  m.querySelector('[data-act=qr]').addEventListener('click', () => showQr(p, m));

  // друзья: кнопка меняется по статусу (нет / заявка отправлена / входящая / друг)
  const fbtn = m.querySelector('[data-act=friend]');
  let fst = { state: 'none' };
  const paintFriend = () => {
    fbtn.textContent = { none: '＋ В друзья', outgoing: '⏳ Заявка отправлена', incoming: '✓ Принять заявку', friends: '✓ В друзьях' }[fst.state];
    fbtn.classList.toggle('active-friend', fst.state === 'friends');
  };
  dbApi.friendStatus(userId).then((r) => { fst = r; paintFriend(); }).catch(() => {});
  fbtn.addEventListener('click', async () => {
    try {
      if (fst.state === 'none') {
        const r = await dbApi.friendRequest(userId);
        toast(r === 'friends' ? 'Теперь вы друзья 🎉' : 'Заявка отправлена ✓');
      } else if (fst.state === 'incoming') {
        await dbApi.friendRespond(fst.id, true); toast('Теперь вы друзья 🎉');
      } else if (fst.state === 'friends') {
        if (!window.confirm('Удалить из друзей?')) return;
        await dbApi.friendRemove(userId); toast('Удалён из друзей');
      } else { await dbApi.friendRemove(userId); toast('Заявка отменена'); }
      fst = await dbApi.friendStatus(userId); paintFriend();
    } catch (err) { qs2('#pm-error', m).textContent = err.message; }
  });

  m.querySelector('[data-act=block]').addEventListener('click', async (e) => {
    const blocks = await dbApi.myBlocks();
    const isBlocked = blocks.has(userId);
    if (!isBlocked && !window.confirm(`Заблокировать ${p.display_name || p.nickname}? Он(а) не сможет писать тебе.`)) return;
    try {
      await dbApi.setBlock(userId, !isBlocked);
      e.target.textContent = isBlocked ? '🚫 Заблокировать' : '✅ Разблокировать';
      toast(isBlocked ? 'Разблокирован ✓' : 'Заблокирован ✓');
    } catch (err) { qs2('#pm-error', m).textContent = err.message; }
  });

  m.querySelector('[data-act=report]').addEventListener('click', async () => {
    const reason = window.prompt('Что нарушает этот пользователь? Опиши коротко:', '') ?? null;
    if (reason === null) return;
    try {
      await dbApi.createReport(userId, reason.trim() || 'без причины');
      toast('Жалоба отправлена ✓ Админ рассмотрит её');
    } catch (err) { qs2('#pm-error', m).textContent = err.message; }
  });
}

// ---------- QR-код профиля ----------
export function showQr(p, parent) {
  const link = `${location.origin}${location.pathname}?add=${p.id}`;
  const q = el(`
    <div class="modal-overlay">
      <div class="modal center qr-modal">
        <h3>QR-код профиля</h3>
        <p class="modal-text">Пусть отсканирует камерой телефона —<br>профиль откроется сразу</p>
        <div class="qr-box" id="qr-box"></div>
        <div class="invite-link">${esc(link)}</div>
        <div class="modal-actions">
          <button class="btn ghost" data-act="close">Закрыть</button>
        </div>
      </div>
    </div>`);
  document.querySelector('#modal-root').appendChild(q);
  q.addEventListener('click', (e) => {
    if (e.target === q || e.target.closest('[data-act=close]')) q.remove();
  });
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    const box = q.querySelector('#qr-box');
    const imgTag = qr.createImgTag(6, 8);
    box.innerHTML = imgTag;
    const img = box.querySelector('img');
    if (img) { img.style.width = '200px'; img.style.height = '200px'; img.style.borderRadius = '12px'; }
  } catch (e) {
    q.querySelector('#qr-box').textContent = 'QR недоступен';
  }
}

function qs2(sel, root) { return root.querySelector(sel); }

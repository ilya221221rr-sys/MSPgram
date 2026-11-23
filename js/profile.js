// ============================================================
//  Профиль пользователя: модальное окно (открывается кликом
//  на аватарку/имя в сообщениях, шапке чата и поиске)
// ============================================================
import { state, dbApi } from './api.js';
import { esc, el, toast, relLastSeen, bus } from './utils.js';

export async function openProfile(userId) {
  if (!userId || !state.me) return;
  if (userId === state.me.id) return; // свой профиль — через настройки

  let p = null;
  try {
    p = await dbApi.loadProfile(userId);
  } catch { /* показываем ниже */ }
  if (!p) { toast('Профиль недоступен'); return; }

  const online = state.online.has(userId);
  const status = online ? 'онлайн' : relLastSeen(p.last_seen, false);
  const av = p.avatar_url
    ? `<img class="avatar xl pm-av" src="${esc(p.avatar_url)}" alt="">`
    : `<span class="avatar xl pm-av" style="background:linear-gradient(135deg,var(--accent),var(--accent2))">${esc((p.display_name || p.nickname || '?')[0].toUpperCase())}</span>`;

  const m = el(`
    <div class="modal-overlay">
      <div class="modal profile-modal">
        <button class="pm-close" data-act="close" title="Закрыть">✕</button>
        <div class="pm-top">
          ${av}
          <div class="pm-name">${esc(p.display_name || p.nickname)}</div>
          <div class="pm-nick">@${esc(p.nickname || '')}</div>
          <div class="pm-status ${online ? 'on' : ''}">${esc(status)}</div>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" data-act="close">Закрыть</button>
          <button class="btn primary" data-act="msg">💬 Написать</button>
        </div>
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
      // новая строка чата в списке
      import('./chatlist.js').then((mod) => mod.renderChatList()).catch(() => {});
    } catch (e) {
      toast('Не получилось: ' + e.message);
    }
  });
}

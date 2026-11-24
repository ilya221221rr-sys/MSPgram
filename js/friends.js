// Друзья: список, заявки, поиск и добавление, мой QR
import { state, dbApi } from './api.js?v=26';
import { qs, esc, el, toast, avatarHTML, bus, relLastSeen, debounce } from './utils.js';
import { presenceLabel, presenceKind } from './api-v18.js';
import { openProfile, showQr } from './profile.js';
import { icon } from './icons.js';

export async function openFriends(tab = 'friends') {
  if (!state.me) return;
  const m = el(`
    <div class="modal-overlay">
      <div class="modal friends-modal">
        <div class="modal-head"><h3>Друзья</h3>
          <button class="icon-btn" data-act="qr" title="Мой QR-код">▦</button></div>
        <div class="seg" id="fr-tabs">
          <button data-t="friends">Друзья</button>
          <button data-t="requests">Заявки <span class="seg-badge hidden" id="fr-badge"></span></button>
          <button data-t="add">Добавить</button>
        </div>
        <div class="fr-body" id="fr-body"><div class="list-empty">Загружаю…</div></div>
        <div class="modal-actions"><button class="btn ghost" data-act="close">Закрыть</button></div>
      </div>
    </div>`);
  document.querySelector('#modal-root').appendChild(m);
  const body = qs('#fr-body', m);
  let data = { friends: [], incoming: [], outgoing: [] };
  let cur = tab;

  const row = (p, right) => {
    const kind = presenceKind(p);
    const r = el(`<div class="person-row">
      ${avatarHTML(p.avatar_url, p.display_name || p.nickname, 'md', false)}
      <div class="chat-row-main">
        <div class="chat-row-top"><span class="chat-row-title">${esc(p.display_name || p.nickname)}</span>
          <span class="person-status ${kind ? 'on' : ''}">${esc(presenceLabel(p, relLastSeen))}</span></div>
        <div class="chat-row-bottom"><span class="chat-row-preview">@${esc(p.nickname)}</span></div>
      </div><div class="fr-actions"></div></div>`);
    right.forEach((b) => r.querySelector('.fr-actions').appendChild(b));
    r.querySelector('.chat-row-main').addEventListener('click', () => { m.remove(); openProfile(p.id); });
    r.querySelector('.avatar').addEventListener('click', () => { m.remove(); openProfile(p.id); });
    return r;
  };
  const btn = (label, cls, fn, title = '') => {
    const b = el(`<button class="btn ${cls} sm" title="${esc(title)}">${label}</button>`);
    b.addEventListener('click', async (e) => {
      e.stopPropagation(); b.disabled = true;
      try { await fn(); } catch (err) { toast('Ошибка: ' + err.message); b.disabled = false; }
    });
    return b;
  };

  const draw = async () => {
    qs('#fr-tabs', m).querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.t === cur));
    const badge = qs('#fr-badge', m);
    badge.textContent = data.incoming.length; badge.classList.toggle('hidden', !data.incoming.length);
    body.innerHTML = '';
    if (cur === 'friends') {
      if (!data.friends.length) { body.innerHTML = '<div class="list-empty">Пока нет друзей 🙂<br>Открой вкладку «Добавить» и найди человека по нику.</div>'; return; }
      data.friends.sort((a, b) => Number(state.online.has(b.profile.id)) - Number(state.online.has(a.profile.id)));
      data.friends.forEach((f) => body.appendChild(row(f.profile, [
        btn(icon('chat', 16), 'primary', async () => { const id = await dbApi.startDirect(f.profile.id); m.remove(); bus.emit('open-chat', id); }, 'Написать'),
        btn('✕', 'ghost', async () => { await dbApi.friendRemove(f.profile.id); data = await dbApi.loadFriends(); draw(); toast('Удалён из друзей'); }, 'Удалить из друзей'),
      ])));
    } else if (cur === 'requests') {
      if (!data.incoming.length && !data.outgoing.length) { body.innerHTML = '<div class="list-empty">Заявок нет</div>'; return; }
      if (data.incoming.length) body.appendChild(el('<div class="search-section">Входящие</div>'));
      data.incoming.forEach((r) => body.appendChild(row(r.profile, [
        btn('Принять', 'primary', async () => { await dbApi.friendRespond(r.id, true); data = await dbApi.loadFriends(); draw(); toast('Теперь вы друзья 🎉'); }),
        btn('✕', 'ghost', async () => { await dbApi.friendRespond(r.id, false); data = await dbApi.loadFriends(); draw(); }, 'Отклонить'),
      ])));
      if (data.outgoing.length) body.appendChild(el('<div class="search-section">Отправленные</div>'));
      data.outgoing.forEach((r) => body.appendChild(row(r.profile, [
        btn('Отменить', 'ghost', async () => { await dbApi.friendRemove(r.profile.id); data = await dbApi.loadFriends(); draw(); }),
      ])));
    } else {
      body.innerHTML = '<input class="fr-search" placeholder="Ник или имя…" autocomplete="off"><div id="fr-res"></div>';
      const inp = qs('.fr-search', body); const res = qs('#fr-res', body);
      inp.addEventListener('input', debounce(async () => {
        const q = inp.value.trim(); res.innerHTML = '';
        if (!q) return;
        const people = await dbApi.searchUsers(q).catch(() => []);
        if (!people.length) { res.innerHTML = '<div class="list-empty">Никого не нашлось</div>'; return; }
        people.forEach((p) => {
          const isF = state.friends.has(p.id);
          const pend = data.outgoing.some((x) => x.profile.id === p.id);
          const inc = data.incoming.find((x) => x.profile.id === p.id);
          const b = isF ? btn('Друг ✓', 'ghost', async () => {})
            : pend ? btn('Заявка отправлена', 'ghost', async () => {})
              : btn(inc ? 'Принять' : '＋ В друзья', 'primary', async () => {
                const st = await dbApi.friendRequest(p.id);
                data = await dbApi.loadFriends(); toast(st === 'friends' ? 'Теперь вы друзья 🎉' : 'Заявка отправлена ✓'); draw();
              });
          if (isF || pend) b.disabled = true;
          res.appendChild(row(p, [b]));
        });
      }, 250));
      setTimeout(() => inp.focus(), 50);
    }
  };

  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-act=close]')) m.remove();
    if (e.target.closest('[data-act=qr]')) showQr(state.me, m);
    const t = e.target.closest('#fr-tabs button'); if (t) { cur = t.dataset.t; draw(); }
  });
  data = await dbApi.loadFriends();
  draw();
}

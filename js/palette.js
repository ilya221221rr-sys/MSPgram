// ============================================================
//  Быстрый переход (Ctrl/⌘ + K): чаты и команды в одном окне
// ============================================================
import { state, chatTitleFor, dbApi } from './api.js?v=26';
import { qs, esc, el, bus, toast, avatarHTML, getPrefs, setPrefs } from './utils.js';

const click = (sel) => () => qs(sel)?.click();

function commands() {
  const c = [
    { ic: '⚙', t: 'Настройки', k: 'settings nastroyki', run: click('#settings-btn') },
    { ic: '🔖', t: 'Избранное', k: 'saved izbrannoe', run: click('#saved-btn') },
    { ic: '✨', t: 'MSP AI — ассистент', k: 'ai ii assistant', run: click('#nav-ai') },
    { ic: '👥', t: 'Друзья', k: 'friends druzya', run: click('#nav-friends') },
    { ic: '➕', t: 'Новая группа или сервер', k: 'new group', run: click('#new-group-btn') },
    { ic: '📁', t: 'Новая папка чатов', k: 'folder papka', run: () => import('./folders.js').then((m) => m.openFolderEditor(null, () => import('./chatlist.js').then((x) => x.renderChatList()))) },
    { ic: '🩺', t: 'Диагностика ИИ', k: 'diag ai ошибка 404', run: () => import('./ai-diag.js').then((m) => m.openAiDiag()) },
    { ic: '🌓', t: 'Переключить светлую/тёмную тему', k: 'theme tema dark light', run: async () => {
      const cur = document.documentElement.dataset.theme; setPrefs({ theme: cur === 'light' ? 'dark' : 'light' });
      (await import('./settings.js')).applyPrefs();
    } },
    { ic: '✓✓', t: 'Прочитать все чаты', k: 'read all prochitat', run: async () => {
      const ids = [...state.unread.entries()].filter(([, n]) => n > 0).map(([id]) => id);
      for (const id of ids) { try { await dbApi.markRead(id); state.unread.delete(id); } catch { /* */ } }
      import('./chatlist.js').then((x) => x.renderChatList()); toast(ids.length ? 'Всё прочитано ✓' : 'Непрочитанных нет');
    } },
  ];
  if (state.me?.is_admin || state.me?.is_moderator) c.push({ ic: '🛡', t: 'Админ-панель', k: 'admin adminka', run: () => import('./admin.js').then((m) => m.openAdminPanel()) });
  return c;
}

export function openPalette() {
  if (qs('#palette') || !state.me) return;
  const m = el(`<div class="modal-overlay palette-overlay" id="palette"><div class="palette">
    <input id="pal-q" type="text" placeholder="Куда перейти? Чат, человек или команда…" autocomplete="off" spellcheck="false">
    <div class="pal-list" id="pal-list"></div>
    <div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> выбор</span><span><kbd>Enter</kbd> открыть</span><span><kbd>Esc</kbd> закрыть</span></div></div></div>`);
  qs('#modal-root').appendChild(m);
  const input = qs('#pal-q', m); const list = qs('#pal-list', m);
  let items = []; let sel = 0;
  const build = () => {
    const q = input.value.trim().toLowerCase();
    const chats = [...state.chats.values()].sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at))
      .map((ch) => ({ ch, t: chatTitleFor(ch) }))
      .filter((x) => !q || x.t.toLowerCase().includes(q))
      .slice(0, q ? 12 : 8)
      .map((x) => ({ chat: true, t: x.t, sub: x.ch.last_message_text || (x.ch.type === 'group' ? 'Сообщество' : 'Личный чат'), ch: x.ch,
        run: () => bus.emit('open-chat', x.ch.id) }));
    const cmds = commands().filter((c) => !q || c.t.toLowerCase().includes(q) || c.k.includes(q));
    items = [...chats, ...cmds]; sel = Math.min(sel, Math.max(0, items.length - 1));
    list.innerHTML = items.map((it, i) => `<div class="pal-item${i === sel ? ' on' : ''}" data-i="${i}">
      ${it.chat ? avatarHTML(it.ch.avatar_url, it.t, 'sm', false) : `<span class="pal-ic">${it.ic}</span>`}
      <div class="pal-main"><b>${esc(it.t)}</b>${it.sub ? `<span>${esc(String(it.sub).slice(0, 70))}</span>` : '<span>Команда</span>'}</div></div>`).join('')
      || '<div class="adm-empty">Ничего не найдено</div>';
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => m.remove();
  const run = (i) => { const it = items[i]; if (!it) return; close(); setTimeout(() => it.run(), 30); };
  input.addEventListener('input', () => { sel = 0; build(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % Math.max(1, items.length); build(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % Math.max(1, items.length); build(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
    else if (e.key === 'Escape') close();
  });
  list.addEventListener('click', (e) => { const r = e.target.closest('[data-i]'); if (r) run(Number(r.dataset.i)); });
  m.addEventListener('click', (e) => { if (e.target === m) close(); });
  build(); input.focus();
}
export const hasPrefsTheme = () => getPrefs().theme;

// ============================================================
//  Папки чатов (как в Telegram): свои вкладки над списком чатов.
//  Хранятся на устройстве (localStorage), счётчики непрочитанных — на вкладке.
// ============================================================
import { state, chatTitleFor } from './api.js?v=26';
import { qs, esc, el, toast, getPrefs, setPrefs, avatarHTML } from './utils.js';

export const getFolders = () => (getPrefs().folders || []).filter((f) => f && f.id);
const saveFolders = (arr) => setPrefs({ folders: arr });
export const folderExists = (key) => getFolders().some((f) => `f:${f.id}` === key);

export function inFolder(key, chat) {
  const f = getFolders().find((x) => `f:${x.id}` === key);
  return !!f && (f.ids || []).includes(chat.id);
}

/** HTML вкладок-папок (после стандартных фильтров) */
export function folderChipsHTML(active) {
  const unreadOf = (f) => (f.ids || []).reduce((a, id) => a + (state.unread.get(id) || 0), 0);
  const chips = getFolders().map((f) => {
    const u = unreadOf(f);
    return `<button class="lf-chip folder${active === `f:${f.id}` ? ' on' : ''}" data-f="f:${esc(f.id)}">${esc(f.emoji || '📁')} ${esc(f.name)}${u ? ` <b>${u > 99 ? '99+' : u}</b>` : ''}</button>`;
  }).join('');
  const edit = active.startsWith('f:') ? '<button class="lf-chip tool" data-f="__edit" title="Изменить папку">✎</button>' : '';
  return `${chips}${edit}<button class="lf-chip tool" data-f="__new" title="Новая папка">＋</button>`;
}

export function openFolderEditor(folderId, onDone) {
  const all = getFolders();
  const cur = all.find((f) => f.id === folderId) || { id: Math.random().toString(36).slice(2, 9), name: '', emoji: '📁', ids: [] };
  const isNew = !all.some((f) => f.id === cur.id);
  const chats = [...state.chats.values()].sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
  const chosen = new Set(cur.ids || []);
  const m = el(`<div class="modal-overlay"><div class="modal folder-modal">
    <h3>${isNew ? 'Новая папка' : 'Папка'}</h3>
    <div class="folder-top"><input id="fo-emoji" maxlength="2" value="${esc(cur.emoji)}" class="fo-emoji" aria-label="Эмодзи"><input id="fo-name" maxlength="20" placeholder="Название (Работа, Друзья…)" value="${esc(cur.name)}"></div>
    <input id="fo-q" type="search" placeholder="Найти чат…" class="fo-q">
    <div class="fo-list" id="fo-list"></div>
    <div class="modal-actions">${isNew ? '' : '<button class="btn danger" data-act="del" style="margin-right:auto">Удалить</button>'}
      <button class="btn ghost" data-act="close">Отмена</button><button class="btn primary" data-act="save">Сохранить</button></div></div></div>`);
  qs('#modal-root').appendChild(m);
  const list = qs('#fo-list', m);
  const draw = () => {
    const q = qs('#fo-q', m).value.trim().toLowerCase();
    list.innerHTML = chats.filter((c) => !q || chatTitleFor(c).toLowerCase().includes(q)).map((c) => `
      <label class="fo-item"><input type="checkbox" data-id="${c.id}" ${chosen.has(c.id) ? 'checked' : ''}>
      ${avatarHTML(c.avatar_url, chatTitleFor(c), 'sm', false)}<span>${esc(chatTitleFor(c))}</span></label>`).join('') || '<div class="adm-empty">Чатов нет</div>';
  };
  draw();
  qs('#fo-q', m).addEventListener('input', draw);
  list.addEventListener('change', (e) => { const id = e.target.dataset.id; if (!id) return; e.target.checked ? chosen.add(id) : chosen.delete(id); });
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-act=close]')) m.remove();
    if (e.target.closest('[data-act=del]')) { saveFolders(all.filter((f) => f.id !== cur.id)); m.remove(); toast('Папка удалена'); onDone?.('all'); }
    if (e.target.closest('[data-act=save]')) {
      const name = qs('#fo-name', m).value.trim();
      if (!name) { toast('Введи название папки'); return; }
      const next = { ...cur, name, emoji: qs('#fo-emoji', m).value.trim() || '📁', ids: [...chosen] };
      saveFolders(isNew ? [...all, next] : all.map((f) => (f.id === cur.id ? next : f)));
      m.remove(); toast('Папка сохранена ✓'); onDone?.(`f:${next.id}`);
    }
  });
  setTimeout(() => qs('#fo-name', m).focus(), 50);
}

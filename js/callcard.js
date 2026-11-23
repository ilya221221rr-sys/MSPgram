// ============================================================
//  История звонков в чате (v20)
//  Звонок записывается в чат обычным сообщением attachment_type='call':
//    attachment_name = '<итог>:<audio|video>', duration_ms = длительность.
//  Миграция БД не нужна. Итоги: ended | missed | cancelled | declined | busy | failed
// ============================================================
import { esc, fmtTime, fmtDuration } from './utils.js';
import { icon } from './icons.js';

export function parseCall(m) {
  const [o = 'ended', k = 'audio'] = String(m.attachment_name || '').split(':');
  return { outcome: o, kind: k === 'video' ? 'video' : 'audio' };
}

/** Текст сообщения (виден в списке чатов и уведомлениях) */
export function callBody(outcome, kind, durMs = 0) {
  const v = kind === 'video';
  if (outcome === 'ended') return `${v ? '📹 Видеозвонок' : '📞 Звонок'} · ${fmtDuration(durMs / 1000)}`;
  if (outcome === 'missed') return v ? '📹 Пропущенный видеозвонок' : '📞 Пропущенный звонок';
  if (outcome === 'cancelled') return v ? '📹 Видеозвонок отменён' : '📞 Звонок отменён';
  if (outcome === 'declined') return v ? '📹 Видеозвонок отклонён' : '📞 Звонок отклонён';
  if (outcome === 'busy') return '📞 Собеседник был занят';
  return '📞 Не удалось соединиться';
}

function titleOf(outcome, kind, own) {
  const v = kind === 'video' ? 'видеозвонок' : 'звонок';
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  if (outcome === 'ended') return own ? `Исходящий ${v}` : `Входящий ${v}`;
  if (outcome === 'missed') return own ? 'Нет ответа' : `Пропущенный ${v}`;
  if (outcome === 'cancelled') return own ? `Отменённый ${v}` : `Пропущенный ${v}`;
  if (outcome === 'declined') return own ? 'Собеседник отклонил' : `Вы отклонили ${v}`;
  if (outcome === 'busy') return own ? 'Собеседник занят' : `Пропущенный ${v}`;
  return cap('не удалось соединиться');
}

/** Карточка звонка в ленте сообщений */
export function callCardHTML(m, meId) {
  const own = m.sender_id === meId;
  const { outcome, kind } = parseCall(m);
  const bad = outcome !== 'ended' && !(own && outcome === 'cancelled') && !(own && outcome === 'declined');
  const missedForMe = !own && outcome !== 'ended' && outcome !== 'declined';
  const cls = outcome === 'ended' ? 'ok' : (missedForMe || outcome === 'failed') ? 'bad' : 'neutral';
  const dir = own ? '↗' : '↙';
  const dur = outcome === 'ended' && m.duration_ms ? ` · ${fmtDuration(m.duration_ms / 1000)}` : '';
  void bad;
  return `
    <div class="msg-row call-row" data-id="${esc(m.id)}">
      <div class="call-card ${cls}">
        <span class="cc-ic">${icon(kind === 'video' ? 'video' : 'phone', 20)}</span>
        <span class="cc-txt">
          <b>${esc(titleOf(outcome, kind, own))}</b>
          <span><i class="cc-dir">${dir}</i> ${esc(fmtTime(m.created_at))}${esc(dur)}</span>
        </span>
        <button class="cc-again" data-recall="${kind}" title="Позвонить ещё раз">${icon(kind === 'video' ? 'video' : 'phone', 18)}</button>
      </div>
    </div>`;
}

// 信用：由未撤销的 credit_events 实时计算（docs/api.md 3.1）。
import { clock, DAY } from '../clock.js';
import { CREDIT_TYPE_LABELS } from '../constants.js';
import { conflict } from '../errors.js';
import { notify } from './notices.js';

export const CREDIT_TYPES = ['attended', 'late', 'cancel_late', 'no_show', 'admin_adjust'];
const MONTH = 30 * DAY;

/** 用户当前是否处于受限 / 封禁（受限到期后自动视为 active） */
export function effectiveStatus(user, now = clock.now()) {
  if (!user) return 'active';
  if (user.status === 'restricted' && user.restricted_until && user.restricted_until <= now.toISOString()) {
    return 'active';
  }
  return user.status;
}

/** 纯计算：计数 → 履约率与等级 */
export function computeCredit({ attended = 0, late = 0, cancelLate = 0, noShow = 0, recentNoShow = 0, status = 'active' }) {
  const kept = attended + late;
  const total = kept + cancelLate + noShow;
  const rate = total === 0 ? 100 : Math.round((kept / total) * 100);
  let level = 'good';
  if (status === 'restricted' || status === 'banned' || recentNoShow >= 2) level = 'restricted';
  else if (rate < 90 || recentNoShow >= 1) level = 'fair';
  return { rate, level, attended, late, cancelLate, noShow, eventsCount: kept };
}

export function creditCounts(db, userId, now = clock.now()) {
  const row = db.get(
    `SELECT
       COALESCE(SUM(type = 'attended'), 0) AS attended,
       COALESCE(SUM(type = 'late'), 0) AS late,
       COALESCE(SUM(type = 'cancel_late'), 0) AS cancelLate,
       COALESCE(SUM(type = 'no_show'), 0) AS noShow,
       COALESCE(SUM(type = 'no_show' AND created_at >= :since), 0) AS recentNoShow
     FROM credit_events WHERE user_id = :userId AND revoked = 0`,
    { userId, since: new Date(now.getTime() - MONTH).toISOString() },
  );
  return {
    attended: Number(row.attended),
    late: Number(row.late),
    cancelLate: Number(row.cancelLate),
    noShow: Number(row.noShow),
    recentNoShow: Number(row.recentNoShow),
  };
}

/** 用户的信用（Me.credit 的形状） */
export function creditOf(db, user, now = clock.now()) {
  const counts = creditCounts(db, user.id, now);
  return computeCredit({ ...counts, status: effectiveStatus(user, now) });
}

export function creditEventView(row) {
  return {
    id: row.id,
    type: row.type,
    typeLabel: CREDIT_TYPE_LABELS[row.type] || row.type,
    source: row.source,
    note: row.note,
    eventId: row.event_id,
    eventTitle: row.event_title ?? null,
    revoked: Boolean(row.revoked),
    createdAt: row.created_at,
    appeal: row.appeal_status ? { id: row.appeal_id, status: row.appeal_status } : null,
  };
}

export function listCreditEvents(db, userId) {
  return db
    .all(
      `SELECT c.*, e.title AS event_title,
         (SELECT a.status FROM appeals a WHERE a.credit_event_id = c.id ORDER BY a.id DESC LIMIT 1) AS appeal_status,
         (SELECT a.id FROM appeals a WHERE a.credit_event_id = c.id ORDER BY a.id DESC LIMIT 1) AS appeal_id
       FROM credit_events c LEFT JOIN events e ON e.id = c.event_id
       WHERE c.user_id = ? ORDER BY c.created_at DESC, c.id DESC`,
      userId,
    )
    .map(creditEventView);
}

/** 新增一条信用记录（系统 / 后台） */
export function addCreditEvent(db, { userId, eventId = null, type, source, note = null }) {
  const id = db.insert('credit_events', {
    user_id: userId,
    event_id: eventId,
    type,
    source,
    note,
    revoked: 0,
    created_at: clock.iso(),
  });
  if (type === 'no_show') checkAutoRestrict(db, userId);
  return id;
}

/**
 * 同一人同一局只保留一条（后台手动记录除外）：已有同类型记录则保持不变（保留撤销状态），
 * 类型变了就覆盖。返回是否有变化。
 */
export function upsertEventCredit(db, { userId, eventId, type, source, note = null }) {
  const existing = db.get(
    "SELECT * FROM credit_events WHERE user_id = ? AND event_id = ? AND source != 'admin' ORDER BY id LIMIT 1",
    userId,
    eventId,
  );
  if (existing) {
    if (existing.type === type) return false;
    db.update('credit_events', existing.id, { type, source, note, revoked: 0 });
  } else {
    db.insert('credit_events', {
      user_id: userId,
      event_id: eventId,
      type,
      source,
      note,
      revoked: 0,
      created_at: clock.iso(),
    });
  }
  if (type === 'no_show') checkAutoRestrict(db, userId);
  return true;
}

/** 一个月内放鸽子 ≥ 2 次 → 自动受限 7 天 */
export function checkAutoRestrict(db, userId) {
  const user = db.get('SELECT * FROM users WHERE id = ?', userId);
  if (!user || effectiveStatus(user) !== 'active') return false;
  const { recentNoShow } = creditCounts(db, userId);
  if (recentNoShow < 2) return false;
  restrictUser(db, userId, 7, '一个月内放鸽子 2 次');
  return true;
}

/**
 * 限制账号 days 天（暂停撮合和报名）。reason 存进 users.restricted_reason（后台可见）；
 * 通知正文默认是「原因：…。到期后自动恢复。」，传了 message 就用 message。
 * 已封禁的账号不能「降级」成受限：抛 CONFLICT，先解封再处理。
 */
export function restrictUser(db, userId, days, reason, { message = null } = {}) {
  const user = db.get('SELECT status FROM users WHERE id = ?', userId);
  if (user?.status === 'banned') throw conflict('账号已封禁，先解封再处理');
  const until = new Date(clock.now().getTime() + days * DAY).toISOString();
  db.update('users', userId, { status: 'restricted', restricted_until: until, restricted_reason: reason || null });
  notify(db, userId, {
    type: 'restricted',
    title: `账号暂停撮合和报名 ${days} 天`,
    body: message || (reason ? `原因：${reason}。到期后自动恢复。` : '到期后自动恢复。'),
    link: 'credit',
  });
  return until;
}

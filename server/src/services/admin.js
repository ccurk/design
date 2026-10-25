// 后台：数据概览、局管理、用户管理。
import { clock, DAY } from '../clock.js';
import { json } from '../db.js';
import { conflict, invalid, notFound } from '../errors.js';
import { addDays, bjDate, bjDayRange } from '../time.js';
import { int, oneOf, str } from '../validate.js';
import { aaSummary } from './aa.js';
import { listAppeals } from './appeals.js';
import { messageView } from './chat.js';
import {
  CREDIT_TYPES,
  addCreditEvent,
  creditOf,
  effectiveStatus,
  listCreditEvents,
  restrictUser,
} from './credit.js';
import { cancelEvent, endAt, eventCard, eventDetail, phaseOf, requireEvent } from './events.js';
import { notify } from './notices.js';
import { adminReportView, banUser, reportCountAgainst } from './reports.js';
import { maskPhone, requireUserRow, userBrief, userSettings } from './users.js';

// ---- 数据概览 ----

const count = (db, sql, ...params) => Number(db.get(sql, ...params).n);

export function stats(db) {
  const now = clock.now();
  const today = bjDate(now);
  const [start, end] = bjDayRange(today);
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString();

  const credit = db.get(
    `SELECT COALESCE(SUM(type IN ('attended', 'late')), 0) AS kept,
            COALESCE(SUM(type IN ('attended', 'late', 'cancel_late', 'no_show')), 0) AS total,
            COALESCE(SUM(type = 'no_show'), 0) AS noShow
     FROM credit_events WHERE revoked = 0 AND created_at >= ?`,
    weekAgo,
  );
  const ended = db
    .all("SELECT * FROM events WHERE status IN ('open', 'formed') AND start_at >= ? AND start_at <= ?", new Date(now.getTime() - 9 * DAY).toISOString(), now.toISOString())
    .filter((e) => phaseOf(e, now) === 'ended' && endAt(e).toISOString() >= weekAgo).length;

  const series = [];
  for (let i = 6; i >= 0; i--) {
    const date = addDays(today, -i);
    const [s, e] = bjDayRange(date);
    series.push({
      date,
      formed: count(db, 'SELECT COUNT(*) AS n FROM events WHERE formed_at >= ? AND formed_at < ?', s, e),
      newUsers: count(db, 'SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?', s, e),
    });
  }

  return {
    today: {
      newUsers: count(db, 'SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?', start, end),
      newIntents: count(db, 'SELECT COUNT(*) AS n FROM intents WHERE created_at >= ? AND created_at < ?', start, end),
      formed: count(db, 'SELECT COUNT(*) AS n FROM events WHERE formed_at >= ? AND formed_at < ?', start, end),
      pendingProposals: count(db, "SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'"),
      pendingReports: count(db, "SELECT COUNT(*) AS n FROM reports WHERE status = 'pending'"),
      pendingPosts: count(db, "SELECT COUNT(*) AS n FROM posts WHERE status = 'pending'"),
      pendingEvents: count(db, "SELECT COUNT(*) AS n FROM events WHERE status = 'pending_review'"),
    },
    week: {
      attendanceRate: Number(credit.total) ? Math.round((Number(credit.kept) / Number(credit.total)) * 100) : 100,
      noShowCount: Number(credit.noShow),
      eventsEnded: ended,
    },
    series,
  };
}

// ---- 局 ----

function eventReportCount(db, eventId) {
  return count(db, "SELECT COUNT(*) AS n FROM reports WHERE target_type = 'event' AND target_id = ?", eventId);
}

function adminEventExtras(db, e) {
  return {
    creator: e.creator_id ? userBrief(db, e.creator_id) : null,
    createdAt: e.created_at,
    reportCount: eventReportCount(db, e.id),
    flags: json.parse(e.moderation, []),
    reviewNote: e.review_note,
    cancelReason: e.cancel_reason,
    formedAt: e.formed_at,
  };
}

export function adminListEvents(db, { status, source, q } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (source) {
    where.push('source = ?');
    params.push(source);
  }
  if (q) {
    where.push('(title LIKE ? OR place LIKE ? OR task LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const rows = db.all(
    `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY start_at DESC LIMIT 300`,
    ...params,
  );
  return { items: rows.map((e) => ({ ...eventCard(db, e), ...adminEventExtras(db, e) })) };
}

export function adminEventDetail(db, id) {
  const e = requireEvent(db, id);
  const members = db.all(
    "SELECT * FROM event_members WHERE event_id = ? ORDER BY (role = 'host') DESC, joined_at, invited_at, user_id",
    id,
  );
  const cache = new Map();
  const messages = db
    .all('SELECT * FROM messages WHERE event_id = ? ORDER BY id DESC LIMIT 50', id)
    .reverse()
    .map((m) => messageView(db, m, null, cache));
  const aa = aaSummary(db, e, null);
  return {
    event: { ...eventDetail(db, e, null), ...adminEventExtras(db, e) },
    members: members.map((m) => ({
      ...userBrief(db, m.user_id),
      role: m.role,
      status: m.status,
      attendance: m.attendance,
      arrivedAt: m.arrived_at,
      safeAt: m.safe_at,
      invitedAt: m.invited_at,
      joinedAt: m.joined_at,
      leftAt: m.left_at,
    })),
    messages,
    aa: { total: aa.total, each: aa.each, itemCount: aa.items.length },
    reports: db
      .all("SELECT * FROM reports WHERE target_type = 'event' AND target_id = ? ORDER BY id DESC", id)
      .map((r) => adminReportView(db, r)),
  };
}

export function reviewUserEvent(db, id, approve, note = null) {
  return db.tx(() => {
    const e = requireEvent(db, id);
    if (e.status !== 'pending_review') throw conflict('这个局不在待审核状态');
    db.update('events', id, { status: approve ? 'open' : 'rejected', review_note: note });
    if (e.creator_id) {
      notify(db, e.creator_id, {
        type: approve ? 'event_approved' : 'event_rejected',
        title: approve ? '你发起的局通过审核了' : '你发起的局没有通过审核',
        body: approve ? `「${e.title}」已经出现在广场上` : note || '内容可能包含联系方式、广告或不当信息，修改后可以重新发起',
        link: `event:${id}`,
      });
    }
    return { ok: true, status: approve ? 'open' : 'rejected' };
  });
}

export function adminCancelEvent(db, id, reason) {
  return db.tx(() => {
    const e = requireEvent(db, id);
    if (['cancelled', 'rejected'].includes(e.status)) throw conflict('这个局已经取消了');
    const why = str(reason, '取消原因', { min: 1, max: 100 });
    cancelEvent(db, e, { reason: why, byAdmin: true });
    return { ok: true, status: 'cancelled' };
  });
}

// ---- 用户 ----

export function adminUserBrief(db, u) {
  return {
    ...userBrief(db, u),
    phoneMasked: maskPhone(u.phone),
    status: effectiveStatus(u),
    credit: creditOf(db, u),
    createdAt: u.created_at,
    reportCount: reportCountAgainst(db, u.id),
  };
}

export function adminListUsers(db, { q, level, status } = {}) {
  const params = [];
  let where = '';
  if (q) {
    where = 'WHERE nickname LIKE ? OR phone LIKE ? OR CAST(id AS TEXT) = ?';
    params.push(`%${q}%`, `%${q}%`, String(q));
  }
  let items = db.all(`SELECT * FROM users ${where} ORDER BY id DESC LIMIT 500`, ...params).map((u) => adminUserBrief(db, u));
  if (level) items = items.filter((u) => u.creditLevel === level);
  if (status) items = items.filter((u) => u.status === status);
  return { items };
}

export function adminUserDetail(db, id) {
  const u = requireUserRow(db, id);
  const events = db
    .all(
      `SELECT e.*, m.status AS member_status, m.role AS member_role FROM event_members m JOIN events e ON e.id = m.event_id
       WHERE m.user_id = ? ORDER BY e.start_at DESC LIMIT 50`,
      id,
    )
    .map((e) => ({ ...eventCard(db, e), memberStatus: e.member_status, role: e.member_role }));
  return {
    user: {
      ...adminUserBrief(db, u),
      bio: u.bio,
      gender: u.gender,
      pace: u.pace,
      interests: json.parse(u.interests, []),
      phoneVerified: Boolean(u.phone_verified),
      idVerified: Boolean(u.id_verified),
      restrictedUntil: effectiveStatus(u) === 'restricted' ? u.restricted_until : null,
      onboarded: Boolean(u.onboarded),
      settings: userSettings(u),
    },
    credit: creditOf(db, u),
    creditEvents: listCreditEvents(db, id),
    reportsAgainst: db
      .all('SELECT * FROM reports WHERE target_user_id = ? ORDER BY id DESC', id)
      .map((r) => adminReportView(db, r)),
    appeals: listAppeals(db, 'all').items.filter((a) => a.user?.id === id),
    events,
  };
}

/** 手动加一条信用记录，或撤销某条记录 */
export function adjustCredit(db, userId, body = {}) {
  const u = requireUserRow(db, userId);
  if (body.revokeId !== undefined) {
    const ce = db.get('SELECT * FROM credit_events WHERE id = ? AND user_id = ?', Number(body.revokeId), userId);
    if (!ce) throw notFound('信用记录不存在');
    db.update('credit_events', ce.id, { revoked: 1 });
  } else {
    const type = oneOf(body.type, '记录类型', CREDIT_TYPES);
    const note = str(body.note, '备注', { min: 1, max: 100 });
    addCreditEvent(db, { userId, type, source: 'admin', note });
  }
  const fresh = requireUserRow(db, u.id);
  return { ok: true, credit: creditOf(db, fresh), creditEvents: listCreditEvents(db, userId) };
}

export function adminRestrict(db, userId, body = {}) {
  requireUserRow(db, userId);
  const days = int(body.days, '天数', { min: 1, max: 365 });
  const reason = str(body.reason, '原因', { min: 1, max: 100 });
  restrictUser(db, userId, days, reason);
  return { ok: true, user: adminUserBrief(db, requireUserRow(db, userId)) };
}

export function adminBan(db, userId, body = {}) {
  const u = requireUserRow(db, userId);
  if (u.status === 'banned') throw conflict('这个账号已经封禁了');
  banUser(db, userId, str(body.reason, '原因', { min: 1, max: 100 }));
  return { ok: true, user: adminUserBrief(db, requireUserRow(db, userId)) };
}

export function adminUnban(db, userId) {
  const u = requireUserRow(db, userId);
  if (effectiveStatus(u) === 'active') throw invalid('这个账号目前没有被限制');
  db.update('users', userId, { status: 'active', restricted_until: null });
  notify(db, userId, { type: 'unbanned', title: '账号已恢复正常', body: '可以继续撮合和报名了', link: null });
  return { ok: true, user: adminUserBrief(db, requireUserRow(db, userId)) };
}


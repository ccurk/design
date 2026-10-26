// 后台：数据概览、局管理、用户管理。
import { clock, DAY } from '../clock.js';
import { json } from '../db.js';
import { conflict, invalid, notFound } from '../errors.js';
import { CREDIT_TYPE_LABELS } from '../constants.js';
import { addDays, bjDate, bjDayRange, bjParts } from '../time.js';
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
import { eventInviteDeadline, inviteDeadline } from './invites.js';
import { notify } from './notices.js';
import { adminReportView, banUser, reportCountAgainst } from './reports.js';
import { maskPhone, requireUserRow, userBrief, userSettings } from './users.js';

// ---- 数据概览 ----

const count = (db, sql, ...params) => Number(db.get(sql, ...params).n);

/** [from, to) 时间窗里的履约率和放鸽子次数（按信用记录的时间） */
function creditWindow(db, from, to) {
  const row = db.get(
    `SELECT COALESCE(SUM(type IN ('attended', 'late')), 0) AS kept,
            COALESCE(SUM(type IN ('attended', 'late', 'cancel_late', 'no_show')), 0) AS total,
            COALESCE(SUM(type = 'no_show'), 0) AS noShow
     FROM credit_events WHERE revoked = 0 AND created_at >= ? AND created_at < ?`,
    from,
    to,
  );
  const total = Number(row.total);
  return { attendanceRate: total ? Math.round((Number(row.kept) / total) * 100) : 100, noShowCount: Number(row.noShow) };
}

/** 北京时间某一天的新用户、新意向、成局数 */
function dayCounts(db, date) {
  const [s, e] = bjDayRange(date);
  return {
    newUsers: count(db, 'SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?', s, e),
    newIntents: count(db, 'SELECT COUNT(*) AS n FROM intents WHERE created_at >= ? AND created_at < ?', s, e),
    formed: count(db, 'SELECT COUNT(*) AS n FROM events WHERE formed_at >= ? AND formed_at < ?', s, e),
  };
}

/** 数据概览：today / yesterday 按北京日期；week 是滚动的最近 7×24 小时，prevWeek 是再往前 7×24 小时 */
export function stats(db) {
  const now = clock.now();
  const today = bjDate(now);
  const nowIso = new Date(now.getTime() + 1).toISOString(); // 含「现在」这一毫秒
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString();
  const twoWeeksAgo = new Date(now.getTime() - 14 * DAY).toISOString();
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
      ...dayCounts(db, today),
      pendingProposals: count(db, "SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'"),
      pendingReports: count(db, "SELECT COUNT(*) AS n FROM reports WHERE status = 'pending'"),
      pendingPosts: count(db, "SELECT COUNT(*) AS n FROM posts WHERE status = 'pending'"),
      pendingEvents: count(db, "SELECT COUNT(*) AS n FROM events WHERE status = 'pending_review'"),
    },
    yesterday: dayCounts(db, addDays(today, -1)),
    week: { ...creditWindow(db, weekAgo, nowIso), eventsEnded: ended },
    prevWeek: creditWindow(db, twoWeeksAgo, weekAgo),
    series,
  };
}

// ---- 局 ----

function eventReportCount(db, eventId) {
  return count(db, "SELECT COUNT(*) AS n FROM reports WHERE target_type = 'event' AND target_id = ?", eventId);
}

/** 邀请进度：joined / 还没回复的 invited 人数；撮合局还在邀请时给出整个局的邀请期限 */
function inviteProgress(e, rows) {
  return {
    joinedCount: rows.filter((r) => r.status === 'joined').length,
    invitedCount: rows.filter((r) => r.status === 'invited').length,
    inviteDeadline: e.source === 'matched' && e.status === 'inviting' ? eventInviteDeadline(e, rows).toISOString() : null,
  };
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
    ...inviteProgress(e, db.all('SELECT * FROM event_members WHERE event_id = ?', e.id)),
  };
}

/** 后台看到的成员状态：邀请过期没回应的显示为 expired（用户那边仍是 declined） */
function adminMemberStatus(m) {
  return m.status === 'declined' && m.invite_expired ? 'expired' : m.status;
}

export const ADMIN_EVENT_STATUSES = ['pending_review', 'inviting', 'open', 'formed', 'ended', 'cancelled', 'rejected'];
const EVENT_SOURCES = ['matched', 'user', 'platform'];
// 结束时间 = 开始 + 时长（与 phaseOf 一致，ISO 字符串可直接比较）
const END_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', start_at, '+' || duration_min || ' minutes')";

/**
 * status：pending_review / inviting / cancelled / rejected 按存的状态筛；
 * open / formed 只含还没结束的；ended = 已经结束的 open / formed 局（按时间算）。
 */
export function adminListEvents(db, { status, source, q } = {}) {
  const where = [];
  const params = [];
  if (status) {
    oneOf(status, '状态筛选', ADMIN_EVENT_STATUSES);
    const now = clock.iso();
    if (status === 'ended') {
      where.push(`status IN ('open', 'formed') AND ${END_SQL} <= ?`);
      params.push(now);
    } else if (status === 'open' || status === 'formed') {
      where.push(`status = ? AND ${END_SQL} > ?`);
      params.push(status, now);
    } else {
      where.push('status = ?');
      params.push(status);
    }
  }
  if (source) {
    oneOf(source, '来源筛选', EVENT_SOURCES);
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
      status: adminMemberStatus(m),
      inviteDeadline: e.source === 'matched' && m.invited_at ? inviteDeadline(e, m).toISOString() : null,
      attendance: m.attendance,
      arrivedAt: m.arrived_at,
      safeAt: m.safe_at,
      invitedAt: m.invited_at,
      joinedAt: m.joined_at,
      leftAt: m.left_at,
    })),
    messages,
    aa: {
      total: aa.total,
      each: aa.each,
      itemCount: aa.bill ? 1 : 0, // 兼容旧字段：v0.3 起每个局最多一笔
      bill: aa.bill
        ? { payer: userBrief(db, aa.bill.payer_id), amount: aa.bill.amount, note: aa.bill.note || null, createdAt: aa.bill.created_at }
        : null,
    },
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
    if (e.status === 'cancelled') throw conflict('这个局已经取消了');
    if (e.status === 'rejected') throw conflict('这个局没通过审核，不用取消');
    if (phaseOf(e) === 'ended') throw conflict('局已经结束了，不能取消');
    const why = str(reason, '取消原因', { min: 1, max: 100 });
    cancelEvent(db, e, { reason: why, byAdmin: true });
    return { ok: true, status: 'cancelled' };
  });
}

// ---- 用户 ----

export function adminUserBrief(db, u) {
  const status = effectiveStatus(u);
  return {
    ...userBrief(db, u),
    phoneMasked: maskPhone(u.phone),
    status,
    // 受限 / 封禁的原因（处理时填的、也是告诉用户的那句）；状态正常时为 null
    restrictedReason: status === 'active' ? null : u.restricted_reason ?? null,
    credit: creditOf(db, u),
    createdAt: u.created_at,
    reportCount: reportCountAgainst(db, u.id),
  };
}

/** 后台的等级筛选：封禁的人算 banned，其余按信用等级 good / fair / restricted */
const adminLevel = (u) => (u.status === 'banned' ? 'banned' : u.creditLevel);

export function adminListUsers(db, { q, level, status } = {}) {
  if (level) oneOf(level, '等级筛选', ['good', 'fair', 'restricted', 'banned']);
  if (status) oneOf(status, '状态筛选', ['active', 'restricted', 'banned']);
  const params = [];
  let where = '';
  if (q) {
    where = 'WHERE nickname LIKE ? OR phone LIKE ? OR CAST(id AS TEXT) = ?';
    params.push(`%${q}%`, `%${q}%`, String(q));
  }
  let items = db.all(`SELECT * FROM users ${where} ORDER BY id DESC LIMIT 500`, ...params).map((u) => adminUserBrief(db, u));
  if (level) items = items.filter((u) => adminLevel(u) === level);
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

/** 「10月23日 桌游夜 · 新手友好 放鸽子」：信用记录的日期（有局用开场日期）+ 局名 + 类型 */
function creditRecordLabel(db, ce) {
  const event = ce.event_id ? db.get('SELECT title, start_at FROM events WHERE id = ?', ce.event_id) : null;
  const p = bjParts(new Date(event?.start_at ?? ce.created_at));
  return [`${p.month}月${p.day}日`, event?.title, CREDIT_TYPE_LABELS[ce.type] || ce.type].filter(Boolean).join(' ');
}

/** 撤销一条信用记录：通知本人；这条记录上还在等处理的申诉自动通过 */
function revokeCredit(db, ce) {
  if (ce.revoked) return; // 已经撤销过，不重复通知
  const now = clock.iso();
  db.update('credit_events', ce.id, { revoked: 1 });
  db.run(
    "UPDATE appeals SET status = 'approved', admin_note = ?, resolved_at = ? WHERE credit_event_id = ? AND status = 'pending'",
    '后台已撤销这条记录',
    now,
    ce.id,
  );
  notify(db, ce.user_id, {
    type: 'credit_revoked',
    title: '你的一条信用记录已撤销',
    body: creditRecordLabel(db, ce),
    link: 'credit',
  });
}

/** 手动加一条信用记录，或撤销某条记录 */
export function adjustCredit(db, userId, body = {}) {
  return db.tx(() => {
    requireUserRow(db, userId);
    if (body.revokeId !== undefined) {
      const ce = db.get('SELECT * FROM credit_events WHERE id = ? AND user_id = ?', Number(body.revokeId), userId);
      if (!ce) throw notFound('信用记录不存在');
      revokeCredit(db, ce);
    } else {
      const type = oneOf(body.type, '记录类型', CREDIT_TYPES);
      const note = str(body.note, '备注', { min: 1, max: 100 });
      addCreditEvent(db, { userId, type, source: 'admin', note });
    }
    const fresh = requireUserRow(db, userId);
    return { ok: true, credit: creditOf(db, fresh), creditEvents: listCreditEvents(db, userId) };
  });
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
  db.update('users', userId, { status: 'active', restricted_until: null, restricted_reason: null });
  notify(db, userId, { type: 'unbanned', title: '账号已恢复正常', body: '可以继续撮合和报名了', link: null });
  return { ok: true, user: adminUserBrief(db, requireUserRow(db, userId)) };
}


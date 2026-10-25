// 局：卡片 / 详情视图、可见性、广场、发起、报名、退出、轻确认、到场、报平安。
import { clock, HOUR, MINUTE } from '../clock.js';
import { CATEGORIES, FEE_TYPES, SYSTEM_MESSAGES, categoryOfTask } from '../constants.js';
import { conflict, forbidden, invalid, notFound, restricted } from '../errors.js';
import { checkAll } from '../moderation.js';
import { dateLabel, fullDateLabel } from '../time.js';
import { bool, int, isoTime, num, oneOf, str } from '../validate.js';
import { creditOf, effectiveStatus, upsertEventCredit } from './credit.js';
import { notify } from './notices.js';
import { blockRelatedIds, getUser, userBrief, userSettings } from './users.js';

// ---- 基础查询 ----

export function getEvent(db, id) {
  return db.get('SELECT * FROM events WHERE id = ?', id);
}

export function requireEvent(db, id) {
  const event = getEvent(db, id);
  if (!event) throw notFound('局不存在');
  return event;
}

export function memberRow(db, eventId, userId) {
  if (!userId) return null;
  return db.get('SELECT * FROM event_members WHERE event_id = ? AND user_id = ?', eventId, userId) || null;
}

/** 已加入的成员（发起人在前，其余按加入时间） */
export function joinedMembers(db, eventId) {
  return db.all(
    `SELECT m.*, u.nickname FROM event_members m JOIN users u ON u.id = m.user_id
     WHERE m.event_id = ? AND m.status = 'joined'
     ORDER BY (m.role = 'host') DESC, m.joined_at, m.user_id`,
    eventId,
  );
}

export function joinedCount(db, eventId) {
  return Number(db.get("SELECT COUNT(*) AS n FROM event_members WHERE event_id = ? AND status = 'joined'", eventId).n);
}

export function endAt(event) {
  return new Date(Date.parse(event.start_at) + event.duration_min * MINUTE);
}

/** upcoming | ongoing | ended（开始 ≤ 现在 < 开始 + 时长 为 ongoing） */
export function phaseOf(event, now = clock.now()) {
  const t = now.getTime();
  if (t < Date.parse(event.start_at)) return 'upcoming';
  if (t < endAt(event).getTime()) return 'ongoing';
  return 'ended';
}

export function feeLabel(event) {
  const est = event.fee_estimate ? ` 约 ¥${Number(event.fee_estimate)}` : '';
  switch (event.fee_type) {
    case 'aa':
      return `AA${est}`;
    case 'free':
      return '免费';
    case 'host':
      return '发起人请客';
    case 'split':
      return `各付各${est}`;
    default:
      return '';
  }
}

/** 群聊是否开启：撮合局成局后；用户局 / 平台局有第二个人加入后 */
export function isChatOpen(event, count) {
  if (event.source === 'matched') return event.status === 'formed';
  return ['open', 'formed'].includes(event.status) && count >= 2;
}

/** 「周六清晨 · 苍山看日出」→「苍山看日出」；「桌游夜 · 新手友好」→「桌游夜」 */
export function shortTitle(title) {
  const parts = String(title).split(/\s*·\s*/);
  if (parts.length > 1 && /^(周|今天|明天|后天|本周|下周|这周|\d+月)/.test(parts[0])) return parts[1];
  return parts[0];
}

export function addSystemMessage(db, eventId, text) {
  return db.insert('messages', { event_id: eventId, user_id: null, kind: 'system', text, created_at: clock.iso() });
}

// ---- 可见性 ----

/**
 * 能否查看这个局：
 * - 撮合局只有被邀请过 / 加入过的人能看；
 * - 待审核 / 被驳回的局只有发起人能看；
 * - 和发起人或成员有拉黑关系、或同性局性别不符时，非成员看不到。
 */
export function canViewEvent(db, event, viewer) {
  const m = viewer ? memberRow(db, event.id, viewer.id) : null;
  const isCreator = viewer && event.creator_id === viewer.id;
  if (isCreator || m) return true;
  if (event.source === 'matched') return false;
  if (['pending_review', 'rejected'].includes(event.status)) return false;
  if (event.same_sex_only && (!viewer || viewer.gender !== event.gender)) return false;
  if (viewer) {
    const related = blockRelatedIds(db, viewer.id);
    if (related.size) {
      if (event.creator_id && related.has(event.creator_id)) return false;
      if (joinedMembers(db, event.id).some((x) => related.has(x.user_id))) return false;
    }
  }
  return true;
}

export function requireVisibleEvent(db, eventId, viewer) {
  const event = requireEvent(db, eventId);
  if (!canViewEvent(db, event, viewer)) throw notFound('局不存在或你没有权限查看');
  return event;
}

/** 报名资格检查（返回中文原因，可报名时返回 null） */
function joinBlocker(db, event, viewer, count, members) {
  if (!viewer) return '请先登录';
  if (event.source === 'matched') return '撮合局只能通过邀请加入';
  if (event.status !== 'open') return '这个局现在不能报名了';
  if (phaseOf(event) !== 'upcoming') return '局已经开始了';
  if (count >= event.capacity) return '已经满员了';
  const status = effectiveStatus(viewer);
  if (status !== 'active' || creditOf(db, viewer).level === 'restricted') return '账号受限中，暂时不能报名';
  if (event.same_sex_only && viewer.gender !== event.gender) return '这是同性局，暂时不能报名';
  const related = blockRelatedIds(db, viewer.id);
  if (members.some((x) => related.has(x.user_id))) return '暂时不能加入这个局';
  return null;
}

// ---- 视图 ----

export function eventCard(db, event, viewer = null, members = joinedMembers(db, event.id)) {
  const now = clock.now();
  return {
    id: event.id,
    title: event.title,
    category: event.category,
    task: event.task,
    startAt: event.start_at,
    dateLabel: dateLabel(new Date(event.start_at), now),
    place: event.place,
    capacity: event.capacity,
    memberCount: members.length,
    membersPreview: members.slice(0, 3).map((x) => userBrief(db, x.user_id, now)),
    feeLabel: feeLabel(event),
    source: event.source,
    status: event.status,
    phase: phaseOf(event, now),
  };
}

export function eventDetail(db, event, viewer = null) {
  const members = joinedMembers(db, event.id);
  const card = eventCard(db, event, viewer, members);
  const mine = viewer ? memberRow(db, event.id, viewer.id) : null;
  const myStatus = mine?.status ?? null;
  const alreadyIn = ['joined', 'applied', 'invited'].includes(myStatus);
  return {
    ...card,
    description: event.description,
    meetingPoint: event.meeting_point,
    durationMin: event.duration_min,
    feeType: event.fee_type,
    feeEstimate: event.fee_estimate === null ? null : Number(event.fee_estimate),
    requireApproval: Boolean(event.require_approval),
    sameSexOnly: Boolean(event.same_sex_only),
    host: event.source === 'user' && event.creator_id ? userBrief(db, event.creator_id) : null,
    members: members.map((x) => ({ ...userBrief(db, x.user_id), role: x.role })),
    myStatus,
    myAttendance: mine && myStatus === 'joined' ? mine.attendance : null,
    myArrivedAt: mine?.arrived_at ?? null,
    canJoin: !alreadyIn && joinBlocker(db, event, viewer, members.length, members) === null,
    isFull: members.length >= event.capacity,
    chatOpen: isChatOpen(event, members.length),
    // 以下为补充字段
    endAt: endAt(event).toISOString(),
    fullDateLabel: fullDateLabel(new Date(event.start_at)),
    isHost: Boolean(viewer && event.creator_id === viewer.id),
    minSize: event.min_size,
  };
}

// ---- 广场 / 搜索 ----

function squareCandidates(db, viewer, { category = null } = {}) {
  const nowIso = clock.iso();
  const rows = db.all(
    `SELECT * FROM events WHERE status = 'open' AND source IN ('user', 'platform') AND start_at > ?
     ${category ? 'AND category = ?' : ''} ORDER BY start_at, id`,
    ...(category ? [nowIso, category] : [nowIso]),
  );
  const related = viewer ? blockRelatedIds(db, viewer.id) : new Set();
  const settings = viewer ? userSettings(viewer) : null;
  return rows.filter((e) => {
    if (e.same_sex_only && (!viewer || viewer.gender !== e.gender)) return false;
    if (settings?.sameSexOnly && !e.same_sex_only) return false;
    if (related.size) {
      if (e.creator_id && related.has(e.creator_id)) return false;
      if (joinedMembers(db, e.id).some((x) => related.has(x.user_id))) return false;
    }
    return true;
  });
}

export function squareList(db, viewer, { category, limit = 20, cursor = 0 } = {}) {
  if (category && !CATEGORIES.includes(category)) throw invalid('分类不正确');
  const all = squareCandidates(db, viewer, { category });
  const page = all.slice(cursor, cursor + limit);
  return {
    items: page.map((e) => eventCard(db, e, viewer)),
    nextCursor: cursor + limit < all.length ? cursor + limit : null,
  };
}

export function searchEvents(db, viewer, q) {
  const term = String(q || '').trim().toLowerCase();
  if (!term) return { items: [] };
  const items = squareCandidates(db, viewer)
    .filter((e) => [e.title, e.place, e.task, e.meeting_point].some((s) => (s || '').toLowerCase().includes(term)))
    .slice(0, 50);
  return { items: items.map((e) => eventCard(db, e, viewer)) };
}

const DEFAULT_HOT = ['看日出', '安静读书', '骑行', '桌游', '拼车去双廊', '早餐'];

export function hotTerms(db) {
  const rows = db.all(
    `SELECT task, COUNT(*) AS n FROM (
       SELECT task FROM events WHERE status IN ('open', 'formed') AND start_at > ? AND task IS NOT NULL
       UNION ALL SELECT task FROM intents WHERE created_at > ?
     ) GROUP BY task ORDER BY n DESC LIMIT 6`,
    clock.iso(),
    new Date(clock.now().getTime() - 14 * 24 * HOUR).toISOString(),
  );
  const terms = [...new Set([...rows.map((r) => r.task), ...DEFAULT_HOT])].slice(0, 8);
  return { terms };
}

// ---- 发起 ----

export function parseEventInput(body) {
  const now = clock.now();
  const title = str(body.title, '标题', { min: 2, max: 30 });
  const category = oneOf(body.category, '类型', CATEGORIES);
  const task = str(body.task, '任务', { max: 10, optional: true });
  const startAt = isoTime(body.startAt, '开始时间');
  if (startAt.getTime() < now.getTime() + 30 * MINUTE) throw invalid('开始时间至少要在 30 分钟以后');
  if (startAt.getTime() > now.getTime() + 90 * 24 * HOUR) throw invalid('只能发起 90 天以内的局');
  const durationMin = int(body.durationMin, '时长', { min: 30, max: 24 * 60, optional: true }) ?? 120;
  const place = str(body.place, '地点', { min: 1, max: 40 });
  const meetingPoint = str(body.meetingPoint, '集合点', { max: 60, optional: true }) ?? '';
  const capacity = int(body.capacity, '人数', { min: 2, max: 20 });
  const feeType = oneOf(body.feeType ?? 'aa', '费用方式', FEE_TYPES);
  const feeEstimate = num(body.feeEstimate, '预计费用', { min: 0, max: 100000, optional: true });
  const requireApproval = bool(body.requireApproval, '是否需要同意', { optional: true }) ?? false;
  const sameSexOnly = bool(body.sameSexOnly, '是否只限同性', { optional: true }) ?? false;
  const description = str(body.description, '说明', { max: 500, optional: true }) ?? '';
  return {
    title,
    category,
    task: task || defaultTaskForCategory(category, title),
    startAt,
    durationMin,
    place,
    meetingPoint,
    capacity,
    feeType,
    feeEstimate,
    requireApproval,
    sameSexOnly,
    description,
  };
}

function defaultTaskForCategory(category, title) {
  const known = ['看日出', '爬山', '徒步', '骑行', '随便走走', '吃饭', '早餐', '夜市', '咖啡', '读书', '桌游', '拼车'];
  const hit = known.find((t) => title.includes(t) && categoryOfTask(t) === category);
  if (hit) return hit;
  return { outdoor: '随便走走', food: '吃饭', coffee: '咖啡', game: '桌游', carpool: '拼车' }[category] || '其他';
}

/** 用户发起局：过审核则 open，否则 pending_review */
export function createUserEvent(db, user, body) {
  if (effectiveStatus(user) !== 'active' || creditOf(db, user).level === 'restricted') {
    throw restricted('账号受限中，暂时不能发起局');
  }
  const input = parseEventInput(body);
  if (input.sameSexOnly && !['female', 'male'].includes(user.gender)) {
    throw invalid('先在资料里填写性别，才能发起同性局');
  }
  const check = checkAll(input.title, input.description, input.place, input.meetingPoint);
  return db.tx(() => {
    const now = clock.iso();
    const id = db.insert('events', {
      ...eventColumns(input),
      gender: input.sameSexOnly ? user.gender : null,
      source: 'user',
      creator_id: user.id,
      status: check.ok ? 'open' : 'pending_review',
      moderation: JSON.stringify(check.reasons),
      min_size: 2,
      created_at: now,
    });
    db.insert('event_members', {
      event_id: id,
      user_id: user.id,
      role: 'host',
      status: 'joined',
      attendance: 'pending',
      joined_at: now,
    });
    return getEvent(db, id);
  });
}

/** 平台局（后台发起） */
export function createPlatformEvent(db, body) {
  const input = parseEventInput(body);
  if (input.sameSexOnly && !['female', 'male'].includes(body.gender)) {
    throw invalid('同性局需要指定 gender（female / male）');
  }
  const id = db.insert('events', {
    ...eventColumns(input),
    require_approval: 0,
    gender: input.sameSexOnly ? body.gender : null,
    source: 'platform',
    creator_id: null,
    status: 'open',
    min_size: 2,
    created_at: clock.iso(),
  });
  return getEvent(db, id);
}

function eventColumns(input) {
  return {
    title: input.title,
    category: input.category,
    task: input.task,
    description: input.description,
    start_at: input.startAt.toISOString(),
    duration_min: input.durationMin,
    place: input.place,
    meeting_point: input.meetingPoint,
    capacity: input.capacity,
    fee_type: input.feeType,
    fee_estimate: input.feeEstimate,
    require_approval: input.requireApproval,
    same_sex_only: input.sameSexOnly,
  };
}

// ---- 成员变动 ----

function setMember(db, eventId, userId, patch) {
  const existing = memberRow(db, eventId, userId);
  if (existing) {
    const keys = Object.keys(patch);
    db.run(
      `UPDATE event_members SET ${keys.map((k) => `${k} = :${k}`).join(', ')} WHERE event_id = :eventId AND user_id = :userId`,
      { ...patch, eventId, userId },
    );
  } else {
    db.insert('event_members', { event_id: eventId, user_id: userId, role: 'member', ...patch });
  }
}

/** 加入成功后的统一处理：系统消息、满员成局 */
function afterJoined(db, event, user) {
  const count = joinedCount(db, event.id);
  if (event.source !== 'matched') addSystemMessage(db, event.id, `${user.nickname} 加入了这个局`);
  if (event.status === 'open' && count >= event.capacity) {
    db.update('events', event.id, { status: 'formed', formed_at: clock.iso() });
    addSystemMessage(db, event.id, SYSTEM_MESSAGES.formed);
    for (const m of joinedMembers(db, event.id)) {
      notify(db, m.user_id, {
        type: 'formed',
        title: '满员成局啦',
        body: `「${event.title}」人齐了，群聊已开启`,
        link: `chat:${event.id}`,
      });
    }
  }
  return getEvent(db, event.id);
}

export function joinEvent(db, user, eventId) {
  return db.tx(() => {
    const event = requireVisibleEvent(db, eventId, user);
    const mine = memberRow(db, eventId, user.id);
    if (mine && ['joined', 'applied'].includes(mine.status)) {
      return { myStatus: mine.status, eventStatus: event.status };
    }
    if (mine?.status === 'invited') throw conflict('你已被邀请，请在「撮合成功」页确认加入');
    const members = joinedMembers(db, eventId);
    const reason = joinBlocker(db, event, user, members.length, members);
    if (reason) {
      if (reason.startsWith('账号受限')) throw restricted(reason);
      if (reason === '已经满员了' || reason === '这个局现在不能报名了') throw conflict(reason);
      if (reason === '局已经开始了') throw invalid(reason);
      throw forbidden(reason);
    }
    const now = clock.iso();
    const needApproval =
      event.source === 'user' && (event.require_approval || (creditOf(db, user).level === 'fair' && event.capacity >= 6));
    if (needApproval) {
      setMember(db, eventId, user.id, { status: 'applied', role: 'member', applied_at: now, attendance: 'pending' });
      if (event.creator_id) {
        notify(db, event.creator_id, {
          type: 'application',
          title: '有人想加入你的局',
          body: `${user.nickname} 申请加入「${event.title}」，去看看吧`,
          link: `event:${event.id}`,
        });
      }
      return { myStatus: 'applied', eventStatus: event.status };
    }
    setMember(db, eventId, user.id, {
      status: 'joined',
      role: 'member',
      joined_at: now,
      left_at: null,
      attendance: 'pending',
      arrived_at: null,
      safe_at: null,
    });
    const updated = afterJoined(db, event, user);
    if (event.creator_id && event.creator_id !== user.id) {
      notify(db, event.creator_id, {
        type: 'join',
        title: '有人加入了你的局',
        body: `${user.nickname} 加入了「${event.title}」`,
        link: `event:${event.id}`,
      });
    }
    return { myStatus: 'joined', eventStatus: updated.status };
  });
}

/** 开场前 24 小时内（含已开始）退出 → 临时鸽 */
export function latePenalty(event, now = clock.now()) {
  return Date.parse(event.start_at) - now.getTime() < 24 * HOUR ? 'cancel_late' : null;
}

/**
 * 退出：joined → left（24 小时规则记临时鸽）；applied → 撤回申请；invited → 等同「换一批」。
 * declineInvite 由 invites.js 注入，避免循环依赖。
 */
export function leaveEvent(db, user, eventId, { declineInvite } = {}) {
  return db.tx(() => {
    const event = requireEvent(db, eventId);
    const mine = memberRow(db, eventId, user.id);
    if (!mine || !['joined', 'applied', 'invited'].includes(mine.status)) throw invalid('你不在这个局里');
    if (mine.status === 'invited') {
      declineInvite(db, user, eventId);
      return { penalty: null };
    }
    const now = clock.now();
    if (mine.status === 'applied') {
      setMember(db, eventId, user.id, { status: 'left', left_at: now.toISOString() });
      return { penalty: null };
    }
    if (mine.role === 'host') throw invalid('你是发起人，不想办了可以取消这个局');
    if (phaseOf(event, now) === 'ended') throw invalid('局已经结束了');
    if (['cancelled', 'rejected'].includes(event.status)) throw invalid('这个局已经取消了');

    const penalty = latePenalty(event, now);
    setMember(db, eventId, user.id, { status: 'left', left_at: now.toISOString(), attendance: 'no' });
    if (penalty) {
      upsertEventCredit(db, {
        userId: user.id,
        eventId,
        type: 'cancel_late',
        source: 'system',
        note: '开场前 24 小时内退出',
      });
    }
    const count = joinedCount(db, eventId);
    if (count > 0) addSystemMessage(db, eventId, `${user.nickname} 退出了这个局`);
    if (event.source !== 'matched' && event.status === 'formed' && count < event.capacity) {
      db.update('events', eventId, { status: 'open' });
    }
    if (event.source === 'matched') {
      db.run(
        "UPDATE intents SET status = 'cancelled', updated_at = ? WHERE event_id = ? AND user_id = ? AND status IN ('invited', 'matched')",
        now.toISOString(),
        eventId,
        user.id,
      );
    }
    if (event.creator_id && event.creator_id !== user.id) {
      notify(db, event.creator_id, {
        type: 'leave',
        title: '有人退出了你的局',
        body: `${user.nickname} 退出了「${event.title}」，名额空出来了`,
        link: `event:${event.id}`,
      });
    }
    return { penalty };
  });
}

/** 取消局（发起人 / 后台）。notifyAll=true 时连发起人一起通知 */
export function cancelEvent(db, event, { reason, byAdmin = false } = {}) {
  const now = clock.iso();
  db.update('events', event.id, { status: 'cancelled', cancel_reason: reason || null });
  addSystemMessage(db, event.id, byAdmin ? `这个局已被平台取消${reason ? `：${reason}` : ''}` : '发起人取消了这个局');
  const members = db.all(
    "SELECT * FROM event_members WHERE event_id = ? AND status IN ('joined', 'applied', 'invited')",
    event.id,
  );
  for (const m of members) {
    if (!byAdmin && m.user_id === event.creator_id) continue;
    notify(db, m.user_id, {
      type: 'event_cancelled',
      title: '局已取消',
      body: `「${event.title}」已取消${reason ? `：${reason}` : ''}。不影响你的信用。`,
      link: `event:${event.id}`,
    });
  }
  // 撮合局取消：意向退回撮合池
  db.run(
    "UPDATE intents SET status = 'open', event_id = NULL, proposal_id = NULL, updated_at = ? WHERE event_id = ? AND status IN ('invited', 'matched')",
    now,
    event.id,
  );
  return getEvent(db, event.id);
}

export function cancelByHost(db, user, eventId) {
  return db.tx(() => {
    const event = requireEvent(db, eventId);
    if (event.creator_id !== user.id) throw forbidden('只有发起人可以取消这个局');
    if (['cancelled', 'rejected'].includes(event.status)) throw conflict('这个局已经取消了');
    if (phaseOf(event) === 'ended') throw invalid('局已经结束了');
    const updated = cancelEvent(db, event, { reason: '发起人取消了这个局' });
    return { ok: true, status: updated.status };
  });
}

// ---- 报名申请 ----

function requireHostEvent(db, user, eventId) {
  const event = requireEvent(db, eventId);
  if (event.creator_id !== user.id) throw forbidden('只有发起人可以处理报名申请');
  return event;
}

export function listApplications(db, user, eventId) {
  const event = requireHostEvent(db, user, eventId);
  const rows = db.all(
    "SELECT * FROM event_members WHERE event_id = ? AND status = 'applied' ORDER BY applied_at",
    event.id,
  );
  return {
    items: rows.map((m) => {
      const u = getUser(db, m.user_id);
      return { user: { ...userBrief(db, u), bio: u.bio }, appliedAt: m.applied_at };
    }),
  };
}

export function approveApplication(db, user, eventId, applicantId) {
  return db.tx(() => {
    const event = requireHostEvent(db, user, eventId);
    const m = memberRow(db, eventId, applicantId);
    if (!m || m.status !== 'applied') throw notFound('没有这条申请');
    if (event.status !== 'open') throw conflict('这个局现在不能再加人了');
    if (joinedCount(db, eventId) >= event.capacity) throw conflict('已经满员了');
    setMember(db, eventId, applicantId, { status: 'joined', joined_at: clock.iso(), attendance: 'pending' });
    const applicant = getUser(db, applicantId);
    const updated = afterJoined(db, event, applicant);
    notify(db, applicantId, {
      type: 'application_result',
      title: '申请通过啦',
      body: `你已加入「${event.title}」`,
      link: `event:${event.id}`,
    });
    return { ok: true, eventStatus: updated.status, memberCount: joinedCount(db, eventId) };
  });
}

export function rejectApplication(db, user, eventId, applicantId) {
  return db.tx(() => {
    const event = requireHostEvent(db, user, eventId);
    const m = memberRow(db, eventId, applicantId);
    if (!m || m.status !== 'applied') throw notFound('没有这条申请');
    setMember(db, eventId, applicantId, { status: 'declined' });
    notify(db, applicantId, {
      type: 'application_result',
      title: '这次没能加入',
      body: `「${event.title}」的发起人这次没有通过申请，去广场看看别的局吧`,
      link: `event:${event.id}`,
    });
    return { ok: true };
  });
}

// ---- 轻确认、到场、报平安 ----

function requireJoined(db, user, eventId) {
  const event = requireEvent(db, eventId);
  const mine = memberRow(db, eventId, user.id);
  if (!mine || mine.status !== 'joined') throw forbidden('你不在这个局里');
  return { event, mine };
}

export function setAttendance(db, user, eventId, going, deps) {
  const { event, mine } = requireJoined(db, user, eventId);
  if (phaseOf(event) === 'ended') throw invalid('局已经结束了');
  if (['cancelled', 'rejected'].includes(event.status)) throw invalid('这个局已经取消了');
  if (going) {
    db.run("UPDATE event_members SET attendance = 'yes' WHERE event_id = ? AND user_id = ?", eventId, user.id);
    return { attendance: 'yes', penalty: null };
  }
  if (mine.role === 'host') throw invalid('你是发起人，去不了的话可以取消这个局');
  const { penalty } = leaveEvent(db, user, eventId, deps);
  return { attendance: 'no', penalty };
}

export function arrive(db, user, eventId) {
  const { event, mine } = requireJoined(db, user, eventId);
  if (mine.arrived_at) return { arrivedAt: mine.arrived_at };
  const now = clock.now();
  if (now.getTime() < Date.parse(event.start_at) - 2 * HOUR) throw invalid('还没到集合时间，开场前 2 小时内再点');
  if (phaseOf(event, now) === 'ended') throw invalid('局已经结束了');
  const arrivedAt = now.toISOString();
  db.run('UPDATE event_members SET arrived_at = ?, attendance = ? WHERE event_id = ? AND user_id = ?', arrivedAt, 'yes', eventId, user.id);
  return { arrivedAt };
}

export function reportSafe(db, user, eventId) {
  const { event, mine } = requireJoined(db, user, eventId);
  if (mine.safe_at) return { ok: true, safeAt: mine.safe_at };
  if (clock.now().getTime() < Date.parse(event.start_at)) throw invalid('局还没开始呢');
  const safeAt = clock.iso();
  db.run('UPDATE event_members SET safe_at = ? WHERE event_id = ? AND user_id = ?', safeAt, eventId, user.id);
  return { ok: true, safeAt };
}


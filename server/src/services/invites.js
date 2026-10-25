// 撮合局的邀请流程：后台确认 → inviting；接受 / 换一批；补邀；邀请到期；成局或取消（docs/api.md 3.2）。
import { clock, HOUR } from '../clock.js';
import { FEE_TYPES, SYSTEM_MESSAGES, categoryOfTask, defaultDurationForTask } from '../constants.js';
import { json } from '../db.js';
import { conflict, invalid, notFound, restricted } from '../errors.js';
import { bjDate, bjDateTime, dateLabel, defaultStartTime } from '../time.js';
import { int, isoTime, num, oneOf, str } from '../validate.js';
import { creditOf, effectiveStatus } from './credit.js';
import { addSystemMessage, eventDetail, getEvent, joinedMembers, memberRow, requireEvent, shortTitle } from './events.js';
import { enrichIntent, groupBounds, isFlexible, pairCompatible, sizeBounds, taskPhrase } from './matchRules.js';
import { notify } from './notices.js';
import { allBlockPairs, getUser, isNewUser, userBrief, userSettings } from './users.js';

const INVITE_TTL = 24 * HOUR; // 邀请 24 小时内有效
const LAST_CALL = 12 * HOUR; // 离开场不到 12 小时不再等

/** 某个被邀请人的回应期限 */
export function inviteDeadline(event, member) {
  const start = Date.parse(event.start_at);
  const invited = Date.parse(member.invited_at || event.created_at);
  return new Date(Math.min(invited + INVITE_TTL, start - LAST_CALL));
}

/** 整个局的邀请期限：最后一个被邀请的人的回应期限（到点后够人成局，不够取消） */
export function eventInviteDeadline(event, rows) {
  const invitedAt = rows.map((r) => Date.parse(r.invited_at || event.created_at));
  const lastInvite = invitedAt.length ? Math.max(...invitedAt) : Date.parse(event.created_at);
  return new Date(Math.min(lastInvite + INVITE_TTL, Date.parse(event.start_at) - LAST_CALL));
}

function inviteNotice(db, userId, event) {
  notify(db, userId, {
    type: 'match',
    title: '撮合成功',
    body: `配到了！「${shortTitle(event.title)}」，去看看同行的人，确认加入吧`,
    link: `match:${event.id}`,
  });
}

/** 后台确认建议 → 创建撮合局（inviting），成员全部 invited，并通知「撮合成功」 */
export function confirmProposal(db, proposalId, overrides = {}) {
  return db.tx(() => {
    const p = db.get('SELECT * FROM proposals WHERE id = ?', proposalId);
    if (!p) throw notFound('建议不存在');
    if (p.status !== 'pending') throw conflict('这条建议已经处理过了');
    const intents = json
      .parse(p.intent_ids, [])
      .map((id) => db.get('SELECT * FROM intents WHERE id = ?', id))
      .filter((i) => i && i.status === 'proposed');
    if (intents.length < 2) throw conflict('人数不够了，请调整成员或退回');
    // 大家约好的人数：size_min 的最大值 ~ size_max 的最小值（开了「2–6 人都可以」按 2–6 算）
    const { min: minSize, max: maxSize } = groupBounds(intents);
    if (intents.length < minSize) {
      throw invalid(`人数不够：这组人约好至少 ${minSize} 人成局，现在只有 ${intents.length} 人`);
    }
    const blocks = allBlockPairs(db);
    for (let i = 0; i < intents.length; i++) {
      for (let j = i + 1; j < intents.length; j++) {
        const a = intents[i].user_id;
        const b = intents[j].user_id;
        if (blocks.has(`${a}:${b}`) || blocks.has(`${b}:${a}`)) throw conflict('组里有人互相拉黑，不能成局');
      }
    }

    const now = clock.now();
    const [h, m] = defaultStartTime(p.task, p.slot);
    const startAt = isoTime(overrides.startAt, '集合时间', { optional: true }) ?? bjDateTime(p.date, h, m);
    if (startAt.getTime() <= now.getTime()) throw invalid('集合时间已经过了，请修改时间');
    const capacity = int(overrides.capacity, '人数上限', { min: 2, max: 20, optional: true }) ?? intents.length;
    if (capacity < intents.length) throw invalid('人数上限不能少于已配到的人数');
    if (capacity > maxSize) throw invalid(`人数上限不能超过 ${maxSize} 人：组里有人只想要 ${maxSize} 人以内的局`);
    const users = intents.map((i) => getUser(db, i.user_id));
    const sameSex = users.some((u) => userSettings(u).sameSexOnly);

    const eventId = db.insert('events', {
      title: str(overrides.title, '标题', { min: 2, max: 30, optional: true }) ?? p.title,
      category: p.category || categoryOfTask(p.task),
      task: p.task,
      description: str(overrides.description, '说明', { max: 500, optional: true }) ?? '',
      start_at: startAt.toISOString(),
      duration_min:
        int(overrides.durationMin, '时长', { min: 30, max: 24 * 60, optional: true }) ?? defaultDurationForTask(p.task),
      place: str(overrides.place, '地点', { max: 40, optional: true }) ?? p.area,
      meeting_point: str(overrides.meetingPoint, '集合点', { max: 60, optional: true }) ?? '',
      capacity,
      min_size: Math.max(2, minSize),
      fee_type: oneOf(overrides.feeType, '费用方式', FEE_TYPES, { optional: true }) ?? 'aa',
      fee_estimate: num(overrides.feeEstimate, '预计费用', { min: 0, max: 100000, optional: true }),
      require_approval: 0,
      same_sex_only: sameSex ? 1 : 0,
      gender: sameSex ? users[0].gender : null,
      source: 'matched',
      creator_id: null,
      status: 'inviting',
      proposal_id: p.id,
      slot: p.slot,
      area: p.area,
      created_at: now.toISOString(),
    });
    for (const intent of intents) {
      db.insert('event_members', {
        event_id: eventId,
        user_id: intent.user_id,
        role: 'member',
        status: 'invited',
        attendance: 'pending',
        invited_at: now.toISOString(),
      });
      db.update('intents', intent.id, { status: 'invited', event_id: eventId, updated_at: now.toISOString() });
    }
    db.update('proposals', p.id, { status: 'confirmed', event_id: eventId, reviewed_at: now.toISOString() });
    const event = getEvent(db, eventId);
    for (const intent of intents) inviteNotice(db, intent.user_id, event);
    return { eventId };
  });
}

/** 被邀请人查看撮合结果 */
export function matchView(db, user, eventId) {
  const event = requireEvent(db, eventId);
  const mine = memberRow(db, eventId, user.id);
  if (event.source !== 'matched' || !mine) throw notFound('没有找到这个撮合结果');
  const rows = db.all(
    "SELECT * FROM event_members WHERE event_id = ? AND status IN ('invited', 'joined') ORDER BY joined_at IS NULL, joined_at, invited_at, user_id",
    eventId,
  );
  return {
    event: eventDetail(db, event, user),
    members: rows.map((r) => ({ ...userBrief(db, r.user_id), status: r.status, isMe: r.user_id === user.id })),
    commonPoints: matchCommonPoints(db, event, rows.map((r) => r.user_id)),
    myStatus: mine.status,
    joinedCount: rows.filter((r) => r.status === 'joined').length,
    deadline: mine.status === 'invited' ? inviteDeadline(event, mine).toISOString() : null,
  };
}

const PACE_POINTS = { slow: '都偏安静', warm: '都是熟了就话多', open: '都随时能聊' };

/** 撮合成功页的「共同点」：都想做的事、节奏、共同兴趣、新人 */
function matchCommonPoints(db, event, userIds) {
  const users = userIds.map((id) => getUser(db, id)).filter(Boolean);
  const points = [`都想${taskPhrase(event.task).replace(/^去/, '')}`];
  const paces = users.map((u) => u.pace);
  if (paces.length && paces[0] && paces.every((p) => p === paces[0])) points.push(PACE_POINTS[paces[0]]);
  const lists = users.map((u) => json.parse(u.interests, []));
  const common = lists.length ? lists.reduce((acc, list) => acc.filter((x) => list.includes(x))) : [];
  for (const interest of common.filter((x) => x !== event.task).slice(0, 2)) points.push(`都喜欢${interest}`);
  const newbies = users.filter((u) => isNewUser(db, u.id)).length;
  if (newbies && newbies * 2 >= users.length) points.push('大多是第一次参加');
  return points.slice(0, 4);
}

export function acceptInvite(db, user, eventId) {
  const outcome = db.tx(() => {
    const event = requireEvent(db, eventId);
    const mine = memberRow(db, eventId, user.id);
    if (event.source !== 'matched' || !mine) throw notFound('没有找到这个撮合结果');
    if (mine.status === 'joined') return { myStatus: 'joined', eventStatus: event.status };
    if (mine.status !== 'invited') throw conflict('邀请已经失效了');
    if (event.status !== 'inviting') throw conflict('这个局已经不再邀请了');
    if (effectiveStatus(user) !== 'active' || creditOf(db, user).level === 'restricted') {
      throw restricted('账号受限中，暂时不能加入');
    }
    if (clock.now().getTime() >= inviteDeadline(event, mine).getTime()) {
      // 过期了：本人还在线，意向退回撮合池继续撮合（先提交，再报错）
      expireInvite(db, event, mine, { reopen: true });
      evaluateInviting(db, eventId);
      return { expired: true };
    }
    db.run(
      "UPDATE event_members SET status = 'joined', joined_at = ? WHERE event_id = ? AND user_id = ?",
      clock.iso(),
      eventId,
      user.id,
    );
    evaluateInviting(db, eventId);
    return { myStatus: 'joined', eventStatus: getEvent(db, eventId).status };
  });
  if (outcome.expired) throw conflict('邀请已经过期了，已帮你继续撮合');
  return outcome;
}

/** 换一批：declined，意向回到 open；随后尝试从撮合池补邀 */
export function declineInvite(db, user, eventId) {
  return db.tx(() => {
    const event = requireEvent(db, eventId);
    const mine = memberRow(db, eventId, user.id);
    if (event.source !== 'matched' || !mine) throw notFound('没有找到这个撮合结果');
    const pendingJoin = mine.status === 'joined' && event.status === 'inviting';
    if (mine.status !== 'invited' && !pendingJoin) throw conflict('现在不能换一批了');
    const now = clock.iso();
    db.run(
      "UPDATE event_members SET status = 'declined', left_at = ? WHERE event_id = ? AND user_id = ?",
      now,
      eventId,
      user.id,
    );
    const intent = db.get('SELECT * FROM intents WHERE event_id = ? AND user_id = ?', eventId, user.id);
    if (intent) {
      db.update('intents', intent.id, { status: 'open', event_id: null, proposal_id: null, updated_at: now });
    }
    backfillEvent(db, getEvent(db, eventId));
    evaluateInviting(db, eventId);
    return { ok: true, intentId: intent?.id ?? null };
  });
}

/** 邀请到期视为放弃：declined；意向标记为 expired（reopen=true 时退回 open 继续撮合） */
function expireInvite(db, event, member, { reopen = false } = {}) {
  const now = clock.iso();
  db.run(
    "UPDATE event_members SET status = 'declined', invite_expired = 1, left_at = ? WHERE event_id = ? AND user_id = ?",
    now,
    event.id,
    member.user_id,
  );
  db.run(
    "UPDATE intents SET status = ?, event_id = NULL, proposal_id = NULL, updated_at = ? WHERE event_id = ? AND user_id = ? AND status = 'invited'",
    reopen ? 'open' : 'expired',
    now,
    event.id,
    member.user_id,
  );
}

/** 全员加入 → 成局；没人在等回应时：够 min_size 成局，否则等补邀直到期限后取消 */
export function evaluateInviting(db, eventId) {
  const event = getEvent(db, eventId);
  if (!event || event.status !== 'inviting') return event?.status;
  const rows = db.all('SELECT * FROM event_members WHERE event_id = ?', eventId);
  const pending = rows.filter((r) => r.status === 'invited');
  const joined = rows.filter((r) => r.status === 'joined');
  if (pending.length) return 'inviting';
  if (joined.length >= event.min_size) {
    formMatchedEvent(db, event);
    return 'formed';
  }
  if (clock.now().getTime() >= eventInviteDeadline(event, rows).getTime()) {
    cancelUnderfilled(db, event);
    return 'cancelled';
  }
  return 'inviting';
}

function formMatchedEvent(db, event) {
  const now = clock.iso();
  db.update('events', event.id, { status: 'formed', formed_at: now });
  addSystemMessage(db, event.id, SYSTEM_MESSAGES.formed);
  const members = joinedMembers(db, event.id);
  for (const m of members) {
    db.run(
      "UPDATE intents SET status = 'matched', updated_at = ? WHERE event_id = ? AND user_id = ? AND status = 'invited'",
      now,
      event.id,
      m.user_id,
    );
    notify(db, m.user_id, {
      type: 'formed',
      title: '成局啦',
      body: `「${shortTitle(event.title)}」${members.length} 人到齐，群聊已开启。第一次见面，慢慢来`,
      link: `chat:${event.id}`,
    });
  }
}

function cancelUnderfilled(db, event) {
  const now = clock.iso();
  db.update('events', event.id, { status: 'cancelled', cancel_reason: '人数没凑齐' });
  const members = db.all("SELECT * FROM event_members WHERE event_id = ? AND status IN ('joined', 'invited')", event.id);
  for (const m of members) {
    db.run(
      "UPDATE intents SET status = 'open', event_id = NULL, proposal_id = NULL, updated_at = ? WHERE event_id = ? AND user_id = ? AND status IN ('invited', 'matched')",
      now,
      event.id,
      m.user_id,
    );
    notify(db, m.user_id, {
      type: 'match_failed',
      title: '这次没凑齐',
      body: '这次没凑齐，已帮你继续撮合',
      link: null,
    });
  }
}

/**
 * 补邀：撮合局还在邀请中且有空位时，从同条件的 open 意向里直接邀请（不再经过后台）。
 * pool 为已附带用户信息的 open 意向（可选，默认现查）。
 */
export function backfillEvent(db, event, pool = null, used = new Set()) {
  if (!event || event.status !== 'inviting' || event.source !== 'matched') return 0;
  const now = clock.now();
  if (now.getTime() >= Date.parse(event.start_at) - LAST_CALL) return 0;
  const rows = db.all('SELECT * FROM event_members WHERE event_id = ?', event.id);
  const active = rows.filter((r) => ['invited', 'joined'].includes(r.status));
  let seats = event.capacity - active.length;
  if (seats <= 0) return 0;

  const known = new Set(rows.map((r) => r.user_id));
  const memberIntents = db
    .all("SELECT * FROM intents WHERE event_id = ? AND status IN ('invited', 'matched')", event.id)
    .map((i) => enrichIntent(db, i, now));
  const eventDate = bjDate(new Date(event.start_at));
  const blocks = allBlockPairs(db);
  const candidates = (pool ?? openPool(db, now)).filter(
    (c) =>
      !used.has(c.id) &&
      !known.has(c.user_id) &&
      c.task === event.task &&
      c.area === (event.area ?? c.area) &&
      c.date_from <= eventDate &&
      eventDate <= c.date_to &&
      (!event.slot || event.slot === 'allday' || isFlexible(c) || c.slot === event.slot) &&
      (!event.same_sex_only || c.gender === event.gender),
  );

  let invited = 0;
  const group = [...memberIntents];
  for (const c of candidates) {
    if (seats <= 0) break;
    if (!group.every((g) => pairCompatible(g, c, blocks))) continue;
    const bounds = sizeBounds(c);
    if (bounds.min > event.capacity || bounds.max < event.capacity - seats + 1) continue;
    const ts = now.toISOString();
    db.run(
      'INSERT OR REPLACE INTO event_members (event_id, user_id, role, status, attendance, invited_at) VALUES (?, ?, ?, ?, ?, ?)',
      event.id,
      c.user_id,
      'member',
      'invited',
      'pending',
      ts,
    );
    db.update('intents', c.id, { status: 'invited', event_id: event.id, proposal_id: event.proposal_id, updated_at: ts });
    inviteNotice(db, c.user_id, event);
    used.add(c.id);
    group.push(c);
    known.add(c.user_id);
    seats--;
    invited++;
  }
  return invited;
}

/** 后台「催一下」：给还没回复、也还没过期的被邀请人发提醒 */
export function remindInvitees(db, eventId) {
  return db.tx(() => {
    const event = requireEvent(db, eventId);
    if (event.source !== 'matched' || event.status !== 'inviting') throw conflict('这个局不在邀请中，不用催了');
    const now = clock.now();
    const pending = db
      .all("SELECT * FROM event_members WHERE event_id = ? AND status = 'invited'", eventId)
      .filter((m) => inviteDeadline(event, m).getTime() > now.getTime());
    for (const m of pending) {
      notify(db, m.user_id, {
        type: 'match_reminder',
        title: `还没回复：${event.title}`,
        body: `${dateLabel(inviteDeadline(event, m), now)} 前点「加入」`,
        link: `match:${event.id}`,
      });
    }
    return { reminded: pending.length };
  });
}

/** 撮合池：open 且未过期的意向（账号受限 / 封禁的人不参与），按提交时间排序 */
export function openPool(db, now = clock.now()) {
  return db
    .all("SELECT * FROM intents WHERE status = 'open' ORDER BY created_at, id")
    .map((i) => enrichIntent(db, i, now))
    .filter((i) => i.userStatus === 'active' && i.creditLevel !== 'restricted');
}

export function backfillInvitingEvents(db, pool, used) {
  const events = db.all("SELECT * FROM events WHERE status = 'inviting' AND source = 'matched' ORDER BY start_at");
  let count = 0;
  for (const e of events) count += backfillEvent(db, e, pool, used);
  return count;
}

/** 每分钟：处理过期邀请，必要时成局或取消 */
export function processInviteDeadlines(db) {
  return db.tx(() => {
    const now = clock.now().getTime();
    const events = db.all("SELECT * FROM events WHERE status = 'inviting'");
    const result = { expiredInvites: 0, formed: 0, cancelled: 0 };
    for (const event of events) {
      const pending = db.all("SELECT * FROM event_members WHERE event_id = ? AND status = 'invited'", event.id);
      for (const m of pending) {
        if (now >= inviteDeadline(event, m).getTime()) {
          expireInvite(db, event, m);
          result.expiredInvites++;
        }
      }
      if (now >= Date.parse(event.start_at)) {
        cancelUnderfilled(db, event);
        result.cancelled++;
        continue;
      }
      const status = evaluateInviting(db, event.id);
      if (status === 'formed') result.formed++;
      if (status === 'cancelled') result.cancelled++;
    }
    return result;
  });
}

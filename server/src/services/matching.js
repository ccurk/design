// 撮合引擎：从撮合池里按提交时间贪心组队 → 生成建议（proposals），并处理补邀和自动成局。
import { clock } from '../clock.js';
import { defaultDurationForTask } from '../constants.js';
import { json } from '../db.js';
import { conflict, invalid, notFound } from '../errors.js';
import { oneOf } from '../validate.js';
import { bjDate, fmtHHMM, slotLabel, weekdayName } from '../time.js';
import { backfillInvitingEvents, confirmProposal, openPool } from './invites.js';
import {
  canJoinGroup,
  enrichIntent,
  groupBounds,
  isIntentExpired,
  planGroup,
  proposalPlan,
  proposalTitle,
  scoreGroup,
  windowLabel,
} from './matchRules.js';
import { firstOverlap } from './overlap.js';
import { getSetting } from './settings.js';
import { intentTimeLabel, intentView } from './intentFormat.js';
import { tagCategory, tagKey } from './tags.js';
import { allBlockPairs, getUser, isNewUser, userBrief } from './users.js';

/** 过期处理：open 意向过了日期 → expired；待确认建议过了日期 → expired（意向一起过期） */
function expireStale(db, now) {
  let expired = 0;
  for (const intent of db.all("SELECT * FROM intents WHERE status = 'open'")) {
    if (isIntentExpired(intent, now)) {
      db.update('intents', intent.id, { status: 'expired', updated_at: now.toISOString() });
      expired++;
    }
  }
  const today = bjDate(now);
  for (const p of db.all("SELECT * FROM proposals WHERE status = 'pending' AND date < ?", today)) {
    db.update('proposals', p.id, { status: 'expired', reviewed_at: now.toISOString() });
    db.run(
      "UPDATE intents SET status = 'expired', updated_at = ? WHERE proposal_id = ? AND status = 'proposed'",
      now.toISOString(),
      p.id,
    );
  }
  return expired;
}

const comboKey = (task, date, userIds) => `${tagKey(task)}|${date}|${[...userIds].sort((a, b) => a - b).join(',')}`;

const isValidGroup = (group) => group.length >= 2 && group.length >= groupBounds(group).min;

/**
 * 贪心组队：按提交时间，从每个还没分组的意向开始，依次吸收兼容的人，直到人数上限。
 * settle(group) 给组排时间（可以去掉排不进的人），返回 { group, plan }；返回 null 时这组不成，组里的人留给后面的组。
 */
export function buildGroups(pool, blocks, settle = (group) => ({ group, plan: null })) {
  const used = new Set();
  const groups = [];
  for (let i = 0; i < pool.length; i++) {
    const seed = pool[i];
    if (used.has(seed.id)) continue;
    const group = [seed];
    for (let j = i + 1; j < pool.length; j++) {
      const c = pool[j];
      if (used.has(c.id)) continue;
      if (!canJoinGroup(group, c, blocks)) continue;
      group.push(c);
      if (group.length >= groupBounds(group).max) break;
    }
    if (!isValidGroup(group)) continue;
    const settled = settle(group);
    if (!settled) continue;
    groups.push(settled);
    settled.group.forEach((g) => used.add(g.id));
  }
  return groups;
}

/**
 * 排时间：选日期和集合时刻；时间上和已加入的局重叠的人先跳过（留在撮合池里），
 * 剩下的人重新排，直到没人冲突；人数不够了这组就不成。
 */
function settleGroup(db, group, now, rejected) {
  let members = group;
  for (;;) {
    const plan = planGroup(members, now);
    if (!plan) return null;
    const duration = defaultDurationForTask(members[0].task);
    const busy = members.filter((m) => firstOverlap(db, m.user_id, plan.startAt, duration));
    if (!busy.length) {
      if (rejected.has(comboKey(members[0].task, plan.date, members.map((g) => g.user_id)))) return null;
      return { group: members, plan };
    }
    members = members.filter((m) => !busy.includes(m));
    if (!isValidGroup(members)) return null;
  }
}

function createProposal(db, group, plan, blocks) {
  const { score, reasons, risks } = scoreGroup(group, plan, blocks);
  const task = group[0].task;
  const id = db.insert('proposals', {
    task,
    category: group[0].category || tagCategory(db, task),
    date: plan.date,
    slot: plan.slot,
    area: group[0].area,
    title: proposalTitle(task, plan.date, plan.slot),
    intent_ids: json.str(group.map((g) => g.id)),
    user_ids: json.str(group.map((g) => g.user_id)),
    score,
    reasons: json.str(reasons),
    risks: json.str(risks),
    status: 'pending',
    created_at: clock.iso(),
  });
  for (const g of group) {
    db.update('intents', g.id, { status: 'proposed', proposal_id: id, updated_at: clock.iso() });
  }
  return { id, score, risks };
}

/**
 * 跑一次撮合：过期处理 → 组队生成建议 → 撮合局补邀 → 自动成局（如开启）。
 * 返回 { created, autoConfirmed, backfilled, expired }
 */
export function runMatching(db) {
  return db.tx(() => {
    const now = clock.now();
    const expired = expireStale(db, now);
    const blocks = allBlockPairs(db);
    const pool = openPool(db, now);
    const rejected = new Set(
      db
        .all("SELECT task, date, user_ids FROM proposals WHERE status = 'rejected'")
        .map((p) => comboKey(p.task, p.date, json.parse(p.user_ids, []))),
    );

    // 先给有人换一批的撮合局补邀（不再经过后台），剩下的人再组新队
    const used = new Set();
    const backfilled = backfillInvitingEvents(db, pool, used);

    const created = [];
    const settle = (group) => settleGroup(db, group, now, rejected);
    for (const { group, plan } of buildGroups(pool.filter((i) => !used.has(i.id)), blocks, settle)) {
      created.push(createProposal(db, group, plan, blocks));
    }

    const autoConfirmed = autoConfirmPending(db);
    return { created: created.length, autoConfirmed, backfilled, expired };
  });
}

/**
 * 自动成局（后台设置打开时）：每次撮合都检查所有待确认的建议，
 * score ≥ 阈值且没有任何风险的直接确认；确认不了的（比如集合时间已过）留给后台。
 */
function autoConfirmPending(db) {
  const auto = getSetting(db, 'autoConfirm');
  if (!auto.enabled) return 0;
  let confirmed = 0;
  for (const p of db.all("SELECT * FROM proposals WHERE status = 'pending' ORDER BY id")) {
    if (p.score < auto.threshold || json.parse(p.risks, []).length) continue;
    try {
      confirmProposal(db, p.id, {});
      confirmed++;
    } catch {
      // 只回滚这一条（嵌套事务用 SAVEPOINT），其余照常
    }
  }
  return confirmed;
}

// ---- 后台：建议局 ----

export function proposalView(db, p) {
  const intents = json
    .parse(p.intent_ids, [])
    .map((id) => db.get('SELECT * FROM intents WHERE id = ?', id))
    .filter(Boolean);
  const bounds = intents.length ? groupBounds(intents) : { min: 2, max: 2 };
  const plan = proposalPlan(p, intents);
  return {
    id: p.id,
    title: p.title,
    task: p.task,
    category: p.category,
    date: p.date,
    dateLabel: weekdayName(p.date),
    slot: p.slot,
    slotLabel: slotLabel(p.slot, p.task),
    // 大家时间窗的交集；有人用了自定义时间段时 windowLabel 是「14:00–16:30」，否则是时间段
    window: { from: fmtHHMM(plan.window[0]), to: fmtHHMM(plan.window[1]) },
    windowLabel: windowLabel(plan, p),
    defaultStartAt: plan.startAt.toISOString(), // 确认表单里集合时间的默认值
    area: p.area,
    score: p.score,
    reasons: json.parse(p.reasons, []),
    risks: json.parse(p.risks, []),
    createdAt: p.created_at,
    status: p.status,
    eventId: p.event_id,
    reviewedAt: p.reviewed_at,
    reviewNote: p.review_note,
    // 组里所有人约好的人数范围：确认时人数要 ≥ minSize，人数上限要 ≤ maxSize
    minSize: bounds.min,
    maxSize: bounds.max,
    members: intents.map((i) => {
      const u = getUser(db, i.user_id);
      return {
        user: userBrief(db, u),
        gender: u.gender,
        pace: u.pace,
        isNew: isNewUser(db, u.id),
        intentId: i.id,
        intentCreatedAt: i.created_at,
        timeLabel: intentTimeLabel(i),
      };
    }),
  };
}

const PROPOSAL_STATUSES = ['pending', 'confirmed', 'rejected', 'expired', 'all'];

/** pending 按匹配度排；已处理的（confirmed / rejected / expired）按处理时间倒序，最多 200 条 */
export function listProposals(db, status = 'pending') {
  oneOf(status, '状态筛选', PROPOSAL_STATUSES);
  let rows;
  if (status === 'all') rows = db.all('SELECT * FROM proposals ORDER BY id DESC LIMIT 200');
  else if (status === 'pending') rows = db.all("SELECT * FROM proposals WHERE status = 'pending' ORDER BY score DESC, id");
  else rows = db.all('SELECT * FROM proposals WHERE status = ? ORDER BY reviewed_at DESC, id DESC LIMIT 200', status);
  return { items: rows.map((p) => proposalView(db, p)) };
}

function requirePending(db, id) {
  const p = db.get('SELECT * FROM proposals WHERE id = ?', id);
  if (!p) throw notFound('建议不存在');
  if (p.status !== 'pending') throw conflict('这条建议已经处理过了');
  return p;
}

/** 退回：意向回到 open（同一组人同一天不会再被撮合到一起） */
export function rejectProposal(db, id, note = null) {
  return db.tx(() => {
    const p = requirePending(db, id);
    const now = clock.iso();
    db.update('proposals', id, { status: 'rejected', reviewed_at: now, review_note: note });
    db.run(
      "UPDATE intents SET status = 'open', proposal_id = NULL, updated_at = ? WHERE proposal_id = ? AND status = 'proposed'",
      now,
      p.id,
    );
    return { ok: true };
  });
}

/** 重新计算匹配度 / 理由 / 风险 */
function rescore(db, p, intentIds) {
  const now = clock.now();
  const intents = intentIds.map((id) => db.get('SELECT * FROM intents WHERE id = ?', id)).filter(Boolean);
  const group = intents.map((i) => enrichIntent(db, i, now));
  const blocks = allBlockPairs(db);
  const { score, reasons, risks } = scoreGroup(group, { date: p.date, slot: p.slot }, blocks);
  db.update('proposals', p.id, {
    intent_ids: json.str(intents.map((i) => i.id)),
    user_ids: json.str(intents.map((i) => i.user_id)),
    score,
    reasons: json.str(reasons),
    risks: json.str(risks),
  });
}

/** 调整成员：remove 为 userId，add 为 open 意向的 id */
export function adjustProposalMembers(db, id, { remove = [], add = [] } = {}) {
  return db.tx(() => {
    const p = requirePending(db, id);
    if (!Array.isArray(remove) || !Array.isArray(add)) throw invalid('remove / add 需要是数组');
    const now = clock.iso();
    let intentIds = json.parse(p.intent_ids, []);
    for (const userId of remove) {
      const intent = intentIds.map((x) => db.get('SELECT * FROM intents WHERE id = ?', x)).find((i) => i?.user_id === userId);
      if (!intent) throw invalid('要移除的人不在这条建议里');
      db.update('intents', intent.id, { status: 'open', proposal_id: null, updated_at: now });
      intentIds = intentIds.filter((x) => x !== intent.id);
    }
    for (const intentId of add) {
      const intent = db.get('SELECT * FROM intents WHERE id = ?', intentId);
      if (!intent || intent.status !== 'open') throw invalid('只能加入撮合池里还在等的意向');
      const userIds = intentIds.map((x) => db.get('SELECT user_id FROM intents WHERE id = ?', x)?.user_id);
      if (userIds.includes(intent.user_id)) throw invalid('这个人已经在组里了');
      db.update('intents', intent.id, { status: 'proposed', proposal_id: p.id, updated_at: now });
      intentIds.push(intent.id);
    }
    if (intentIds.length < 2) throw invalid('至少要保留 2 个人');
    rescore(db, p, intentIds);
    return proposalView(db, db.get('SELECT * FROM proposals WHERE id = ?', id));
  });
}

/** 用户取消了在建议里的意向：从建议里移除；剩不到 2 人时建议作废、其他人回到 open */
export function removeIntentFromProposal(db, intent) {
  const p = db.get('SELECT * FROM proposals WHERE id = ?', intent.proposal_id);
  if (!p || p.status !== 'pending') return;
  const remaining = json.parse(p.intent_ids, []).filter((x) => x !== intent.id);
  if (remaining.length < 2) {
    db.update('proposals', p.id, { status: 'expired', reviewed_at: clock.iso(), review_note: '成员取消了意向' });
    db.run(
      "UPDATE intents SET status = 'open', proposal_id = NULL, updated_at = ? WHERE proposal_id = ? AND status = 'proposed' AND id != ?",
      clock.iso(),
      p.id,
      intent.id,
    );
    return;
  }
  rescore(db, p, remaining);
}

const INTENT_STATUSES = ['open', 'proposed', 'invited', 'matched', 'cancelled', 'expired', 'all'];

/** 后台：撮合池里的意向（默认 open；proposed = 已进建议局、等后台确认的） */
export function listPoolIntents(db, status = 'open') {
  oneOf(status, '状态筛选', INTENT_STATUSES);
  const rows =
    status === 'all'
      ? db.all('SELECT * FROM intents ORDER BY id DESC LIMIT 300')
      : db.all('SELECT * FROM intents WHERE status = ? ORDER BY created_at LIMIT 300', status);
  const now = clock.now().getTime();
  return {
    items: rows.map((i) => {
      const view = intentView(i);
      return {
        id: i.id,
        user: userBrief(db, i.user_id),
        task: i.task,
        title: view.title,
        dateFrom: i.date_from,
        dateTo: i.date_to,
        slot: i.slot,
        slotLabel: view.slotLabel,
        timeFrom: view.timeFrom,
        timeTo: view.timeTo,
        timeLabel: view.timeLabel,
        area: i.area,
        sizeMin: i.size_min,
        sizeMax: i.size_max,
        relaxTime: Boolean(i.relax_time),
        relaxSize: Boolean(i.relax_size),
        status: i.status,
        eventId: i.event_id ?? null,
        proposalId: i.proposal_id ?? null,
        isNew: isNewUser(db, i.user_id),
        createdAt: i.created_at,
        waitingHours: Math.max(0, Math.floor((now - Date.parse(i.created_at)) / 3600000)),
      };
    }),
  };
}

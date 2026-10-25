// 撮合引擎：从撮合池里按提交时间贪心组队 → 生成建议（proposals），并处理补邀和自动成局。
import { clock } from '../clock.js';
import { categoryOfTask } from '../constants.js';
import { json } from '../db.js';
import { conflict, invalid, notFound } from '../errors.js';
import { bjDate, slotLabel, weekdayName } from '../time.js';
import { backfillInvitingEvents, confirmProposal, openPool } from './invites.js';
import {
  canJoinGroup,
  enrichIntent,
  groupBounds,
  isIntentExpired,
  planGroup,
  proposalTitle,
  scoreGroup,
} from './matchRules.js';
import { getSetting } from './settings.js';
import { intentView } from './intentFormat.js';
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

const comboKey = (task, date, userIds) => `${task}|${date}|${[...userIds].sort((a, b) => a - b).join(',')}`;

/** 贪心组队：按提交时间，从每个还没分组的意向开始，依次吸收兼容的人，直到人数上限 */
export function buildGroups(pool, blocks) {
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
    if (group.length < 2 || group.length < groupBounds(group).min) continue;
    groups.push(group);
    group.forEach((g) => used.add(g.id));
  }
  return groups;
}

function createProposal(db, group, plan, blocks) {
  const { score, reasons, risks } = scoreGroup(group, plan, blocks);
  const task = group[0].task;
  const id = db.insert('proposals', {
    task,
    category: group[0].category || categoryOfTask(task),
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
    for (const group of buildGroups(pool.filter((i) => !used.has(i.id)), blocks)) {
      const plan = planGroup(group, now);
      if (!plan) continue;
      if (rejected.has(comboKey(group[0].task, plan.date, group.map((g) => g.user_id)))) continue;
      created.push(createProposal(db, group, plan, blocks));
    }

    let autoConfirmed = 0;
    const auto = getSetting(db, 'autoConfirm');
    if (auto.enabled) {
      for (const p of created) {
        if (p.score >= auto.threshold && p.risks.length === 0) {
          confirmProposal(db, p.id, {});
          autoConfirmed++;
        }
      }
    }
    return { created: created.length, autoConfirmed, backfilled, expired };
  });
}

// ---- 后台：建议局 ----

export function proposalView(db, p) {
  const intents = json
    .parse(p.intent_ids, [])
    .map((id) => db.get('SELECT * FROM intents WHERE id = ?', id))
    .filter(Boolean);
  return {
    id: p.id,
    title: p.title,
    task: p.task,
    category: p.category,
    date: p.date,
    dateLabel: weekdayName(p.date),
    slot: p.slot,
    slotLabel: slotLabel(p.slot, p.task),
    area: p.area,
    score: p.score,
    reasons: json.parse(p.reasons, []),
    risks: json.parse(p.risks, []),
    createdAt: p.created_at,
    status: p.status,
    eventId: p.event_id,
    reviewedAt: p.reviewed_at,
    reviewNote: p.review_note,
    members: intents.map((i) => {
      const u = getUser(db, i.user_id);
      return {
        user: userBrief(db, u),
        gender: u.gender,
        pace: u.pace,
        isNew: isNewUser(db, u.id),
        intentId: i.id,
        intentCreatedAt: i.created_at,
      };
    }),
  };
}

export function listProposals(db, status = 'pending') {
  const rows =
    status === 'all'
      ? db.all('SELECT * FROM proposals ORDER BY id DESC LIMIT 200')
      : db.all('SELECT * FROM proposals WHERE status = ? ORDER BY score DESC, id', status);
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

/** 后台：撮合池里还在等的意向 */
export function listPoolIntents(db, status = 'open') {
  const rows =
    status === 'all'
      ? db.all('SELECT * FROM intents ORDER BY id DESC LIMIT 300')
      : db.all('SELECT * FROM intents WHERE status = ? ORDER BY created_at', status);
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
        area: i.area,
        sizeMin: i.size_min,
        sizeMax: i.size_max,
        relaxTime: Boolean(i.relax_time),
        relaxSize: Boolean(i.relax_size),
        status: i.status,
        createdAt: i.created_at,
        waitingHours: Math.max(0, Math.floor((now - Date.parse(i.created_at)) / 3600000)),
      };
    }),
  };
}

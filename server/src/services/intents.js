// 撮合意向：提交（立刻触发一次撮合）、查看、放宽条件、取消。
import { clock } from '../clock.js';
import { DEFAULT_AREA, defaultSlotForTask } from '../constants.js';
import { conflict, invalid, notFound, restricted } from '../errors.js';
import {
  EARLIEST_MINUTE,
  LATEST_MINUTE,
  SLOTS,
  addDays,
  bjDate,
  dateLabel,
  fmtHHMM,
  parseHHMM,
  resolveWhen,
  slotOfMinute,
} from '../time.js';
import { bool, int, oneOf, str } from '../validate.js';
import { creditOf, effectiveStatus } from './credit.js';
import { intentView } from './intentFormat.js';
import { declineInvite } from './invites.js';
import { MIN_TOGETHER, enrichIntent, intentWindow, isIntentExpired, pairCompatible, sizeBounds } from './matchRules.js';
import { removeIntentFromProposal, runMatching } from './matching.js';
import { overlapLabel, windowGap } from './overlap.js';
import { parseTag, tagKey, useTag } from './tags.js';
import { allBlockPairs } from './users.js';

const ACTIVE_STATUSES = ['open', 'proposed', 'invited'];

function assertCanMatch(db, user) {
  if (effectiveStatus(user) !== 'active' || creditOf(db, user).level === 'restricted') {
    throw restricted('账号受限中，暂时不能撮合');
  }
}

const given = (v) => v !== undefined && v !== null && v !== '';

/**
 * 时间：slot（morning / afternoon / evening / allday）和 timeFrom + timeTo（"HH:MM"，北京时间）二选一；
 * 都不给按任务给默认时间段。自定义时间段要在 05:00–23:59 之间、至少 60 分钟。
 */
function parseIntentTime(body, task) {
  const hasSlot = given(body.slot);
  const hasTime = given(body.timeFrom) || given(body.timeTo);
  if (hasSlot && hasTime) throw invalid('时间段和具体时间只能选一个');
  if (!hasTime) {
    return { slot: oneOf(body.slot, '时间段', SLOTS, { optional: true }) ?? defaultSlotForTask(task), timeFrom: null, timeTo: null };
  }
  if (!given(body.timeFrom) || !given(body.timeTo)) throw invalid('请同时填写开始和结束时间');
  const from = parseHHMM(body.timeFrom);
  const to = parseHHMM(body.timeTo);
  if (from === null || to === null) throw invalid('时间格式不正确，请用 HH:MM（如 14:00）');
  if (from < EARLIEST_MINUTE || to > LATEST_MINUTE) throw invalid('时间要在 05:00–23:59 之间');
  if (from >= to) throw invalid('结束时间要晚于开始时间');
  if (to - from < MIN_TOGETHER) throw invalid('时间段至少要 1 个小时');
  // slot 只作参考（按开始时间推），时间窗以 timeFrom / timeTo 为准
  return { slot: slotOfMinute(from), timeFrom: fmtHHMM(from), timeTo: fmtHHMM(to) };
}

function datesBetween(from, to) {
  const dates = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  return dates;
}

export function createIntent(db, user, body) {
  assertCanMatch(db, user);
  const now = clock.now();
  const task = parseTag(body.task, '想做的事');
  if (body.when === undefined || body.when === null || body.when === '') throw invalid('请选择什么时候');
  const range = resolveWhen(String(body.when), now);
  if (!range) throw invalid('时间格式不正确，可以是 today / tomorrow / weekend / YYYY-MM-DD');
  const today = bjDate(now);
  if (range.dateFrom < today) throw invalid('不能选已经过去的日子');
  if (range.dateTo > addDays(today, 30)) throw invalid('只能选 30 天以内的日子');
  const { slot, timeFrom, timeTo } = parseIntentTime(body, task);
  const area = str(body.area, '地区', { max: 20, optional: true }) ?? DEFAULT_AREA;
  const sizeMin = int(body.sizeMin, '最少人数', { min: 2, max: 20, optional: true }) ?? 3;
  const sizeMax = int(body.sizeMax, '最多人数', { min: 2, max: 20, optional: true }) ?? Math.max(5, sizeMin);
  if (sizeMin > sizeMax) throw invalid('最少人数不能大于最多人数');
  const relaxTime = bool(body.relaxTime, '时间放宽', { optional: true }) ?? false;
  const relaxSize = bool(body.relaxSize, '人数放宽', { optional: true }) ?? false;
  const label = str(body.label, '描述', { max: 20, optional: true });
  const shape = { date_to: range.dateTo, slot, relax_time: relaxTime, time_from: timeFrom, time_to: timeTo };
  if (isIntentExpired(shape, now)) throw invalid('这个时间段已经过去了，换个时间吧');

  // 同一个标签（按规范化的 key 比较）、日期有重叠的意向只能有一个在撮合中
  const key = tagKey(task);
  const duplicate = db
    .all(
      `SELECT task FROM intents WHERE user_id = ? AND status IN ('open', 'proposed', 'invited')
       AND date_from <= ? AND date_to >= ?`,
      user.id,
      range.dateTo,
      range.dateFrom,
    )
    .some((row) => tagKey(row.task) === key);
  if (duplicate) throw conflict('你已经有一个相同的意向在撮合中了');

  // 时间窗里已经没有连续 60 分钟的空档（都被已加入的局占了）
  const gap = windowGap(db, user.id, datesBetween(range.dateFrom, range.dateTo), intentWindow(shape), MIN_TOGETHER);
  if (!gap.free) throw conflict(`这个时间你已经有局了：${gap.blockers.slice(0, 2).map(overlapLabel).join('、')}`);

  const id = db.tx(() => {
    const tag = useTag(db, task);
    return db.insert('intents', {
      user_id: user.id,
      task: tag.name,
      category: tag.category,
      label,
      date_from: range.dateFrom,
      date_to: range.dateTo,
      slot,
      time_from: timeFrom,
      time_to: timeTo,
      area,
      size_min: sizeMin,
      size_max: sizeMax,
      relax_time: relaxTime,
      relax_size: relaxSize,
      status: 'open',
      created_at: now.toISOString(),
    });
  });
  runMatching(db); // 提交后立刻撮合一次
  return intentView(db.get('SELECT * FROM intents WHERE id = ?', id));
}

function requireOwnIntent(db, user, id) {
  const intent = db.get('SELECT * FROM intents WHERE id = ?', id);
  if (!intent || intent.user_id !== user.id) throw notFound('意向不存在');
  return intent;
}

export function myIntents(db, user) {
  const rows = db.all(
    `SELECT * FROM intents WHERE user_id = ? AND status IN ('open', 'proposed', 'invited') ORDER BY created_at DESC`,
    user.id,
  );
  return { items: rows.map((i) => intentView(i)) };
}

/** 其他条件相同（能和我配到一起）的 open 意向数，按人去重 */
export function similarCount(db, intent) {
  const now = clock.now();
  const me = enrichIntent(db, intent, now);
  const blocks = allBlockPairs(db);
  const users = new Set();
  const rows = db.all(
    "SELECT * FROM intents WHERE status = 'open' AND area = ? AND id != ? AND user_id != ?",
    intent.area,
    intent.id,
    intent.user_id,
  );
  for (const row of rows) {
    if (tagKey(row.task) !== me.taskKey) continue;
    if (isIntentExpired(row, now)) continue;
    const other = enrichIntent(db, row, now);
    if (other.userStatus !== 'active' || other.creditLevel === 'restricted') continue;
    if (pairCompatible(me, other, blocks)) users.add(other.user_id);
  }
  return users.size;
}

export function intentDetail(db, user, id) {
  const intent = requireOwnIntent(db, user, id);
  const similar = similarCount(db, intent);
  const needMore = intent.status === 'open' ? Math.max(0, sizeBounds(intent).min - (similar + 1)) : 0;
  return {
    ...intentView(intent),
    similarCount: similar,
    needMore,
    submittedAt: intent.created_at,
    submittedLabel: dateLabel(new Date(intent.created_at)),
  };
}

export function updateIntent(db, user, id, body) {
  const intent = requireOwnIntent(db, user, id);
  if (!['open', 'proposed'].includes(intent.status)) throw conflict('这个意向已经有结果了，不能再修改');
  const patch = { updated_at: clock.iso() };
  const relaxTime = bool(body.relaxTime, '时间放宽', { optional: true });
  const relaxSize = bool(body.relaxSize, '人数放宽', { optional: true });
  if (relaxTime !== null) patch.relax_time = relaxTime;
  if (relaxSize !== null) patch.relax_size = relaxSize;
  db.update('intents', id, patch);
  if (intent.status === 'open') runMatching(db);
  return intentDetail(db, user, id);
}

export function cancelIntent(db, user, id) {
  return db.tx(() => {
    const intent = requireOwnIntent(db, user, id);
    if (intent.status === 'matched') throw invalid('已经成局了，要退出请到局里操作');
    if (!ACTIVE_STATUSES.includes(intent.status)) return { ok: true };
    if (intent.status === 'proposed') removeIntentFromProposal(db, intent);
    if (intent.status === 'invited' && intent.event_id) declineInvite(db, user, intent.event_id);
    db.update('intents', id, { status: 'cancelled', proposal_id: null, event_id: null, updated_at: clock.iso() });
    return { ok: true };
  });
}

export { intentView };

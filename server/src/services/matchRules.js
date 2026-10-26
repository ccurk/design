// 撮合规则（纯函数为主）：兼容性、人数、时间窗、日期选择、匹配度 / 理由 / 风险（docs/api.md 3.2）。
import { clock, HOUR } from '../clock.js';
import { json } from '../db.js';
import {
  SLOT_WINDOWS,
  addDays,
  bjDate,
  bjDateTime,
  defaultStartTime,
  parseHHMM,
  rangeText,
  slotLabel,
  slotOfMinute,
  weekdayName,
} from '../time.js';
import { creditOf, effectiveStatus } from './credit.js';
import { tagKey } from './tags.js';
import { isNewUser, userSettings } from './users.js';

/** 一组人的时间窗交集至少要有 60 分钟 */
export const MIN_TOGETHER = 60;

/** 人数范围；开了「2–6 人都可以」按 2–6 算 */
export function sizeBounds(intent) {
  return intent.relax_size ? { min: 2, max: 6 } : { min: intent.size_min, max: intent.size_max };
}

/** 时间段是否可放宽：allday 或开了「时间放宽到全天」 */
export function isFlexible(intent) {
  return intent.slot === 'allday' || Boolean(intent.relax_time);
}

/** 用了自定义时间段（timeFrom / timeTo）的意向 */
export function isCustomTime(intent) {
  return parseHHMM(intent.time_from) !== null && parseHHMM(intent.time_to) !== null;
}

/**
 * 意向的时间窗 [from, to)（北京时间当天的分钟数）：自定义时间段，或时间段对应的窗
 * （上午 05:00–12:00、下午 12:00–18:00、晚上 18:00–23:00、全天 05:00–23:00）；
 * 开了「放宽到全天」时扩到至少 05:00–23:00。
 */
export function intentWindow(intent) {
  let [from, to] = isCustomTime(intent)
    ? [parseHHMM(intent.time_from), parseHHMM(intent.time_to)]
    : SLOT_WINDOWS[intent.slot] ?? SLOT_WINDOWS.allday;
  if (intent.relax_time) {
    from = Math.min(from, SLOT_WINDOWS.allday[0]);
    to = Math.max(to, SLOT_WINDOWS.allday[1]);
  }
  return [from, to];
}

const windowOf = (x) => x.window ?? intentWindow(x);
const keyOf = (x) => x.taskKey ?? tagKey(x.task);

export function datesOverlap(a, b) {
  return a.date_from <= b.date_to && b.date_from <= a.date_to;
}

/** 两个时间窗重叠的分钟数（不重叠时 ≤ 0） */
export function windowOverlap(a, b) {
  return Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
}

/**
 * 时间能不能凑上：两人的时间窗交集 ≥ 60 分钟。
 * 只用时间段时等价于原来的规则（同一个时间段，或任一方是全天 / 放宽到全天）。
 * 区间两两交集 ≥ 60 分钟 ⇔ 整组交集 ≥ 60 分钟，所以组队时两两检查就够了。
 */
export function windowsCompatible(a, b) {
  return windowOverlap(windowOf(a), windowOf(b)) >= MIN_TOGETHER;
}

/** 一组人时间窗的交集 [from, to) */
export function groupWindow(group) {
  return [Math.max(...group.map((g) => windowOf(g)[0])), Math.min(...group.map((g) => windowOf(g)[1]))];
}

/** 意向是否已过期：最后一天的时间窗已经结束（自定义时间段 = date_to 的 timeTo） */
export function isIntentExpired(intent, now = clock.now()) {
  const [, to] = intentWindow(intent);
  return bjDateTime(intent.date_to, 0, to).getTime() <= now.getTime();
}

/** 自定义时间段的集合时刻：交集开始时间向上取整到 :00 / :30；取整后剩不到 60 分钟就用交集开始 */
export function customStartMinute([from, to]) {
  const rounded = Math.ceil(from / 30) * 30;
  return rounded + MIN_TOGETHER <= to ? rounded : from;
}

const minutesOf = ([h, m]) => h * 60 + m;

/** 给意向附上撮合需要的用户信息 */
export function enrichIntent(db, intent, now = clock.now()) {
  const user = db.get('SELECT * FROM users WHERE id = ?', intent.user_id);
  const credit = creditOf(db, user, now);
  return {
    ...intent,
    taskKey: tagKey(intent.task),
    window: intentWindow(intent),
    custom: isCustomTime(intent),
    nickname: user.nickname,
    gender: user.gender,
    pace: user.pace,
    interests: json.parse(user.interests, []),
    sameSexOnly: userSettings(user).sameSexOnly,
    userStatus: effectiveStatus(user, now),
    creditLevel: credit.level,
    isNew: isNewUser(db, user.id),
  };
}

/** 两个意向能否进同一组（同标签、同地区、日期重叠、时间窗交集 ≥ 60 分钟、没有拉黑、同性规则） */
export function pairCompatible(a, b, blocks) {
  if (a.user_id === b.user_id) return false;
  if (keyOf(a) !== keyOf(b) || a.area !== b.area) return false;
  if (!datesOverlap(a, b) || !windowsCompatible(a, b)) return false;
  if (blocks.has(`${a.user_id}:${b.user_id}`) || blocks.has(`${b.user_id}:${a.user_id}`)) return false;
  if (a.sameSexOnly || b.sameSexOnly) {
    if (a.gender === 'unknown' || b.gender === 'unknown' || a.gender !== b.gender) return false;
  }
  return true;
}

export function groupBounds(group) {
  return {
    min: Math.max(...group.map((g) => sizeBounds(g).min)),
    max: Math.min(...group.map((g) => sizeBounds(g).max)),
  };
}

/** 候选人能否加入当前组（兼容所有人，且人数约束仍可满足） */
export function canJoinGroup(group, candidate, blocks) {
  if (!group.every((g) => pairCompatible(g, candidate, blocks))) return false;
  const { min, max } = groupBounds([...group, candidate]);
  return group.length + 1 <= max && min <= max;
}

/**
 * 组的时间段：有人用了自定义时间段时按交集的开始时刻推（只用来起标题）；
 * 否则有固定时间段的人以其为准，再否则取大家原本选的时间段里最多的。
 */
export function groupSlot(group) {
  if (group.some(isCustomTime)) return slotOfMinute(groupWindow(group)[0]);
  const fixed = group.find((g) => !isFlexible(g));
  if (fixed) return fixed.slot;
  const counts = {};
  for (const g of group) if (g.slot !== 'allday') counts[g.slot] = (counts[g.slot] || 0) + 1;
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : 'allday';
}

/**
 * 默认集合时刻（当天第几分钟）：没人用自定义时间段时和以前一样按任务 / 时间段（看日出 05:50、下午 15:00……）；
 * 有人用了自定义时间段时取交集开始时间（向上取整到 :00 / :30）。
 */
export function groupStartMinute(group, slot = groupSlot(group)) {
  if (group.some(isCustomTime)) return customStartMinute(groupWindow(group));
  return minutesOf(defaultStartTime(group[0].task, slot));
}

/** 选日期：所有人日期区间的交集里，第一个默认集合时刻在 2 小时以后的日子 */
export function planGroup(group, now = clock.now()) {
  const from = group.map((g) => g.date_from).sort().at(-1);
  const to = group.map((g) => g.date_to).sort()[0];
  const slot = groupSlot(group);
  const window = groupWindow(group);
  const custom = group.some(isCustomTime);
  const startMinute = groupStartMinute(group, slot);
  for (let d = from < bjDate(now) ? bjDate(now) : from; d <= to; d = addDays(d, 1)) {
    const startAt = bjDateTime(d, 0, startMinute);
    if (startAt.getTime() > now.getTime() + 2 * HOUR) return { date: d, slot, startAt, window, custom };
  }
  return null;
}

/** 建议局（已经存下来的）的时间：时间窗交集、有没有人用自定义时间段、默认集合时刻（确认表单的默认值） */
export function proposalPlan(p, intents) {
  const custom = intents.some(isCustomTime);
  const window = intents.length ? groupWindow(intents) : SLOT_WINDOWS[p.slot] ?? SLOT_WINDOWS.allday;
  const startMinute = intents.length && custom ? customStartMinute(window) : minutesOf(defaultStartTime(p.task, p.slot));
  return { window, custom, startAt: bjDateTime(p.date, 0, startMinute) };
}

/** 建议局的时间窗标签：有人用了自定义时间段时是「14:00–16:30」，否则是时间段（清晨 / 上午 / 下午 / 晚上 / 全天） */
export function windowLabel(plan, p) {
  return plan.custom ? rangeText(plan.window[0], plan.window[1]) : slotLabel(p.slot, p.task);
}

const TASK_PHRASES = {
  看日出: '去看日出',
  爬山: '去爬山',
  徒步: '去徒步',
  骑行: '去骑行',
  随便走走: '随便走走',
  吃饭: '一起吃饭',
  早餐: '吃早餐',
  夜市: '逛夜市',
  咖啡: '喝咖啡',
  读书: '安静读书',
  桌游: '玩桌游',
  拼车: '拼车出发',
};

const PACE_REASONS = { slow: '都偏慢热', warm: '都是熟了就话多', open: '都随时能聊' };

export function taskPhrase(task) {
  return TASK_PHRASES[task] || `一起${task}`;
}

const TASK_VERBS = { 咖啡: '喝咖啡', 早餐: '吃早餐', 夜市: '逛夜市', 桌游: '玩桌游' };

/** 建议局的默认标题：「周六清晨 · 一起看日出」「周二下午 · 一起喝咖啡」 */
export function proposalTitle(task, date, slot) {
  const when = `${weekdayName(date)}${slot === 'allday' ? '' : slotLabel(slot, task)}`;
  return `${when} · 一起${TASK_VERBS[task] || task}`;
}

/**
 * 匹配度：基础 60；全组社交节奏相同 +10；时间段完全一致 +10；共同兴趣每个 +5（最多 15）；
 * 全员信用良好 +5；满分 100。同时给出中文理由和风险提示。
 */
export function scoreGroup(group, plan, blocks = new Set()) {
  const task = group[0].task;
  const when = `${weekdayName(plan.date)}${plan.slot === 'allday' ? '' : slotLabel(plan.slot, task)}`;
  let score = 60;
  const reasons = [`都想${taskPhrase(task)}`];
  const risks = [];

  if (group.some(isCustomTime)) {
    // 有人用了自定义时间段：理由写交集；大家的时间窗完全一样才算「时间一致」
    const windows = group.map(windowOf);
    if (windows.every((w) => w[0] === windows[0][0] && w[1] === windows[0][1])) score += 10;
    const [from, to] = groupWindow(group);
    // 后台调整成员后交集可能不够 60 分钟：不写理由，下面的风险会提示
    if (to - from >= MIN_TOGETHER) reasons.push(`大家都有空：${rangeText(from, to)}`);
  } else {
    const slots = group.map((g) => g.slot);
    if (slots.every((s) => s === slots[0])) {
      score += 10;
      reasons.push(`时间都在${when}`);
    } else {
      reasons.push(`时间都能凑上${when}`);
    }
  }

  const paces = group.map((g) => g.pace);
  if (paces[0] && paces.every((p) => p === paces[0])) {
    score += 10;
    reasons.push(PACE_REASONS[paces[0]] || '社交节奏相近');
  }

  const common = group
    .map((g) => g.interests || [])
    .reduce((acc, list) => acc.filter((x) => list.includes(x)));
  if (common.length) {
    score += Math.min(15, common.length * 5);
    reasons.push(`共同兴趣：${common.slice(0, 3).join('、')}`);
  }

  if (group.every((g) => g.creditLevel === 'good')) {
    score += 5;
    reasons.push('全员信用良好');
  }

  const fair = group.filter((g) => g.creditLevel !== 'good').length;
  if (fair) risks.push(`有 ${fair} 人信用一般`);
  const newbies = group.filter((g) => g.isNew).length;
  if (newbies === group.length) risks.push('全员陌生，建议选公共场所');
  else if (newbies) risks.push(`${newbies} 位是第一次参加`);
  if (plan.slot === 'evening') risks.push('夜间局，集合点要选人多的地方');

  // 后台手动调整成员后可能出现的冲突
  const pairs = [];
  for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) pairs.push([group[i], group[j]]);
  if (pairs.some(([a, b]) => blocks.has(`${a.user_id}:${b.user_id}`) || blocks.has(`${b.user_id}:${a.user_id}`))) {
    risks.push('组里有人互相拉黑，不能成局');
  } else if (pairs.some(([a, b]) => !pairCompatible(a, b, blocks))) {
    risks.push('有人的时间或条件不完全一致');
  }

  return { score: Math.min(100, score), reasons, risks };
}

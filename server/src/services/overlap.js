// 时间重叠检测：一个人已加入（joined / applied）的局，时间段 [开始, 开始 + 时长) 不能和新局重叠（docs/api.md 3.3）。
// 报名、接受撮合邀请、发起局、发起人通过申请、后台确认建议、撮合排时间、提交意向时都会用到。
import { DAY, MINUTE } from '../clock.js';
import { conflict } from '../errors.js';
import { bjDateTime, eventRangeLabel, shortTitle } from '../time.js';

const endMs = (e) => Date.parse(e.start_at) + e.duration_min * MINUTE;

/** userId 已加入 / 申请中、且和 [from, to) 有重叠的局（按开始时间排） */
export function busyEvents(db, userId, from, to, { excludeEventId = null } = {}) {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  return db
    .all(
      `SELECT e.* FROM event_members m JOIN events e ON e.id = m.event_id
       WHERE m.user_id = ? AND m.status IN ('joined', 'applied') AND e.status NOT IN ('cancelled', 'rejected')
         AND e.id != ? AND e.start_at < ? AND e.start_at > ?
       ORDER BY e.start_at, e.id`,
      userId,
      excludeEventId ?? 0,
      new Date(toMs).toISOString(),
      new Date(fromMs - DAY).toISOString(), // 局最长 24 小时
    )
    .filter((e) => endMs(e) > fromMs);
}

/** 和 [startAt, startAt + durationMin) 重叠的第一个局，没有返回 null */
export function firstOverlap(db, userId, startAt, durationMin, opts) {
  const start = new Date(startAt).getTime();
  return busyEvents(db, userId, start, start + durationMin * MINUTE, opts)[0] ?? null;
}

/** 「「苍山看日出」（10月31日 05:50–09:50）」 */
export function overlapLabel(event) {
  return `「${shortTitle(event.title)}」（${eventRangeLabel(new Date(event.start_at), new Date(endMs(event)))}）`;
}

/** 本人报名 / 接受邀请 / 发起局时检查：重叠 → 409「和你已加入的「…」（…）时间重叠了」 */
export function assertNoOverlap(db, userId, startAt, durationMin, opts) {
  const hit = firstOverlap(db, userId, startAt, durationMin, opts);
  if (hit) throw conflict(`和你已加入的${overlapLabel(hit)}时间重叠了`);
}

/**
 * 提交意向时：时间窗（[from, to) 分钟）在这些日期里还有没有连续 minutes 分钟的空档。
 * 有一天有就算有；都没有时返回挡住的局。
 */
export function windowGap(db, userId, dates, [from, to], minutes = 60) {
  const blockers = [];
  for (const date of dates) {
    const start = bjDateTime(date, 0, from).getTime();
    const end = bjDateTime(date, 0, to).getTime();
    const busy = busyEvents(db, userId, start, end);
    let cursor = start;
    let free = false;
    for (const e of busy) {
      if (Date.parse(e.start_at) - cursor >= minutes * MINUTE) {
        free = true;
        break;
      }
      cursor = Math.max(cursor, endMs(e));
    }
    if (free || end - cursor >= minutes * MINUTE) return { free: true, blockers: [] };
    for (const e of busy) if (!blockers.some((b) => b.id === e.id)) blockers.push(e);
  }
  return { free: false, blockers };
}

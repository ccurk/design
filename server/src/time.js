// 北京时间（固定 +08:00，中国不使用夏令时）相关的日期计算与中文标签。
// 不依赖宿主机时区：先把 UTC 时间加 8 小时，再读 getUTC* 字段。
import { clock, DAY } from './clock.js';

const OFFSET = 8 * 60 * 60 * 1000;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const pad = (n) => String(n).padStart(2, '0');

/** 北京时间的各个字段 */
export function bjParts(date) {
  const d = new Date(new Date(date).getTime() + OFFSET);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(), // 0 = 周日
  };
}

/** 北京日期 YYYY-MM-DD */
export function bjDate(date = clock.now()) {
  const p = bjParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function isDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 北京日期 + 时分 → Date（UTC 时间点） */
export function bjDateTime(dateStr, hour = 0, minute = 0) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour, minute) - OFFSET);
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY).toISOString().slice(0, 10);
}

/** b - a 相差的天数 */
export function dayDiff(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
}

export function weekdayOf(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

export function weekdayName(dateStr) {
  return `周${WEEKDAYS[weekdayOf(dateStr)]}`;
}

/** 本周一（周一为一周的开始） */
function mondayOf(dateStr) {
  const wd = weekdayOf(dateStr);
  return addDays(dateStr, -((wd + 6) % 7));
}

/** 下一个（严格晚于今天的）星期几，weekday: 0=周日 … 6=周六 */
export function nextWeekday(weekday, now = clock.now()) {
  const today = bjDate(now);
  const diff = (weekday - weekdayOf(today) + 7) % 7 || 7;
  return addDays(today, diff);
}

/** 最近一个（严格早于今天的）星期几 */
export function lastWeekday(weekday, now = clock.now()) {
  const today = bjDate(now);
  const diff = (weekdayOf(today) - weekday + 7) % 7 || 7;
  return addDays(today, -diff);
}

/** 日期的口语标签：今天 / 明天 / 昨天 / 周六 / 上周五 / 11月8日 */
export function dayLabel(dateStr, now = clock.now()) {
  const today = bjDate(now);
  const diff = dayDiff(today, dateStr);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  if (diff >= 2 && diff <= 6) return weekdayName(dateStr);
  if (diff <= -2 && diff >= -6) {
    return dateStr < mondayOf(today) ? `上${weekdayName(dateStr)}` : weekdayName(dateStr);
  }
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}月${d}日`;
}

export function hhmm(date) {
  const p = bjParts(date);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** 时间点标签：「周六 05:50」「今天 20:00」 */
export function dateLabel(date, now = clock.now()) {
  return `${dayLabel(bjDate(date), now)} ${hhmm(date)}`;
}

/** 完整日期：「10月31日 05:50」 */
export function fullDateLabel(date) {
  const p = bjParts(date);
  return `${p.month}月${p.day}日 ${hhmm(date)}`;
}

/** 按具体时刻给出时段：凌晨 / 清晨 / 上午 / 中午 / 下午 / 晚上 */
export function timeOfDayLabel(date) {
  const h = bjParts(date).hour;
  if (h < 5) return '凌晨';
  if (h < 8) return '清晨';
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  return '晚上';
}

// ---- 撮合时间段 slot ----
export const SLOTS = ['morning', 'afternoon', 'evening', 'allday'];
const SLOT_LABELS = { morning: '上午', afternoon: '下午', evening: '晚上', allday: '全天' };
const SLOT_END_HOUR = { morning: 12, afternoon: 18, evening: 23, allday: 23 };

export function slotLabel(slot, task) {
  if (slot === 'morning' && (task === '看日出' || task === '早餐')) return '清晨';
  return SLOT_LABELS[slot] || '全天';
}

/** 某个日期 + 时间段的结束时刻 */
export function slotEnd(dateStr, slot) {
  return bjDateTime(dateStr, SLOT_END_HOUR[slot] ?? 23, 0);
}

/** 撮合出来的局默认的集合时刻 */
export function defaultStartTime(task, slot) {
  if (task === '看日出') return [5, 50];
  if (task === '早餐') return [8, 30];
  if (slot === 'morning') return [9, 0];
  if (slot === 'afternoon') return [15, 0];
  if (slot === 'evening') return [19, 0];
  return [10, 0];
}

/**
 * when: today | tomorrow | weekend | YYYY-MM-DD → {dateFrom, dateTo}
 * 「本周末」：周一到周五 → 本周六、日；周六 → 今明两天；周日 → 今天。
 */
export function resolveWhen(when, now = clock.now()) {
  const today = bjDate(now);
  if (when === 'today') return { dateFrom: today, dateTo: today };
  if (when === 'tomorrow') {
    const t = addDays(today, 1);
    return { dateFrom: t, dateTo: t };
  }
  if (when === 'weekend') {
    const wd = weekdayOf(today);
    if (wd === 0) return { dateFrom: today, dateTo: today };
    const sat = addDays(today, 6 - wd);
    return { dateFrom: sat, dateTo: addDays(sat, 1) };
  }
  if (isDateStr(when)) return { dateFrom: when, dateTo: when };
  return null;
}

/** 日期区间的标签：「周日」「本周末」「11月8日–11月9日」 */
export function rangeLabel(dateFrom, dateTo, now = clock.now()) {
  if (dateFrom === dateTo) return dayLabel(dateFrom, now);
  if (weekdayOf(dateFrom) === 6 && dayDiff(dateFrom, dateTo) === 1) {
    return dayDiff(bjDate(now), dateFrom) <= 6 ? '本周末' : `${dayLabel(dateFrom, now)}周末`;
  }
  return `${dayLabel(dateFrom, now)}–${dayLabel(dateTo, now)}`;
}

/** 北京某天 [00:00, 次日 00:00) 对应的 UTC ISO 区间 */
export function bjDayRange(dateStr) {
  return [bjDateTime(dateStr).toISOString(), bjDateTime(addDays(dateStr, 1)).toISOString()];
}

// 撮合意向的展示格式（Intent）。
import { clock } from '../clock.js';
import { rangeLabel, slotLabel } from '../time.js';

const isCustom = (intent) => Boolean(intent.time_from && intent.time_to);

/** 意向的片区列表（多选，兼容旧的单个 area） */
function intentAreas(intent) {
  try {
    const a = JSON.parse(intent.areas);
    if (Array.isArray(a) && a.length) return a;
  } catch {
    // 旧意向没有 areas 字段，回落到单个 area
  }
  return intent.area ? [intent.area] : [];
}

/** 时间标签：清晨 / 上午 / 下午 / 晚上 / 全天，自定义时间段是「14:00–17:00」 */
export function intentTimeLabel(intent) {
  return isCustom(intent) ? `${intent.time_from}–${intent.time_to}` : slotLabel(intent.slot, intent.task);
}

/** 「周日下午 · 骑行」「周日 14:00–17:00 · 骑行」「本周末 · 爬山」（全天不写时间） */
export function intentTitle(intent, now = clock.now()) {
  const range = rangeLabel(intent.date_from, intent.date_to, now);
  const name = intent.label || intent.task;
  if (isCustom(intent)) return `${range} ${intentTimeLabel(intent)} · ${name}`;
  if (intent.slot === 'allday') return `${range} · ${name}`;
  return `${range}${slotLabel(intent.slot, intent.task)} · ${name}`;
}

export function intentView(intent, now = clock.now()) {
  return {
    id: intent.id,
    task: intent.task,
    category: intent.category,
    title: intentTitle(intent, now),
    dateFrom: intent.date_from,
    dateTo: intent.date_to,
    slot: intent.slot,
    slotLabel: slotLabel(intent.slot, intent.task),
    timeFrom: isCustom(intent) ? intent.time_from : null,
    timeTo: isCustom(intent) ? intent.time_to : null,
    timeLabel: intentTimeLabel(intent),
    area: intent.area,
    areas: intentAreas(intent),
    sameSexOnly: Boolean(intent.same_sex_only),
    sizeMin: intent.size_min,
    sizeMax: intent.size_max,
    relaxTime: Boolean(intent.relax_time),
    relaxSize: Boolean(intent.relax_size),
    status: intent.status,
    eventId: intent.event_id ?? null,
    createdAt: intent.created_at,
  };
}

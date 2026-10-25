// 撮合意向的展示格式（Intent）。
import { clock } from '../clock.js';
import { rangeLabel, slotLabel } from '../time.js';

/** 「周日 · 洱海边骑行」 */
export function intentTitle(intent, now = clock.now()) {
  return `${rangeLabel(intent.date_from, intent.date_to, now)} · ${intent.label || intent.task}`;
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
    area: intent.area,
    sizeMin: intent.size_min,
    sizeMax: intent.size_max,
    relaxTime: Boolean(intent.relax_time),
    relaxSize: Boolean(intent.relax_size),
    status: intent.status,
    eventId: intent.event_id ?? null,
    createdAt: intent.created_at,
  };
}

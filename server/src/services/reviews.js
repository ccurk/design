// 互评与信用结算（docs/api.md 3.5）：多数票、平票有利于被评价者、点过「我到了」算一票准时。
import { clock, DAY, MINUTE } from '../clock.js';
import { FEELINGS } from '../constants.js';
import { forbidden, invalid } from '../errors.js';
import { strArray } from '../validate.js';
import { upsertEventCredit } from './credit.js';
import { endAt, eventCard, joinedMembers, memberRow, phaseOf, requireEvent } from './events.js';
import { userBrief } from './users.js';

const REVIEW_WINDOW = 7 * DAY;
const LATE_AFTER = 15 * MINUTE;
const RESULT_TYPES = { on_time: 'attended', late: 'late', no_show: 'no_show' };
const FAVOR_ORDER = ['on_time', 'late', 'no_show']; // 平票时按这个顺序取

function requireMember(db, user, eventId) {
  const event = requireEvent(db, eventId);
  const mine = memberRow(db, eventId, user.id);
  if (!mine || mine.status !== 'joined') throw forbidden('只有一起参加的人可以评价');
  return event;
}

export function hasSubmitted(db, eventId, userId) {
  return Boolean(db.get('SELECT 1 FROM review_feelings WHERE event_id = ? AND reviewer_id = ?', eventId, userId));
}

export function reviewView(db, user, eventId) {
  const event = requireMember(db, user, eventId);
  const end = endAt(event);
  const now = clock.now().getTime();
  return {
    event: eventCard(db, event, user),
    people: joinedMembers(db, eventId)
      .filter((m) => m.user_id !== user.id)
      .map((m) => userBrief(db, m.user_id)),
    submitted: hasSubmitted(db, eventId, user.id),
    // 补充字段
    canSubmit: phaseOf(event) === 'ended' && now <= end.getTime() + REVIEW_WINDOW,
    deadline: new Date(end.getTime() + REVIEW_WINDOW).toISOString(),
    feelingOptions: FEELINGS,
  };
}

export function submitReview(db, user, eventId, body) {
  const event = requireMember(db, user, eventId);
  const now = clock.now().getTime();
  if (phaseOf(event) !== 'ended') throw invalid('局结束后才能评价');
  if (now > endAt(event).getTime() + REVIEW_WINDOW) throw invalid('评价已经截止了（结束后 7 天内）');
  if (['cancelled', 'rejected'].includes(event.status)) throw invalid('这个局已经取消了');

  const others = joinedMembers(db, eventId).filter((m) => m.user_id !== user.id).map((m) => m.user_id);
  const attendance = body?.attendance ?? {};
  if (typeof attendance !== 'object' || Array.isArray(attendance)) throw invalid('attendance 格式不正确');
  for (const [key, value] of Object.entries(attendance)) {
    if (!others.includes(Number(key))) throw invalid('只能评价一起参加的人');
    if (!RESULT_TYPES[value]) throw invalid('到场情况只能是 on_time / late / no_show');
  }
  const feelings = strArray(body?.feelings ?? [], '整体感受', { maxItems: FEELINGS.length });
  if (feelings.some((f) => !FEELINGS.includes(f))) throw invalid('整体感受不正确');

  db.tx(() => {
    const ts = clock.iso();
    for (const targetId of others) {
      db.run(
        `INSERT INTO reviews (event_id, reviewer_id, target_id, attendance, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(event_id, reviewer_id, target_id) DO UPDATE SET attendance = excluded.attendance`,
        eventId,
        user.id,
        targetId,
        attendance[targetId] ?? 'on_time', // 默认都是准时
        ts,
      );
    }
    db.run(
      `INSERT INTO review_feelings (event_id, reviewer_id, feelings, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(event_id, reviewer_id) DO UPDATE SET feelings = excluded.feelings`,
      eventId,
      user.id,
      JSON.stringify(feelings),
      ts,
    );
    settleEvent(db, event);
  });
  return { ok: true };
}

/** 单个人的结果：多数票，平票有利于被评价者 */
export function majority(votes) {
  let best = null;
  for (const key of FAVOR_ORDER) {
    if (votes[key] > 0 && (best === null || votes[key] > votes[best])) best = key;
  }
  return best;
}

/**
 * 重算该局所有人的结果，以 source=review 写入 / 覆盖 credit_events（同一人同一局只保留一条）。
 * 没有任何票的人：自己交过评价则默认准时，否则先不记。
 */
export function settleEvent(db, event) {
  const members = joinedMembers(db, event.id);
  const memberIds = new Set(members.map((m) => m.user_id));
  const reviews = db.all('SELECT * FROM reviews WHERE event_id = ?', event.id).filter((r) => memberIds.has(r.reviewer_id));
  const submitters = new Set(
    db.all('SELECT reviewer_id FROM review_feelings WHERE event_id = ?', event.id).map((r) => r.reviewer_id),
  );
  const start = Date.parse(event.start_at);
  const results = {};
  for (const m of members) {
    const votes = { on_time: 0, late: 0, no_show: 0 };
    for (const r of reviews) if (r.target_id === m.user_id) votes[r.attendance]++;
    if (m.arrived_at) votes[Date.parse(m.arrived_at) > start + LATE_AFTER ? 'late' : 'on_time']++;
    let result = majority(votes);
    if (!result) {
      if (!submitters.has(m.user_id)) continue;
      result = 'on_time';
    }
    const total = votes.on_time + votes.late + votes.no_show;
    upsertEventCredit(db, {
      userId: m.user_id,
      eventId: event.id,
      type: RESULT_TYPES[result],
      source: 'review',
      note: total ? `互评结果（${total} 票）` : '已参与互评，默认准时',
    });
    results[m.user_id] = result;
  }
  return results;
}

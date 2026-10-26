// 「我的局」：进行中（含撮合中的意向）/ 已结束 / 我发起的。
import { clock, DAY } from '../clock.js';
import { intentTimeLabel, intentTitle } from './intentFormat.js';
import { similarCount } from './intents.js';
import { endAt, eventCard, getEvent, joinedCount, phaseOf } from './events.js';
import { hasSubmitted } from './reviews.js';
import { sizeBounds } from './matchRules.js';
import { rangeLabel } from '../time.js';

const REVIEW_WINDOW = 7 * DAY;

function needsReview(db, event, member, now) {
  if (member.status !== 'joined' || phaseOf(event, now) !== 'ended') return false;
  if (['cancelled', 'rejected'].includes(event.status)) return false;
  if (now.getTime() > endAt(event).getTime() + REVIEW_WINDOW) return false;
  if (joinedCount(db, event.id) < 2) return false;
  return !hasSubmitted(db, event.id, member.user_id);
}

function myEventCard(db, user, event, member, now) {
  const intent = db.get('SELECT id FROM intents WHERE event_id = ? AND user_id = ?', event.id, user.id);
  return {
    ...eventCard(db, event, user),
    myStatus: member?.status ?? null,
    needReview: member ? needsReview(db, event, member, now) : false,
    reviewed: hasSubmitted(db, event.id, user.id),
    intentId: intent?.id ?? null,
  };
}

/** 撮合中的意向也以卡片形式出现（id 为 null，带 intentId；成局前看不到是谁） */
function intentCard(db, intent, now) {
  const similar = intent.status === 'open' ? similarCount(db, intent) : 0;
  const needMore = intent.status === 'open' ? Math.max(0, sizeBounds(intent).min - (similar + 1)) : 0;
  return {
    id: null,
    title: intentTitle(intent, now),
    category: intent.category,
    task: intent.task,
    startAt: null,
    dateLabel: `${rangeLabel(intent.date_from, intent.date_to, now)} ${intentTimeLabel(intent)}`,
    place: intent.area,
    capacity: intent.size_max,
    memberCount: similar + 1,
    membersPreview: [],
    feeLabel: '',
    source: 'matched',
    status: 'matching',
    phase: 'upcoming',
    myStatus: 'matching',
    needReview: false,
    reviewed: false,
    intentId: intent.id,
    intentStatus: intent.status,
    needMore,
  };
}

function memberships(db, userId, statuses) {
  return db.all(
    `SELECT m.*, e.start_at FROM event_members m JOIN events e ON e.id = m.event_id
     WHERE m.user_id = ? AND m.status IN (${statuses.map(() => '?').join(', ')})`,
    userId,
    ...statuses,
  );
}

export function myEvents(db, user, tab = 'ongoing') {
  const now = clock.now();
  if (tab === 'created') {
    const rows = db.all('SELECT * FROM events WHERE creator_id = ? ORDER BY start_at DESC', user.id);
    return {
      items: rows.map((e) => myEventCard(db, user, e, db.get('SELECT * FROM event_members WHERE event_id = ? AND user_id = ?', e.id, user.id), now)),
    };
  }
  if (tab === 'ended') {
    const items = memberships(db, user.id, ['joined'])
      .map((m) => ({ m, e: getEvent(db, m.event_id) }))
      .filter(({ e }) => phaseOf(e, now) === 'ended' && !['cancelled', 'rejected', 'pending_review', 'inviting'].includes(e.status))
      .sort((a, b) => b.e.start_at.localeCompare(a.e.start_at))
      .slice(0, 50)
      .map(({ m, e }) => myEventCard(db, user, e, m, now));
    return { items };
  }
  return { items: ongoingItems(db, user, now) };
}

export function ongoingItems(db, user, now = clock.now()) {
  const events = memberships(db, user.id, ['joined', 'invited', 'applied'])
    .map((m) => ({ m, e: getEvent(db, m.event_id) }))
    .filter(({ e }) => phaseOf(e, now) !== 'ended' && !['cancelled', 'rejected'].includes(e.status))
    .sort((a, b) => a.e.start_at.localeCompare(b.e.start_at))
    .map(({ m, e }) => myEventCard(db, user, e, m, now));
  const intents = db
    .all("SELECT * FROM intents WHERE user_id = ? AND status IN ('open', 'proposed') ORDER BY created_at DESC", user.id)
    .map((i) => intentCard(db, i, now));
  return [...events, ...intents];
}

export function ongoingCount(db, user) {
  return ongoingItems(db, user).length;
}

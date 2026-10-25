// 消息中心：需要你处理（actions）+ 局聊（chats）+ 通知（notices）。
import { clock, DAY, HOUR } from '../clock.js';
import { dateLabel } from '../time.js';
import { endAt, getEvent, isChatOpen, joinedCount, phaseOf, shortTitle } from './events.js';
import { inviteDeadline } from './invites.js';
import { listNotices } from './notices.js';
import { hasSubmitted } from './reviews.js';
import { getUser } from './users.js';

function memberships(db, userId, status) {
  return db.all('SELECT * FROM event_members WHERE user_id = ? AND status = ?', userId, status);
}

export function inboxActions(db, user, now = clock.now()) {
  const actions = [];
  const t = now.getTime();

  for (const m of memberships(db, user.id, 'invited')) {
    const e = getEvent(db, m.event_id);
    if (e?.status !== 'inviting') continue;
    actions.push({
      type: 'match',
      eventId: e.id,
      title: `撮合成功：${e.title}`,
      deadline: inviteDeadline(e, m).toISOString(),
    });
  }

  for (const m of memberships(db, user.id, 'joined')) {
    const e = getEvent(db, m.event_id);
    if (!e || !['formed', 'open'].includes(e.status)) continue;
    const start = Date.parse(e.start_at);
    // 开场前 48 小时内，出席待确认
    if (m.attendance === 'pending' && start > t && start - t <= 48 * HOUR) {
      actions.push({
        type: 'attendance',
        eventId: e.id,
        title: `${dateLabel(new Date(e.start_at), now)} · ${shortTitle(e.title)}`,
        startAt: e.start_at,
      });
    }
    // 局结束后 7 天内，还没评价
    if (
      phaseOf(e, now) === 'ended' &&
      t <= endAt(e).getTime() + 7 * DAY &&
      joinedCount(db, e.id) >= 2 &&
      !hasSubmitted(db, e.id, user.id)
    ) {
      actions.push({ type: 'review', eventId: e.id, title: `「${shortTitle(e.title)}」结束啦` });
    }
  }
  return actions;
}

export function inboxChats(db, user) {
  const rows = db.all(
    `SELECT m.*, (SELECT MAX(id) FROM messages WHERE event_id = m.event_id) AS last_id
     FROM event_members m WHERE m.user_id = ? AND m.status = 'joined'`,
    user.id,
  );
  const chats = [];
  for (const m of rows) {
    const e = getEvent(db, m.event_id);
    const count = joinedCount(db, e.id);
    if (!isChatOpen(e, count)) continue;
    if (!m.last_id && phaseOf(e) === 'ended') continue; // 已结束且没人说过话的局不进列表
    const last = m.last_id ? db.get('SELECT * FROM messages WHERE id = ?', m.last_id) : null;
    const unread = Number(
      db.get(
        'SELECT COUNT(*) AS n FROM messages WHERE event_id = ? AND id > ? AND (user_id IS NULL OR user_id != ?)',
        e.id,
        m.last_read_message_id,
        user.id,
      ).n,
    );
    chats.push({
      eventId: e.id,
      title: `${shortTitle(e.title)} · ${count} 人`,
      category: e.category,
      lastMessage: last
        ? {
            nickname: last.user_id ? getUser(db, last.user_id)?.nickname ?? null : null,
            text: last.text,
            createdAt: last.created_at,
          }
        : null,
      unread,
      muted: Boolean(m.muted),
      sortKey: last?.created_at ?? e.start_at,
    });
  }
  chats.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  return chats.map(({ sortKey, ...c }) => c);
}

export function inbox(db, user) {
  const actions = inboxActions(db, user);
  const chats = inboxChats(db, user);
  const notices = listNotices(db, user.id, 50);
  const unreadNotices = Number(
    db.get('SELECT COUNT(*) AS n FROM notices WHERE user_id = ? AND read = 0', user.id).n,
  );
  const unreadChats = chats.filter((c) => !c.muted).reduce((sum, c) => sum + c.unread, 0);
  return {
    actions,
    chats,
    notices,
    unread: {
      actions: actions.length,
      chats: unreadChats,
      notices: unreadNotices,
      total: actions.length + unreadChats + unreadNotices,
    },
  };
}

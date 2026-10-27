// 提醒（每分钟检查一次，docs/api.md 3.4）：轻确认、去评价、报平安；顺便解除到期的限制。
import { clock, DAY, HOUR } from '../clock.js';
import { bjDate, dateLabel } from '../time.js';
import { ORGANIZE_TTL, endAt, joinedCount, phaseOf, shortTitle } from './events.js';
import { markOnce, notify } from './notices.js';
import { hasSubmitted } from './reviews.js';
import { userSettings } from './users.js';

export function runReminders(db, logger) {
  const now = clock.now();
  const t = now.getTime();
  const result = { attendance: 0, review: 0, safe: 0, safeEscalated: 0, restrictionsLifted: 0, organizeReminders: 0 };

  // 1. 开场前 48 小时内、出席待确认 → 「还去吗？」（只提醒一次）
  const upcoming = db.all(
    `SELECT m.user_id, e.* FROM event_members m JOIN events e ON e.id = m.event_id
     WHERE m.status = 'joined' AND m.attendance = 'pending' AND e.status IN ('formed', 'open')
       AND e.start_at > ? AND e.start_at <= ?`,
    now.toISOString(),
    new Date(t + 48 * HOUR).toISOString(),
  );
  for (const row of upcoming) {
    if (joinedCount(db, row.id) < 2) continue; // 只有自己的局不用确认
    if (!markOnce(db, `attendance:${row.id}:${row.user_id}`)) continue;
    notify(db, row.user_id, {
      type: 'attendance',
      title: '需要你处理 · 还去吗？',
      body: `${dateLabel(new Date(row.start_at), now)} · ${shortTitle(row.title)}。提前说不算鸽，确认一下大家心里有数`,
      link: `event:${row.id}`,
    });
    result.attendance++;
  }

  // 2 / 3. 最近结束的局：去评价、报平安
  const recent = db.all(
    `SELECT m.user_id, m.safe_at, e.* FROM event_members m JOIN events e ON e.id = m.event_id
     WHERE m.status = 'joined' AND e.status IN ('formed', 'open') AND e.start_at >= ? AND e.start_at <= ?`,
    new Date(t - 8 * DAY).toISOString(),
    now.toISOString(),
  );
  for (const row of recent) {
    if (phaseOf(row, now) !== 'ended') continue;
    const end = endAt(row).getTime();
    if (t <= end + 7 * DAY && !hasSubmitted(db, row.id, row.user_id) && joinedCount(db, row.id) >= 2) {
      if (markOnce(db, `review:${row.id}:${row.user_id}`)) {
        notify(db, row.user_id, {
          type: 'review',
          title: `「${shortTitle(row.title)}」结束啦`,
          body: '给同行的人一个评价 · 匿名，只用来算信用',
          link: `review:${row.id}`,
        });
        result.review++;
      }
    }
    if (joinedCount(db, row.id) < 2) continue; // 只有自己的局不用报平安
    if (row.safe_at || t > end + DAY) continue;
    const user = db.get('SELECT * FROM users WHERE id = ?', row.user_id);
    if (!user || !userSettings(user).checkInReminder) continue;
    if (markOnce(db, `safe:${row.id}:${row.user_id}`)) {
      notify(db, row.user_id, {
        type: 'safe',
        title: '到家了吗？点一下报平安',
        body: `「${shortTitle(row.title)}」结束啦，到家后点一下报平安，让大家放心`,
        link: `event:${row.id}`,
      });
      result.safe++;
    } else {
      const mark = db.get('SELECT created_at FROM job_marks WHERE key = ?', `safe:${row.id}:${row.user_id}`);
      // 1 小时没回应：只记日志（短信通知紧急联系人留作后续）
      if (mark && Date.parse(mark.created_at) + HOUR <= t && markOnce(db, `safe_escalate:${row.id}:${row.user_id}`)) {
        logger?.warn?.(`[safe] 用户 ${row.user_id} 在局 ${row.id} 结束 1 小时后仍未报平安（紧急联系人通知待接入）`);
        result.safeEscalated++;
      }
    }
  }

  // 4. 受限到期自动恢复
  const lifted = db.all(
    "SELECT id FROM users WHERE status = 'restricted' AND restricted_until IS NOT NULL AND restricted_until <= ?",
    now.toISOString(),
  );
  for (const { id } of lifted) {
    db.update('users', id, { status: 'active', restricted_until: null, restricted_reason: null });
    notify(db, id, { type: 'unrestricted', title: '账号已恢复', body: '可以继续撮合和报名了', link: null });
    result.restrictionsLifted++;
  }
  // 组局有效期最后 3 天：还没凑够人的局，每天提醒发起人一次（叫朋友来，否则到期自动解散）
  const openEvents = db.all("SELECT * FROM events WHERE status = 'open' AND source = 'user' AND creator_id IS NOT NULL");
  for (const e of openEvents) {
    const expiry = Date.parse(e.created_at) + ORGANIZE_TTL;
    if (t < expiry - 3 * DAY || t >= expiry) continue; // 只在最后 3 天内
    const joined = joinedCount(db, e.id);
    const need = Math.max(2, e.min_size);
    if (joined >= need) continue; // 够人了不会解散，不打扰
    if (!markOnce(db, `organize_soon:${e.id}:${bjDate(now)}`)) continue; // 每天一次
    const daysLeft = Math.max(1, Math.ceil((expiry - t) / DAY));
    notify(db, e.creator_id, {
      type: 'organize_expiring',
      title: '你的局快到期了',
      body: `「${shortTitle(e.title)}」还差 ${need - joined} 人，还有 ${daysLeft} 天没凑齐就自动解散，转发给朋友一起来吧`,
      link: `event:${e.id}`,
    });
    result.organizeReminders++;
  }
  return result;
}

// 用户：简要信息、设置、拉黑 / 不看。
import { clock } from '../clock.js';
import { json } from '../db.js';
import { notFound } from '../errors.js';
import { creditOf, effectiveStatus } from './credit.js';

// avatarColor 按 id % 4 固定分配（与设计稿一致：1 栗子=accent，2 小满=ink，3 阿野=stone，4 七七=slate）
const AVATAR_COLORS = ['slate', 'accent', 'ink', 'stone'];

export const DEFAULT_SETTINGS = { sameSexOnly: false, checkInReminder: true, profileOpen: true };

export function getUser(db, id) {
  return db.get('SELECT * FROM users WHERE id = ?', id);
}

export function requireUserRow(db, id) {
  const user = getUser(db, id);
  if (!user) throw notFound('用户不存在');
  return user;
}

export function userSettings(user) {
  return { ...DEFAULT_SETTINGS, ...json.parse(user.settings, {}) };
}

/** 头像上的字：一般取第一个字；「阿野」「小满」「老周」「大鹏」这类取后一个字（与设计稿一致） */
export function avatarText(nickname) {
  const chars = Array.from(nickname || '?');
  return chars.length >= 2 && '阿小老大'.includes(chars[0]) ? chars[1] : chars[0];
}

export function maskPhone(phone) {
  if (!phone) return null;
  return phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone;
}

/** UserBrief */
export function userBrief(db, userOrId, now = clock.now()) {
  const user = typeof userOrId === 'object' ? userOrId : getUser(db, userOrId);
  if (!user) return null;
  const credit = creditOf(db, user, now);
  return {
    id: user.id,
    nickname: user.nickname,
    avatarUrl: user.avatar_url || null,
    avatarText: avatarText(user.nickname),
    avatarColor: AVATAR_COLORS[user.id % 4],
    creditRate: credit.rate,
    creditLevel: credit.level,
  };
}

/** 从没到场过的人算「第一次参加」 */
export function isNewUser(db, userId) {
  const row = db.get(
    "SELECT COUNT(*) AS n FROM credit_events WHERE user_id = ? AND revoked = 0 AND type IN ('attended', 'late')",
    userId,
  );
  return Number(row.n) === 0;
}

export function isActive(user) {
  return effectiveStatus(user) === 'active';
}

// ---- 拉黑 / 不看 ----

export function isBlockedEither(db, a, b) {
  if (!a || !b) return false;
  return Boolean(
    db.get(
      'SELECT 1 FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)',
      a,
      b,
      b,
      a,
    ),
  );
}

/** 与我有拉黑关系（任一方向）的人 */
export function blockRelatedIds(db, userId) {
  if (!userId) return new Set();
  const rows = db.all(
    'SELECT blocked_id AS id FROM blocks WHERE user_id = ? UNION SELECT user_id AS id FROM blocks WHERE blocked_id = ?',
    userId,
    userId,
  );
  return new Set(rows.map((r) => r.id));
}

export function mutedIds(db, userId) {
  if (!userId) return new Set();
  return new Set(db.all('SELECT muted_id FROM mutes WHERE user_id = ?', userId).map((r) => r.muted_id));
}

/** 所有拉黑关系，形如 "a:b"（a 拉黑了 b） */
export function allBlockPairs(db) {
  return new Set(db.all('SELECT user_id, blocked_id FROM blocks').map((r) => `${r.user_id}:${r.blocked_id}`));
}

export function block(db, userId, targetId) {
  if (userId === targetId) return { ok: true, blocked: false };
  requireUserRow(db, targetId);
  db.run('INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)', userId, targetId, clock.iso());
  return { ok: true, blocked: true };
}

export function unblock(db, userId, targetId) {
  db.run('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?', userId, targetId);
  return { ok: true, blocked: false };
}

export function mute(db, userId, targetId) {
  if (userId === targetId) return { ok: true, muted: false };
  requireUserRow(db, targetId);
  db.run('INSERT OR IGNORE INTO mutes (user_id, muted_id, created_at) VALUES (?, ?, ?)', userId, targetId, clock.iso());
  return { ok: true, muted: true };
}

export function unmute(db, userId, targetId) {
  db.run('DELETE FROM mutes WHERE user_id = ? AND muted_id = ?', userId, targetId);
  return { ok: true, muted: false };
}

export function blockedList(db, userId) {
  return db
    .all('SELECT u.* FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ? ORDER BY b.created_at DESC', userId)
    .map((u) => userBrief(db, u));
}

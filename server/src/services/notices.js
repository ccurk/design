// 站内通知。写入 notices 表后，会触发 db.hooks.notice（用于微信订阅消息推送，见 wechat.js）。
import { clock } from '../clock.js';
import { notFound } from '../errors.js';

/**
 * link 约定（客户端据此跳转）：
 *   match:<eventId>  撮合成功页     event:<eventId>  局详情     chat:<eventId>  群聊
 *   review:<eventId> 互评页         post:<postId>    动态详情   credit          我的信用记录
 */
export function notify(db, userId, { type, title, body = '', link = null }) {
  const id = db.insert('notices', {
    user_id: userId,
    type,
    title,
    body,
    link,
    read: 0,
    created_at: clock.iso(),
  });
  const notice = { id, userId, type, title, body, link };
  try {
    db.hooks?.notice?.(notice);
  } catch {
    // 推送失败不影响业务
  }
  return id;
}

export function noticeView(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    link: row.link,
    read: Boolean(row.read),
    createdAt: row.created_at,
  };
}

export function listNotices(db, userId, limit = 50) {
  return db
    .all('SELECT * FROM notices WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, limit)
    .map(noticeView);
}

export function markRead(db, userId, noticeId) {
  const row = db.get('SELECT * FROM notices WHERE id = ? AND user_id = ?', noticeId, userId);
  if (!row) throw notFound('通知不存在');
  db.run('UPDATE notices SET read = 1 WHERE id = ?', noticeId);
  return { ok: true };
}

export function markAllRead(db, userId) {
  const { changes } = db.run('UPDATE notices SET read = 1 WHERE user_id = ? AND read = 0', userId);
  return { ok: true, updated: changes };
}

/** 定时任务去重：同一个 key 只做一次。返回 true 表示第一次 */
export function markOnce(db, key) {
  const { changes } = db.run('INSERT OR IGNORE INTO job_marks (key, created_at) VALUES (?, ?)', key, clock.iso());
  return changes > 0;
}

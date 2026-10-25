// 举报：用户提交（可同时拉黑），后台处理并通知举报人。
import { createHash } from 'node:crypto';
import { clock } from '../clock.js';
import { REPORT_ACTIONS, REPORT_TARGETS } from '../constants.js';
import { json } from '../db.js';
import { conflict, invalid, notFound } from '../errors.js';
import { oneOf, str, strArray } from '../validate.js';
import { restrictUser } from './credit.js';
import { canViewEvent, cancelEvent, getEvent, memberRow } from './events.js';
import { notify } from './notices.js';
import { block, getUser, userBrief } from './users.js';

/** 找到被举报对象和它的作者 */
function resolveTarget(db, type, id) {
  switch (type) {
    case 'user': {
      const u = getUser(db, id);
      return u && { userId: u.id, preview: `${u.nickname}${u.bio ? `：${u.bio}` : ''}` };
    }
    case 'event': {
      const e = getEvent(db, id);
      return e && { userId: e.creator_id, preview: `局「${e.title}」${e.description ? `：${e.description}` : ''}`, event: e };
    }
    case 'post': {
      const p = db.get('SELECT * FROM posts WHERE id = ?', id);
      return p && { userId: p.user_id, preview: p.text };
    }
    case 'comment': {
      const c = db.get('SELECT * FROM comments WHERE id = ?', id);
      return c && { userId: c.user_id, preview: c.text };
    }
    case 'message': {
      const m = db.get('SELECT * FROM messages WHERE id = ?', id);
      return m && { userId: m.user_id, preview: m.text, eventId: m.event_id };
    }
    default:
      return null;
  }
}

export function createReport(db, user, body) {
  const targetType = oneOf(body?.targetType, '举报对象', REPORT_TARGETS);
  const targetId = Number(body?.targetId);
  if (!Number.isInteger(targetId) || targetId <= 0) throw invalid('举报对象不正确');
  const reason = str(body?.reason, '举报原因', { min: 1, max: 30 });
  const detail = str(body?.detail, '补充说明', { max: 500, optional: true });
  const images = strArray(body?.images ?? [], '截图', { maxItems: 3, maxLen: 500 });
  const target = resolveTarget(db, targetType, targetId);
  if (!target) throw notFound('被举报的内容不存在');
  if (targetType === 'message' && !memberRow(db, target.eventId, user.id)) throw notFound('被举报的内容不存在');
  if (targetType === 'event' && !canViewEvent(db, target.event, user)) throw notFound('被举报的内容不存在');
  if (target.userId === user.id) throw invalid('不能举报自己');

  const existing = db.get(
    "SELECT id FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'pending'",
    user.id,
    targetType,
    targetId,
  );
  const id =
    existing?.id ??
    db.insert('reports', {
      reporter_id: user.id,
      target_type: targetType,
      target_id: targetId,
      target_user_id: target.userId ?? null,
      reason,
      detail,
      images: JSON.stringify(images),
      status: 'pending',
      created_at: clock.iso(),
    });
  if (body?.alsoBlock && target.userId) block(db, user.id, target.userId);
  return { id, status: 'pending' };
}

/** 举报人对后台也匿名：「用户#3a9」 */
export function anonId(userId) {
  return `用户#${createHash('sha256').update(`reporter:${userId}`).digest('hex').slice(0, 3)}`;
}

export function reportCountAgainst(db, userId) {
  return Number(db.get('SELECT COUNT(*) AS n FROM reports WHERE target_user_id = ?', userId).n);
}

export function adminReportView(db, r) {
  const target = resolveTarget(db, r.target_type, r.target_id);
  const targetUser = r.target_user_id ? getUser(db, r.target_user_id) : null;
  return {
    id: r.id,
    reason: r.reason,
    detail: r.detail,
    images: json.parse(r.images, []),
    targetType: r.target_type,
    targetId: r.target_id,
    preview: target ? String(target.preview).slice(0, 120) : '（内容已不存在）',
    targetUser: targetUser
      ? { ...userBrief(db, targetUser), reportCount: reportCountAgainst(db, targetUser.id), status: targetUser.status }
      : null,
    reporterAnonId: anonId(r.reporter_id),
    createdAt: r.created_at,
    status: r.status,
    action: r.action,
    adminNote: r.admin_note,
    resolvedAt: r.resolved_at,
  };
}

export function adminListReports(db, status = 'pending') {
  const rows =
    status === 'all'
      ? db.all('SELECT * FROM reports ORDER BY id DESC LIMIT 200')
      : db.all('SELECT * FROM reports WHERE status = ? ORDER BY id DESC LIMIT 200', status);
  return { items: rows.map((r) => adminReportView(db, r)) };
}

const RESULT_TEXT = {
  dismiss: '经核实暂未发现违规，感谢你的反馈',
  warn: '已对对方进行警告',
  delete_content: '相关内容已删除',
  restrict_7d: '对方已被限制使用',
  ban: '对方已被封禁',
};

/** 删除被举报的内容 */
function deleteContent(db, r) {
  switch (r.target_type) {
    case 'post':
      db.update('posts', r.target_id, { status: 'deleted' });
      break;
    case 'comment':
      db.update('comments', r.target_id, { status: 'deleted' });
      break;
    case 'message':
      db.update('messages', r.target_id, { kind: 'system', text: '一条消息因违反社区公约已被移除', user_id: null });
      break;
    case 'event': {
      const e = getEvent(db, r.target_id);
      if (e && !['cancelled', 'rejected'].includes(e.status)) cancelEvent(db, e, { reason: '违反社区公约', byAdmin: true });
      break;
    }
    case 'user':
      if (r.target_user_id) db.update('users', r.target_user_id, { bio: '' });
      break;
    default:
  }
}

export function banUser(db, userId, reason) {
  db.update('users', userId, { status: 'banned' });
  db.run('DELETE FROM sessions WHERE user_id = ?', userId);
  db.run(
    "UPDATE intents SET status = 'cancelled', updated_at = ? WHERE user_id = ? AND status IN ('open', 'proposed')",
    clock.iso(),
    userId,
  );
  notify(db, userId, { type: 'banned', title: '账号已被封禁', body: reason ? `原因：${reason}` : '', link: null });
}

export function resolveReport(db, id, { action, note = null }) {
  return db.tx(() => {
    const r = db.get('SELECT * FROM reports WHERE id = ?', id);
    if (!r) throw notFound('举报不存在');
    if (r.status !== 'pending') throw conflict('这条举报已经处理过了');
    oneOf(action, '处理方式', REPORT_ACTIONS);
    const targetUserId = r.target_user_id;
    if (['warn', 'restrict_7d', 'ban'].includes(action) && !targetUserId) throw invalid('这条举报没有对应的用户');

    if (action === 'warn') {
      notify(db, targetUserId, {
        type: 'warning',
        title: '你收到一次提醒',
        body: note || '有人反馈你的言行让人不舒服，请遵守社区公约。再次违反会被限制使用。',
        link: null,
      });
    } else if (action === 'delete_content') {
      deleteContent(db, r);
    } else if (action === 'restrict_7d') {
      restrictUser(db, targetUserId, 7, note || '被举报并核实违反社区公约');
    } else if (action === 'ban') {
      banUser(db, targetUserId, note || '严重违反社区公约');
    }

    db.update('reports', id, {
      status: action === 'dismiss' ? 'dismissed' : 'resolved',
      action,
      admin_note: note,
      resolved_at: clock.iso(),
    });
    notify(db, r.reporter_id, {
      type: 'report_result',
      title: '你的举报已处理',
      body: RESULT_TEXT[action],
      link: null,
    });
    return adminReportView(db, db.get('SELECT * FROM reports WHERE id = ?', id));
  });
}

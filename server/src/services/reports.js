// 举报：用户提交（可同时拉黑），后台处理并通知举报人。
import { createHash } from 'node:crypto';
import { clock } from '../clock.js';
import { REPORT_ACTIONS, REPORT_TARGETS } from '../constants.js';
import { json } from '../db.js';
import { blocked, conflict, invalid, notFound } from '../errors.js';
import { checkContact } from '../moderation.js';
import { absUrls, storeUrl } from '../urls.js';
import { oneOf, str, strArray } from '../validate.js';
import { effectiveStatus, restrictUser } from './credit.js';
import { canViewEvent, cancelEvent, getEvent, memberRow } from './events.js';
import { notify } from './notices.js';
import { block, getUser, userBrief } from './users.js';

/** 找到被举报对象、它的作者和上下文 */
function resolveTarget(db, type, id) {
  switch (type) {
    case 'user': {
      const u = getUser(db, id);
      return u && { userId: u.id, preview: `${u.nickname}${u.bio ? `：${u.bio}` : ''}`, context: null };
    }
    case 'event': {
      const e = getEvent(db, id);
      return (
        e && {
          userId: e.creator_id,
          preview: `局「${e.title}」${e.description ? `：${e.description}` : ''}`,
          event: e,
          context: { eventId: e.id, eventTitle: e.title },
        }
      );
    }
    case 'post': {
      const p = db.get('SELECT * FROM posts WHERE id = ?', id);
      return p && { userId: p.user_id, preview: p.text, context: { postId: p.id } };
    }
    case 'comment': {
      const c = db.get('SELECT * FROM comments WHERE id = ?', id);
      if (!c) return null;
      const post = db.get('SELECT * FROM posts WHERE id = ?', c.post_id);
      return {
        userId: c.user_id,
        preview: c.text,
        context: { postId: c.post_id, postPreview: post ? post.text.slice(0, 40) : null },
      };
    }
    case 'message': {
      const m = db.get('SELECT * FROM messages WHERE id = ?', id);
      if (!m) return null;
      const e = getEvent(db, m.event_id);
      return {
        userId: m.user_id,
        preview: m.text,
        eventId: m.event_id,
        context: { eventId: m.event_id, eventTitle: e?.title ?? null },
      };
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
  const images = strArray(body?.images ?? [], '截图', { maxItems: 3, maxLen: 500 }).map(storeUrl);
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
    images: absUrls(db, json.parse(r.images, [])),
    targetType: r.target_type,
    targetId: r.target_id,
    preview: target ? String(target.preview).slice(0, 120) : '（内容已不存在）',
    context: target ? target.context : null,
    targetUser: targetUser
      ? {
          ...userBrief(db, targetUser),
          reportCount: reportCountAgainst(db, targetUser.id),
          status: effectiveStatus(targetUser),
        }
      : null,
    reporterAnonId: anonId(r.reporter_id),
    createdAt: r.created_at,
    status: r.status,
    action: r.action,
    adminNote: r.admin_note,
    message: r.user_message ?? null,
    resolvedAt: r.resolved_at,
  };
}

const REPORT_STATUSES = ['pending', 'resolved', 'dismissed', 'all'];

export function adminListReports(db, status = 'pending') {
  oneOf(status, '状态筛选', REPORT_STATUSES);
  const rows =
    status === 'all'
      ? db.all('SELECT * FROM reports ORDER BY id DESC LIMIT 200')
      : db.all('SELECT * FROM reports WHERE status = ? ORDER BY id DESC LIMIT 200', status);
  return { items: rows.map((r) => adminReportView(db, r)) };
}

// 给举报人的处理结果
const RESULT_TEXT = {
  dismiss: '经核实暂未发现违规，感谢你的反馈',
  warn: '已对对方进行警告',
  delete_content: '相关内容已删除',
  restrict_7d: '对方已被限制使用',
  ban: '对方已被封禁',
};

// 不填 message 时发给被处理的人的默认说明
const DEFAULT_WARNING = '有人反馈你的言行让人不舒服，请遵守社区公约。再次违反会被限制使用。';
const DEFAULT_RESTRICT_REASON = '被举报并核实违反社区公约';
const DEFAULT_BAN_REASON = '严重违反社区公约';

/** 删除被举报的内容，并通知作者（内容本来就不在了则不通知） */
function deleteContent(db, r, message) {
  const authorId = r.target_user_id;
  let title = null;
  switch (r.target_type) {
    case 'post': {
      const p = db.get('SELECT status FROM posts WHERE id = ?', r.target_id);
      if (!p || p.status === 'deleted') break;
      db.update('posts', r.target_id, { status: 'deleted' });
      title = '你的一条动态因违反社区公约被删除';
      break;
    }
    case 'comment': {
      const c = db.get('SELECT status FROM comments WHERE id = ?', r.target_id);
      if (!c || c.status === 'deleted') break;
      db.update('comments', r.target_id, { status: 'deleted' });
      title = '你的一条评论因违反社区公约被删除';
      break;
    }
    case 'message': {
      const m = db.get('SELECT * FROM messages WHERE id = ?', r.target_id);
      if (!m || !m.user_id) break; // 已经被移除过
      db.update('messages', r.target_id, { kind: 'system', text: '一条消息因违反社区公约已被移除', user_id: null });
      title = '你的一条群聊消息因违反社区公约被删除';
      break;
    }
    case 'event': {
      const e = getEvent(db, r.target_id);
      if (!e || ['cancelled', 'rejected'].includes(e.status)) break;
      cancelEvent(db, e, { reason: '违反社区公约', byAdmin: true, skipUserIds: authorId ? [authorId] : [] });
      title = `你发起的局「${e.title}」因违反社区公约被取消`;
      break;
    }
    case 'user': {
      const u = authorId ? getUser(db, authorId) : null;
      if (!u || !u.bio) break;
      db.update('users', u.id, { bio: '' });
      title = '你的个人简介因违反社区公约被清空';
      break;
    }
    default:
  }
  if (title && authorId) notify(db, authorId, { type: 'content_deleted', title, body: message || '', link: null });
}

/** 封号：已经封禁的不重复处理（返回 false） */
export function banUser(db, userId, reason, { message = null } = {}) {
  const user = getUser(db, userId);
  if (!user || user.status === 'banned') return false;
  db.update('users', userId, { status: 'banned', restricted_reason: reason || null });
  db.run('DELETE FROM sessions WHERE user_id = ?', userId);
  db.run(
    "UPDATE intents SET status = 'cancelled', updated_at = ? WHERE user_id = ? AND status IN ('open', 'proposed')",
    clock.iso(),
    userId,
  );
  notify(db, userId, {
    type: 'banned',
    title: '账号已被封禁',
    body: message || (reason ? `原因：${reason}` : ''),
    link: null,
  });
  return true;
}

/**
 * 处理举报。note 只给后台看（存 admin_note，不会发给任何用户）；
 * message 是发给被处理的人的说明，填了就替换 warn / restrict_7d / ban 的默认文案，
 * delete_content 时接在「你的一条……被删除」后面。
 */
export function resolveReport(db, id, { action, note = null, message = null }) {
  return db.tx(() => {
    const r = db.get('SELECT * FROM reports WHERE id = ?', id);
    if (!r) throw notFound('举报不存在');
    if (r.status !== 'pending') throw conflict('这条举报已经处理过了');
    oneOf(action, '处理方式', REPORT_ACTIONS);
    if (message) {
      // 后台写的说明常要点名违规内容（「请不要推销代购」），所以只拦联系方式和网址
      const check = checkContact(message);
      if (!check.ok) throw blocked('给用户的说明里不能有手机号、微信号或网址', check.reasons);
    }
    const targetUserId = r.target_user_id;
    if (['warn', 'restrict_7d', 'ban'].includes(action) && !targetUserId) throw invalid('这条举报没有对应的用户');

    if (action === 'warn') {
      notify(db, targetUserId, { type: 'warning', title: '你收到一次提醒', body: message || DEFAULT_WARNING, link: null });
    } else if (action === 'delete_content') {
      deleteContent(db, r, message);
    } else if (action === 'restrict_7d') {
      restrictUser(db, targetUserId, 7, message || DEFAULT_RESTRICT_REASON, { message });
    } else if (action === 'ban') {
      banUser(db, targetUserId, message || DEFAULT_BAN_REASON, { message }); // 已封禁的不重复处理
    }

    db.update('reports', id, {
      status: action === 'dismiss' ? 'dismissed' : 'resolved',
      action,
      admin_note: note,
      user_message: action === 'dismiss' ? null : message,
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

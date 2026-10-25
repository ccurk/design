// 动态（公共朋友圈）与评论。动态命中审核进后台（pending），评论命中直接拒绝。
import { clock } from '../clock.js';
import { json } from '../db.js';
import { blocked, forbidden, invalid, notFound } from '../errors.js';
import { checkText } from '../moderation.js';
import { int, oneOf, str, strArray } from '../validate.js';
import { getEvent, memberRow } from './events.js';
import { notify } from './notices.js';
import { blockRelatedIds, getUser, mutedIds, userBrief } from './users.js';

/** 同局的人：曾经一起加入过这个局 */
function wasMember(db, eventId, userId) {
  const m = memberRow(db, eventId, userId);
  return Boolean(m && ['joined', 'left'].includes(m.status) && m.joined_at);
}

export function postView(db, post, viewerId, cache = new Map()) {
  const brief = (id) => {
    if (!cache.has(id)) cache.set(id, userBrief(db, id));
    return cache.get(id);
  };
  const event = post.event_id ? getEvent(db, post.event_id) : null;
  const likeCount = Number(db.get('SELECT COUNT(*) AS n FROM post_likes WHERE post_id = ?', post.id).n);
  const commentCount = Number(
    db.get("SELECT COUNT(*) AS n FROM comments WHERE post_id = ? AND status = 'approved'", post.id).n,
  );
  return {
    id: post.id,
    author: brief(post.user_id),
    text: post.text,
    images: json.parse(post.images, []),
    event: event ? { id: event.id, title: event.title } : null,
    likeCount,
    commentCount,
    liked: Boolean(viewerId && db.get('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?', post.id, viewerId)),
    mine: post.user_id === viewerId,
    status: post.status,
    visibility: post.visibility,
    createdAt: post.created_at,
  };
}

/** 能否看到某条动态（作者本人总能看到未删除的） */
function canSeePost(db, post, viewer, related = blockRelatedIds(db, viewer?.id), muted = new Set()) {
  if (post.status === 'deleted') return false;
  const isAuthor = viewer && post.user_id === viewer.id;
  if (isAuthor) return true;
  if (post.status !== 'approved') return false;
  if (related.has(post.user_id) || muted.has(post.user_id)) return false;
  if (post.visibility === 'event') return Boolean(viewer && post.event_id && wasMember(db, post.event_id, viewer.id));
  return true;
}

export function listPosts(db, viewer, { cursor = null, limit = 20 } = {}) {
  const related = blockRelatedIds(db, viewer?.id);
  const muted = mutedIds(db, viewer?.id);
  const items = [];
  let lastId = cursor;
  let hasMore = false;
  // 按 id 倒序分批扫描，过滤掉看不到的；多看一条来判断还有没有下一页
  for (;;) {
    const batch = db.all(
      `SELECT * FROM posts WHERE status IN ('approved', 'pending') ${lastId ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT 100`,
      ...(lastId ? [lastId] : []),
    );
    for (const post of batch) {
      if (!canSeePost(db, post, viewer, related, muted)) continue;
      if (items.length === limit) {
        hasMore = true;
        break;
      }
      items.push(post);
    }
    if (hasMore || batch.length < 100) break;
    lastId = batch.at(-1).id;
  }
  const cache = new Map();
  return {
    items: items.map((p) => postView(db, p, viewer?.id, cache)),
    nextCursor: hasMore ? items.at(-1).id : null,
  };
}

function requireVisiblePost(db, id, viewer) {
  const post = db.get('SELECT * FROM posts WHERE id = ?', id);
  if (!post || !canSeePost(db, post, viewer)) throw notFound('动态不存在或已删除');
  return post;
}

export function commentView(db, c, viewerId, cache = new Map()) {
  const brief = (id) => {
    if (!cache.has(id)) cache.set(id, userBrief(db, id));
    return cache.get(id);
  };
  const replyTo = c.reply_to_user_id ? getUser(db, c.reply_to_user_id) : null;
  return {
    id: c.id,
    author: brief(c.user_id),
    text: c.text,
    replyTo: replyTo ? { id: replyTo.id, nickname: replyTo.nickname } : null,
    createdAt: c.created_at,
    mine: c.user_id === viewerId,
  };
}

export function postDetail(db, viewer, id) {
  const post = requireVisiblePost(db, id, viewer);
  const related = blockRelatedIds(db, viewer?.id);
  const cache = new Map();
  const comments = db
    .all("SELECT * FROM comments WHERE post_id = ? AND status = 'approved' ORDER BY id", id)
    .filter((c) => !related.has(c.user_id))
    .map((c) => commentView(db, c, viewer?.id, cache));
  return { ...postView(db, post, viewer?.id, cache), comments };
}

export function createPost(db, user, body) {
  const text = str(body?.text, '内容', { min: 1, max: 500 });
  const images = strArray(body?.images ?? [], '图片', { maxItems: 9, maxLen: 500 });
  if (images.some((url) => !/^(https?:\/\/|\/uploads\/)/.test(url))) throw invalid('图片地址不正确，请先上传');
  const eventId = int(body?.eventId, '关联的局', { min: 1, optional: true });
  const visibility = oneOf(body?.visibility ?? 'public', '谁能看到', ['public', 'event']);
  if (eventId) {
    const event = getEvent(db, eventId);
    if (!event || !wasMember(db, eventId, user.id)) throw invalid('只能关联你参加过的局');
  }
  if (visibility === 'event' && !eventId) throw invalid('「只给同局的人」需要先关联一个局');
  const check = checkText(text);
  const id = db.insert('posts', {
    user_id: user.id,
    text,
    images: JSON.stringify(images),
    event_id: eventId,
    visibility,
    status: check.ok ? 'approved' : 'pending',
    moderation: JSON.stringify(check.reasons),
    created_at: clock.iso(),
  });
  return postView(db, db.get('SELECT * FROM posts WHERE id = ?', id), user.id);
}

export function deletePost(db, user, id) {
  const post = db.get('SELECT * FROM posts WHERE id = ?', id);
  if (!post || post.status === 'deleted') throw notFound('动态不存在或已删除');
  if (post.user_id !== user.id) throw forbidden('只能删除自己的动态');
  db.update('posts', id, { status: 'deleted' });
  return { ok: true };
}

export function setLike(db, user, id, liked) {
  requireVisiblePost(db, id, user);
  if (liked) {
    db.run('INSERT OR IGNORE INTO post_likes (post_id, user_id, created_at) VALUES (?, ?, ?)', id, user.id, clock.iso());
  } else {
    db.run('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?', id, user.id);
  }
  const likeCount = Number(db.get('SELECT COUNT(*) AS n FROM post_likes WHERE post_id = ?', id).n);
  return { liked, likeCount };
}

export function addComment(db, user, postId, body) {
  const post = requireVisiblePost(db, postId, user);
  if (post.status !== 'approved') throw invalid('动态还在审核中，暂时不能评论');
  const text = str(body?.text, '评论', { min: 1, max: 200 });
  const replyToUserId = int(body?.replyToUserId, '回复对象', { min: 1, optional: true });
  if (replyToUserId && !getUser(db, replyToUserId)) throw invalid('回复的人不存在');
  const check = checkText(text);
  if (!check.ok) throw blocked('评论里不能发联系方式或广告', check.reasons);
  const id = db.insert('comments', {
    post_id: postId,
    user_id: user.id,
    reply_to_user_id: replyToUserId,
    text,
    status: 'approved',
    created_at: clock.iso(),
  });
  const notifyIds = new Set([post.user_id, replyToUserId].filter((x) => x && x !== user.id));
  for (const uid of notifyIds) {
    notify(db, uid, {
      type: 'comment',
      title: uid === post.user_id ? '你的动态有新评论' : '有人回复了你',
      body: `${user.nickname}：${text.slice(0, 40)}`,
      link: `post:${postId}`,
    });
  }
  return commentView(db, db.get('SELECT * FROM comments WHERE id = ?', id), user.id);
}

// ---- 后台 ----

export function adminPostView(db, post) {
  return {
    ...postView(db, post, null),
    flags: json.parse(post.moderation, []),
  };
}

export function adminListPosts(db, status = 'pending') {
  const rows =
    status === 'all'
      ? db.all('SELECT * FROM posts ORDER BY id DESC LIMIT 200')
      : db.all('SELECT * FROM posts WHERE status = ? ORDER BY id DESC LIMIT 200', status);
  return { items: rows.map((p) => adminPostView(db, p)) };
}

export function moderatePost(db, id, approve, note = null) {
  const post = db.get('SELECT * FROM posts WHERE id = ?', id);
  if (!post || post.status === 'deleted') throw notFound('动态不存在');
  db.update('posts', id, { status: approve ? 'approved' : 'rejected' });
  notify(db, post.user_id, {
    type: approve ? 'post_approved' : 'post_rejected',
    title: approve ? '你的动态已通过审核' : '你的动态没有通过审核',
    body: approve ? '大家已经能在动态里看到了' : note || '内容可能包含联系方式、广告或不当信息',
    link: `post:${id}`,
  });
  return adminPostView(db, db.get('SELECT * FROM posts WHERE id = ?', id));
}

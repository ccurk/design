// 动态（公共朋友圈）与评论。动态命中审核进后台（pending），评论命中直接拒绝。
import { clock } from '../clock.js';
import { json } from '../db.js';
import { blocked, conflict, forbidden, invalid, notFound } from '../errors.js';
import { checkText } from '../moderation.js';
import { absUrl, absUrls, parseImages } from '../urls.js';
import { int, oneOf, str } from '../validate.js';
import { getEvent, memberRow } from './events.js';
import { notify } from './notices.js';
import { blockRelatedIds, getUser, mutedIds, userBrief } from './users.js';

/** 同局的人：曾经一起加入过这个局 */
async function wasMember(db, eventId, userId) {
  const m = await memberRow(db, eventId, userId);
  return Boolean(m && ['joined', 'left'].includes(m.status) && m.joined_at);
}

export async function postView(db, post, viewerId, cache = new Map()) {
  const brief = async (id) => {
    if (!cache.has(id)) cache.set(id, await userBrief(db, id));
    return cache.get(id);
  };
  const event = post.event_id ? await getEvent(db, post.event_id) : null;
  const likeCount = Number((await db.get('SELECT COUNT(*) AS n FROM post_likes WHERE post_id = ?', post.id)).n);
  const commentCount = Number(
    (await db.get("SELECT COUNT(*) AS n FROM comments WHERE post_id = ? AND status = 'approved'", post.id)).n,
  );
  return {
    id: post.id,
    author: await brief(post.user_id),
    text: post.text,
    images: absUrls(db, json.parse(post.images, [])),
    event: event ? { id: event.id, title: event.title } : null,
    likeCount,
    commentCount,
    liked: Boolean(viewerId && (await db.get('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?', post.id, viewerId))),
    mine: post.user_id === viewerId,
    status: post.status,
    visibility: post.visibility,
    createdAt: post.created_at,
  };
}

/** 能否看到某条动态（作者本人总能看到未删除的） */
async function canSeePost(db, post, viewer, related, muted = new Set()) {
  related ??= await blockRelatedIds(db, viewer?.id);
  if (post.status === 'deleted') return false;
  const isAuthor = viewer && post.user_id === viewer.id;
  if (isAuthor) return true;
  if (post.status !== 'approved') return false;
  if (related.has(post.user_id) || muted.has(post.user_id)) return false;
  if (post.visibility === 'event') return Boolean(viewer && post.event_id && (await wasMember(db, post.event_id, viewer.id)));
  return true;
}

export async function listPosts(db, viewer, { cursor = null, limit = 20 } = {}) {
  const related = await blockRelatedIds(db, viewer?.id);
  const muted = await mutedIds(db, viewer?.id);
  const items = [];
  let lastId = cursor;
  let hasMore = false;
  // 按 id 倒序分批扫描，过滤掉看不到的；多看一条来判断还有没有下一页
  for (;;) {
    const batch = await db.all(
      `SELECT * FROM posts WHERE status IN ('approved', 'pending') ${lastId ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT 100`,
      ...(lastId ? [lastId] : []),
    );
    for (const post of batch) {
      if (!(await canSeePost(db, post, viewer, related, muted))) continue;
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
    items: await Promise.all(items.map((p) => postView(db, p, viewer?.id, cache))),
    nextCursor: hasMore ? items.at(-1).id : null,
  };
}

/** 首页「大家最近在玩」：最近带图的公开动态（排除拉黑、不看的人），第一张图作封面 */
export async function highlightPosts(db, viewer, limit = 10) {
  const related = await blockRelatedIds(db, viewer?.id);
  const muted = await mutedIds(db, viewer?.id);
  const picked = [];
  let lastId = null;
  for (;;) {
    const batch = await db.all(
      `SELECT * FROM posts WHERE status = 'approved' AND visibility = 'public' ${lastId ? 'AND id < ?' : ''}
       ORDER BY id DESC LIMIT 100`,
      ...(lastId ? [lastId] : []),
    );
    for (const post of batch) {
      if (related.has(post.user_id) || muted.has(post.user_id)) continue;
      const images = json.parse(post.images, []);
      if (!images.length) continue;
      picked.push({ post, image: images[0] });
      if (picked.length >= limit) break;
    }
    if (picked.length >= limit || batch.length < 100) break;
    lastId = batch.at(-1).id;
  }
  const cache = new Map();
  return await Promise.all(
    picked.map(async ({ post, image }) => {
      if (!cache.has(post.user_id)) cache.set(post.user_id, await userBrief(db, post.user_id));
      const event = post.event_id ? await getEvent(db, post.event_id) : null;
      return {
        postId: post.id,
        image: absUrl(db, image),
        text: post.text,
        user: cache.get(post.user_id),
        eventTitle: event?.title ?? null,
      };
    }),
  );
}

async function requireVisiblePost(db, id, viewer) {
  const post = await db.get('SELECT * FROM posts WHERE id = ?', id);
  if (!post || !(await canSeePost(db, post, viewer))) throw notFound('动态不存在或已删除');
  return post;
}

export async function commentView(db, c, viewerId, cache = new Map()) {
  const brief = async (id) => {
    if (!cache.has(id)) cache.set(id, await userBrief(db, id));
    return cache.get(id);
  };
  const replyTo = c.reply_to_user_id ? await getUser(db, c.reply_to_user_id) : null;
  return {
    id: c.id,
    author: await brief(c.user_id),
    text: c.text,
    replyTo: replyTo ? { id: replyTo.id, nickname: replyTo.nickname } : null,
    createdAt: c.created_at,
    mine: c.user_id === viewerId,
  };
}

export async function postDetail(db, viewer, id) {
  const post = await requireVisiblePost(db, id, viewer);
  const related = await blockRelatedIds(db, viewer?.id);
  const cache = new Map();
  const comments = await Promise.all(
    (await db.all("SELECT * FROM comments WHERE post_id = ? AND status = 'approved' ORDER BY id", id))
      .filter((c) => !related.has(c.user_id))
      .map((c) => commentView(db, c, viewer?.id, cache)),
  );
  return { ...(await postView(db, post, viewer?.id, cache)), comments };
}

export async function createPost(db, user, body) {
  const text = str(body?.text, '内容', { min: 1, max: 500 });
  const images = parseImages(body?.images, { max: 9 }); // 存相对路径 /uploads/…，返回时拼成绝对地址
  const eventId = int(body?.eventId, '关联的局', { min: 1, optional: true });
  const visibility = oneOf(body?.visibility ?? 'public', '谁能看到', ['public', 'event']);
  if (eventId) {
    const event = await getEvent(db, eventId);
    if (!event || !(await wasMember(db, eventId, user.id))) throw invalid('只能关联你参加过的局');
  }
  if (visibility === 'event' && !eventId) throw invalid('「只给同局的人」需要先关联一个局');
  const check = checkText(text);
  const id = await db.insert('posts', {
    user_id: user.id,
    text,
    images: JSON.stringify(images),
    event_id: eventId,
    visibility,
    status: check.ok ? 'approved' : 'pending',
    moderation: JSON.stringify(check.reasons),
    created_at: clock.iso(),
  });
  return await postView(db, await db.get('SELECT * FROM posts WHERE id = ?', id), user.id);
}

export async function deletePost(db, user, id) {
  const post = await db.get('SELECT * FROM posts WHERE id = ?', id);
  if (!post || post.status === 'deleted') throw notFound('动态不存在或已删除');
  if (post.user_id !== user.id) throw forbidden('只能删除自己的动态');
  await db.update('posts', id, { status: 'deleted' });
  return { ok: true };
}

export async function setLike(db, user, id, liked) {
  await requireVisiblePost(db, id, user);
  if (liked) {
    await db.run('INSERT IGNORE INTO post_likes (post_id, user_id, created_at) VALUES (?, ?, ?)', id, user.id, clock.iso());
  } else {
    await db.run('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?', id, user.id);
  }
  const likeCount = Number((await db.get('SELECT COUNT(*) AS n FROM post_likes WHERE post_id = ?', id)).n);
  return { liked, likeCount };
}

export async function addComment(db, user, postId, body) {
  const post = await requireVisiblePost(db, postId, user);
  if (post.status !== 'approved') throw invalid('动态还在审核中，暂时不能评论');
  const text = str(body?.text, '评论', { min: 1, max: 200 });
  const replyToUserId = int(body?.replyToUserId, '回复对象', { min: 1, optional: true });
  if (replyToUserId && !(await getUser(db, replyToUserId))) throw invalid('回复的人不存在');
  const check = checkText(text);
  if (!check.ok) throw blocked('评论里不能发联系方式或广告', check.reasons);
  const id = await db.insert('comments', {
    post_id: postId,
    user_id: user.id,
    reply_to_user_id: replyToUserId,
    text,
    status: 'approved',
    created_at: clock.iso(),
  });
  const notifyIds = new Set([post.user_id, replyToUserId].filter((x) => x && x !== user.id));
  for (const uid of notifyIds) {
    await notify(db, uid, {
      type: 'comment',
      title: uid === post.user_id ? '你的动态有新评论' : '有人回复了你',
      body: `${user.nickname}：${text.slice(0, 40)}`,
      link: `post:${postId}`,
    });
  }
  return await commentView(db, await db.get('SELECT * FROM comments WHERE id = ?', id), user.id);
}

// ---- 后台 ----

export async function adminPostView(db, post) {
  return {
    ...(await postView(db, post, null)),
    flags: json.parse(post.moderation, []),
  };
}

export async function adminListPosts(db, status = 'pending') {
  oneOf(status, '状态筛选', ['pending', 'approved', 'rejected', 'deleted', 'all']);
  const rows =
    status === 'all'
      ? await db.all('SELECT * FROM posts ORDER BY id DESC LIMIT 200')
      : await db.all('SELECT * FROM posts WHERE status = ? ORDER BY id DESC LIMIT 200', status);
  return { items: await Promise.all(rows.map((p) => adminPostView(db, p))) };
}

export async function moderatePost(db, id, approve, note = null) {
  const post = await db.get('SELECT * FROM posts WHERE id = ?', id);
  if (!post || post.status === 'deleted') throw notFound('动态不存在');
  if (post.status !== 'pending') throw conflict('这条动态已经审核过了');
  await db.update('posts', id, { status: approve ? 'approved' : 'rejected' });
  await notify(db, post.user_id, {
    type: approve ? 'post_approved' : 'post_rejected',
    title: approve ? '你的动态已通过审核' : '你的动态没有通过审核',
    body: approve ? '大家已经能在动态里看到了' : note || '内容可能包含联系方式、广告或不当信息',
    link: `post:${id}`,
  });
  return await adminPostView(db, await db.get('SELECT * FROM posts WHERE id = ?', id));
}

// 群聊、破冰话题、局信息、免打扰。
import { clock } from '../clock.js';
import { ICEBREAKERS } from '../constants.js';
import { blocked, forbidden } from '../errors.js';
import { checkText } from '../moderation.js';
import { str } from '../validate.js';
import { aaSummary } from './aa.js';
import { eventDetail, isChatOpen, joinedMembers, memberRow, requireEvent } from './events.js';
import { userBrief } from './users.js';

async function requireJoined(db, user, eventId, message = '加入这个局后才能看群聊') {
  const event = await requireEvent(db, eventId);
  const mine = await memberRow(db, eventId, user.id);
  if (!mine || mine.status !== 'joined') throw forbidden(message);
  return { event, mine };
}

export async function messageView(db, row, viewerId, cache = new Map()) {
  let user = null;
  if (row.user_id) {
    if (!cache.has(row.user_id)) cache.set(row.user_id, userBrief(db, row.user_id));
    user = await cache.get(row.user_id);
  }
  return {
    id: row.id,
    kind: row.kind,
    user,
    text: row.text,
    createdAt: row.created_at,
    mine: viewerId != null && row.user_id === viewerId, // 后台查看时没有 viewer，系统消息不能算「我的」
  };
}

export function icebreakerView(event) {
  const index = ((event.icebreaker_index % ICEBREAKERS.length) + ICEBREAKERS.length) % ICEBREAKERS.length;
  return { index, total: ICEBREAKERS.length, question: ICEBREAKERS[index] };
}

/** ?after=<id> 轮询新消息；不传 after 返回最近 50 条。调用即视为已读 */
export async function listMessages(db, user, eventId, { after = null } = {}) {
  const { event } = await requireJoined(db, user, eventId);
  const rows =
    after !== null
      ? await db.all('SELECT * FROM messages WHERE event_id = ? AND id > ? ORDER BY id LIMIT 200', eventId, after)
      : (await db.all('SELECT * FROM messages WHERE event_id = ? ORDER BY id DESC LIMIT 50', eventId)).reverse();
  const last = (await db.get('SELECT MAX(id) AS id FROM messages WHERE event_id = ?', eventId))?.id || 0;
  await db.run(
    'UPDATE event_members SET last_read_message_id = MAX(last_read_message_id, ?) WHERE event_id = ? AND user_id = ?',
    last,
    eventId,
    user.id,
  );
  const cache = new Map();
  return {
    items: await Promise.all(rows.map((r) => messageView(db, r, user.id, cache))),
    icebreaker: icebreakerView(event),
    chatOpen: isChatOpen(event),
  };
}

export async function postMessage(db, user, eventId, body) {
  const { event } = await requireJoined(db, user, eventId, '加入这个局后才能发消息');
  if (!isChatOpen(event)) throw forbidden('群聊还没开启，成群后就能聊了');
  const text = str(body?.text, '消息', { min: 1, max: 500 });
  const check = checkText(text);
  if (!check.ok) throw blocked('群聊里不能发联系方式或广告', check.reasons);
  const id = await db.insert('messages', {
    event_id: eventId,
    user_id: user.id,
    kind: 'text',
    text,
    created_at: clock.iso(),
  });
  await db.run('UPDATE event_members SET last_read_message_id = ? WHERE event_id = ? AND user_id = ?', id, eventId, user.id);
  return await messageView(db, await db.get('SELECT * FROM messages WHERE id = ?', id), user.id);
}

/** 换一个破冰话题（全组共享同一个序号） */
export async function nextIcebreaker(db, user, eventId) {
  const { event } = await requireJoined(db, user, eventId);
  const index = (event.icebreaker_index + 1) % ICEBREAKERS.length;
  await db.update('events', eventId, { icebreaker_index: index });
  return icebreakerView({ ...event, icebreaker_index: index });
}

export async function eventInfo(db, user, eventId) {
  const { event, mine } = await requireJoined(db, user, eventId, '加入这个局后才能查看');
  const aa = await aaSummary(db, event, user.id);
  return {
    event: await eventDetail(db, event, user),
    members: await Promise.all(
      (await joinedMembers(db, eventId)).map(async (m) => ({
        ...(await userBrief(db, m.user_id)),
        role: m.role,
        isMe: m.user_id === user.id,
      })),
    ),
    aa: { each: aa.each, openTransfers: aa.transfers.filter((t) => t.status !== 'confirmed').length },
    muted: Boolean(mine.muted),
  };
}

export async function setMuted(db, user, eventId, muted) {
  await requireJoined(db, user, eventId, '加入这个局后才能设置');
  await db.run('UPDATE event_members SET muted = ? WHERE event_id = ? AND user_id = ?', muted ? 1 : 0, eventId, user.id);
  return { muted: Boolean(muted) };
}

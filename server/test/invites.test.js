import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { clock } from '../src/clock.js';
import { runMatching } from '../src/services/matching.js';
import { HOUR, addCredit, makeIntent, makeUser, startServer } from './helpers.js';

let s;
let users;
let tokens;
let admin;

/** 3 个人想周六上午看日出 → 引擎生成建议 */
async function setupProposal(n = 3) {
  users = Array.from({ length: n }, () => makeUser(s.db));
  users.forEach((u) => addCredit(s.db, u, 'attended', 2));
  users.forEach((u) => makeIntent(s.db, u));
  runMatching(s.db);
  tokens = await Promise.all(users.map((u) => s.login(u)));
  admin = await s.adminToken();
  const { items } = await s.ok('GET', '/api/admin/proposals?status=pending', { token: admin });
  return items[0];
}

describe('撮合局：确认 → 邀请 → 加入 / 换一批', () => {
  beforeEach(async () => {
    s = await startServer();
  });
  afterEach(() => s.close());

  test('后台确认 → inviting 局 + 成员 invited + 意向 invited + 通知「撮合成功」', async () => {
    const proposal = await setupProposal();
    assert.equal(proposal.members.length, 3);
    assert.ok(proposal.members.every((m) => m.intentId && m.user.nickname));

    const { eventId } = await s.ok('POST', `/api/admin/proposals/${proposal.id}/confirm`, {
      token: admin,
      body: { title: '周六清晨 · 苍山看日出', place: '大理古城南门', meetingPoint: '南门城楼下', feeEstimate: 30, capacity: 3 },
    });
    const event = s.db.get('SELECT * FROM events WHERE id = ?', eventId);
    assert.equal(event.status, 'inviting');
    assert.equal(event.source, 'matched');
    assert.equal(event.start_at, '2026-10-30T21:50:00.000Z'); // 周六 05:50 北京时间
    assert.equal(s.db.get("SELECT COUNT(*) AS n FROM event_members WHERE event_id = ? AND status = 'invited'", eventId).n, 3);
    assert.equal(s.db.get("SELECT COUNT(*) AS n FROM intents WHERE event_id = ? AND status = 'invited'", eventId).n, 3);
    assert.equal(s.db.get('SELECT status FROM proposals WHERE id = ?', proposal.id).status, 'confirmed');

    const inbox = await s.ok('GET', '/api/inbox', { token: tokens[0] });
    assert.ok(inbox.notices.some((n) => n.type === 'match' && n.title === '撮合成功' && n.link === `match:${eventId}`));
    const action = inbox.actions.find((a) => a.type === 'match');
    assert.equal(action.eventId, eventId);
    assert.equal(action.title, '撮合成功：周六清晨 · 苍山看日出');
    assert.ok(action.deadline);

    // 撮合局不进广场，非成员看不到
    const square = await s.ok('GET', '/api/events');
    assert.ok(!square.items.some((e) => e.id === eventId));
    const outsider = await s.login(makeUser(s.db));
    assert.equal((await s.api('GET', `/api/events/${eventId}`, { token: outsider })).status, 404);
    assert.equal((await s.api('GET', `/api/events/${eventId}`)).status, 404);
    assert.equal((await s.api('GET', `/api/matches/${eventId}`, { token: outsider })).status, 404);

    const match = await s.ok('GET', `/api/matches/${eventId}`, { token: tokens[0] });
    assert.equal(match.myStatus, 'invited');
    assert.equal(match.members.length, 3);
    assert.equal(match.joinedCount, 0);
    assert.ok(match.commonPoints.includes('都想看日出'));
    assert.equal(match.event.title, '周六清晨 · 苍山看日出');
    assert.equal(match.event.dateLabel, '周六 05:50');
    assert.equal(match.event.feeLabel, 'AA 约 ¥30');
  });

  test('全员加入 → formed，群聊开启并有系统消息', async () => {
    const proposal = await setupProposal();
    const { eventId } = await s.ok('POST', `/api/admin/proposals/${proposal.id}/confirm`, { token: admin, body: {} });
    let r = await s.ok('POST', `/api/matches/${eventId}/accept`, { token: tokens[0] });
    assert.deepEqual(r, {
      myStatus: 'joined',
      eventStatus: 'inviting',
      formed: false,
      remaining: 2,
      memberCount: 1,
      capacity: 3,
      exitDeadline: '2026-10-29T21:50:00.000Z', // 开场前 24 小时
    });
    await s.ok('POST', `/api/matches/${eventId}/accept`, { token: tokens[1] });
    r = await s.ok('POST', `/api/matches/${eventId}/accept`, { token: tokens[2] });
    assert.equal(r.eventStatus, 'formed');
    assert.equal(r.formed, true);
    assert.equal(r.remaining, 0);
    assert.equal(r.memberCount, 3);

    const msgs = await s.ok('GET', `/api/events/${eventId}/messages`, { token: tokens[0] });
    assert.equal(msgs.items[0].kind, 'system');
    assert.equal(msgs.items[0].text, '满员啦，群已自动建好 · 第一次见面，慢慢来');
    assert.equal(msgs.icebreaker.total, 5);
    assert.equal(s.db.get("SELECT COUNT(*) AS n FROM intents WHERE event_id = ? AND status = 'matched'", eventId).n, 3);

    const detail = await s.ok('GET', `/api/events/${eventId}`, { token: tokens[1] });
    assert.equal(detail.status, 'formed');
    assert.equal(detail.chatOpen, true);
    assert.equal(detail.memberCount, 3);
    assert.equal(detail.host, null);

    const inbox = await s.ok('GET', '/api/inbox', { token: tokens[1] });
    assert.equal(inbox.chats[0].eventId, eventId);
    assert.equal(inbox.chats[0].unread, 1); // tokens[1] 还没读过那条系统消息
  });

  test('换一批 → declined，意向回到 open，不扣分；有同条件的人自动补邀', async () => {
    const proposal = await setupProposal();
    const { eventId } = await s.ok('POST', `/api/admin/proposals/${proposal.id}/confirm`, { token: admin, body: {} });
    const r = await s.ok('POST', `/api/matches/${eventId}/decline`, { token: tokens[2] });
    assert.equal(r.ok, true);
    const intent = s.db.get('SELECT * FROM intents WHERE id = ?', r.intentId);
    assert.equal(intent.status, 'open');
    assert.equal(intent.event_id, null);
    assert.equal(s.db.get('SELECT COUNT(*) AS n FROM credit_events WHERE user_id = ?', users[2]).n, 2); // 没新增记录

    // 新来一个同条件的人：跑撮合时直接补邀（不经过后台）
    const newcomer = makeUser(s.db);
    makeIntent(s.db, newcomer);
    const result = runMatching(s.db);
    assert.equal(result.backfilled, 1);
    const m = s.db.get('SELECT * FROM event_members WHERE event_id = ? AND user_id = ?', eventId, newcomer);
    assert.equal(m.status, 'invited');
    // 刚才换一批的人不会再被邀请回这个局
    assert.equal(s.db.get('SELECT status FROM event_members WHERE event_id = ? AND user_id = ?', eventId, users[2]).status, 'declined');

    for (const t of [tokens[0], tokens[1], await s.login(newcomer)]) {
      await s.ok('POST', `/api/matches/${eventId}/accept`, { token: t });
    }
    assert.equal(s.db.get('SELECT status FROM events WHERE id = ?', eventId).status, 'formed');
  });

  test('邀请超过 24 小时没回应视为放弃：够人就成局', async () => {
    const proposal = await setupProposal(4);
    const { eventId } = await s.ok('POST', `/api/admin/proposals/${proposal.id}/confirm`, { token: admin, body: {} });
    for (const t of tokens.slice(0, 3)) await s.ok('POST', `/api/matches/${eventId}/accept`, { token: t });
    assert.equal(s.db.get('SELECT status FROM events WHERE id = ?', eventId).status, 'inviting');

    clock.advance(24 * HOUR + 60000);
    await s.ok('POST', '/api/dev/tick');
    assert.equal(s.db.get('SELECT status FROM events WHERE id = ?', eventId).status, 'formed');
    assert.equal(s.db.get('SELECT status FROM event_members WHERE event_id = ? AND user_id = ?', eventId, users[3]).status, 'declined');
    assert.equal(s.db.get('SELECT status FROM intents WHERE user_id = ?', users[3]).status, 'expired');
  });

  test('到期不够人 → 取消该局，意向退回 open，并通知「这次没凑齐」', async () => {
    const proposal = await setupProposal(3);
    const { eventId } = await s.ok('POST', `/api/admin/proposals/${proposal.id}/confirm`, { token: admin, body: {} });
    await s.ok('POST', `/api/matches/${eventId}/accept`, { token: tokens[0] });
    await s.ok('POST', `/api/matches/${eventId}/accept`, { token: tokens[1] });
    // 离开场不到 12 小时（周六 05:50 前 12 小时 = 周五 17:50）
    clock.set('2026-10-30T10:00:00.000Z');
    await s.ok('POST', '/api/dev/tick');
    assert.equal(s.db.get('SELECT status FROM events WHERE id = ?', eventId).status, 'cancelled');
    for (const u of users.slice(0, 2)) {
      assert.equal(s.db.get('SELECT status FROM intents WHERE user_id = ?', u).status, 'open');
      assert.ok(s.db.get("SELECT 1 FROM notices WHERE user_id = ? AND type = 'match_failed' AND body = '这次没凑齐，已帮你继续撮合'", u));
    }
    const late = await s.api('POST', `/api/matches/${eventId}/accept`, { token: tokens[2] });
    assert.equal(late.status, 409);
  });

  test('过期后才点加入：返回 409，邀请作废、意向退回撮合池（不会被回滚）', async () => {
    const proposal = await setupProposal(4);
    const { eventId } = await s.ok('POST', `/api/admin/proposals/${proposal.id}/confirm`, { token: admin, body: {} });
    for (const t of tokens.slice(0, 3)) await s.ok('POST', `/api/matches/${eventId}/accept`, { token: t });
    clock.advance(24 * HOUR + 60000); // 定时任务还没跑
    const late = await s.api('POST', `/api/matches/${eventId}/accept`, { token: tokens[3] });
    assert.equal(late.status, 409);
    assert.equal(s.db.get('SELECT status FROM event_members WHERE event_id = ? AND user_id = ?', eventId, users[3]).status, 'declined');
    assert.equal(s.db.get('SELECT status FROM intents WHERE user_id = ?', users[3]).status, 'open');
    assert.equal(s.db.get('SELECT status FROM events WHERE id = ?', eventId).status, 'formed');
  });

  test('成局前在局里点退出 = 换一批，不扣分', async () => {
    const proposal = await setupProposal(3);
    const { eventId } = await s.ok('POST', `/api/admin/proposals/${proposal.id}/confirm`, { token: admin, body: {} });
    await s.ok('POST', `/api/matches/${eventId}/accept`, { token: tokens[0] });
    const r = await s.ok('POST', `/api/events/${eventId}/leave`, { token: tokens[0] });
    assert.deepEqual(r, { penalty: null });
    assert.equal(s.db.get('SELECT status FROM event_members WHERE event_id = ? AND user_id = ?', eventId, users[0]).status, 'declined');
    assert.equal(s.db.get('SELECT status FROM intents WHERE user_id = ?', users[0]).status, 'open');
  });

  test('后台调整成员会重新计算匹配度；拉黑冲突不能确认', async () => {
    const proposal = await setupProposal(3);
    const extra = makeUser(s.db);
    const extraIntent = makeIntent(s.db, extra);
    let p = await s.ok('POST', `/api/admin/proposals/${proposal.id}/members`, {
      token: admin,
      body: { remove: [users[2]], add: [extraIntent] },
    });
    assert.deepEqual(p.members.map((m) => m.user.id).sort(), [users[0], users[1], extra].sort());
    assert.ok(p.risks.includes('1 位是第一次参加'));
    assert.equal(s.db.get('SELECT status FROM intents WHERE user_id = ?', users[2]).status, 'open');

    s.db.insert('blocks', { user_id: extra, blocked_id: users[0], created_at: clock.iso() });
    p = await s.ok('POST', `/api/admin/proposals/${proposal.id}/members`, { token: admin, body: {} });
    assert.ok(p.risks.includes('组里有人互相拉黑，不能成局'));
    const res = await s.api('POST', `/api/admin/proposals/${proposal.id}/confirm`, { token: admin, body: {} });
    assert.equal(res.status, 409);
  });

  test('取消意向：撮合中的意向从建议里移除，剩不到 2 人时建议作废', async () => {
    const proposal = await setupProposal(3);
    const mine = await s.ok('GET', '/api/intents/mine', { token: tokens[0] });
    assert.equal(mine.items[0].status, 'proposed');
    await s.ok('DELETE', `/api/intents/${mine.items[0].id}`, { token: tokens[0] });
    let p = s.db.get('SELECT * FROM proposals WHERE id = ?', proposal.id);
    assert.equal(JSON.parse(p.intent_ids).length, 2);
    const other = await s.ok('GET', '/api/intents/mine', { token: tokens[1] });
    await s.ok('DELETE', `/api/intents/${other.items[0].id}`, { token: tokens[1] });
    p = s.db.get('SELECT * FROM proposals WHERE id = ?', proposal.id);
    assert.equal(p.status, 'expired');
    assert.equal(s.db.get('SELECT status FROM intents WHERE user_id = ?', users[2]).status, 'open');
  });

  test('「我的局」里撮合中的意向以卡片出现（id 为 null）', async () => {
    const u = makeUser(s.db);
    const t = await s.login(u);
    const intent = await s.ok('POST', '/api/intents', { token: t, body: { task: '爬山', when: 'weekend', slot: 'morning' } });
    assert.equal(intent.title, '本周末上午 · 爬山');
    assert.equal(intent.dateFrom, '2026-10-31');
    assert.equal(intent.dateTo, '2026-11-01');
    const { items } = await s.ok('GET', '/api/events/mine?tab=ongoing', { token: t });
    assert.equal(items.length, 1);
    assert.equal(items[0].id, null);
    assert.equal(items[0].intentId, intent.id);
    assert.equal(items[0].myStatus, 'matching');
    assert.equal((await s.ok('GET', '/api/me', { token: t })).ongoingCount, 1);
  });
});

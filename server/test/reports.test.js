import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { runMatching } from '../src/services/matching.js';
import { makeIntent, makeUser, startServer } from './helpers.js';

let s;

describe('举报与处理', () => {
  beforeEach(async () => {
    s = await startServer();
  });
  afterEach(() => s.close());

  test('restrict_7d：被举报的人退出撮合，举报人收到处理结果', async () => {
    const [reporter, bad, x, y] = [makeUser(s.db), makeUser(s.db), makeUser(s.db), makeUser(s.db)];
    const tr = await s.login(reporter);
    const r = await s.ok('POST', '/api/reports', {
      token: tr,
      body: { targetType: 'user', targetId: bad, reason: '骚扰或不当言行', detail: '一直问我住哪', alsoBlock: true },
    });
    assert.equal(r.status, 'pending');
    assert.ok(s.db.get('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?', reporter, bad));

    const admin = await s.adminToken();
    const { items } = await s.ok('GET', '/api/admin/reports?status=pending', { token: admin });
    assert.equal(items.length, 1);
    assert.equal(items[0].targetUser.id, bad);
    assert.equal(items[0].targetUser.reportCount, 1);
    assert.match(items[0].reporterAnonId, /^用户#[0-9a-f]{3}$/);
    assert.ok(!JSON.stringify(items[0]).includes(`"reporterId"`));

    await s.ok('POST', `/api/admin/reports/${r.id}/resolve`, { token: admin, body: { action: 'restrict_7d', note: '核实属实' } });
    const badUser = s.db.get('SELECT * FROM users WHERE id = ?', bad);
    assert.equal(badUser.status, 'restricted');

    // 受限的人不参与撮合：bad + x + y 本来能凑一组
    [bad, x, y].forEach((u) => makeIntent(s.db, u));
    assert.equal(runMatching(s.db).created, 0);
    const z = makeUser(s.db);
    makeIntent(s.db, z);
    assert.equal(runMatching(s.db).created, 1);
    const proposal = s.db.get("SELECT * FROM proposals WHERE status = 'pending'");
    assert.ok(!JSON.parse(proposal.user_ids).includes(bad));

    const tb = await s.login(bad);
    const join = await s.api('POST', '/api/intents', { token: tb, body: { task: '咖啡', when: 'tomorrow' } });
    assert.equal(join.body.error.code, 'RESTRICTED');

    const inbox = await s.ok('GET', '/api/inbox', { token: tr });
    const notice = inbox.notices.find((n) => n.type === 'report_result');
    assert.equal(notice.title, '你的举报已处理');
    assert.equal(notice.body, '对方已被限制使用');
    assert.equal(notice.read, false);
    await s.ok('POST', `/api/notices/${notice.id}/read`, { token: tr });
    assert.equal((await s.ok('GET', '/api/inbox', { token: tr })).unread.notices, 0);

    const again = await s.api('POST', `/api/admin/reports/${r.id}/resolve`, { token: admin, body: { action: 'ban' } });
    assert.equal(again.status, 409);
  });

  test('delete_content 删除被举报的消息；ban 后对方 token 失效', async () => {
    const [a, b] = [makeUser(s.db), makeUser(s.db)];
    const [ta, tb] = [await s.login(a), await s.login(b)];
    const ev = await s.ok('POST', '/api/events', {
      token: ta,
      body: { title: '吃饭局', category: 'food', startAt: '2026-10-31T06:00:00.000Z', place: '人民路', capacity: 4, feeType: 'aa' },
    });
    await s.ok('POST', `/api/events/${ev.id}/join`, { token: tb });
    const msg = await s.ok('POST', `/api/events/${ev.id}/messages`, { token: tb, body: { text: '我朋友的店能打折，回头私下找我' } });
    const rep = await s.ok('POST', '/api/reports', { token: ta, body: { targetType: 'message', targetId: msg.id, reason: '推销 / 拉人头' } });
    const admin = await s.adminToken();
    const list = await s.ok('GET', '/api/admin/reports', { token: admin });
    assert.equal(list.items[0].preview, '我朋友的店能打折，回头私下找我');
    await s.ok('POST', `/api/admin/reports/${rep.id}/resolve`, { token: admin, body: { action: 'delete_content' } });
    const { items } = await s.ok('GET', `/api/events/${ev.id}/messages`, { token: ta });
    assert.ok(!items.some((m) => m.text.includes('打折')));

    const rep2 = await s.ok('POST', '/api/reports', { token: ta, body: { targetType: 'user', targetId: b, reason: '推销 / 拉人头' } });
    await s.ok('POST', `/api/admin/reports/${rep2.id}/resolve`, { token: admin, body: { action: 'ban', note: '多次推销' } });
    const after = await s.api('GET', '/api/me', { token: tb });
    assert.equal(after.status, 401); // 会话已清除
    const relogin = await s.api('POST', '/api/auth/dev-login', { body: { userId: b } });
    assert.equal(relogin.status, 403);
    assert.equal(relogin.body.error.code, 'FORBIDDEN');
  });

  test('不能举报自己；被举报内容不存在时 404', async () => {
    const a = makeUser(s.db);
    const ta = await s.login(a);
    assert.equal((await s.api('POST', '/api/reports', { token: ta, body: { targetType: 'user', targetId: a, reason: '其他' } })).status, 400);
    assert.equal((await s.api('POST', '/api/reports', { token: ta, body: { targetType: 'post', targetId: 999, reason: '其他' } })).status, 404);
  });
});

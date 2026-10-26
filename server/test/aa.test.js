import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { settleTransfers } from '../src/services/aa.js';
import { makeUser, startServer } from './helpers.js';

describe('AA 结算（纯函数）', () => {
  test('欠钱最多的人先还给垫钱最多的人', () => {
    const balances = new Map([
      [1, 9000],
      [2, 0],
      [3, -3000],
      [4, -3000],
      [5, -3000],
    ]);
    assert.deepEqual(settleTransfers(balances), [
      { from: 3, to: 1, cents: 3000 },
      { from: 4, to: 1, cents: 3000 },
      { from: 5, to: 1, cents: 3000 },
    ]);
    const mixed = new Map([
      [1, 5000],
      [2, 2000],
      [3, -6000],
      [4, -1000],
    ]);
    assert.deepEqual(settleTransfers(mixed), [
      { from: 3, to: 1, cents: 5000 },
      { from: 3, to: 2, cents: 1000 },
      { from: 4, to: 2, cents: 1000 },
    ]);
  });
});

describe('AA：一次声明', () => {
  let s;
  let ids;
  let tokens;
  let eventId;
  const notices = (userId) => s.db.all("SELECT * FROM notices WHERE user_id = ? AND type = 'aa_bill' ORDER BY id", userId);

  before(async () => {
    s = await startServer();
    ids = [0, 1, 2, 3, 4].map(() => makeUser(s.db));
    s.db.update('users', ids[1], { nickname: '阿野' });
    tokens = await Promise.all(ids.map((u) => s.login(u)));
    const ev = await s.ok('POST', '/api/events', {
      token: tokens[0],
      body: { title: '苍山看日出', tag: '看日出', startAt: '2026-10-31T06:00:00.000Z', place: '古城南门', capacity: 5, feeType: 'aa', feeEstimate: 30 },
    });
    eventId = ev.id;
    for (const t of tokens.slice(1)) await s.ok('POST', `/api/events/${eventId}/join`, { token: t });
  });
  after(() => s.close());

  test('还没记账：bill 为 null，任何成员都能记；局外人看不到', async () => {
    const aa = await s.ok('GET', `/api/events/${eventId}/aa`, { token: tokens[3] });
    assert.deepEqual(aa, { bill: null, total: 0, each: 0, memberCount: 5, transfers: [], canDeclare: true });
    const outsider = await s.api('GET', `/api/events/${eventId}/aa`, { token: await s.login(makeUser(s.db)) });
    assert.equal(outsider.status, 403);
    const bad = await s.api('POST', `/api/events/${eventId}/aa`, { token: tokens[1], body: { amount: 1.005 } });
    assert.equal(bad.status, 400);
    const zero = await s.api('POST', `/api/events/${eventId}/aa`, { token: tokens[1], body: { amount: 0 } });
    assert.equal(zero.status, 400);
    const ad = await s.api('POST', `/api/events/${eventId}/aa`, { token: tokens[1], body: { amount: 150, note: '加我微信 aye2024 转账' } });
    assert.equal(ad.status, 422);
  });

  test('阿野记 ¥150（车费 + 早餐）：5 人每人 ¥30，其他 4 人各转 ¥30 给阿野，并通知其他成员', async () => {
    const aa = await s.ok('POST', `/api/events/${eventId}/aa`, { token: tokens[1], body: { amount: 150, note: '车费 + 早餐' } });
    assert.equal(aa.bill.payer.id, ids[1]);
    assert.equal(aa.bill.amount, 150);
    assert.equal(aa.bill.note, '车费 + 早餐');
    assert.equal(aa.bill.mine, true);
    assert.equal(aa.bill.editable, true);
    assert.ok(aa.bill.createdAt);
    assert.equal(aa.total, 150);
    assert.equal(aa.each, 30);
    assert.equal(aa.memberCount, 5);
    assert.equal(aa.canDeclare, false);
    assert.deepEqual(
      aa.transfers.map((t) => [t.from.id, t.to.id, t.amount, t.status]),
      [ids[0], ids[2], ids[3], ids[4]].map((id) => [id, ids[1], 30, 'pending']),
    );
    assert.deepEqual(aa.transfers.map((t) => t.role), ['to', 'to', 'to', 'to']); // 阿野看：都是别人转给他
    const mine = await s.ok('GET', `/api/events/${eventId}/aa`, { token: tokens[3] });
    assert.deepEqual(mine.transfers.map((t) => t.role), mine.transfers.map((t) => (t.from.id === ids[3] ? 'from' : null)));
    assert.equal(mine.bill.mine, false);
    assert.equal(mine.bill.editable, false);

    const [n] = notices(ids[0]);
    assert.equal(n.body, '阿野 记了这个局的 AA：共 ¥150（车费 + 早餐），每人 ¥30，转给阿野');
    assert.equal(n.link, `chat:${eventId}`);
    assert.equal(notices(ids[1]).length, 0); // 不通知自己
  });

  test('记了就锁定：别人不能再记第二笔；旧的 /aa/items 已删除', async () => {
    const again = await s.api('POST', `/api/events/${eventId}/aa`, { token: tokens[2], body: { amount: 30, note: '门票' } });
    assert.equal(again.status, 409);
    const old = await s.api('POST', `/api/events/${eventId}/aa/items`, { token: tokens[2], body: { name: '门票', amount: 30 } });
    assert.equal(old.status, 404);
  });

  test('只有记账人能改 / 撤回；改了会重新通知；除不尽保留两位小数', async () => {
    assert.equal((await s.api('PUT', `/api/events/${eventId}/aa`, { token: tokens[2], body: { amount: 160 } })).status, 403);
    assert.equal((await s.api('DELETE', `/api/events/${eventId}/aa`, { token: tokens[2] })).status, 403);
    const aa = await s.ok('PUT', `/api/events/${eventId}/aa`, { token: tokens[1], body: { amount: 100, note: '车费' } });
    assert.equal(aa.total, 100);
    assert.equal(aa.each, 20);
    assert.equal(aa.bill.note, '车费');
    assert.equal(notices(ids[0]).at(-1).body, '阿野 改了这个局的 AA：共 ¥100（车费），每人 ¥20，转给阿野');
    const odd = await s.ok('PUT', `/api/events/${eventId}/aa`, { token: tokens[1], body: { amount: 100.01 } });
    assert.equal(odd.each, 20);
    assert.equal(odd.bill.note, null);
    await s.ok('PUT', `/api/events/${eventId}/aa`, { token: tokens[1], body: { amount: 150, note: '车费 + 早餐' } });
  });

  test('我已转账 → paid；对方确认收到 → confirmed；有人转过以后不能再改 / 撤回', async () => {
    let aa = await s.ok('POST', `/api/events/${eventId}/aa/paid`, { token: tokens[3], body: { toUserId: ids[1] } });
    assert.equal(aa.transfers.find((t) => t.from.id === ids[3]).status, 'paid');
    aa = await s.ok('POST', `/api/events/${eventId}/aa/confirm`, { token: tokens[1], body: { fromUserId: ids[3] } });
    assert.equal(aa.transfers.find((t) => t.from.id === ids[3]).status, 'confirmed');
    assert.equal(aa.bill.editable, false);
    const info = await s.ok('GET', `/api/events/${eventId}/info`, { token: tokens[0] });
    assert.deepEqual(info.aa, { each: 30, openTransfers: 3 });
    const wrong = await s.api('POST', `/api/events/${eventId}/aa/paid`, { token: tokens[3], body: { toUserId: ids[2] } });
    assert.equal(wrong.status, 400);
    assert.equal((await s.api('PUT', `/api/events/${eventId}/aa`, { token: tokens[1], body: { amount: 10 } })).status, 409);
    assert.equal((await s.api('DELETE', `/api/events/${eventId}/aa`, { token: tokens[1] })).status, 409);

    const admin = await s.adminToken();
    const detail = await s.ok('GET', `/api/admin/events/${eventId}`, { token: admin });
    assert.equal(detail.aa.total, 150);
    assert.equal(detail.aa.itemCount, 1);
    assert.equal(detail.aa.bill.payer.id, ids[1]);
    assert.equal(detail.aa.bill.note, '车费 + 早餐');
  });
});

describe('AA：撤回', () => {
  let s;
  after(() => s.close());

  test('还没人转账时记账人可以撤回，撤回后谁都可以重新记；并通知其他成员', async () => {
    s = await startServer();
    const [host, a, b] = [makeUser(s.db), makeUser(s.db), makeUser(s.db)];
    const [th, ta, tb] = await Promise.all([host, a, b].map((u) => s.login(u)));
    const ev = await s.ok('POST', '/api/events', {
      token: th,
      body: { title: '吃饭局', tag: '吃饭', startAt: '2026-10-31T06:00:00.000Z', place: '人民路', capacity: 3, feeType: 'aa' },
    });
    await s.ok('POST', `/api/events/${ev.id}/join`, { token: ta });
    await s.ok('POST', `/api/events/${ev.id}/join`, { token: tb });
    await s.ok('POST', `/api/events/${ev.id}/aa`, { token: ta, body: { amount: 90 } });
    const nick = s.db.get('SELECT nickname FROM users WHERE id = ?', a).nickname;
    assert.equal(
      s.db.get("SELECT body FROM notices WHERE user_id = ? AND type = 'aa_bill'", host).body,
      `${nick} 记了这个局的 AA：共 ¥90，每人 ¥30，转给${nick}`,
    );
    const cleared = await s.ok('DELETE', `/api/events/${ev.id}/aa`, { token: ta });
    assert.equal(cleared.bill, null);
    assert.equal(cleared.canDeclare, true);
    assert.equal(cleared.transfers.length, 0);
    assert.equal(s.db.get("SELECT body FROM notices WHERE user_id = ? AND type = 'aa_bill' ORDER BY id DESC", b).body, `${nick} 撤回了这个局的 AA`);
    const redo = await s.ok('POST', `/api/events/${ev.id}/aa`, { token: tb, body: { amount: 60, note: '晚饭' } });
    assert.equal(redo.bill.payer.id, b);
    assert.equal(redo.each, 20);
    // 局取消后不能再记
    await s.ok('POST', `/api/events/${ev.id}/cancel`, { token: th });
    const view = await s.ok('GET', `/api/events/${ev.id}/aa`, { token: tb });
    assert.equal(view.bill.editable, false);
  });
});

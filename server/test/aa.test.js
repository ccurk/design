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

describe('AA 记账接口', () => {
  let s;
  let ids;
  let tokens;
  let eventId;

  before(async () => {
    s = await startServer();
    ids = [0, 1, 2, 3, 4].map(() => makeUser(s.db));
    tokens = await Promise.all(ids.map((u) => s.login(u)));
    const ev = await s.ok('POST', '/api/events', {
      token: tokens[0],
      body: { title: '苍山看日出', category: 'outdoor', startAt: '2026-10-31T06:00:00.000Z', place: '古城南门', capacity: 5, feeType: 'aa', feeEstimate: 30 },
    });
    eventId = ev.id;
    for (const t of tokens.slice(1)) await s.ok('POST', `/api/events/${eventId}/join`, { token: t });
  });
  after(() => s.close());

  test('拼车 120 + 早餐 30，5 人平摊：每人 30，三个人各转 30 给垫车费的人', async () => {
    await s.ok('POST', `/api/events/${eventId}/aa/items`, { token: tokens[1], body: { name: '拼车车费', amount: 120 } });
    const aa = await s.ok('POST', `/api/events/${eventId}/aa/items`, { token: tokens[2], body: { name: '早餐', amount: 30 } });
    assert.equal(aa.total, 150);
    assert.equal(aa.each, 30);
    assert.equal(aa.memberCount, 5);
    assert.equal(aa.items.length, 2);
    assert.equal(aa.items[1].mine, true);
    assert.deepEqual(
      aa.transfers.map((t) => [t.from.id, t.to.id, t.amount, t.status]),
      [
        [ids[0], ids[1], 30, 'pending'],
        [ids[3], ids[1], 30, 'pending'],
        [ids[4], ids[1], 30, 'pending'],
      ],
    );
    const mine = await s.ok('GET', `/api/events/${eventId}/aa`, { token: tokens[3] });
    assert.deepEqual(mine.transfers.map((t) => t.role), [null, 'from', null]);
  });

  test('我已转账 → paid；对方确认收到 → confirmed', async () => {
    let aa = await s.ok('POST', `/api/events/${eventId}/aa/paid`, { token: tokens[3], body: { toUserId: ids[1] } });
    assert.equal(aa.transfers.find((t) => t.from.id === ids[3]).status, 'paid');
    aa = await s.ok('POST', `/api/events/${eventId}/aa/confirm`, { token: tokens[1], body: { fromUserId: ids[3] } });
    assert.equal(aa.transfers.find((t) => t.from.id === ids[3]).status, 'confirmed');
    const info = await s.ok('GET', `/api/events/${eventId}/info`, { token: tokens[0] });
    assert.deepEqual(info.aa, { each: 30, openTransfers: 2 });
    const wrong = await s.api('POST', `/api/events/${eventId}/aa/paid`, { token: tokens[3], body: { toUserId: ids[2] } });
    assert.equal(wrong.status, 400);
  });

  test('除不尽时保留两位小数；只能删自己记的账', async () => {
    const aa = await s.ok('POST', `/api/events/${eventId}/aa/items`, { token: tokens[0], body: { name: '门票', amount: 10 } });
    assert.equal(aa.total, 160);
    assert.equal(aa.each, 32);
    const item = aa.items.find((i) => i.name === '门票');
    assert.equal((await s.api('DELETE', `/api/events/${eventId}/aa/items/${item.id}`, { token: tokens[1] })).status, 403);
    await s.ok('DELETE', `/api/events/${eventId}/aa/items/${item.id}`, { token: tokens[0] });
    const odd = await s.ok('POST', `/api/events/${eventId}/aa/items`, { token: tokens[0], body: { name: '水', amount: 10.01 } });
    assert.equal(odd.each, 32);
    assert.equal(odd.total, 160.01);
    const bad = await s.api('POST', `/api/events/${eventId}/aa/items`, { token: tokens[0], body: { name: '水', amount: 1.005 } });
    assert.equal(bad.status, 400);
    const outsider = await s.api('GET', `/api/events/${eventId}/aa`, { token: await s.login(makeUser(s.db)) });
    assert.equal(outsider.status, 403);
  });
});

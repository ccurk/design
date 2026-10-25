import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { clock } from '../src/clock.js';
import { addCreditEvent, computeCredit, creditOf } from '../src/services/credit.js';
import { addCredit, makeUser, startServer } from './helpers.js';

describe('信用计算（纯函数）', () => {
  test('没有任何记录时履约率 100、等级良好', () => {
    assert.deepEqual(computeCredit({}), {
      rate: 100,
      level: 'good',
      attended: 0,
      late: 0,
      cancelLate: 0,
      noShow: 0,
      eventsCount: 0,
    });
  });

  test('履约率 = (attended + late) / (attended + late + cancel_late + no_show)，取整', () => {
    assert.equal(computeCredit({ attended: 44, cancelLate: 1 }).rate, 98);
    assert.equal(computeCredit({ attended: 23, late: 1, noShow: 1 }).rate, 96);
    assert.equal(computeCredit({ attended: 1, late: 1, cancelLate: 1 }).rate, 67);
    assert.equal(computeCredit({ attended: 3, late: 2 }).eventsCount, 5);
  });

  test('等级：<90 或一个月内有放鸽子为一般；受限账号或一个月内放鸽子 ≥2 为受限', () => {
    assert.equal(computeCredit({ attended: 9, cancelLate: 1 }).level, 'good'); // 90
    assert.equal(computeCredit({ attended: 8, cancelLate: 1 }).level, 'fair'); // 89
    assert.equal(computeCredit({ attended: 30, noShow: 1, recentNoShow: 1 }).level, 'fair');
    assert.equal(computeCredit({ attended: 30, noShow: 1, recentNoShow: 0 }).level, 'good');
    assert.equal(computeCredit({ attended: 30, noShow: 2, recentNoShow: 2 }).level, 'restricted');
    assert.equal(computeCredit({ attended: 30, status: 'restricted' }).level, 'restricted');
  });
});

describe('信用（数据库）', () => {
  let s;
  before(async () => {
    s = await startServer();
  });
  after(() => s.close());

  test('撤销的记录不计入；超过一个月的放鸽子只影响履约率', () => {
    const id = makeUser(s.db);
    addCredit(s.db, id, 'attended', 9);
    addCredit(s.db, id, 'no_show', 1, { daysAgo: 45 });
    const user = s.db.get('SELECT * FROM users WHERE id = ?', id);
    let credit = creditOf(s.db, user);
    assert.equal(credit.rate, 90);
    assert.equal(credit.level, 'good');

    const ce = s.db.get("SELECT id FROM credit_events WHERE user_id = ? AND type = 'no_show'", id);
    s.db.update('credit_events', ce.id, { revoked: 1 });
    credit = creditOf(s.db, user);
    assert.equal(credit.rate, 100);
    assert.equal(credit.noShow, 0);
  });

  test('一个月内第 2 次放鸽子 → 自动受限 7 天，并发通知；7 天后自动恢复', async () => {
    const id = makeUser(s.db);
    addCredit(s.db, id, 'attended', 5);
    addCredit(s.db, id, 'no_show', 1, { daysAgo: 10 });
    addCreditEvent(s.db, { userId: id, type: 'no_show', source: 'review', note: 'test' });
    const user = s.db.get('SELECT * FROM users WHERE id = ?', id);
    assert.equal(user.status, 'restricted');
    const days = (Date.parse(user.restricted_until) - clock.now().getTime()) / 86400000;
    assert.equal(Math.round(days), 7);
    assert.equal(creditOf(s.db, user).level, 'restricted');
    assert.ok(s.db.get("SELECT 1 FROM notices WHERE user_id = ? AND type = 'restricted'", id));

    // 受限期间不能撮合
    const token = await s.login(id);
    const res = await s.api('POST', '/api/intents', { token, body: { task: '看日出', when: 'tomorrow' } });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'RESTRICTED');

    // 7 天后：受限状态自动失效（视为 active）
    clock.advance(7 * 86400000 + 60000);
    const me = await s.ok('GET', '/api/me', { token });
    assert.equal(me.status, 'active');
  });

  test('信用记录列表与申诉：后台通过后记录撤销、履约率回升', async () => {
    const id = makeUser(s.db);
    addCredit(s.db, id, 'attended', 3);
    addCredit(s.db, id, 'cancel_late', 1, { daysAgo: 3, source: 'system' });
    const token = await s.login(id);
    const list = await s.ok('GET', '/api/me/credit-events', { token });
    const bad = list.items.find((x) => x.type === 'cancel_late');
    assert.equal(bad.typeLabel, '临时鸽');
    assert.equal((await s.ok('GET', '/api/me', { token })).credit.rate, 75);

    const appeal = await s.ok('POST', `/api/credit-events/${bad.id}/appeal`, {
      token,
      body: { text: '那天客栈停电手机没电了，提前跟发起人说过' },
    });
    assert.equal(appeal.status, 'pending');
    const dup = await s.api('POST', `/api/credit-events/${bad.id}/appeal`, { token, body: { text: '再申诉一次试试看' } });
    assert.equal(dup.status, 409);

    const admin = await s.adminToken();
    const appeals = await s.ok('GET', '/api/admin/appeals', { token: admin });
    assert.ok(appeals.items.some((a) => a.id === appeal.id));
    await s.ok('POST', `/api/admin/appeals/${appeal.id}/resolve`, { token: admin, body: { approve: true } });
    assert.equal((await s.ok('GET', '/api/me', { token })).credit.rate, 100);
  });

  test('后台手动加记录 / 撤销记录', async () => {
    const id = makeUser(s.db);
    const admin = await s.adminToken();
    let r = await s.ok('POST', `/api/admin/users/${id}/credit`, { token: admin, body: { type: 'late', note: '人工补录' } });
    assert.equal(r.credit.late, 1);
    const ce = r.creditEvents[0];
    assert.equal(ce.source, 'admin');
    r = await s.ok('POST', `/api/admin/users/${id}/credit`, { token: admin, body: { revokeId: ce.id } });
    assert.equal(r.credit.late, 0);
  });
});

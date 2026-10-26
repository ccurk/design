import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { clock } from '../src/clock.js';
import { ADMIN_PASSWORD, makeIntent, makeUser, startServer } from './helpers.js';

describe('鉴权', () => {
  let s;
  before(async () => {
    s = await startServer();
  });
  after(() => s.close());

  test('后台密码错误 → 401；正确 → token', async () => {
    const bad = await s.api('POST', '/api/admin/login', { body: { password: 'nope' } });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error.code, 'UNAUTHORIZED');
    const good = await s.ok('POST', '/api/admin/login', { body: { password: ADMIN_PASSWORD } });
    assert.match(good.token, /^a_/);
  });

  test('用户 token 不能调后台接口，后台 token 不能调用户接口', async () => {
    const userToken = await s.login(makeUser(s.db));
    const adminToken = await s.adminToken();
    for (const url of ['/api/admin/stats', '/api/admin/proposals', '/api/admin/users']) {
      const r = await s.api('GET', url, { token: userToken });
      assert.equal(r.status, 401, url);
    }
    const r = await s.api('GET', '/api/me', { token: adminToken });
    assert.equal(r.status, 401);
    assert.equal((await s.api('GET', '/api/admin/stats')).status, 401);
    assert.equal((await s.api('GET', '/api/me')).status, 401);
    assert.equal((await s.api('GET', '/api/admin/stats', { token: adminToken })).status, 200);
  });

  test('开发模式登录：code → openid = dev_<code>；同一个 code 再登录不是新用户', async () => {
    const first = await s.ok('POST', '/api/auth/login', { body: { code: 'abc' } });
    assert.equal(first.isNew, true);
    assert.equal(first.user.onboarded, false);
    assert.equal(s.db.get('SELECT openid FROM users WHERE id = ?', first.user.id).openid, 'dev_abc');
    const second = await s.ok('POST', '/api/auth/login', { body: { code: 'abc' } });
    assert.equal(second.isNew, false);
    assert.equal(second.user.id, first.user.id);
    const phone = await s.ok('POST', '/api/auth/phone', { token: second.token, body: { code: 'xyz' } });
    assert.equal(phone.phoneVerified, true);
    assert.match(phone.phoneMasked, /^138\*{4}\d{4}$/);
    assert.equal((await s.api('POST', '/api/auth/login', { body: {} })).status, 400);
  });

  test('错误格式统一：{ error: { code, message } }', async () => {
    const r = await s.api('GET', '/api/events/abc');
    assert.equal(r.status, 404);
    assert.deepEqual(Object.keys(r.body.error).sort(), ['code', 'message']);
    const bad = await fetch(`${s.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'VALIDATION');
  });

  test('CORS 预检', async () => {
    const r = await fetch(`${s.base}/api/me`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-headers': 'authorization,content-type' },
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  });
});

describe('后台管理', () => {
  let s;
  let admin;
  before(async () => {
    s = await startServer();
    admin = await s.adminToken();
  });
  after(() => s.close());

  test('数据概览', async () => {
    const stats = await s.ok('GET', '/api/admin/stats', { token: admin });
    assert.deepEqual(Object.keys(stats.today).sort(), [
      'formed',
      'newIntents',
      'newUsers',
      'pendingEvents',
      'pendingPosts',
      'pendingProposals',
      'pendingReports',
    ]);
    assert.equal(stats.series.length, 7);
    assert.equal(stats.series[6].date, '2026-10-26');
    assert.equal(typeof stats.week.attendanceRate, 'number');
  });

  test('设置：自动成局默认关闭、阈值 90，可修改', async () => {
    assert.deepEqual(await s.ok('GET', '/api/admin/settings', { token: admin }), { autoConfirm: { enabled: false, threshold: 90 } });
    const updated = await s.ok('PUT', '/api/admin/settings', { token: admin, body: { autoConfirm: { enabled: true, threshold: 85 } } });
    assert.deepEqual(updated, { autoConfirm: { enabled: true, threshold: 85 } });
    await s.ok('PUT', '/api/admin/settings', { token: admin, body: { autoConfirm: { enabled: false } } });
  });

  test('撮合池与立即撮合', async () => {
    const users = [1, 2, 3].map(() => makeUser(s.db));
    users.forEach((u) => makeIntent(s.db, u, { task: '桌游', slot: 'evening' }));
    const pool = await s.ok('GET', '/api/admin/intents?status=open', { token: admin });
    assert.equal(pool.items.length, 3);
    assert.equal(pool.items[0].title, '周六晚上 · 桌游');
    assert.equal(pool.items[0].timeLabel, '晚上');
    assert.equal(pool.items[0].timeFrom, null);
    assert.equal(pool.items[0].waitingHours, 0);
    const run = await s.ok('POST', '/api/admin/match/run', { token: admin });
    assert.equal(run.created, 1);
    const { items } = await s.ok('GET', '/api/admin/proposals', { token: admin });
    assert.equal(items[0].slotLabel, '晚上');
    assert.equal(items[0].members.length, 3);
  });

  test('用户列表 / 详情 / 限制 / 封禁 / 解封', async () => {
    const u = makeUser(s.db, { nickname: '测试用户甲', phone: '13912345678' });
    let list = await s.ok('GET', '/api/admin/users?q=测试用户甲', { token: admin });
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].phoneMasked, '139****5678');
    await s.ok('POST', `/api/admin/users/${u}/restrict`, { token: admin, body: { days: 3, reason: '多次迟到' } });
    list = await s.ok('GET', '/api/admin/users?status=restricted', { token: admin });
    assert.ok(list.items.some((x) => x.id === u));
    await s.ok('POST', `/api/admin/users/${u}/unban`, { token: admin });
    await s.ok('POST', `/api/admin/users/${u}/ban`, { token: admin, body: { reason: '广告' } });
    const detail = await s.ok('GET', `/api/admin/users/${u}`, { token: admin });
    assert.equal(detail.user.status, 'banned');
    assert.ok(Array.isArray(detail.creditEvents));
    assert.ok(Array.isArray(detail.reportsAgainst));
    assert.ok(Array.isArray(detail.events));
  });
});

describe('后台登录防暴力猜密码', () => {
  let s;
  before(async () => {
    s = await startServer();
  });
  after(() => s.close());

  test('同一 IP 输错 10 次后锁 15 分钟，到点自动解锁', async () => {
    for (let i = 0; i < 10; i++) {
      const bad = await s.api('POST', '/api/admin/login', { body: { password: `wrong-${i}` } });
      assert.equal(bad.status, 401);
    }
    const locked = await s.api('POST', '/api/admin/login', { body: { password: ADMIN_PASSWORD } });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error.code, 'TOO_MANY_REQUESTS');
    assert.match(locked.body.error.message, /15 分钟后再试/);

    clock.advance(15 * 60 * 1000 + 1000);
    const good = await s.ok('POST', '/api/admin/login', { body: { password: ADMIN_PASSWORD } });
    assert.match(good.token, /^a_/);
  });

  test('登录成功会清掉输错次数', async () => {
    for (let i = 0; i < 9; i++) await s.api('POST', '/api/admin/login', { body: { password: 'nope' } });
    await s.ok('POST', '/api/admin/login', { body: { password: ADMIN_PASSWORD } });
    for (let i = 0; i < 9; i++) await s.api('POST', '/api/admin/login', { body: { password: 'nope' } });
    assert.equal((await s.api('POST', '/api/admin/login', { body: { password: ADMIN_PASSWORD } })).status, 200);
  });

  test('所有响应都带 X-Content-Type-Options: nosniff', async () => {
    const res = await fetch(`${s.base}/api/health`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});

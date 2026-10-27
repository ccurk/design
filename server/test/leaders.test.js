import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { makeUser, startServer } from './helpers.js';

let s;
let admin;

const fullApp = (over = {}) => ({
  realName: '张三',
  specialties: ['骑行'],
  intro: '我在大理带骑行三年，路线熟，想成为官方带队',
  emergencyName: '李四',
  emergencyPhone: '13800000000',
  images: ['/uploads/cert.png'],
  agree: true,
  ...over,
});

describe('官方带队申请', () => {
  beforeEach(async () => {
    s = await startServer();
    admin = await s.adminToken();
  });
  afterEach(() => s.close());

  test('没完成手机号认证不能申请', async () => {
    const token = await s.login(makeUser(s.db)); // 默认未认证
    const r = await s.api('POST', '/api/leader-application', { token, body: { intro: '我常在大理带骑行，想做官方带队', images: [] } });
    assert.equal(r.status, 403);
  });

  test('认证后可申请 → pending；重复申请冲突；GET 返回状态', async () => {
    const token = await s.login(makeUser(s.db, { phone_verified: 1 }));
    const res = await s.ok('POST', '/api/leader-application', { token, body: fullApp() });
    assert.equal(res.isLeader, false);
    assert.equal(res.application.status, 'pending');
    assert.equal((await s.api('POST', '/api/leader-application', { token, body: fullApp({ intro: '再申请一次看看行不行呢，这段话够长了' }) })).status, 409);
    const mine = await s.ok('GET', '/api/leader-application', { token });
    assert.equal(mine.application.status, 'pending');
    assert.equal(mine.isLeader, false);
  });

  test('后台通过 → 成为官方带队 + 通知 + 资料带 isLeader', async () => {
    const uid = makeUser(s.db, { phone_verified: 1 });
    const token = await s.login(uid);
    await s.ok('POST', '/api/leader-application', { token, body: fullApp({ specialties: ['桌游'], intro: '我在大理组织桌游夜很久了，想做官方带队' }) });
    const { items } = await s.ok('GET', '/api/admin/leader-applications?status=pending', { token: admin });
    assert.equal(items.length, 1);
    assert.ok(items[0].user && items[0].user.nickname);
    await s.ok('POST', `/api/admin/leader-applications/${items[0].id}/review`, { token: admin, body: { approve: true } });

    assert.equal((await s.ok('GET', '/api/me', { token })).isLeader, true);
    const mine = await s.ok('GET', '/api/leader-application', { token });
    assert.equal(mine.isLeader, true);
    assert.equal(mine.application.status, 'approved');
    assert.ok(s.db.get("SELECT 1 FROM notices WHERE user_id = ? AND type = 'leader_result'", uid));
    // 别人主页也能看到带队徽标
    const other = await s.login(makeUser(s.db));
    assert.equal((await s.ok('GET', `/api/users/${uid}`, { token: other })).user.isLeader, true);
    // 已是带队再申请 → 冲突
    assert.equal((await s.api('POST', '/api/leader-application', { token, body: fullApp({ intro: '我已经是带队了还能再报吗，测一下这段' }) })).status, 409);
  });

  test('后台驳回 → 不是带队 + 带说明通知', async () => {
    const token = await s.login(makeUser(s.db, { phone_verified: 1 }));
    await s.ok('POST', '/api/leader-application', { token, body: fullApp({ intro: '随便写点东西看看能不能过审核这段够长' }) });
    const { items } = await s.ok('GET', '/api/admin/leader-applications', { token: admin });
    await s.ok('POST', `/api/admin/leader-applications/${items[0].id}/review`, { token: admin, body: { approve: false, note: '资料不足' } });
    assert.equal((await s.ok('GET', '/api/me', { token })).isLeader, false);
    const mine = await s.ok('GET', '/api/leader-application', { token });
    assert.equal(mine.application.status, 'rejected');
    assert.equal(mine.application.note, '资料不足');
  });

  test('结构化认证：缺擅长方向 / 没传材料 / 没勾承诺都会被拦，补齐才过', async () => {
    const token = await s.login(makeUser(s.db, { phone_verified: 1 }));
    assert.equal((await s.api('POST', '/api/leader-application', { token, body: fullApp({ specialties: [] }) })).status, 400);
    assert.equal((await s.api('POST', '/api/leader-application', { token, body: fullApp({ images: [] }) })).status, 400);
    assert.equal((await s.api('POST', '/api/leader-application', { token, body: fullApp({ agree: false }) })).status, 400);
    const ok = await s.ok('POST', '/api/leader-application', { token, body: fullApp() });
    assert.equal(ok.application.status, 'pending');
    assert.deepEqual(ok.application.specialties, ['骑行']);
    assert.equal(ok.application.realName, '张三');
    assert.equal(ok.application.emergencyName, '李四');
  });
});

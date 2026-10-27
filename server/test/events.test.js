import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { clock } from '../src/clock.js';
import { makeUser, startServer } from './helpers.js';

let s;

/** 周六 10-31 北京时间 14:00 = 06:00Z */
const SAT_2PM = '2026-10-31T06:00:00.000Z';

async function hostEvent(token, overrides = {}) {
  return s.ok('POST', '/api/events', {
    token,
    body: {
      title: '安静读书局 · 不用聊天',
      category: 'coffee',
      startAt: SAT_2PM,
      place: '人民路咖啡馆',
      capacity: 3,
      feeType: 'split',
      requireApproval: false,
      sameSexOnly: false,
      ...overrides,
    },
  });
}

describe('用户发起的局', () => {
  beforeEach(async () => {
    s = await startServer();
  });
  afterEach(() => s.close());

  test('发起 → open，进广场；满员自动 formed；有人退出回到 open', async () => {
    const [host, a, b] = [makeUser(s.db), makeUser(s.db), makeUser(s.db)];
    const [th, ta, tb] = await Promise.all([host, a, b].map((u) => s.login(u)));
    const ev = await hostEvent(th);
    assert.equal(ev.status, 'open');
    assert.equal(ev.source, 'user');
    assert.equal(ev.task, '读书');
    assert.equal(ev.dateLabel, '周六 14:00');
    assert.equal(ev.feeLabel, '各付各');
    assert.equal(ev.memberCount, 1);
    assert.equal(ev.host.id, host);
    assert.equal(ev.chatOpen, false);
    assert.equal(ev.myStatus, 'joined');

    const square = await s.ok('GET', '/api/events?category=coffee');
    assert.deepEqual(square.items.map((e) => e.id), [ev.id]);
    assert.equal(square.nextCursor, null);
    assert.equal((await s.ok('GET', '/api/search?q=咖啡馆')).items.length, 1);
    assert.equal((await s.ok('GET', '/api/search?q=双廊')).items.length, 0);

    const detail = await s.ok('GET', `/api/events/${ev.id}`, { token: ta });
    assert.equal(detail.canJoin, true);
    let r = await s.ok('POST', `/api/events/${ev.id}/join`, { token: ta });
    assert.deepEqual(r, {
      myStatus: 'joined',
      eventStatus: 'open',
      formed: false,
      remaining: 1,
      memberCount: 2,
      capacity: 3,
      exitDeadline: '2026-10-30T06:00:00.000Z', // 默认开场前 24 小时
    });
    assert.equal((await s.ok('GET', `/api/events/${ev.id}`, { token: ta })).chatOpen, false); // 群聊只在成群后开启
    r = await s.ok('POST', `/api/events/${ev.id}/join`, { token: tb });
    assert.equal(r.eventStatus, 'formed');
    assert.equal(r.formed, true);
    assert.equal(r.remaining, 0);
    assert.equal((await s.ok('GET', `/api/events/${ev.id}`, { token: ta })).chatOpen, true);
    const msgs = await s.ok('GET', `/api/events/${ev.id}/messages`, { token: th });
    assert.ok(msgs.items.some((m) => m.text === '满员啦，群已自动建好 · 第一次见面，慢慢来'));

    // 满员后不在广场（只展示 open）
    assert.equal((await s.ok('GET', '/api/events')).items.length, 0);
    const full = await s.api('POST', `/api/events/${ev.id}/join`, { token: await s.login(makeUser(s.db)) });
    assert.equal(full.status, 409);

    r = await s.ok('POST', `/api/events/${ev.id}/leave`, { token: tb });
    assert.deepEqual(r, { penalty: null }); // 提前 5 天退出，不扣分
    assert.equal(s.db.get('SELECT status FROM events WHERE id = ?', ev.id).status, 'open');
  });

  test('开场前 24 小时内退出 → 临时鸽（cancel_late）；24 小时以上 → 不记录', async () => {
    const [host, a, b] = [makeUser(s.db), makeUser(s.db), makeUser(s.db)];
    const [th, ta, tb] = await Promise.all([host, a, b].map((u) => s.login(u)));
    // 最晚退出时间设成开场前 2 小时，开场前 24 小时内还能退（但要记临时鸽）
    const ev = await hostEvent(th, { capacity: 5, exitDeadline: '2026-10-31T04:00:00.000Z' });
    await s.ok('POST', `/api/events/${ev.id}/join`, { token: ta });
    await s.ok('POST', `/api/events/${ev.id}/join`, { token: tb });

    clock.set('2026-10-30T05:00:00.000Z'); // 开场前 25 小时
    let r = await s.ok('POST', `/api/events/${ev.id}/leave`, { token: ta });
    assert.equal(r.penalty, null);
    assert.equal(s.db.get('SELECT COUNT(*) AS n FROM credit_events WHERE user_id = ?', a).n, 0);

    clock.set('2026-10-30T07:00:00.000Z'); // 开场前 23 小时
    r = await s.ok('POST', `/api/events/${ev.id}/attendance`, { token: tb, body: { going: false } });
    assert.deepEqual(r, { attendance: 'no', penalty: 'cancel_late' });
    const ce = s.db.get('SELECT * FROM credit_events WHERE user_id = ?', b);
    assert.equal(ce.type, 'cancel_late');
    assert.equal(ce.event_id, ev.id);
    assert.equal(ce.source, 'system');
    const me = await s.ok('GET', '/api/me', { token: tb });
    assert.equal(me.credit.cancelLate, 1);
    assert.equal(me.credit.rate, 0);

    // 发起人不能直接退出，只能取消
    const hostLeave = await s.api('POST', `/api/events/${ev.id}/leave`, { token: th });
    assert.equal(hostLeave.status, 400);
  });

  test('轻确认「去」、到场打卡、报平安', async () => {
    const [host, a] = [makeUser(s.db), makeUser(s.db)];
    const [th, ta] = await Promise.all([host, a].map((u) => s.login(u)));
    const ev = await hostEvent(th);
    await s.ok('POST', `/api/events/${ev.id}/join`, { token: ta });
    assert.deepEqual(await s.ok('POST', `/api/events/${ev.id}/attendance`, { token: ta, body: { going: true } }), {
      attendance: 'yes',
      penalty: null,
    });
    const early = await s.api('POST', `/api/events/${ev.id}/arrive`, { token: ta });
    assert.equal(early.status, 400);
    clock.set('2026-10-31T05:55:00.000Z');
    const { arrivedAt } = await s.ok('POST', `/api/events/${ev.id}/arrive`, { token: ta });
    assert.equal(arrivedAt, '2026-10-31T05:55:00.000Z');
    assert.equal((await s.ok('GET', `/api/events/${ev.id}`, { token: ta })).myArrivedAt, arrivedAt);
    clock.set('2026-10-31T08:30:00.000Z');
    const safe = await s.ok('POST', `/api/events/${ev.id}/safe`, { token: ta });
    assert.equal(safe.ok, true);
  });

  test('需要发起人同意的局：报名 → applied → 同意后 joined', async () => {
    const [host, a, b] = [makeUser(s.db), makeUser(s.db), makeUser(s.db)];
    const [th, ta, tb] = await Promise.all([host, a, b].map((u) => s.login(u)));
    const ev = await hostEvent(th, { requireApproval: true, capacity: 4 });
    const applied = await s.ok('POST', `/api/events/${ev.id}/join`, { token: ta });
    assert.equal(applied.myStatus, 'applied');
    assert.equal(applied.eventStatus, 'open');
    assert.equal(applied.memberCount, 1);
    assert.equal(applied.remaining, 3);
    await s.ok('POST', `/api/events/${ev.id}/join`, { token: tb });
    assert.equal((await s.api('GET', `/api/events/${ev.id}/applications`, { token: ta })).status, 403);
    const apps = await s.ok('GET', `/api/events/${ev.id}/applications`, { token: th });
    assert.deepEqual(apps.items.map((x) => x.user.id), [a, b]);
    await s.ok('POST', `/api/events/${ev.id}/applications/${a}/approve`, { token: th });
    await s.ok('POST', `/api/events/${ev.id}/applications/${b}/reject`, { token: th });
    assert.equal((await s.ok('GET', `/api/events/${ev.id}`, { token: ta })).myStatus, 'joined');
    assert.equal((await s.ok('GET', `/api/events/${ev.id}`, { token: tb })).myStatus, 'declined');
    const inbox = await s.ok('GET', '/api/inbox', { token: ta });
    assert.ok(inbox.notices.some((n) => n.type === 'application_result' && n.title === '申请通过啦'));
  });

  test('拉黑：看不到对方发起 / 参加的局，也不能报名', async () => {
    const [host, me, other] = [makeUser(s.db), makeUser(s.db), makeUser(s.db)];
    const [th, tm, to] = await Promise.all([host, me, other].map((u) => s.login(u)));
    const ev = await hostEvent(th);
    await s.ok('POST', `/api/blocks/${host}`, { token: tm });
    assert.equal((await s.ok('GET', '/api/events', { token: tm })).items.length, 0);
    assert.equal((await s.ok('GET', '/api/search?q=读书', { token: tm })).items.length, 0);
    assert.equal((await s.api('GET', `/api/events/${ev.id}`, { token: tm })).status, 404);
    assert.equal((await s.api('POST', `/api/events/${ev.id}/join`, { token: tm })).status, 404);
    assert.equal((await s.ok('GET', '/api/events', { token: to })).items.length, 1);
    await s.ok('DELETE', `/api/blocks/${host}`, { token: tm });
    assert.equal((await s.ok('GET', '/api/events', { token: tm })).items.length, 1);
  });

  test('同性局：只有同性别的人能看到和报名', async () => {
    const host = makeUser(s.db, { gender: 'female' });
    const male = makeUser(s.db, { gender: 'male' });
    const female = makeUser(s.db, { gender: 'female' });
    const ev = await hostEvent(await s.login(host), { sameSexOnly: true });
    assert.equal((await s.ok('GET', '/api/events', { token: await s.login(male) })).items.length, 0);
    assert.equal((await s.ok('GET', '/api/events', { token: await s.login(female) })).items.length, 1);
    assert.equal((await s.ok('GET', '/api/events')).items.length, 0); // 未登录看不到同性局
    const r = await s.api('POST', `/api/events/${ev.id}/join`, { token: await s.login(male) });
    assert.equal(r.status, 404);
  });

  test('开了「只参加同性局」的人仍能在广场看到并加入混合局（该设置只约束撮合，不过滤浏览）', async () => {
    const ev = await hostEvent(await s.login(makeUser(s.db))); // 默认 any 混合局
    const viewer = await s.login(makeUser(s.db, { gender: 'female', settings: { sameSexOnly: true } }));
    const square = await s.ok('GET', '/api/events', { token: viewer });
    assert.ok(square.items.some((e) => e.id === ev.id), '开了「只参加同性局」也应看到混合局');
    await s.ok('POST', `/api/events/${ev.id}/join`, { token: viewer }); // 看得到也加得进，前后一致
  });

  test('内容审核不过 → pending_review，只有发起人看得到；后台通过后进广场', async () => {
    const host = makeUser(s.db);
    const th = await s.login(host);
    const ev = await hostEvent(th, { description: '想来的加我微信 lizi2024 拉群' });
    assert.equal(ev.status, 'pending_review');
    assert.equal((await s.ok('GET', '/api/events')).items.length, 0);
    assert.equal((await s.api('GET', `/api/events/${ev.id}`, { token: await s.login(makeUser(s.db)) })).status, 404);
    const created = await s.ok('GET', '/api/events/mine?tab=created', { token: th });
    assert.equal(created.items[0].status, 'pending_review');

    const admin = await s.adminToken();
    const list = await s.ok('GET', '/api/admin/events?status=pending_review', { token: admin });
    assert.deepEqual(list.items[0].flags, ['包含微信 / QQ 等联系方式']);
    await s.ok('POST', `/api/admin/events/${ev.id}/approve`, { token: admin });
    assert.equal((await s.ok('GET', '/api/events')).items.length, 1);
  });

  test('发起人取消 / 后台取消都会通知成员', async () => {
    const [host, a] = [makeUser(s.db), makeUser(s.db)];
    const [th, ta] = await Promise.all([host, a].map((u) => s.login(u)));
    const ev = await hostEvent(th);
    await s.ok('POST', `/api/events/${ev.id}/join`, { token: ta });
    assert.equal((await s.api('POST', `/api/events/${ev.id}/cancel`, { token: ta })).status, 403);
    await s.ok('POST', `/api/events/${ev.id}/cancel`, { token: th });
    const inbox = await s.ok('GET', '/api/inbox', { token: ta });
    assert.ok(inbox.notices.some((n) => n.type === 'event_cancelled'));

    const ev2 = await hostEvent(th);
    const admin = await s.adminToken();
    await s.ok('POST', `/api/admin/events/${ev2.id}/cancel`, { token: admin, body: { reason: '场地临时关闭' } });
    const hostInbox = await s.ok('GET', '/api/inbox', { token: th });
    assert.ok(hostInbox.notices.some((n) => n.body.includes('场地临时关闭')));
  });

  test('平台局（后台发起）出现在广场，没有发起人', async () => {
    const admin = await s.adminToken();
    const { eventId } = await s.ok('POST', '/api/admin/events', {
      token: admin,
      body: { title: '洱海边日落 · 平台局', category: 'outdoor', task: '随便走走', startAt: SAT_2PM, place: '龙龛码头', capacity: 8, feeType: 'free' },
    });
    const square = await s.ok('GET', '/api/events');
    const card = square.items.find((e) => e.id === eventId);
    assert.equal(card.source, 'platform');
    assert.equal(card.feeLabel, '免费');
    const detail = await s.ok('GET', `/api/events/${eventId}`);
    assert.equal(detail.host, null);
    assert.equal(detail.canJoin, false); // 未登录
  });

  test('广场分页与参数校验', async () => {
    const th = await s.login(makeUser(s.db));
    for (let i = 0; i < 3; i++) {
      // 同一个发起人的局时间不能重叠：每个 1 小时，前后接上
      await hostEvent(th, { title: `读书局 ${i + 1}`, startAt: new Date(Date.parse(SAT_2PM) + i * 3600000).toISOString(), durationMin: 60 });
    }
    const p1 = await s.ok('GET', '/api/events?limit=2');
    assert.deepEqual(p1.items.map((e) => e.title), ['读书局 1', '读书局 2']);
    assert.equal(p1.nextCursor, 2);
    const p2 = await s.ok('GET', `/api/events?limit=2&cursor=${p1.nextCursor}`);
    assert.deepEqual(p2.items.map((e) => e.title), ['读书局 3']);
    assert.equal(p2.nextCursor, null);
    const bad = await s.api('POST', '/api/events', { token: th, body: { title: 'x' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'VALIDATION');
    assert.match(bad.body.error.message, /标题/);
  });
});

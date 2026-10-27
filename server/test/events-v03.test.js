// v0.3 的局：谁可以报名、图片、地点、最晚退出时间、成群规则、群聊只在成群后开启。
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { clock } from '../src/clock.js';
import { runMinuteJobs } from '../src/jobs.js';
import { runMatching } from '../src/services/matching.js';
import { addCredit, makeIntent, makeUser, startServer } from './helpers.js';

let s;
const SAT_2PM = '2026-10-31T06:00:00.000Z'; // 北京时间周六 14:00
const BASE = 'http://localhost:3000'; // 测试配置下的 PUBLIC_BASE_URL

beforeEach(async () => {
  s = await startServer(); // 北京时间 2026-10-26（周一）10:00
});
afterEach(() => s.close());

const body = (overrides) => ({ title: '洱海边散步', tag: '随便走走', startAt: SAT_2PM, place: '才村码头', capacity: 4, feeType: 'free', ...overrides });
const create = (token, overrides = {}) => s.api('POST', '/api/events', { token, body: body(overrides) });
const createOk = async (token, overrides = {}) => s.ok('POST', '/api/events', { token, body: body(overrides) });
const notices = (userId, type) => s.db.all('SELECT * FROM notices WHERE user_id = ? AND type = ? ORDER BY id', userId, type);
const messages = (eventId) => s.db.all('SELECT * FROM messages WHERE event_id = ? ORDER BY id', eventId);

describe('谁可以报名 genderLimit', () => {
  test('用户发起：限制必须包含发起人自己；没填性别 → 先去选性别；旧的 sameSexOnly 仍接受', async () => {
    const unknown = await s.login(makeUser(s.db, { gender: 'unknown' }));
    let r = await create(unknown, { genderLimit: 'female' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.message, '先在资料里选性别');
    r = await create(unknown, { sameSexOnly: true });
    assert.equal(r.body.error.message, '先在资料里选性别');
    assert.equal((await create(unknown, { genderLimit: 'any' })).status, 200);

    const female = await s.login(makeUser(s.db, { gender: 'female' }));
    r = await create(female, { genderLimit: 'male' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.message, '发起人自己也要能参加');
    assert.equal((await create(female, { genderLimit: 'everyone' })).status, 400);
    const ev = await createOk(female, { genderLimit: 'female', startAt: '2026-11-01T06:00:00.000Z' });
    assert.deepEqual([ev.genderLimit, ev.genderLabel, ev.sameSexOnly], ['female', '只限女生', true]);
    const legacy = await createOk(await s.login(makeUser(s.db, { gender: 'male' })), { sameSexOnly: true });
    assert.deepEqual([legacy.genderLimit, legacy.genderLabel], ['male', '只限男生']);
    const open = await createOk(await s.login(makeUser(s.db)), {});
    assert.deepEqual([open.genderLimit, open.genderLabel, open.sameSexOnly], ['any', null, false]);
  });

  test('开了「只参加同性局」后不能把性别改回未填（与 updateSafety 对称）', async () => {
    const token = await s.login(makeUser(s.db, { gender: 'female' }));
    await s.ok('PUT', '/api/me/safety', { token, body: { sameSexOnly: true } });
    assert.equal((await s.api('PUT', '/api/me', { token, body: { gender: 'unknown' } })).status, 400);
    // 关掉开关后就能改
    await s.ok('PUT', '/api/me/safety', { token, body: { sameSexOnly: false } });
    await s.ok('PUT', '/api/me', { token, body: { gender: 'unknown' } });
  });

  test('性别不符（含未填）的人看不到、也报不了名；平台局可以任意限制', async () => {
    const admin = await s.adminToken();
    const { eventId } = await s.ok('POST', '/api/admin/events', { token: admin, body: body({ genderLimit: 'male', title: '男生夜跑' }) });
    const male = await s.login(makeUser(s.db, { gender: 'male' }));
    const female = await s.login(makeUser(s.db, { gender: 'female' }));
    const unknown = await s.login(makeUser(s.db, { gender: 'unknown' }));
    assert.deepEqual((await s.ok('GET', '/api/events', { token: male })).items.map((e) => [e.id, e.genderLimit, e.genderLabel]), [
      [eventId, 'male', '只限男生'],
    ]);
    for (const token of [female, unknown, undefined]) {
      assert.equal((await s.ok('GET', '/api/events', { token })).items.length, 0);
      assert.equal((await s.ok('GET', '/api/home', { token })).featuredEvents.length, 0);
      assert.equal((await s.api('GET', `/api/events/${eventId}`, { token })).status, 404);
    }
    assert.equal((await s.api('POST', `/api/events/${eventId}/join`, { token: female })).status, 404);
    assert.equal((await s.api('POST', `/api/events/${eventId}/join`, { token: unknown })).status, 404);
    const joined = await s.ok('POST', `/api/events/${eventId}/join`, { token: male });
    assert.equal(joined.myStatus, 'joined');
  });
});

describe('图片和地点', () => {
  test('图片 0–9 张，必须是本站 /uploads/ 的地址；存相对路径，返回绝对地址（客户端绝对 / 相对都能提交）', async () => {
    const token = await s.login(makeUser(s.db));
    let r = await create(token, { images: Array.from({ length: 10 }, (_, i) => `/uploads/p${i}.png`) });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.message, '图片最多 9 张');
    for (const images of [['https://evil.example.com/a.png'], ['/static/a.png'], ['/uploads/../db.sqlite'], [42], 'x']) {
      r = await create(token, { images });
      assert.equal(r.status, 400, JSON.stringify(images));
    }
    const ev = await createOk(token, { images: ['/uploads/a.png', 'http://192.168.1.8:3000/uploads/b.jpg', '/uploads/a.png'] });
    assert.deepEqual(ev.images, [`${BASE}/uploads/a.png`, `${BASE}/uploads/b.jpg`]);
    assert.equal(ev.cover, `${BASE}/uploads/a.png`);
    assert.equal(s.db.get('SELECT images FROM events WHERE id = ?', ev.id).images, '["/uploads/a.png","/uploads/b.jpg"]');
    const plain = await createOk(await s.login(makeUser(s.db)));
    assert.deepEqual([plain.images, plain.cover, plain.coverKey], [[], null, 'oldtown']);
  });

  test('地点 location 可选：{name, address, latitude, longitude}；没填 place 时用 location.name', async () => {
    const token = await s.login(makeUser(s.db));
    const location = { name: '才村码头', address: '大理市才村洱海边', latitude: 25.6745, longitude: 100.1993 };
    const ev = await createOk(token, { place: undefined, location });
    assert.equal(ev.place, '才村码头');
    assert.deepEqual(ev.location, location);
    const named = await createOk(await s.login(makeUser(s.db)), { place: '洱海边', location: { name: '才村码头' } });
    assert.equal(named.place, '洱海边');
    assert.deepEqual(named.location, { name: '才村码头', address: null, latitude: null, longitude: null });
    for (const [loc, message] of [
      [{ name: '' }, '请填写地点名称'],
      [{ name: '码头', latitude: 91, longitude: 100 }, '纬度需要在 -90–90 之间'],
      [{ name: '码头', latitude: 25 }, '经纬度要一起填'],
      ['才村码头', '地点格式不正确'],
    ]) {
      const r = await create(token, { location: loc });
      assert.equal(r.status, 400, JSON.stringify(loc));
      assert.equal(r.body.error.message, message);
    }
    const none = await create(token, { place: undefined });
    assert.equal(none.body.error.message, '请填写地点');
  });
});

describe('最晚退出时间 exitDeadline', () => {
  test('默认 max(开始前 24 小时, 现在 + 30 分钟)；可以传，要在 (现在, 开始] 之间', async () => {
    const token = await s.login(makeUser(s.db));
    const ev = await createOk(token);
    assert.equal(ev.exitDeadline, '2026-10-30T06:00:00.000Z');
    assert.equal(ev.exitDeadlineLabel, '10月30日 14:00');
    const soon = await createOk(await s.login(makeUser(s.db)), { startAt: '2026-10-26T04:00:00.000Z' }); // 2 小时后开始
    assert.equal(soon.exitDeadline, '2026-10-26T02:30:00.000Z');
    const custom = await createOk(await s.login(makeUser(s.db)), { exitDeadline: '2026-10-31T04:00:00.000Z' });
    assert.equal(custom.exitDeadline, '2026-10-31T04:00:00.000Z');
    const atStart = await createOk(await s.login(makeUser(s.db)), { exitDeadline: SAT_2PM });
    assert.equal(atStart.exitDeadline, SAT_2PM);
    // 早于现在、等于现在、晚于开始、格式不对
    for (const exitDeadline of ['2026-10-26T01:00:00.000Z', '2026-10-26T02:00:00.000Z', '2026-11-02T06:01:00.000Z', 'soon']) {
      const r = await create(token, { exitDeadline, startAt: '2026-11-02T06:00:00.000Z' });
      assert.equal(r.status, 400, exitDeadline);
    }
  });

  test('过了最晚退出时间：不能退出，也不能点「去不了了」（409 写明时间）；详情 canLeave=false 并给原因', async () => {
    const [host, a] = [makeUser(s.db), makeUser(s.db)];
    const [th, ta] = [await s.login(host), await s.login(a)];
    const ev = await createOk(th);
    await s.ok('POST', `/api/events/${ev.id}/join`, { token: ta });
    let detail = await s.ok('GET', `/api/events/${ev.id}`, { token: ta });
    assert.deepEqual([detail.canLeave, detail.leaveBlockedReason, detail.remaining], [true, null, 2]);
    const hostView = await s.ok('GET', `/api/events/${ev.id}`, { token: th });
    assert.deepEqual([hostView.canLeave, hostView.leaveBlockedReason], [false, '你是发起人，不想办了可以取消这个局']);
    assert.deepEqual(
      [(await s.ok('GET', `/api/events/${ev.id}`)).canLeave, (await s.ok('GET', `/api/events/${ev.id}`)).leaveBlockedReason],
      [false, null],
    );

    clock.set('2026-10-30T06:00:00.000Z'); // 正好到最晚退出时间
    const message = '已过最晚退出时间（10月30日 14:00），不能退出了';
    detail = await s.ok('GET', `/api/events/${ev.id}`, { token: ta });
    assert.deepEqual([detail.canLeave, detail.leaveBlockedReason], [false, message]);
    let r = await s.api('POST', `/api/events/${ev.id}/leave`, { token: ta });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.message, message);
    r = await s.api('POST', `/api/events/${ev.id}/attendance`, { token: ta, body: { going: false } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.message, message);
    assert.deepEqual(await s.ok('POST', `/api/events/${ev.id}/attendance`, { token: ta, body: { going: true } }), {
      attendance: 'yes',
      penalty: null,
    });
    assert.equal(s.db.get('SELECT status FROM event_members WHERE event_id = ? AND user_id = ?', ev.id, a).status, 'joined');
  });

  test('到了最晚退出时间还没满员：人数 ≥ minSize 就成群（「人数够了…」），通知所有人；还在等同意的申请一并结束', async () => {
    const [host, a, applicant] = [makeUser(s.db), makeUser(s.db), makeUser(s.db)];
    const [th, ta, tp] = await Promise.all([host, a, applicant].map((u) => s.login(u)));
    const ev = await createOk(th, { capacity: 5, requireApproval: true });
    await s.ok('POST', `/api/events/${ev.id}/join`, { token: ta });
    // 同意 a、留一个待处理的申请
    await s.ok('POST', `/api/events/${ev.id}/applications/${a}/approve`, { token: th });
    assert.equal((await s.ok('POST', `/api/events/${ev.id}/join`, { token: tp })).myStatus, 'applied');
    assert.equal(messages(ev.id).some((m) => m.kind === 'system' && m.text.includes('群已自动建好')), false);

    clock.set('2026-10-30T05:59:00.000Z');
    assert.deepEqual(runMinuteJobs({ db: s.db }).exitDeadlines, { formed: 0, cancelled: 0 });
    clock.set('2026-10-30T06:00:00.000Z');
    assert.deepEqual(runMinuteJobs({ db: s.db }).exitDeadlines, { formed: 1, cancelled: 0 });
    const row = s.db.get('SELECT status, formed_at FROM events WHERE id = ?', ev.id);
    assert.deepEqual([row.status, row.formed_at], ['formed', '2026-10-30T06:00:00.000Z']);
    assert.equal(messages(ev.id).at(-1).text, '人数够了，群已自动建好 · 第一次见面，慢慢来');
    for (const u of [host, a]) {
      const [n] = notices(u, 'formed');
      assert.deepEqual([n.title, n.link], ['人数够了，群已建好', `chat:${ev.id}`]);
    }
    assert.equal(s.db.get('SELECT status FROM event_members WHERE event_id = ? AND user_id = ?', ev.id, applicant).status, 'declined');
    assert.ok(notices(applicant, 'application_result').some((n) => n.body.includes('已经截止报名了')));
    assert.equal((await s.ok('GET', `/api/events/${ev.id}`, { token: ta })).chatOpen, true);
    // 只处理一次
    assert.deepEqual(runMinuteJobs({ db: s.db }).exitDeadlines, { formed: 0, cancelled: 0 });
  });

  test('人数不够 minSize：取消（原因「没凑齐人」），发起人和成员都收到通知', async () => {
    const [host, a] = [makeUser(s.db), makeUser(s.db)];
    const [th, ta] = [await s.login(host), await s.login(a)];
    assert.equal((await create(th, { capacity: 4, minSize: 5 })).status, 400); // minSize 不能超过人数上限
    const ev = await createOk(th, { capacity: 6, minSize: 3 });
    assert.equal(ev.minSize, 3);
    await s.ok('POST', `/api/events/${ev.id}/join`, { token: ta });
    clock.set('2026-10-30T06:00:00.000Z');
    assert.deepEqual(runMinuteJobs({ db: s.db }).exitDeadlines, { formed: 0, cancelled: 1 });
    const row = s.db.get('SELECT status, cancel_reason FROM events WHERE id = ?', ev.id);
    assert.deepEqual([row.status, row.cancel_reason], ['cancelled', '没凑齐人']);
    for (const u of [host, a]) {
      const [n] = notices(u, 'event_cancelled');
      assert.equal(n.body, '「洱海边散步」已取消：没凑齐人。不影响你的信用。');
    }
    // 只有发起人一个人的局也会取消
    const lonely = await createOk(await s.login(makeUser(s.db)), { startAt: '2026-11-01T06:00:00.000Z' });
    clock.set('2026-10-31T06:00:00.000Z');
    runMinuteJobs({ db: s.db });
    assert.equal(s.db.get('SELECT status FROM events WHERE id = ?', lonely.id).status, 'cancelled');
  });

  test('早就结束了的 open 局（老库升级）：只改状态，不发通知、不加系统消息', async () => {
    const [host, a] = [makeUser(s.db), makeUser(s.db)];
    const old = (title, members) => {
      const id = s.db.insert('events', {
        title, category: 'coffee', task: '咖啡', start_at: '2026-10-20T06:00:00.000Z', duration_min: 120, place: '古城',
        capacity: 4, min_size: 2, source: 'user', creator_id: host, status: 'open', created_at: '2026-10-15T00:00:00.000Z',
      });
      for (const u of members) s.db.insert('event_members', { event_id: id, user_id: u, role: u === host ? 'host' : 'member', status: 'joined', joined_at: '2026-10-16T00:00:00.000Z' });
      return id;
    };
    const enough = old('上周的咖啡局', [host, a]);
    const lonely = old('没人来的咖啡局', [host]);
    assert.deepEqual(runMinuteJobs({ db: s.db }).exitDeadlines, { formed: 1, cancelled: 1 });
    const row = s.db.get('SELECT status, formed_at FROM events WHERE id = ?', enough);
    assert.deepEqual([row.status, row.formed_at], ['formed', '2026-10-19T06:00:00.000Z']);
    assert.equal(s.db.get('SELECT status FROM events WHERE id = ?', lonely).status, 'cancelled');
    assert.equal(s.db.get("SELECT COUNT(*) AS n FROM notices WHERE type IN ('formed', 'event_cancelled')").n, 0);
    assert.equal(s.db.get('SELECT COUNT(*) AS n FROM messages').n, 0);
    // 成群的那个照常进入「去评价」
    assert.equal(s.db.get("SELECT COUNT(*) AS n FROM notices WHERE type = 'review'").n, 2);
  });

  test('过了最晚退出时间不再接受报名，广场也不显示', async () => {
    const [th, ta] = await Promise.all([makeUser(s.db), makeUser(s.db)].map((u) => s.login(u)));
    const ev = await createOk(th, { capacity: 5, exitDeadline: '2026-10-28T06:00:00.000Z' });
    assert.equal((await s.ok('GET', '/api/events')).items.length, 1);
    clock.set('2026-10-28T06:00:00.000Z'); // 定时任务还没跑，局还是 open
    assert.equal((await s.ok('GET', '/api/events')).items.length, 0);
    assert.equal((await s.ok('GET', '/api/search?q=散步')).items.length, 0);
    assert.equal((await s.ok('GET', `/api/events/${ev.id}`, { token: ta })).canJoin, false);
    const r = await s.api('POST', `/api/events/${ev.id}/join`, { token: ta });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.message, '已经截止报名了');
  });

  test('撮合局：确认时默认 max(开始前 24 小时, 现在 + 30 分钟)；已加入的人过了最晚退出时间不能「换一批」，还没回复的人可以', async () => {
    clock.set('2026-10-29T02:00:00.000Z'); // 周四 10:00，离周六 05:50 不到 44 小时
    const users = [1, 2, 3].map(() => makeUser(s.db));
    users.forEach((u) => addCredit(s.db, u, 'attended', 2));
    users.forEach((u) => makeIntent(s.db, u));
    runMatching(s.db);
    const admin = await s.adminToken();
    const { items } = await s.ok('GET', '/api/admin/proposals', { token: admin });
    const bad = await s.api('POST', `/api/admin/proposals/${items[0].id}/confirm`, { token: admin, body: { exitDeadline: '2026-10-31T00:00:00.000Z' } });
    assert.equal(bad.status, 400); // 晚于开始
    const { eventId } = await s.ok('POST', `/api/admin/proposals/${items[0].id}/confirm`, { token: admin, body: {} });
    const tokens = await Promise.all(users.map((u) => s.login(u)));
    const accepted = await s.ok('POST', `/api/matches/${eventId}/accept`, { token: tokens[0] });
    assert.equal(accepted.exitDeadline, '2026-10-29T21:50:00.000Z'); // 周五 05:50
    clock.set('2026-10-29T22:00:00.000Z'); // 周五 06:00：过了最晚退出时间，还在等另外两个人（期限周五 10:00）
    const message = '已过最晚退出时间（10月30日 05:50），不能退出了';
    for (const url of [`/api/matches/${eventId}/decline`, `/api/events/${eventId}/leave`]) {
      const r = await s.api('POST', url, { token: tokens[0] });
      assert.equal(r.status, 409, url);
      assert.equal(r.body.error.message, message);
    }
    const declined = await s.ok('POST', `/api/matches/${eventId}/decline`, { token: tokens[1] }); // 还没加入的人照常换一批
    assert.equal(declined.ok, true);
  });

  test('需要同意的局：过了最晚退出时间发起人也不能再通过申请', async () => {
    const [host, applicantId] = [makeUser(s.db), makeUser(s.db)];
    const [th, ta] = [await s.login(host), await s.login(applicantId)];
    const ev = await createOk(th, { requireApproval: true, exitDeadline: '2026-10-28T06:00:00.000Z' });
    await s.ok('POST', `/api/events/${ev.id}/join`, { token: ta });
    clock.set('2026-10-28T06:30:00.000Z');
    const r = await s.api('POST', `/api/events/${ev.id}/applications/${applicantId}/approve`, { token: th });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.message, '已经截止报名了');
  });
});

describe('成群：满员立即成群，群聊只在成群后开启', () => {
  test('平台局满员 → 成群：系统消息「满员啦…」+ 给每个成员发 formed 通知；成群前不能发消息', async () => {
    const admin = await s.adminToken();
    const { eventId } = await s.ok('POST', '/api/admin/events', { token: admin, body: body({ capacity: 2, tag: '咖啡', title: '平台咖啡局' }) });
    const [a, b] = [makeUser(s.db), makeUser(s.db)];
    const [ta, tb] = [await s.login(a), await s.login(b)];
    let r = await s.ok('POST', `/api/events/${eventId}/join`, { token: ta });
    assert.deepEqual(r, {
      myStatus: 'joined',
      eventStatus: 'open',
      formed: false,
      remaining: 1,
      memberCount: 1,
      capacity: 2,
      exitDeadline: '2026-10-30T06:00:00.000Z',
    });
    assert.equal((await s.ok('GET', `/api/events/${eventId}`, { token: ta })).chatOpen, false);
    const early = await s.api('POST', `/api/events/${eventId}/messages`, { token: ta, body: { text: '有人吗' } });
    assert.equal(early.status, 403);
    assert.equal(early.body.error.message, '群聊还没开启，成群后就能聊了');
    assert.equal((await s.ok('GET', '/api/inbox', { token: ta })).chats.length, 0);

    r = await s.ok('POST', `/api/events/${eventId}/join`, { token: tb });
    assert.deepEqual([r.myStatus, r.eventStatus, r.formed, r.remaining, r.memberCount], ['joined', 'formed', true, 0, 2]);
    assert.equal(messages(eventId).at(-1).text, '满员啦，群已自动建好 · 第一次见面，慢慢来');
    for (const u of [a, b]) {
      const [n] = notices(u, 'formed');
      assert.deepEqual([n.title, n.link], ['满员啦，群已建好', `chat:${eventId}`]);
    }
    await s.ok('POST', `/api/events/${eventId}/messages`, { token: ta, body: { text: '大家好' } });
    assert.equal((await s.ok('GET', '/api/inbox', { token: tb })).chats[0].eventId, eventId);
    // 重复点加入：返回当前状态
    assert.equal((await s.ok('POST', `/api/events/${eventId}/join`, { token: ta })).formed, true);
  });

  test('成群后有人（在最晚退出时间前）退出：局回到 open 继续招人，群聊照常；再满员不重复发成群通知', async () => {
    const [host, a, b, c] = [makeUser(s.db), makeUser(s.db), makeUser(s.db), makeUser(s.db)];
    const [th, ta, tb, tc] = await Promise.all([host, a, b, c].map((u) => s.login(u)));
    const ev = await createOk(th, { capacity: 3 });
    await s.ok('POST', `/api/events/${ev.id}/join`, { token: ta });
    await s.ok('POST', `/api/events/${ev.id}/join`, { token: tb });
    assert.equal(notices(host, 'formed').length, 1);
    await s.ok('POST', `/api/events/${ev.id}/leave`, { token: tb });
    const detail = await s.ok('GET', `/api/events/${ev.id}`, { token: ta });
    assert.deepEqual([detail.status, detail.chatOpen, detail.remaining], ['open', true, 1]);
    assert.deepEqual((await s.ok('GET', '/api/events')).items.map((e) => e.id), [ev.id]);
    const r = await s.ok('POST', `/api/events/${ev.id}/join`, { token: tc });
    assert.deepEqual([r.eventStatus, r.formed], ['formed', true]);
    assert.equal(notices(host, 'formed').length, 1);
    assert.equal(messages(ev.id).filter((m) => m.text.includes('群已自动建好')).length, 1);
  });
});

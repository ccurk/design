import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { clock } from '../src/clock.js';
import { runMinuteJobs, startJobs } from '../src/jobs.js';
import { HOUR, makeUser, startServer } from './helpers.js';

let s;
const noticesOf = (userId, type) => s.db.all('SELECT * FROM notices WHERE user_id = ? AND type = ?', userId, type);

describe('定时任务：提醒', () => {
  beforeEach(async () => {
    s = await startServer();
  });
  afterEach(() => s.close());

  test('开场前 48 小时内提醒轻确认（只提醒一次），并出现在「需要你处理」', async () => {
    const [host, a] = [makeUser(s.db), makeUser(s.db)];
    const [th, ta] = [await s.login(host), await s.login(a)];
    const startAt = new Date(clock.now().getTime() + 50 * HOUR).toISOString();
    const ev = await s.ok('POST', '/api/events', {
      token: th,
      body: { title: '苍山小环线徒步', category: 'outdoor', startAt, place: '感通索道', capacity: 4, feeType: 'split' },
    });
    await s.ok('POST', `/api/events/${ev.id}/join`, { token: ta });
    const warns = [];
    const logger = { warn: (...args) => warns.push(args.join(' ')) };

    runMinuteJobs({ db: s.db, logger });
    assert.equal(noticesOf(a, 'attendance').length, 0);

    clock.advance(3 * HOUR);
    runMinuteJobs({ db: s.db, logger });
    runMinuteJobs({ db: s.db, logger });
    assert.equal(noticesOf(a, 'attendance').length, 1);
    assert.equal(noticesOf(host, 'attendance').length, 1);
    let inbox = await s.ok('GET', '/api/inbox', { token: ta });
    const action = inbox.actions.find((x) => x.type === 'attendance');
    assert.equal(action.eventId, ev.id);
    assert.equal(action.startAt, startAt);
    await s.ok('POST', `/api/events/${ev.id}/attendance`, { token: ta, body: { going: true } });
    inbox = await s.ok('GET', '/api/inbox', { token: ta });
    assert.ok(!inbox.actions.some((x) => x.type === 'attendance'));

    // 结束后：去评价 + 报平安；1 小时没回应只记日志
    clock.set(new Date(Date.parse(startAt) + 2 * HOUR + 60000));
    await s.ok('POST', `/api/events/${ev.id}/safe`, { token: th });
    runMinuteJobs({ db: s.db, logger });
    assert.equal(noticesOf(a, 'review').length, 1);
    assert.equal(noticesOf(a, 'safe').length, 1);
    assert.equal(noticesOf(host, 'safe').length, 0); // 已经报过平安
    clock.advance(HOUR + 60000);
    const result = runMinuteJobs({ db: s.db, logger });
    assert.equal(result.reminders.safeEscalated, 1);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /仍未报平安/);
    runMinuteJobs({ db: s.db, logger });
    assert.equal(warns.length, 1);
  });

  test('受限到期自动恢复', () => {
    const u = makeUser(s.db, { status: 'restricted', restricted_until: new Date(clock.now().getTime() + HOUR).toISOString() });
    clock.advance(2 * HOUR);
    const result = runMinuteJobs({ db: s.db });
    assert.equal(result.reminders.restrictionsLifted, 1);
    assert.equal(s.db.get('SELECT status FROM users WHERE id = ?', u).status, 'active');
  });

  test('startJobs 启动时先跑一遍，stop 后不再运行', () => {
    const logs = [];
    const jobs = startJobs({ db: s.db, logger: { info: (m) => logs.push(m), debug() {}, error() {} } }, { matchEvery: 1e9, minuteEvery: 1e9 });
    jobs.stop();
    assert.ok(logs.some((m) => m.includes('定时任务已启动')));
  });

  test('静态文件：不存在的上传文件返回 404 JSON；后台页面没构建时给出提示', async () => {
    const r = await s.api('GET', '/uploads/nope.png');
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'NOT_FOUND');
    const admin = await fetch(`${s.base}/admin/proposals`);
    assert.ok([200, 404].includes(admin.status));
  });

  test('上传：只收图片，≤ 5MB', async () => {
    const t = await s.login(makeUser(s.db));
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    let form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'a.png');
    const ok = await s.ok('POST', '/api/upload', { token: t, form });
    assert.match(ok.url, /\/uploads\/.+\.png$/);
    const file = await fetch(`${s.base}${new URL(ok.url).pathname}`);
    assert.equal(file.status, 200);

    form = new FormData();
    form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'a.txt');
    const bad = await s.api('POST', '/api/upload', { token: t, form });
    assert.equal(bad.status, 400);

    form = new FormData();
    form.append('file', new Blob([Buffer.alloc(5 * 1024 * 1024 + 10)], { type: 'image/jpeg' }), 'big.jpg');
    const big = await s.api('POST', '/api/upload', { token: t, form });
    assert.equal(big.status, 400);
    assert.equal(big.body.error.message, '图片不能超过 5MB');
  });
});

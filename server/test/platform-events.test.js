import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { clock } from '../src/clock.js';
import { EVENT_TEMPLATES, OPERATOR_OPENID, publishDailyEvents, publishPlatformEvent } from '../src/services/platformEvents.js';
import { makeUser, startServer } from './helpers.js';

let s;

describe('运营带队的平台局 / 每日自动发布', () => {
  beforeEach(async () => {
    s = await startServer();
  });
  afterEach(() => s.close());

  test('每日发布:发运营带队的开放局,当天只发一次,不塞假人', () => {
    const r1 = publishDailyEvents(s.db, { perDay: 2, aheadDays: 2 });
    assert.equal(r1.created, 4);
    const r2 = publishDailyEvents(s.db, { perDay: 2, aheadDays: 2 });
    assert.equal(r2.skipped, true); // markOnce:当天只发一次

    const op = s.db.get('SELECT id FROM users WHERE openid = ?', OPERATOR_OPENID);
    const events = s.db.all("SELECT * FROM events WHERE source = 'platform' AND status = 'open'");
    assert.equal(events.length, 4);
    for (const e of events) {
      const members = s.db.all('SELECT * FROM event_members WHERE event_id = ?', e.id);
      assert.equal(members.length, 1); // 只有运营号,没有假的种子账号占位
      assert.equal(members[0].user_id, op.id);
      assert.ok(e.capacity > members.length); // 还有空位留给真人
      assert.ok(Date.parse(e.start_at) > clock.now().getTime()); // 都是未来的局
      assert.ok(!e.title.includes('undefined'), `标题不该有 undefined：${e.title}`);
      assert.match(e.title, /^周[日一二三四五六]/, `标题应以周几开头：${e.title}`);
    }
  });

  test('真人能在广场看到并加入运营局', async () => {
    const eventId = publishPlatformEvent(s.db, EVENT_TEMPLATES[2], { date: '2026-10-28' }); // 咖啡局,capacity 4
    const token = await s.login(makeUser(s.db));
    const square = await s.ok('GET', '/api/events', { token });
    assert.ok(
      square.items.some((e) => e.id === eventId),
      '运营局应出现在广场',
    );
    await s.ok('POST', `/api/events/${eventId}/join`, { token }); // 真人加得进
    // 运营 + 真人 = 2 人,还没满,仍 open
    assert.equal(s.db.get('SELECT status FROM events WHERE id = ?', eventId).status, 'open');
    assert.equal(s.db.get("SELECT COUNT(*) AS n FROM event_members WHERE event_id = ? AND status = 'joined'", eventId).n, 2);
  });

  test('广场筛选：只看官方、按片区', async () => {
    const cycId = publishPlatformEvent(s.db, EVENT_TEMPLATES[1], { date: '2026-10-28' }); // 骑行 · 才村
    const coffeeId = publishPlatformEvent(s.db, EVENT_TEMPLATES[2], { date: '2026-10-28' }); // 咖啡 · 古城
    const token = await s.login(makeUser(s.db));

    const official = await s.ok('GET', '/api/events?source=official', { token });
    assert.ok(official.items.length >= 2 && official.items.every((e) => e.source === 'platform'), '只看官方应全是平台局');

    const cai = await s.ok('GET', `/api/events?area=${encodeURIComponent('才村')}`, { token });
    assert.ok(cai.items.some((e) => e.id === cycId), '才村应有骑行局');
    assert.ok(!cai.items.some((e) => e.id === coffeeId), '才村不应有古城的咖啡局');
  });

  test('历史已成团的局(撑场面)不进广场,真人加不到;只有未来开放局进广场', async () => {
    // 一个过去的、已成团的平台局(模拟 seed-coldstart 造的撑场面数据)
    const pastId = s.db.insert('events', {
      title: '上周 · 苍山看日出',
      category: 'outdoor',
      task: '看日出',
      start_at: '2026-10-19T21:50:00.000Z', // 上周,已过去
      duration_min: 240,
      place: '大理古城南门',
      capacity: 5,
      min_size: 3,
      source: 'platform',
      creator_id: null,
      status: 'formed',
      created_at: '2026-10-14T00:00:00.000Z',
    });
    const futureId = publishPlatformEvent(s.db, EVENT_TEMPLATES[0], { date: '2026-10-28' });

    const token = await s.login(makeUser(s.db));
    const square = await s.ok('GET', '/api/events', { token });
    assert.ok(!square.items.some((e) => e.id === pastId), '历史已成团的局不该出现在广场');
    assert.ok(square.items.some((e) => e.id === futureId), '未来开放的运营局应出现在广场');
    // 真人也加不到历史局(已结束)
    assert.equal((await s.api('POST', `/api/events/${pastId}/join`, { token })).status >= 300, true);
  });
});

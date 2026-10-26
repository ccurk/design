import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { clock } from '../src/clock.js';
import { SLOTS } from '../src/time.js';
import { customStartMinute, intentWindow, isFlexible, pairCompatible } from '../src/services/matchRules.js';
import { runMatching } from '../src/services/matching.js';
import { addCredit, makeIntent, makeUser, startServer } from './helpers.js';

let s;
let admin;

beforeEach(async () => {
  s = await startServer(); // 北京时间 2026-10-26（周一）10:00；周六是 10-31
  admin = await s.adminToken();
});
afterEach(() => s.close());

const pendingProposals = () => s.db.all("SELECT * FROM proposals WHERE status = 'pending' ORDER BY id");

/** n 个想周六下午骑行的人，第 i 个用 windows[i]（[from, to] 或 slot 字符串） */
function cyclists(windows) {
  return windows.map((w) => {
    const u = makeUser(s.db);
    addCredit(s.db, u, 'attended', 2);
    const time = Array.isArray(w) ? { slot: 'afternoon', time_from: w[0], time_to: w[1] } : { slot: w };
    const id = makeIntent(s.db, u, { task: '骑行', ...time });
    return { user: u, intent: id };
  });
}

describe('意向的时间：提交', () => {
  test('slot 和 timeFrom + timeTo 二选一；自定义时间段 05:00–23:59、至少 60 分钟、任意分钟', async () => {
    const token = await s.login(makeUser(s.db));
    const post = (body) => s.api('POST', '/api/intents', { token, body: { task: '骑行', when: '2026-11-01', ...body } });
    for (const [body, message] of [
      [{ slot: 'afternoon', timeFrom: '14:00', timeTo: '17:00' }, '时间段和具体时间只能选一个'],
      [{ timeFrom: '14:00' }, '请同时填写开始和结束时间'],
      [{ timeFrom: '9:00', timeTo: '11:00' }, '时间格式不正确，请用 HH:MM（如 14:00）'],
      [{ timeFrom: '14:00', timeTo: '24:00' }, '时间格式不正确，请用 HH:MM（如 14:00）'],
      [{ timeFrom: '04:30', timeTo: '07:00' }, '时间要在 05:00–23:59 之间'],
      [{ timeFrom: '17:00', timeTo: '14:00' }, '结束时间要晚于开始时间'],
      [{ timeFrom: '14:00', timeTo: '14:59' }, '时间段至少要 1 个小时'],
    ]) {
      const r = await post(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error.message, message);
    }
    const intent = (await post({ timeFrom: '14:05', timeTo: '15:05' })).body;
    assert.deepEqual([intent.timeFrom, intent.timeTo, intent.timeLabel], ['14:05', '15:05', '14:05–15:05']);
    assert.equal(intent.title, '周日 14:05–15:05 · 骑行');
    assert.equal(intent.slot, 'afternoon'); // 只作参考
    const late = await s.ok('POST', '/api/intents', {
      token: await s.login(makeUser(s.db)),
      body: { task: '夜市', when: '2026-11-01', timeFrom: '22:59', timeTo: '23:59' },
    });
    assert.equal(late.timeLabel, '22:59–23:59');
  });

  test('timeLabel 和标题：「周日下午 · 骑行」「周日 14:00–17:00 · 骑行」「本周末 · 爬山」（全天不写）', async () => {
    const tokens = await Promise.all([1, 2, 3, 4].map(() => s.login(makeUser(s.db))));
    const a = await s.ok('POST', '/api/intents', { token: tokens[0], body: { task: '骑行', when: '2026-11-01', slot: 'afternoon' } });
    assert.deepEqual([a.title, a.timeLabel, a.timeFrom, a.timeTo], ['周日下午 · 骑行', '下午', null, null]);
    const b = await s.ok('POST', '/api/intents', { token: tokens[1], body: { task: '骑行', when: '2026-11-01', timeFrom: '14:00', timeTo: '17:00' } });
    assert.equal(b.title, '周日 14:00–17:00 · 骑行');
    const c = await s.ok('POST', '/api/intents', { token: tokens[2], body: { task: '爬山', when: 'weekend', slot: 'allday' } });
    assert.deepEqual([c.title, c.timeLabel], ['本周末 · 爬山', '全天']);
    const d = await s.ok('POST', '/api/intents', { token: tokens[3], body: { task: '看日出', when: '2026-10-31' } });
    assert.deepEqual([d.title, d.timeLabel, d.slot], ['周六清晨 · 看日出', '清晨', 'morning']);
    const mine = await s.ok('GET', '/api/events/mine?tab=ongoing', { token: tokens[1] });
    assert.equal(mine.items[0].dateLabel, '周日 14:00–17:00');
  });
});

describe('意向的时间：撮合', () => {
  test('只用时间段时，时间窗规则和原来完全一样（同一个时间段，或任一方全天 / 放宽到全天）', () => {
    const shapes = [];
    for (const slot of SLOTS) for (const relax of [0, 1]) shapes.push({ slot, relax_time: relax });
    let n = 0;
    for (const a of shapes) {
      for (const b of shapes) {
        const old = a.slot === b.slot || isFlexible(a) || isFlexible(b);
        const common = { task: '骑行', area: '古城', date_from: '2026-10-31', date_to: '2026-10-31', gender: 'female' };
        const now = pairCompatible({ ...common, ...a, user_id: 1 }, { ...common, ...b, user_id: 2 }, new Set());
        assert.equal(now, old, `${JSON.stringify(a)} × ${JSON.stringify(b)}`);
        n++;
      }
    }
    assert.equal(n, 64);
    assert.deepEqual(intentWindow({ slot: 'morning' }), [300, 720]);
    assert.deepEqual(intentWindow({ slot: 'evening', relax_time: 1 }), [300, 1380]);
  });

  test('一组人的时间窗交集 ≥ 60 分钟才配到一起', () => {
    const a = { task: '骑行', area: '古城', date_from: '2026-10-31', date_to: '2026-10-31', user_id: 1, slot: 'afternoon', time_from: '14:00', time_to: '17:00' };
    const pairWith = (patch) => pairCompatible(a, { ...a, user_id: 2, ...patch }, new Set());
    assert.equal(pairWith({ time_from: '15:30', time_to: '18:00' }), true); // 90 分钟
    assert.equal(pairWith({ time_from: '16:00', time_to: '18:00' }), true); // 正好 60 分钟
    assert.equal(pairWith({ time_from: '16:30', time_to: '19:00' }), false); // 30 分钟
    assert.equal(pairWith({ time_from: null, time_to: null, slot: 'afternoon' }), true);
    assert.equal(pairWith({ time_from: null, time_to: null, slot: 'allday' }), true);
    assert.equal(pairWith({ time_from: null, time_to: null, slot: 'morning' }), false);
    assert.equal(pairWith({ time_from: null, time_to: null, slot: 'morning', relax_time: 1 }), true);
    assert.equal(pairWith({ time_from: null, time_to: null, slot: 'evening' }), false);

    // 两两交集够 60 分钟，整组也够：14:00–17:00、15:30–18:00、下午 → 15:30–17:00
    cyclists([['14:00', '17:00'], ['15:30', '18:00'], 'afternoon']);
    assert.equal(runMatching(s.db).created, 1);
    // 和第一个人只有 30 分钟交集的人不会进同一组
    const s2 = cyclists([['18:30', '21:00']]);
    runMatching(s.db);
    assert.equal(s.db.get('SELECT status FROM intents WHERE id = ?', s2[0].intent).status, 'open');
  });

  test('有人用了自定义时间段：理由「大家都有空：…」，集合时间 = 交集开始向上取整到 :00 / :30', async () => {
    cyclists([['14:10', '17:00'], ['13:00', '16:00'], 'afternoon']); // 交集 14:10–16:00
    runMatching(s.db);
    const [p] = pendingProposals();
    assert.ok(JSON.parse(p.reasons).includes('大家都有空：14:10–16:00'));
    assert.equal(p.title, '周六下午 · 一起骑行');
    const { items } = await s.ok('GET', '/api/admin/proposals', { token: admin });
    assert.deepEqual(items[0].window, { from: '14:10', to: '16:00' });
    assert.equal(items[0].windowLabel, '14:10–16:00');
    assert.equal(items[0].defaultStartAt, '2026-10-31T06:30:00.000Z'); // 北京时间 14:30
    assert.deepEqual(items[0].members.map((m) => m.timeLabel), ['14:10–17:00', '13:00–16:00', '下午']);
    const { eventId } = await s.ok('POST', `/api/admin/proposals/${p.id}/confirm`, { token: admin, body: {} });
    assert.equal(s.db.get('SELECT start_at FROM events WHERE id = ?', eventId).start_at, '2026-10-31T06:30:00.000Z');
  });

  test('取整后剩不到 60 分钟就用交集开始；时间窗完全一样时算「时间一致」加分', () => {
    assert.equal(customStartMinute([14 * 60 + 10, 15 * 60 + 20]), 14 * 60 + 10);
    assert.equal(customStartMinute([14 * 60 + 10, 15 * 60 + 30]), 14 * 60 + 30);
    assert.equal(customStartMinute([14 * 60, 15 * 60]), 14 * 60);
    assert.equal(customStartMinute([14 * 60 + 31, 18 * 60]), 15 * 60);

    cyclists([['14:10', '15:20'], ['14:00', '16:00'], 'allday']); // 交集 14:10–15:20
    runMatching(s.db);
    let [p] = pendingProposals();
    assert.ok(JSON.parse(p.reasons).includes('大家都有空：14:10–15:20'));
    assert.ok(!JSON.parse(p.reasons).some((r) => r.startsWith('时间都')));
    s.db.run("UPDATE proposals SET status = 'rejected'");

    const same = cyclists([['19:00', '21:00'], ['19:00', '21:00'], ['19:00', '21:00']]);
    runMatching(s.db);
    [p] = pendingProposals();
    assert.deepEqual(JSON.parse(p.user_ids), same.map((x) => x.user));
    assert.equal(p.slot, 'evening');
    // 60 + 时间窗完全一样 10 + 都偏慢热 10 + 共同兴趣「看日出」5 + 全员信用良好 5
    assert.equal(p.score, 90);
    assert.ok(JSON.parse(p.risks).includes('夜间局，集合点要选人多的地方'));
  });

  test('只用时间段时建议局的 window / windowLabel / defaultStartAt 和原来的默认集合时间一致', async () => {
    [1, 2, 3].forEach(() => makeIntent(s.db, makeUser(s.db))); // 周六上午看日出
    runMatching(s.db);
    const { items } = await s.ok('GET', '/api/admin/proposals', { token: admin });
    assert.deepEqual(items[0].window, { from: '05:00', to: '12:00' });
    assert.equal(items[0].windowLabel, '清晨');
    assert.equal(items[0].defaultStartAt, '2026-10-30T21:50:00.000Z'); // 周六 05:50
    assert.ok(items[0].reasons.includes('时间都在周六清晨'));
  });
});

describe('意向的时间：过期', () => {
  test('自定义时间段在 date_to + timeTo 过期；时间段的过期时间不变', async () => {
    const u = makeUser(s.db);
    const custom = makeIntent(s.db, u, { task: '咖啡', date_from: '2026-10-26', date_to: '2026-10-26', slot: 'afternoon', time_from: '11:00', time_to: '13:30' });
    const morning = makeIntent(s.db, makeUser(s.db), { task: '爬山', date_from: '2026-10-26', date_to: '2026-10-26', slot: 'morning' });
    clock.set('2026-10-26T04:00:00.000Z'); // 北京 12:00：上午的过期，13:30 的还没有
    runMatching(s.db);
    assert.equal(s.db.get('SELECT status FROM intents WHERE id = ?', morning).status, 'expired');
    assert.equal(s.db.get('SELECT status FROM intents WHERE id = ?', custom).status, 'open');
    clock.set('2026-10-26T05:29:00.000Z'); // 13:29
    runMatching(s.db);
    assert.equal(s.db.get('SELECT status FROM intents WHERE id = ?', custom).status, 'open');
    clock.set('2026-10-26T05:30:00.000Z'); // 13:30
    runMatching(s.db);
    assert.equal(s.db.get('SELECT status FROM intents WHERE id = ?', custom).status, 'expired');

    // 提交时已经过去的时间段直接拒绝
    const token = await s.login(makeUser(s.db));
    const r = await s.api('POST', '/api/intents', { token, body: { task: '咖啡', when: 'today', timeFrom: '06:00', timeTo: '13:00' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.message, '这个时间段已经过去了，换个时间吧');
    const ok = await s.ok('POST', '/api/intents', { token, body: { task: '咖啡', when: 'today', timeFrom: '12:00', timeTo: '14:00' } });
    assert.equal(ok.status, 'open');
  });
});

describe('补邀：候选人的时间窗要覆盖 [开始, 开始 + 60 分钟]', () => {
  test('下午 15:00 开始的局：覆盖 15:00–16:00 的人才会被补邀', async () => {
    const group = cyclists(['afternoon', 'afternoon', 'afternoon']);
    runMatching(s.db);
    const [p] = pendingProposals();
    const { eventId } = await s.ok('POST', `/api/admin/proposals/${p.id}/confirm`, { token: admin, body: { capacity: 5 } });
    assert.equal(s.db.get('SELECT start_at FROM events WHERE id = ?', eventId).start_at, '2026-10-31T07:00:00.000Z'); // 15:00
    const [late, morning, covers, allday] = cyclists([['15:30', '18:00'], 'morning', ['14:30', '16:00'], 'allday']);
    const result = runMatching(s.db);
    assert.equal(result.backfilled, 2);
    const status = (u) => s.db.get('SELECT status FROM event_members WHERE event_id = ? AND user_id = ?', eventId, u)?.status ?? null;
    assert.equal(status(covers.user), 'invited');
    assert.equal(status(allday.user), 'invited');
    assert.equal(status(late.user), null);
    assert.equal(status(morning.user), null);
    assert.equal(group.length, 3);
  });
});

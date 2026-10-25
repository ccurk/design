import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { clock } from '../src/clock.js';
import { majority } from '../src/services/reviews.js';
import { makeUser, startServer } from './helpers.js';

let s;
let ids;
let tokens;
let eventId;

/** 4 个人的局：周六 10-31 北京时间 14:00–16:00 */
async function setupEndedEvent() {
  ids = [0, 1, 2, 3].map(() => makeUser(s.db));
  tokens = await Promise.all(ids.map((u) => s.login(u)));
  const ev = await s.ok('POST', '/api/events', {
    token: tokens[0],
    body: { title: '桌游夜 · 新手友好', category: 'game', startAt: '2026-10-31T06:00:00.000Z', place: '一苇桌游馆', capacity: 6, feeType: 'aa' },
  });
  eventId = ev.id;
  for (const t of tokens.slice(1)) await s.ok('POST', `/api/events/${eventId}/join`, { token: t });
}

const credit = (userId) => s.db.all('SELECT * FROM credit_events WHERE user_id = ? AND event_id = ?', userId, eventId);

describe('互评与信用结算', () => {
  beforeEach(async () => {
    s = await startServer();
    await setupEndedEvent();
  });
  afterEach(() => s.close());

  test('多数票，平票有利于被评价者', () => {
    assert.equal(majority({ on_time: 1, late: 1, no_show: 0 }), 'on_time');
    assert.equal(majority({ on_time: 0, late: 1, no_show: 1 }), 'late');
    assert.equal(majority({ on_time: 1, late: 0, no_show: 2 }), 'no_show');
    assert.equal(majority({ on_time: 0, late: 0, no_show: 0 }), null);
  });

  test('局结束前不能评价；结束后出现「去评价」', async () => {
    const early = await s.api('POST', `/api/events/${eventId}/reviews`, { token: tokens[1], body: { attendance: {} } });
    assert.equal(early.status, 400);
    clock.set('2026-10-31T09:00:00.000Z');
    const inbox = await s.ok('GET', '/api/inbox', { token: tokens[1] });
    assert.deepEqual(inbox.actions, [{ type: 'review', eventId, title: '「桌游夜」结束啦' }]);
    const view = await s.ok('GET', `/api/events/${eventId}/review`, { token: tokens[1] });
    assert.equal(view.submitted, false);
    assert.deepEqual(view.people.map((p) => p.id).sort(), [ids[0], ids[2], ids[3]].sort());
    assert.equal(view.event.phase, 'ended');
  });

  test('每次提交都重算全组结果，同一人同一局只保留一条记录', async () => {
    clock.set('2026-10-31T09:00:00.000Z');
    const [a, b, c, d] = ids;
    // 第 1 份：a 说 d 没来
    await s.ok('POST', `/api/events/${eventId}/reviews`, {
      token: tokens[0],
      body: { attendance: { [b]: 'on_time', [c]: 'late', [d]: 'no_show' }, feelings: ['很放松'] },
    });
    assert.equal(credit(d)[0].type, 'no_show');
    assert.equal(credit(c)[0].type, 'late');
    assert.equal(credit(a)[0].type, 'attended'); // a 自己没票，但交了评价，默认准时

    // 第 2 份：b 说 d 准时 → 1:1 平票，按有利于 d 算准时；c 被说准时 → 1:1 → 准时
    await s.ok('POST', `/api/events/${eventId}/reviews`, {
      token: tokens[1],
      body: { attendance: { [a]: 'on_time', [c]: 'on_time', [d]: 'on_time' }, feelings: [] },
    });
    assert.equal(credit(d).length, 1);
    assert.equal(credit(d)[0].type, 'attended');
    assert.equal(credit(c)[0].type, 'attended');

    // 第 3 份：c 说 d 没来 → 2:1 没来
    await s.ok('POST', `/api/events/${eventId}/reviews`, {
      token: tokens[2],
      body: { attendance: { [a]: 'on_time', [b]: 'late', [d]: 'no_show' } },
    });
    assert.equal(credit(d).length, 1);
    assert.equal(credit(d)[0].type, 'no_show');
    assert.equal(credit(b)[0].type, 'attended'); // b: 1 准时(a) vs 1 迟到(c) → 平票按准时

    const view = await s.ok('GET', `/api/events/${eventId}/review`, { token: tokens[2] });
    assert.equal(view.submitted, true);
    const me = await s.ok('GET', '/api/me', { token: tokens[3] });
    assert.equal(me.credit.noShow, 1);
    assert.equal(me.credit.level, 'fair');
  });

  test('点过「我到了」的人默认准时（算一票）；迟到 15 分钟以上点的算迟到', async () => {
    const [, b, c, d] = ids;
    clock.set('2026-10-31T06:05:00.000Z');
    await s.ok('POST', `/api/events/${eventId}/arrive`, { token: tokens[3] });
    clock.set('2026-10-31T06:30:00.000Z');
    await s.ok('POST', `/api/events/${eventId}/arrive`, { token: tokens[2] });
    clock.set('2026-10-31T09:00:00.000Z');
    // a 说 d 没来、c 准时：d 有 1 票准时（打卡）对 1 票没来 → 平票按准时；c 1 票迟到（打卡晚）对 1 票准时 → 准时
    await s.ok('POST', `/api/events/${eventId}/reviews`, {
      token: tokens[0],
      body: { attendance: { [b]: 'on_time', [c]: 'on_time', [d]: 'no_show' } },
    });
    assert.equal(credit(d)[0].type, 'attended');
    assert.equal(credit(c)[0].type, 'attended');
    // 再来一票 c 迟到 → 2:1 迟到
    await s.ok('POST', `/api/events/${eventId}/reviews`, { token: tokens[1], body: { attendance: { [c]: 'late' } } });
    assert.equal(credit(c)[0].type, 'late');
  });

  test('只能评价同局的人；超过 7 天不能再评', async () => {
    clock.set('2026-10-31T09:00:00.000Z');
    const outsider = makeUser(s.db);
    const bad = await s.api('POST', `/api/events/${eventId}/reviews`, {
      token: tokens[0],
      body: { attendance: { [outsider]: 'no_show' } },
    });
    assert.equal(bad.status, 400);
    const notMember = await s.api('POST', `/api/events/${eventId}/reviews`, { token: await s.login(outsider), body: {} });
    assert.equal(notMember.status, 403);
    clock.set('2026-11-08T09:00:00.000Z');
    const late = await s.api('POST', `/api/events/${eventId}/reviews`, { token: tokens[0], body: {} });
    assert.equal(late.status, 400);
  });
});

// 时间重叠检测：一个人已加入（joined / applied）的局，时间段 [开始, 开始 + 时长] 不能和新局重叠。
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { clock } from '../src/clock.js';
import { runMatching } from '../src/services/matching.js';
import { addCredit, makeIntent, makeUser, startServer } from './helpers.js';

let s;
let admin;

beforeEach(async () => {
  s = await startServer(); // 北京时间 2026-10-26（周一）10:00；周六是 10-31
  admin = await s.adminToken();
});
afterEach(() => s.close());

/** 周六北京时间 h 点开始的局（UTC 时间 = h - 8） */
const sat = (h, m = 0) => new Date(Date.UTC(2026, 9, 31, h - 8, m)).toISOString();

async function hostEvent(token, startAt, overrides = {}) {
  return s.ok('POST', '/api/events', {
    token,
    body: { title: '苍山看日出', tag: '看日出', startAt, durationMin: 120, place: '古城南门', capacity: 6, feeType: 'aa', ...overrides },
  });
}

describe('报名、发起、通过申请时检查重叠', () => {
  test('报名：和已加入的局重叠 → 409（写明哪个局、几点到几点）；首尾相接不算重叠', async () => {
    const [h1, h2, h3, me] = await Promise.all([1, 2, 3, 4].map(() => s.login(makeUser(s.db))));
    const a = await hostEvent(h1, sat(14), { title: '周六下午 · 苍山看日出' }); // 14:00–16:00
    const b = await hostEvent(h2, sat(15), { title: '读书局', tag: '读书' }); // 15:00–17:00
    const c = await hostEvent(h3, sat(16), { title: '桌游局', tag: '桌游' }); // 16:00–18:00
    await s.ok('POST', `/api/events/${a.id}/join`, { token: me });
    const r = await s.api('POST', `/api/events/${b.id}/join`, { token: me });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.message, '和你已加入的「苍山看日出」（10月31日 14:00–16:00）时间重叠了');
    assert.equal((await s.ok('POST', `/api/events/${c.id}/join`, { token: me })).myStatus, 'joined');
    // 退出后就不冲突了
    await s.ok('POST', `/api/events/${a.id}/leave`, { token: me });
    await s.ok('POST', `/api/events/${c.id}/leave`, { token: me });
    assert.equal((await s.ok('POST', `/api/events/${b.id}/join`, { token: me })).myStatus, 'joined');
  });

  test('申请中（applied）的局也算；发起局时发起人自动加入，同样检查', async () => {
    const [h1, me] = await Promise.all([1, 2].map(() => s.login(makeUser(s.db))));
    const a = await hostEvent(h1, sat(14), { requireApproval: true });
    assert.equal((await s.ok('POST', `/api/events/${a.id}/join`, { token: me })).myStatus, 'applied');
    const r = await s.api('POST', '/api/events', {
      token: me,
      body: { title: '洱海边散步', tag: '随便走走', startAt: sat(15, 30), place: '才村码头', capacity: 4 },
    });
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /^和你已加入的「苍山看日出」（10月31日 14:00–16:00）时间重叠了$/);
    assert.equal(s.db.get("SELECT COUNT(*) AS n FROM events WHERE title = '洱海边散步'").n, 0);
    // 已取消的局不算
    await s.ok('POST', `/api/events/${a.id}/cancel`, { token: h1 });
    assert.equal((await hostEvent(me, sat(15, 30))).status, 'open');
  });

  test('发起人通过申请时检查申请人（不透露对方另一个局的细节）', async () => {
    const [host, applicant, other] = [makeUser(s.db), makeUser(s.db), makeUser(s.db, { nickname: '小林' })];
    const [th, to] = [await s.login(host), await s.login(other)];
    const ev = await hostEvent(th, sat(14), { requireApproval: true });
    await s.ok('POST', `/api/events/${ev.id}/join`, { token: to });
    // 小林在申请后又被拉进了同一时间的另一个局（比如历史数据），通过时拦下
    const busy = await hostEvent(await s.login(applicant), sat(13));
    s.db.insert('event_members', { event_id: busy.id, user_id: other, role: 'member', status: 'joined', attendance: 'pending', joined_at: clock.iso() });
    const r = await s.api('POST', `/api/events/${ev.id}/applications/${other}/approve`, { token: th });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.message, '小林 这个时间已经有别的局了，不能通过');
    assert.equal(s.db.get('SELECT status FROM event_members WHERE event_id = ? AND user_id = ?', ev.id, other).status, 'applied');
  });
});

describe('撮合局：接受邀请、后台确认、引擎排时间', () => {
  async function sunriseProposal(n = 3) {
    const users = Array.from({ length: n }, (_, i) => makeUser(s.db, { nickname: `日出${i + 1}` }));
    users.forEach((u) => addCredit(s.db, u, 'attended', 2));
    users.forEach((u) => makeIntent(s.db, u)); // 周六上午看日出 → 05:50 开始，4 小时
    runMatching(s.db);
    const { items } = await s.ok('GET', '/api/admin/proposals', { token: admin });
    return { proposal: items[0], users, tokens: await Promise.all(users.map((u) => s.login(u))) };
  }

  test('后台确认时有成员时间冲突 → 409 并写明是谁', async () => {
    const { proposal, tokens } = await sunriseProposal();
    const other = await s.login(makeUser(s.db));
    const ev = await hostEvent(other, sat(8), { title: '喜洲吃早餐', tag: '早餐' }); // 08:00–10:00，和 05:50–09:50 重叠
    await s.ok('POST', `/api/events/${ev.id}/join`, { token: tokens[1] });
    const r = await s.api('POST', `/api/admin/proposals/${proposal.id}/confirm`, { token: admin, body: {} });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.message, '日出2 和已加入的「喜洲吃早餐」（10月31日 08:00–10:00）时间重叠了');
    // 改个时间就能确认
    const ok = await s.ok('POST', `/api/admin/proposals/${proposal.id}/confirm`, {
      token: admin,
      body: { startAt: sat(10, 30), durationMin: 120 },
    });
    assert.ok(ok.eventId);
  });

  test('接受邀请：和已加入的局重叠 → 409，仍然是 invited', async () => {
    const { proposal, users, tokens } = await sunriseProposal();
    const { eventId } = await s.ok('POST', `/api/admin/proposals/${proposal.id}/confirm`, { token: admin, body: {} });
    const other = await s.login(makeUser(s.db));
    const ev = await hostEvent(other, sat(7), { title: '洱海边早餐', tag: '早餐' });
    await s.ok('POST', `/api/events/${ev.id}/join`, { token: tokens[0] }); // 被邀请（还没加入）不挡报名
    const r = await s.api('POST', `/api/matches/${eventId}/accept`, { token: tokens[0] });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.message, '和你已加入的「洱海边早餐」（10月31日 07:00–09:00）时间重叠了');
    assert.equal(s.db.get('SELECT status FROM event_members WHERE event_id = ? AND user_id = ?', eventId, users[0]).status, 'invited');
    const accepted = await s.ok('POST', `/api/matches/${eventId}/accept`, { token: tokens[1] });
    assert.equal(accepted.myStatus, 'joined');
  });

  test('撮合引擎排时间时跳过有冲突的成员（留在撮合池里）', async () => {
    const users = Array.from({ length: 4 }, () => makeUser(s.db));
    users.forEach((u) => addCredit(s.db, u, 'attended', 2));
    const intents = users.map((u) => makeIntent(s.db, u));
    // 第 1 个人周六 08:00 已经有局了（和 05:50–09:50 重叠）
    const other = await s.login(makeUser(s.db));
    const ev = await hostEvent(other, sat(8), { tag: '早餐', title: '早餐局' });
    await s.ok('POST', `/api/events/${ev.id}/join`, { token: await s.login(users[0]) });
    assert.equal(runMatching(s.db).created, 1);
    const p = s.db.get("SELECT * FROM proposals WHERE status = 'pending'");
    assert.deepEqual(JSON.parse(p.user_ids), users.slice(1));
    assert.equal(s.db.get('SELECT status FROM intents WHERE id = ?', intents[0]).status, 'open');

    // 只剩 2 个没冲突的人：凑不够 3 人就不成组
    const more = Array.from({ length: 3 }, () => makeUser(s.db));
    more.forEach((u) => makeIntent(s.db, u, { task: '爬山' }));
    await s.ok('POST', `/api/events/${ev.id}/join`, { token: await s.login(more[0]) });
    assert.equal(runMatching(s.db).created, 0);
    assert.equal(s.db.get("SELECT COUNT(*) AS n FROM intents WHERE task = '爬山' AND status = 'open'").n, 3);
  });
});

describe('提交意向：时间窗里已经没有连续 60 分钟的空档 → 409', () => {
  test('被已加入的局占满 → 409「这个时间你已经有局了：…」；还有空档或周末另一天有空就可以', async () => {
    const me = makeUser(s.db);
    const token = await s.login(me);
    const host = await s.login(makeUser(s.db));
    const ev = await hostEvent(host, sat(14), { title: '周六下午 · 读书局', tag: '读书', durationMin: 180 }); // 14:00–17:00
    await s.ok('POST', `/api/events/${ev.id}/join`, { token });
    const post = (body) => s.api('POST', '/api/intents', { token, body: { task: '骑行', when: '2026-10-31', ...body } });

    let r = await post({ timeFrom: '14:00', timeTo: '15:30' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.message, '这个时间你已经有局了：「读书局」（10月31日 14:00–17:00）');
    r = await post({ timeFrom: '13:30', timeTo: '17:30' }); // 前后各剩 30 分钟
    assert.equal(r.status, 409);
    r = await post({ timeFrom: '13:00', timeTo: '17:30' }); // 13:00–14:00 有一个小时
    assert.equal(r.status, 200);
    await s.ok('DELETE', `/api/intents/${r.body.id}`, { token });
    r = await post({ slot: 'afternoon' }); // 12:00–14:00、17:00–18:00 都有空
    assert.equal(r.status, 200);
    await s.ok('DELETE', `/api/intents/${r.body.id}`, { token });
    r = await post({ when: 'weekend', timeFrom: '14:00', timeTo: '15:30' }); // 周日有空
    assert.equal(r.status, 200);
  });
});

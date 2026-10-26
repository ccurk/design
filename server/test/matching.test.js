import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { setSetting } from '../src/services/settings.js';
import { runMatching } from '../src/services/matching.js';
import { addCredit, makeIntent, makeUser, startServer } from './helpers.js';

let s;

function pending() {
  return s.db.all("SELECT * FROM proposals WHERE status = 'pending' ORDER BY id").map((p) => ({
    ...p,
    userIds: JSON.parse(p.user_ids),
    reasons: JSON.parse(p.reasons),
    risks: JSON.parse(p.risks),
  }));
}

describe('撮合引擎', () => {
  beforeEach(async () => {
    if (s) await s.close();
    s = await startServer(); // 北京时间周一 10:00；意向默认是周六（10-31）上午看日出
  });
  after(() => s.close());

  test('同任务、同日期、同时间段的人按提交顺序组成一组', () => {
    const users = [1, 2, 3].map(() => makeUser(s.db));
    users.forEach((u) => addCredit(s.db, u, 'attended', 2));
    const intents = users.map((u) => makeIntent(s.db, u));
    const result = runMatching(s.db);
    assert.equal(result.created, 1);
    const [p] = pending();
    assert.deepEqual(p.userIds, users);
    assert.equal(p.date, '2026-10-31');
    assert.equal(p.slot, 'morning');
    assert.equal(p.title, '周六清晨 · 一起看日出');
    for (const id of intents) {
      const row = s.db.get('SELECT status, proposal_id FROM intents WHERE id = ?', id);
      assert.equal(row.status, 'proposed');
      assert.equal(row.proposal_id, p.id);
    }
  });

  test('不同任务 / 不同地区 / 日期不重叠 / 时间段不同 都不会配到一起', () => {
    const a = makeUser(s.db);
    const b = makeUser(s.db);
    const c = makeUser(s.db);
    const d = makeUser(s.db);
    makeIntent(s.db, a);
    makeIntent(s.db, b, { task: '爬山' });
    makeIntent(s.db, c, { area: '双廊' });
    makeIntent(s.db, d, { date_from: '2026-11-01', date_to: '2026-11-01' });
    const e = makeUser(s.db);
    makeIntent(s.db, e, { slot: 'evening' });
    assert.equal(runMatching(s.db).created, 0);
  });

  test('allday 或「时间放宽到全天」可以和任何时间段配', () => {
    const users = [1, 2, 3].map(() => makeUser(s.db));
    makeIntent(s.db, users[0], { slot: 'afternoon' });
    makeIntent(s.db, users[1], { slot: 'allday' });
    makeIntent(s.db, users[2], { slot: 'morning', relax_time: 1 });
    runMatching(s.db);
    const [p] = pending();
    assert.ok(p, '应该生成一条建议');
    assert.equal(p.slot, 'afternoon'); // 以有固定时间段的人为准
    assert.ok(p.reasons.some((r) => r.startsWith('时间都能凑上')));
  });

  test('互相拉黑的人不能在同一组', () => {
    const users = [1, 2, 3, 4].map(() => makeUser(s.db));
    s.db.insert('blocks', { user_id: users[1], blocked_id: users[0], created_at: new Date().toISOString() });
    users.forEach((u) => makeIntent(s.db, u));
    runMatching(s.db);
    const [p] = pending();
    // 1 号是种子；2 号拉黑了 1 号所以被跳过；3、4 号加入
    assert.deepEqual(p.userIds, [users[0], users[2], users[3]]);
    assert.equal(s.db.get('SELECT status FROM intents WHERE user_id = ?', users[1]).status, 'open');
  });

  test('开了「只参加同性局」：整组必须同性，性别未知的人不进同性组', () => {
    const f1 = makeUser(s.db, { gender: 'female', settings: { sameSexOnly: true } });
    const m1 = makeUser(s.db, { gender: 'male' });
    const unknown = makeUser(s.db, { gender: 'unknown' });
    const f2 = makeUser(s.db, { gender: 'female' });
    const f3 = makeUser(s.db, { gender: 'female' });
    [f1, m1, unknown, f2, f3].forEach((u) => makeIntent(s.db, u));
    runMatching(s.db);
    const [p] = pending();
    assert.deepEqual(p.userIds, [f1, f2, f3]);
  });

  test('人数：达到所有人 size_min 的最大值才成组，最多到 size_max 的最小值', () => {
    const users = Array.from({ length: 7 }, () => makeUser(s.db));
    users.forEach((u) => makeIntent(s.db, u)); // 3–5 人
    runMatching(s.db);
    const props = pending();
    assert.equal(props.length, 1);
    assert.equal(props[0].userIds.length, 5);
    // 剩下 2 个人不够 3 人，继续等
    assert.equal(s.db.get("SELECT COUNT(*) AS n FROM intents WHERE status = 'open'").n, 2);

    // 有人只想要小局：size_max = 3
    const more = Array.from({ length: 4 }, () => makeUser(s.db));
    makeIntent(s.db, more[0], { task: '咖啡', slot: 'afternoon', size_min: 2, size_max: 3 });
    more.slice(1).forEach((u) => makeIntent(s.db, u, { task: '咖啡', slot: 'afternoon' }));
    runMatching(s.db);
    const coffee = pending().find((p) => p.task === '咖啡');
    assert.equal(coffee.userIds.length, 3);
  });

  test('人数不够不成组；开了「2–6 人都可以」按 2–6 算', () => {
    const a = makeUser(s.db);
    const b = makeUser(s.db);
    makeIntent(s.db, a, { task: '桌游', slot: 'evening' });
    const ib = makeIntent(s.db, b, { task: '桌游', slot: 'evening' });
    assert.equal(runMatching(s.db).created, 0);
    s.db.update('intents', ib, { relax_size: 1 });
    assert.equal(runMatching(s.db).created, 0); // a 仍要求至少 3 人
    s.db.run("UPDATE intents SET relax_size = 1 WHERE task = '桌游'");
    assert.equal(runMatching(s.db).created, 1);
    const [p] = pending();
    assert.ok(p.risks.includes('夜间局，集合点要选人多的地方'));
  });

  test('匹配度、理由、风险', () => {
    const interests = ['看日出', '咖啡', '读书'];
    const users = [1, 2, 3].map(() => makeUser(s.db, { pace: 'slow', interests }));
    users.forEach((u) => addCredit(s.db, u, 'attended', 3));
    users.forEach((u) => makeIntent(s.db, u));
    runMatching(s.db);
    let [p] = pending();
    // 60 + 节奏 10 + 时间段 10 + 共同兴趣 3×5 + 全员良好 5 = 100
    assert.equal(p.score, 100);
    assert.deepEqual(p.reasons, ['都想去看日出', '时间都在周六清晨', '都偏慢热', '共同兴趣：看日出、咖啡、读书', '全员信用良好']);
    assert.deepEqual(p.risks, []);

    // 新人 + 信用一般 + 节奏不同
    const fresh = makeUser(s.db, { pace: 'open', interests: ['爬山'] });
    const fair = makeUser(s.db, { pace: 'slow', interests: ['爬山'] });
    addCredit(s.db, fair, 'attended', 8);
    addCredit(s.db, fair, 'cancel_late', 2);
    const third = makeUser(s.db, { pace: 'slow', interests: ['爬山', '拍照'] });
    addCredit(s.db, third, 'attended', 1);
    [fresh, fair, third].forEach((u) => makeIntent(s.db, u, { task: '爬山' }));
    runMatching(s.db);
    p = pending().find((x) => x.task === '爬山');
    assert.equal(p.score, 60 + 10 + 5); // 时间段一致 + 1 个共同兴趣
    assert.deepEqual(p.risks, ['有 1 人信用一般', '1 位是第一次参加']);
  });

  test('受限 / 封禁的人不参与撮合', () => {
    const users = [1, 2, 3].map(() => makeUser(s.db));
    s.db.update('users', users[2], { status: 'restricted', restricted_until: '2099-01-01T00:00:00.000Z' });
    users.forEach((u) => makeIntent(s.db, u));
    assert.equal(runMatching(s.db).created, 0);
  });

  test('过期意向会被标记为 expired', () => {
    const u = makeUser(s.db);
    const id = makeIntent(s.db, u, { date_from: '2026-10-25', date_to: '2026-10-25' });
    runMatching(s.db);
    assert.equal(s.db.get('SELECT status FROM intents WHERE id = ?', id).status, 'expired');
  });

  test('后台退回后，同一组人同一天不会再被配到一起', async () => {
    const users = [1, 2, 3].map(() => makeUser(s.db));
    users.forEach((u) => makeIntent(s.db, u));
    runMatching(s.db);
    const [p] = pending();
    const admin = await s.adminToken();
    await s.ok('POST', `/api/admin/proposals/${p.id}/reject`, { token: admin, body: { note: '时间太早' } });
    assert.equal(s.db.get("SELECT COUNT(*) AS n FROM intents WHERE status = 'open'").n, 3);
    assert.equal(runMatching(s.db).created, 0);
  });

  test('自动成局：分数够且没有风险时直接确认', () => {
    setSetting(s.db, 'autoConfirm', { enabled: true, threshold: 80 });
    const users = [1, 2, 3].map(() => makeUser(s.db, { interests: ['看日出'] }));
    users.forEach((u) => addCredit(s.db, u, 'attended', 1));
    users.forEach((u) => makeIntent(s.db, u));
    const result = runMatching(s.db);
    assert.equal(result.autoConfirmed, 1);
    const event = s.db.get("SELECT * FROM events WHERE source = 'matched'");
    assert.equal(event.status, 'inviting');
  });

  test('提交意向后立刻撮合，并能看到同意向人数', async () => {
    const a = makeUser(s.db);
    const b = makeUser(s.db);
    const ta = await s.login(a);
    const tb = await s.login(b);
    const ia = await s.ok('POST', '/api/intents', { token: ta, body: { task: '骑行', when: '2026-11-01', slot: 'afternoon' } });
    assert.equal(ia.title, '周日下午 · 骑行');
    assert.equal(ia.slotLabel, '下午');
    assert.equal(ia.timeLabel, '下午');
    assert.deepEqual([ia.timeFrom, ia.timeTo], [null, null]);
    await s.ok('POST', '/api/intents', { token: tb, body: { task: '骑行', when: '2026-11-01', slot: 'afternoon' } });
    const detail = await s.ok('GET', `/api/intents/${ia.id}`, { token: ta });
    assert.equal(detail.similarCount, 1);
    assert.equal(detail.needMore, 1);

    const c = makeUser(s.db);
    const tc = await s.login(c);
    const ic = await s.ok('POST', '/api/intents', { token: tc, body: { task: '骑行', when: '2026-11-01', slot: 'afternoon' } });
    assert.equal(ic.status, 'proposed');
    const dup = await s.api('POST', '/api/intents', { token: tc, body: { task: '骑行', when: '2026-11-01' } });
    assert.equal(dup.status, 409);
  });

  test('放宽条件：PUT 和 PATCH 都能改（小程序只能用 PUT）', async () => {
    const token = await s.login(makeUser(s.db));
    const intent = await s.ok('POST', '/api/intents', { token, body: { task: '爬山', when: '2026-11-01', slot: 'morning' } });
    assert.equal(intent.relaxTime, false);
    const viaPut = await s.ok('PUT', `/api/intents/${intent.id}`, { token, body: { relaxTime: true } });
    assert.equal(viaPut.relaxTime, true);
    assert.equal(viaPut.relaxSize, false);
    const viaPatch = await s.ok('PATCH', `/api/intents/${intent.id}`, { token, body: { relaxSize: true } });
    assert.equal(viaPatch.relaxTime, true);
    assert.equal(viaPatch.relaxSize, true);
  });
});

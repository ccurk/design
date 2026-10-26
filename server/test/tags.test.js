import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { clock } from '../src/clock.js';
import { runMatching } from '../src/services/matching.js';
import { normalizeTagName, parseTag, tagKey } from '../src/services/tags.js';
import { DAY, makeUser, startServer } from './helpers.js';

let s;
let admin;
const SAT_2PM = '2026-10-31T06:00:00.000Z';

beforeEach(async () => {
  s = await startServer(); // 北京时间 2026-10-26（周一）10:00
  admin = await s.adminToken();
});
afterEach(() => s.close());

const tagRow = (name) => s.db.get('SELECT * FROM tags WHERE key = ?', tagKey(name));

describe('标签：规范化与校验', () => {
  test('NFKC、去首尾空格、合并连续空白；key 再把拉丁字母转小写', () => {
    assert.equal(normalizeTagName('  ＫＴＶ　　唱歌 '), 'KTV 唱歌');
    assert.equal(tagKey('  ＫＴＶ　　唱歌 '), 'ktv 唱歌');
    assert.equal(tagKey('Ktv'), tagKey('ktv'));
    assert.equal(parseTag('飞盘·夜场'), '飞盘·夜场');
    assert.equal(parseTag('a-b_c 1'), 'a-b_c 1');
    assert.equal(parseTag('－飞盘＿'), '-飞盘_'); // 全角符号经 NFKC 变半角
  });

  test('1–8 个字；只允许文字、数字、空格和 ·-_；审核不过 → 422「这个标签不能用」', async () => {
    const token = await s.login(makeUser(s.db));
    const post = (task) => s.api('POST', '/api/intents', { token, body: { task, when: 'tomorrow' } });
    for (const [task, status, message] of [
      ['', 400, '请填写想做的事'],
      ['   ', 400, '请填写想做的事'],
      ['一二三四五六七八九', 400, '想做的事最多 8 个字'],
      ['唱歌🎤', 400, '想做的事只能用文字、数字、空格和 ·-_'],
      ['爬山!', 400, '想做的事只能用文字、数字、空格和 ·-_'],
      ['代购', 422, '这个标签不能用'],
      ['QQ12345', 422, '这个标签不能用'],
    ]) {
      const r = await post(task);
      assert.equal(r.status, status, task);
      assert.equal(r.body.error.message, message, task);
    }
    assert.equal((await post('一二三四五六七八')).status, 200); // 正好 8 个字
  });
});

describe('标签：用户添加、撮合按 key 比较', () => {
  test('新标签自动建一条（hot=0）并记 last_used_at；「KTV」和「ktv」是同一个标签，能配到一起', async () => {
    const users = [1, 2, 3].map(() => makeUser(s.db));
    const tokens = await Promise.all(users.map((u) => s.login(u)));
    const first = await s.ok('POST', '/api/intents', { token: tokens[0], body: { task: 'KTV', when: '2026-10-31', slot: 'evening' } });
    assert.equal(first.task, 'KTV');
    assert.equal(first.category, 'other');
    const row = tagRow('KTV');
    assert.deepEqual([row.name, row.hot, row.category, row.last_used_at], ['KTV', 0, 'other', clock.iso()]);

    clock.advance(60000);
    const second = await s.ok('POST', '/api/intents', { token: tokens[1], body: { task: ' ｋｔｖ ', when: '2026-10-31', slot: 'evening' } });
    assert.equal(second.task, 'KTV'); // 用标签表里的写法
    assert.equal(s.db.get("SELECT COUNT(*) AS n FROM tags WHERE key = 'ktv'").n, 1);
    assert.equal(tagRow('ktv').last_used_at, clock.iso());
    const third = await s.ok('POST', '/api/intents', { token: tokens[2], body: { task: 'Ktv', when: '2026-10-31', slot: 'evening' } });
    assert.equal(third.status, 'proposed');
    const p = s.db.get("SELECT * FROM proposals WHERE status = 'pending'");
    assert.deepEqual(JSON.parse(p.user_ids), users);
    // 同一个人同一天、同一个标签（大小写不同）算重复
    const dup = await s.api('POST', '/api/intents', { token: tokens[0], body: { task: 'ktv', when: '2026-10-31', slot: 'afternoon' } });
    assert.equal(dup.status, 409);
  });

  test('只用内置任务名时行为不变：不同标签不会配到一起', () => {
    const users = [1, 2, 3].map(() => makeUser(s.db));
    users.forEach((u, i) =>
      s.db.insert('intents', {
        user_id: u,
        task: ['看日出', '爬山', '看日出'][i],
        category: 'outdoor',
        date_from: '2026-10-31',
        date_to: '2026-10-31',
        slot: 'morning',
        area: '古城',
        status: 'open',
        created_at: clock.iso(),
      }),
    );
    assert.equal(runMatching(s.db).created, 0);
  });
});

describe('标签：热门列表（后台维护）', () => {
  test('GET /api/tags/hot 不需要登录，按顺序返回 { name, category, cover }', async () => {
    const { items } = await s.ok('GET', '/api/tags/hot');
    assert.deepEqual(
      items.map((t) => t.name),
      ['看日出', '爬山', '骑行', '咖啡', '吃饭', '桌游', '拼车', '随便走走', '读书', '拍照'],
    );
    assert.deepEqual(items[0], { name: '看日出', category: 'outdoor', cover: 'sunrise' });
    assert.deepEqual(items.at(-1), { name: '拍照', category: 'outdoor', cover: 'lake' });
  });

  test('后台：scope=hot 按顺序；scope=all 按最近使用次数倒序；PUT /tags/hot 整体替换热门列表', async () => {
    const [a, b] = [makeUser(s.db), makeUser(s.db)];
    const [ta, tb] = [await s.login(a), await s.login(b)];
    // 「徒步」40 天前用过 1 次，最近用了 2 次；「早餐」最近 1 次
    s.db.insert('intents', {
      user_id: a, task: '徒步', category: 'outdoor', date_from: '2026-09-15', date_to: '2026-09-15', slot: 'morning', area: '古城',
      status: 'expired', created_at: new Date(clock.now().getTime() - 40 * DAY).toISOString(),
    });
    await s.ok('POST', '/api/intents', { token: ta, body: { task: '徒步', when: '2026-11-01' } });
    await s.ok('POST', '/api/intents', { token: tb, body: { task: '徒步', when: '2026-11-01' } });
    await s.ok('POST', '/api/intents', { token: ta, body: { task: '早餐', when: '2026-11-02' } });

    const all = await s.ok('GET', '/api/admin/tags?scope=all', { token: admin });
    assert.deepEqual(all.items.slice(0, 2).map((t) => [t.name, t.recentCount, t.useCount]), [
      ['徒步', 2, 3],
      ['早餐', 1, 1],
    ]);
    const hiking = all.items[0];
    assert.equal(hiking.hot, false);
    assert.equal(hiking.cover, 'mountain');
    assert.ok(hiking.lastUsedAt);
    const longer = await s.ok('GET', '/api/admin/tags?scope=all&days=60', { token: admin });
    assert.equal(longer.items[0].recentCount, 3);
    assert.equal((await s.api('GET', '/api/admin/tags?scope=nope', { token: admin })).status, 400);
    assert.equal((await s.api('GET', '/api/admin/tags?days=0', { token: admin })).status, 400);

    const hot = await s.ok('GET', '/api/admin/tags?scope=hot', { token: admin });
    assert.equal(hot.items.length, 10);
    assert.deepEqual(hot.items.map((t) => t.sort), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const byName = Object.fromEntries(all.items.map((t) => [t.name, t.id]));
    const replaced = await s.ok('PUT', '/api/admin/tags/hot', { token: admin, body: { ids: [byName['徒步'], byName['看日出'], byName['拍照']] } });
    assert.deepEqual(replaced.items.map((t) => t.name), ['徒步', '看日出', '拍照']);
    assert.deepEqual((await s.ok('GET', '/api/tags/hot')).items.map((t) => t.name), ['徒步', '看日出', '拍照']);
    assert.equal(tagRow('爬山').hot, 0);
    assert.equal((await s.api('PUT', '/api/admin/tags/hot', { token: admin, body: { ids: [byName['徒步'], 99999] } })).status, 404);
    assert.equal((await s.api('PUT', '/api/admin/tags/hot', { token: admin, body: { ids: [byName['徒步'], byName['徒步']] } })).status, 400);
    assert.equal((await s.api('PUT', '/api/admin/tags/hot', { token: admin, body: { ids: 'x' } })).status, 400);
  });

  test('后台增删改：重名 409；新热门排在最后；插画不设时按分类给默认值', async () => {
    const dup = await s.api('POST', '/api/admin/tags', { token: admin, body: { name: ' 徒步 ', category: 'outdoor' } });
    assert.equal(dup.status, 409);
    assert.equal((await s.api('POST', '/api/admin/tags', { token: admin, body: { name: '飞盘', category: 'sports' } })).status, 400);
    assert.equal((await s.api('POST', '/api/admin/tags', { token: admin, body: { name: '飞盘', category: 'outdoor', cover: 'beach' } })).status, 400);
    assert.equal((await s.api('POST', '/api/admin/tags', { token: admin, body: { name: '加盟', category: 'other' } })).status, 422);

    const created = await s.ok('POST', '/api/admin/tags', { token: admin, body: { name: '飞盘', category: 'outdoor', hot: true } });
    assert.equal(created.cover, 'mountain'); // outdoor 的默认插画
    assert.equal(created.hot, true);
    assert.equal(created.sort, 10);
    assert.equal((await s.ok('GET', '/api/tags/hot')).items.at(-1).name, '飞盘');

    const updated = await s.ok('PUT', `/api/admin/tags/${created.id}`, {
      token: admin,
      body: { name: 'Frisbee', category: 'game', cover: 'lake', hot: false },
    });
    assert.deepEqual([updated.name, updated.category, updated.cover, updated.hot], ['Frisbee', 'game', 'lake', false]);
    const reset = await s.ok('PUT', `/api/admin/tags/${created.id}`, { token: admin, body: { cover: null } });
    assert.equal(reset.cover, 'boardgame'); // game 的默认插画
    const clash = await s.api('PUT', `/api/admin/tags/${created.id}`, { token: admin, body: { name: '桌游' } });
    assert.equal(clash.status, 409);

    assert.deepEqual(await s.ok('DELETE', `/api/admin/tags/${created.id}`, { token: admin }), { ok: true });
    assert.equal((await s.api('PUT', `/api/admin/tags/${created.id}`, { token: admin, body: { hot: true } })).status, 404);
    assert.equal((await s.api('DELETE', `/api/admin/tags/${created.id}`, { token: admin })).status, 404);
    // 用户 token 不能调
    const user = await s.login(makeUser(s.db));
    assert.equal((await s.api('GET', '/api/admin/tags', { token: user })).status, 401);
  });
});

describe('局的标签', () => {
  async function create(token, body) {
    return s.ok('POST', '/api/events', {
      token,
      body: { title: '周六一起玩', startAt: SAT_2PM, place: '古城', capacity: 4, feeType: 'aa', ...body },
    });
  }

  test('用 tag 发起，分类由标签推出；旧的 category 仍接受；新标签用 category 当分类', async () => {
    const tokens = await Promise.all([1, 2, 3, 4].map(() => s.login(makeUser(s.db))));
    const photo = await create(tokens[0], { tag: '拍照' });
    assert.deepEqual([photo.tag, photo.task, photo.category, photo.coverKey], ['拍照', '拍照', 'outdoor', 'lake']);
    const legacy = await create(tokens[1], { title: '周六喝咖啡', category: 'coffee' });
    assert.deepEqual([legacy.tag, legacy.category, legacy.coverKey], ['咖啡', 'coffee', 'coffee']);
    const fresh = await create(tokens[2], { tag: '剧本杀', category: 'game' });
    assert.deepEqual([fresh.tag, fresh.category, fresh.coverKey], ['剧本杀', 'game', 'boardgame']);
    assert.equal(tagRow('剧本杀').hot, 0);
    const noHint = await create(tokens[3], { tag: 'Live' });
    assert.deepEqual([noHint.category, noHint.coverKey], ['other', 'oldtown']);
    assert.equal((await s.api('POST', '/api/events', { token: tokens[3], body: { title: '没标签的局', startAt: SAT_2PM, place: '古城', capacity: 4 } })).status, 400);
  });

  test('GET /api/events?tag= 按规范化后的标签筛', async () => {
    const tokens = await Promise.all([1, 2, 3].map(() => s.login(makeUser(s.db))));
    const ktv = await create(tokens[0], { tag: 'KTV' });
    const cycling = await create(tokens[1], { tag: '骑行' });
    await create(tokens[2], { tag: '咖啡' });
    assert.deepEqual((await s.ok('GET', '/api/events?tag=ktv')).items.map((e) => e.id), [ktv.id]);
    assert.deepEqual((await s.ok('GET', `/api/events?tag=${encodeURIComponent(' ＫＴＶ ')}`)).items.map((e) => e.id), [ktv.id]);
    assert.deepEqual((await s.ok('GET', `/api/events?tag=${encodeURIComponent('骑行')}`)).items.map((e) => e.id), [cycling.id]);
    assert.equal((await s.ok('GET', '/api/events?tag=nothing')).items.length, 0);
    assert.equal((await s.ok('GET', '/api/events')).items.length, 3);
    assert.deepEqual((await s.ok('GET', '/api/events?tag=ktv&category=other')).items.map((e) => e.id), [ktv.id]);
    assert.equal((await s.ok('GET', '/api/events?tag=ktv&category=food')).items.length, 0);
  });
});

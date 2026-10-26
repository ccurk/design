// 首页内容、轮播图（后台）、后台上传、图片地址（库里存相对路径，返回绝对地址）。
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { clock } from '../src/clock.js';
import { makeUser, startServer } from './helpers.js';

let s;
let admin;
const BASE = 'http://localhost:3000'; // 测试配置下的 PUBLIC_BASE_URL
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

beforeEach(async () => {
  s = await startServer(); // 北京时间 2026-10-26（周一）10:00
  admin = await s.adminToken();
});
afterEach(() => s.close());

function pngForm(type = 'image/png', data = PNG, name = 'a.png') {
  const form = new FormData();
  form.append('file', new Blob([data], { type }), name);
  return form;
}

describe('后台上传 POST /api/admin/upload', () => {
  test('后台 token，multipart 字段 file，只收图片 ≤ 5MB → { url }（绝对地址，能直接访问）', async () => {
    const { url } = await s.ok('POST', '/api/admin/upload', { token: admin, form: pngForm() });
    assert.match(url, /^http:\/\/localhost:3000\/uploads\/[\w-]+\.png$/);
    const file = await fetch(`${s.base}${new URL(url).pathname}`);
    assert.equal(file.status, 200);
    const user = await s.login(makeUser(s.db));
    assert.equal((await s.api('POST', '/api/admin/upload', { token: user, form: pngForm() })).status, 401);
    assert.equal((await s.api('POST', '/api/admin/upload', { form: pngForm() })).status, 401);
    const text = await s.api('POST', '/api/admin/upload', { token: admin, form: pngForm('text/plain', Buffer.from('hi'), 'a.txt') });
    assert.equal(text.status, 400);
    const big = await s.api('POST', '/api/admin/upload', {
      token: admin,
      form: pngForm('image/jpeg', Buffer.alloc(5 * 1024 * 1024 + 10), 'big.jpg'),
    });
    assert.equal(big.status, 400);
    assert.equal(big.body.error.message, '图片不能超过 5MB');
    const empty = await s.api('POST', '/api/admin/upload', { token: admin, form: new FormData() });
    assert.equal(empty.status, 400);
  });
});

describe('轮播图（后台维护）', () => {
  test('增删改、排序、停用；图片只收本站上传的，库里存相对路径', async () => {
    const { url } = await s.ok('POST', '/api/admin/upload', { token: admin, form: pngForm() });
    const path = new URL(url).pathname;
    for (const [body, status] of [
      [{ title: '没有图' }, 400],
      [{ image: 'https://cdn.example.com/a.png', title: '外站图' }, 400],
      [{ image: url, title: '' }, 400],
      [{ image: url, title: '标题'.repeat(11) }, 400],
      [{ image: url, title: '链接不对', link: 'https://example.com' }, 400],
      [{ image: url, title: '链接不对', link: 'event:abc' }, 400],
    ]) {
      assert.equal((await s.api('POST', '/api/admin/banners', { token: admin, body })).status, status, JSON.stringify(body));
    }
    const a = await s.ok('POST', '/api/admin/banners', {
      token: admin,
      body: { image: url, title: '苍山日出', subtitle: '周六清晨一起看日出', link: 'event:12' },
    });
    assert.deepEqual(
      { ...a, createdAt: undefined },
      { id: a.id, image: `${BASE}${path}`, title: '苍山日出', subtitle: '周六清晨一起看日出', link: 'event:12', sort: 0, enabled: true, createdAt: undefined },
    );
    assert.equal(s.db.get('SELECT image FROM banners WHERE id = ?', a.id).image, path);
    const b = await s.ok('POST', '/api/admin/banners', { token: admin, body: { image: path, title: '洱海骑行', link: 'square' } });
    const c = await s.ok('POST', '/api/admin/banners', { token: admin, body: { image: path, title: '新人第一次来', link: 'rules', enabled: false } });
    assert.deepEqual([b.sort, b.subtitle, c.sort, c.enabled], [1, null, 2, false]);
    for (const link of ['create', 'feed', 'credit', 'post:3', 'chat:1', 'match:2', 'review:4', null]) {
      await s.ok('PUT', `/api/admin/banners/${b.id}`, { token: admin, body: { link } });
    }
    await s.ok('PUT', `/api/admin/banners/${b.id}`, { token: admin, body: { link: 'square' } });

    // 首页只显示开着的，按顺序
    let home = await s.ok('GET', '/api/home');
    assert.deepEqual(home.banners.map((x) => x.title), ['苍山日出', '洱海骑行']);
    assert.deepEqual(Object.keys(home.banners[0]).sort(), ['id', 'image', 'link', 'subtitle', 'title']);

    const updated = await s.ok('PUT', `/api/admin/banners/${c.id}`, { token: admin, body: { enabled: true, subtitle: '先看看社区公约' } });
    assert.deepEqual([updated.enabled, updated.subtitle, updated.title], [true, '先看看社区公约', '新人第一次来']);
    assert.equal((await s.api('PUT', `/api/admin/banners/${c.id}`, { token: admin, body: { enabled: 'yes' } })).status, 400);
    const ordered = await s.ok('PUT', '/api/admin/banners/order', { token: admin, body: { ids: [c.id, a.id] } });
    assert.deepEqual(ordered.items.map((x) => [x.title, x.sort]), [
      ['新人第一次来', 0],
      ['苍山日出', 1],
      ['洱海骑行', 2],
    ]);
    home = await s.ok('GET', '/api/home');
    assert.deepEqual(home.banners.map((x) => x.title), ['新人第一次来', '苍山日出', '洱海骑行']);
    assert.equal((await s.api('PUT', '/api/admin/banners/order', { token: admin, body: { ids: [c.id, 9999] } })).status, 404);
    assert.equal((await s.api('PUT', '/api/admin/banners/order', { token: admin, body: { ids: [c.id, c.id] } })).status, 400);

    assert.deepEqual(await s.ok('DELETE', `/api/admin/banners/${a.id}`, { token: admin }), { ok: true });
    assert.equal((await s.api('PUT', `/api/admin/banners/${a.id}`, { token: admin, body: { title: '没了' } })).status, 404);
    assert.deepEqual((await s.ok('GET', '/api/admin/banners', { token: admin })).items.map((x) => x.title), ['新人第一次来', '洱海骑行']);
    const user = await s.login(makeUser(s.db));
    assert.equal((await s.api('GET', '/api/admin/banners', { token: user })).status, 401);
  });
});

describe('首页 GET /api/home', () => {
  test('不需要登录；返回轮播图、热门标签、带图的动态、精选局、本周数据', async () => {
    const [author, host, member] = [makeUser(s.db, { nickname: '阿野' }), makeUser(s.db), makeUser(s.db)];
    const [ta, th, tm] = await Promise.all([author, host, member].map((u) => s.login(u)));
    const { url } = await s.ok('POST', '/api/upload', { token: ta, form: pngForm() });
    const withImage = await s.ok('POST', '/api/posts', { token: ta, body: { text: '洱海边的早晨', images: [url] } });
    await s.ok('POST', '/api/posts', { token: ta, body: { text: '没有图的动态', images: [] } });
    await s.ok('POST', '/api/posts', { token: ta, body: { text: '兼职日结，私聊', images: [url] } }); // 待审核，不出现
    const events = [];
    for (let i = 0; i < 8; i++) {
      const t = i === 0 ? th : await s.login(makeUser(s.db));
      events.push(
        await s.ok('POST', '/api/events', {
          token: t,
          body: { title: `周末局 ${i + 1}`, tag: '咖啡', startAt: new Date(Date.parse('2026-10-31T06:00:00.000Z') + i * 3600000).toISOString(), place: '古城', capacity: 2 },
        }),
      );
    }
    await s.ok('POST', `/api/events/${events[0].id}/join`, { token: tm }); // 满员成群 → 不在广场

    const home = await s.ok('GET', '/api/home');
    assert.deepEqual(Object.keys(home).sort(), ['banners', 'featuredEvents', 'highlights', 'hotTags', 'stats']);
    assert.deepEqual(home.banners, []);
    assert.equal(home.hotTags.length, 10);
    assert.deepEqual(Object.keys(home.hotTags[0]).sort(), ['category', 'cover', 'name']);
    assert.equal(home.highlights.length, 1);
    assert.deepEqual(home.highlights[0], {
      postId: withImage.id,
      image: `${BASE}${new URL(url).pathname}`,
      text: '洱海边的早晨',
      user: home.highlights[0].user,
      eventTitle: null,
    });
    assert.equal(home.highlights[0].user.nickname, '阿野');
    assert.deepEqual(home.featuredEvents.map((e) => e.title), ['周末局 2', '周末局 3', '周末局 4', '周末局 5', '周末局 6', '周末局 7']);
    assert.ok(['tag', 'cover', 'coverKey', 'genderLimit', 'genderLabel', 'exitDeadline'].every((k) => k in home.featuredEvents[0]));
    assert.deepEqual(home.stats, { weekPeople: 9, weekFormed: 1 }); // 8 个发起人 + 1 个成员；1 个局成群
  });

  test('登录了按拉黑过滤动态和局；近 7 天以外的不算进本周数据', async () => {
    const [me, blockedUser] = [makeUser(s.db), makeUser(s.db)];
    const [tme, tb] = [await s.login(me), await s.login(blockedUser)];
    const { url } = await s.ok('POST', '/api/upload', { token: tb, form: pngForm() });
    await s.ok('POST', '/api/posts', { token: tb, body: { text: '洱海', images: [url] } });
    await s.ok('POST', '/api/events', {
      token: tb,
      body: { title: '拉黑的人发起的局', tag: '骑行', startAt: '2026-10-31T06:00:00.000Z', place: '古城', capacity: 4 },
    });
    assert.equal((await s.ok('GET', '/api/home', { token: tme })).highlights.length, 1);
    await s.ok('POST', `/api/blocks/${blockedUser}`, { token: tme });
    const home = await s.ok('GET', '/api/home', { token: tme });
    assert.equal(home.highlights.length, 0);
    assert.equal(home.featuredEvents.length, 0);
    assert.equal((await s.ok('GET', '/api/home')).featuredEvents.length, 1);
    assert.equal(home.stats.weekPeople, 1);
    clock.advance(8 * 24 * 3600 * 1000);
    assert.deepEqual((await s.ok('GET', '/api/home')).stats, { weekPeople: 0, weekFormed: 0 });
  });
});

describe('图片地址：存相对路径，返回绝对地址', () => {
  test('动态：绝对 / 相对都能提交，外站图片不收；老数据里的绝对地址也换成当前的 PUBLIC_BASE_URL', async () => {
    const u = makeUser(s.db);
    const token = await s.login(u);
    const post = await s.ok('POST', '/api/posts', {
      token,
      body: { text: '古城', images: ['http://192.168.1.5:3000/uploads/a.png', '/uploads/b.jpg'] },
    });
    assert.deepEqual(post.images, [`${BASE}/uploads/a.png`, `${BASE}/uploads/b.jpg`]);
    assert.equal(s.db.get('SELECT images FROM posts WHERE id = ?', post.id).images, '["/uploads/a.png","/uploads/b.jpg"]');
    for (const images of [['https://cdn.example.com/x.png'], Array.from({ length: 10 }, (_, i) => `/uploads/${i}.png`)]) {
      assert.equal((await s.api('POST', '/api/posts', { token, body: { text: '外站', images } })).status, 400);
    }
    const legacy = s.db.insert('posts', {
      user_id: u,
      text: '老数据',
      images: JSON.stringify(['http://old-host:3000/uploads/c.png']),
      visibility: 'public',
      status: 'approved',
      created_at: clock.iso(),
    });
    assert.deepEqual((await s.ok('GET', `/api/posts/${legacy}`, { token })).images, [`${BASE}/uploads/c.png`]);
  });

  test('头像：本站上传的存相对路径、返回绝对地址；微信头像等外站地址原样保留', async () => {
    const u = makeUser(s.db);
    const token = await s.login(u);
    let me = await s.ok('PUT', '/api/me', { token, body: { avatarUrl: 'http://10.0.0.2:3000/uploads/avatar.png' } });
    assert.equal(me.avatarUrl, `${BASE}/uploads/avatar.png`);
    assert.equal(s.db.get('SELECT avatar_url FROM users WHERE id = ?', u).avatar_url, '/uploads/avatar.png');
    me = await s.ok('PUT', '/api/me', { token, body: { avatarUrl: 'https://thirdwx.qlogo.cn/mmopen/abc/132' } });
    assert.equal(me.avatarUrl, 'https://thirdwx.qlogo.cn/mmopen/abc/132');
    assert.equal((await s.api('PUT', '/api/me', { token, body: { avatarUrl: 'ftp://x/y.png' } })).status, 400);
  });
});

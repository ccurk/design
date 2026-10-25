import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { checkText } from '../src/moderation.js';
import { makeUser, startServer } from './helpers.js';

describe('checkText', () => {
  test('正常内容通过', () => {
    for (const text of [
      '我带了几个暖宝宝，山上清晨挺冷的',
      '5:50 古城南门集合刚好',
      'AA 约 ¥30，钱在微信里直接转',
      '2026-10-31 13:30 见',
      '',
    ]) {
      assert.deepEqual(checkText(text), { ok: true, reasons: [] }, text);
    }
  });

  test('联系方式：手机号（含空格分隔）、微信 / vx / QQ 号、网址', () => {
    assert.deepEqual(checkText('有事打我电话13812345678').reasons, ['包含手机号']);
    assert.deepEqual(checkText('电话 138 1234 5678').reasons, ['包含手机号']);
    assert.deepEqual(checkText('加我微信 lizi_2024').reasons, ['包含微信 / QQ 等联系方式']);
    assert.deepEqual(checkText('vx：dapeng888').reasons, ['包含微信 / QQ 等联系方式']);
    assert.deepEqual(checkText('V信号是abc12345').reasons, ['包含微信 / QQ 等联系方式']);
    assert.deepEqual(checkText('QQ 12345678').reasons, ['包含微信 / QQ 等联系方式']);
    assert.deepEqual(checkText('看这里 https://example.com/x').reasons, ['包含网址']);
    assert.equal(checkText('www.abc.cn').ok, false);
  });

  test('广告与擦边 / 违法', () => {
    assert.deepEqual(checkText('专业代购，兼职日结').reasons, ['疑似广告：代购、兼职、日结']);
    assert.deepEqual(checkText('线上博彩下注').reasons, ['擦边或违法内容：博彩、下注']);
    assert.equal(checkText('一夜情').ok, false);
  });
});

describe('审核接入', () => {
  let s;
  let tokens;
  let eventId;
  before(async () => {
    s = await startServer();
    const ids = [makeUser(s.db), makeUser(s.db)];
    tokens = await Promise.all(ids.map((u) => s.login(u)));
    const ev = await s.ok('POST', '/api/events', {
      token: tokens[0],
      body: { title: '洱海骑行', category: 'outdoor', startAt: '2026-10-31T06:00:00.000Z', place: '才村码头', capacity: 4, feeType: 'split' },
    });
    eventId = ev.id;
    await s.ok('POST', `/api/events/${eventId}/join`, { token: tokens[1] });
  });
  after(() => s.close());

  test('群聊发手机号 / 微信号 → 422 CONTENT_BLOCKED', async () => {
    for (const text of ['有事打我 13912345678', '加个微信吧 wxid_abc123']) {
      const r = await s.api('POST', `/api/events/${eventId}/messages`, { token: tokens[1], body: { text } });
      assert.equal(r.status, 422);
      assert.equal(r.body.error.code, 'CONTENT_BLOCKED');
      assert.equal(r.body.error.message, '群聊里不能发联系方式或广告');
    }
    const okMsg = await s.ok('POST', `/api/events/${eventId}/messages`, { token: tokens[1], body: { text: '几点集合呀' } });
    assert.equal(okMsg.mine, true);
    assert.equal(okMsg.kind, 'text');
    const { items } = await s.ok('GET', `/api/events/${eventId}/messages?after=0`, { token: tokens[0] });
    assert.equal(items.filter((m) => m.kind === 'text').length, 1);
  });

  test('评论命中直接拒绝；动态命中进待审核', async () => {
    const post = await s.ok('POST', '/api/posts', { token: tokens[0], body: { text: '今天的洱海好安静', images: [], visibility: 'public' } });
    assert.equal(post.status, 'approved');
    const bad = await s.api('POST', `/api/posts/${post.id}/comments`, { token: tokens[1], body: { text: '加我 vx abc12345 带你玩' } });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error.code, 'CONTENT_BLOCKED');
    const comment = await s.ok('POST', `/api/posts/${post.id}/comments`, { token: tokens[1], body: { text: '真好看', replyToUserId: null } });
    assert.equal(comment.text, '真好看');

    const flagged = await s.ok('POST', '/api/posts', { token: tokens[1], body: { text: '兼职刷单日结，私聊', images: [] } });
    assert.equal(flagged.status, 'pending');
    // 别人看不到待审核的动态，作者自己能看到
    const othersFeed = await s.ok('GET', '/api/posts', { token: tokens[0] });
    assert.ok(!othersFeed.items.some((p) => p.id === flagged.id));
    const myFeed = await s.ok('GET', '/api/posts', { token: tokens[1] });
    assert.ok(myFeed.items.some((p) => p.id === flagged.id));
    const admin = await s.adminToken();
    const queue = await s.ok('GET', '/api/admin/posts?status=pending', { token: admin });
    assert.equal(queue.items[0].id, flagged.id);
    assert.ok(queue.items[0].flags[0].startsWith('疑似广告'));
    await s.ok('POST', `/api/admin/posts/${flagged.id}/reject`, { token: admin });
    assert.equal((await s.api('GET', `/api/posts/${flagged.id}`, { token: tokens[0] })).status, 404);
  });

  test('昵称、简介命中拒绝保存', async () => {
    const r = await s.api('PUT', '/api/me', { token: tokens[0], body: { bio: '代购请找我 13812345678' } });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'CONTENT_BLOCKED');
    const me = await s.ok('PUT', '/api/me', {
      token: tokens[0],
      body: { nickname: '栗子', bio: '慢热，但很靠谱。', pace: 'slow', interests: ['看日出', '咖啡'], gender: 'female', onboarded: true },
    });
    assert.equal(me.nickname, '栗子');
    assert.equal(me.avatarText, '栗');
    assert.deepEqual(me.interests, ['看日出', '咖啡']);
  });
});

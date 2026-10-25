import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { seed } from '../src/seed.js';
import { startServer } from './helpers.js';

describe('演示数据', () => {
  let s;
  let token;
  let ids;
  before(async () => {
    s = await startServer();
    ids = seed(s.db);
    token = (await s.ok('POST', '/api/auth/dev-login', { body: {} })).token;
  });
  after(() => s.close());

  test('不传 userId 登录为「栗子」', async () => {
    const me = await s.ok('GET', '/api/me', { token });
    assert.equal(me.nickname, '栗子');
    assert.equal(me.avatarColor, 'accent');
    assert.equal(me.credit.attended, 6);
    assert.equal(me.credit.rate, 100);
    assert.equal(me.ongoingCount, 2);
  });

  test('我的局：苍山看日出（已成局）+ 洱海边骑行（撮合中）；桌游夜待评价', async () => {
    const ongoing = await s.ok('GET', '/api/events/mine?tab=ongoing', { token });
    assert.deepEqual(ongoing.items.map((i) => i.title), ['周六清晨 · 苍山看日出', '周日 · 洱海边骑行']);
    assert.equal(ongoing.items[0].status, 'formed');
    assert.equal(ongoing.items[0].dateLabel.endsWith('05:50'), true);
    assert.equal(ongoing.items[1].needMore, 1);
    const ended = await s.ok('GET', '/api/events/mine?tab=ended', { token });
    assert.equal(ended.items[0].title, '桌游夜 · 新手友好');
    assert.equal(ended.items[0].needReview, true);
    assert.ok(ended.items.slice(1).every((i) => i.reviewed));
  });

  test('消息中心：去评价、局聊未读 3、举报处理通知', async () => {
    const inbox = await s.ok('GET', '/api/inbox', { token });
    assert.ok(inbox.actions.some((a) => a.type === 'review' && a.title === '「桌游夜」结束啦'));
    assert.equal(inbox.chats[0].title, '苍山看日出 · 5 人');
    assert.equal(inbox.chats[0].unread, 3);
    assert.equal(inbox.chats[0].lastMessage.nickname, '阿野');
    assert.ok(inbox.notices.some((n) => n.type === 'report_result' && n.body === '对方已被限制使用'));
  });

  test('群聊与 AA：拼车车费 ¥120（阿野）+ 早餐 ¥30（小满）', async () => {
    const msgs = await s.ok('GET', `/api/events/${ids.events.sunrise}/messages`, { token });
    assert.equal(msgs.items[0].text, '满员啦，群已自动建好 · 第一次见面，慢慢来');
    const aa = await s.ok('GET', `/api/events/${ids.events.sunrise}/aa`, { token });
    assert.deepEqual(aa.items.map((i) => [i.name, i.payer.nickname, i.amount]), [
      ['拼车车费', '阿野', 120],
      ['早餐', '小满', 30],
    ]);
    assert.equal(aa.each, 30);
    const mine = aa.transfers.find((t) => t.role === 'from');
    assert.deepEqual([mine.to.nickname, mine.amount, mine.status], ['阿野', 30, 'pending']);
    assert.equal(aa.transfers.find((t) => t.from.nickname === '木木').status, 'confirmed');
  });

  test('广场 4 个 open 局；动态 2 条、评论 5 条', async () => {
    const square = await s.ok('GET', '/api/events', { token });
    assert.deepEqual(square.items.map((e) => e.title).sort(), ['喜洲稻田边吃早餐', '安静读书局 · 不用聊天', '拼车去双廊', '洱海西岸骑行'].sort());
    const posts = await s.ok('GET', '/api/posts', { token });
    assert.equal(posts.items.length, 2);
    const detail = await s.ok('GET', `/api/posts/${posts.items.find((p) => p.author.nickname === '阿野').id}`, { token });
    assert.equal(detail.comments.length, 5);
    assert.equal(detail.comments[4].replyTo.nickname, '南风');
  });

  test('后台：1 条待确认建议、2 条待处理举报、1 条申诉、1 个待审核局', async () => {
    const admin = await s.adminToken();
    const proposals = await s.ok('GET', '/api/admin/proposals', { token: admin });
    assert.equal(proposals.items.length, 1);
    assert.equal(proposals.items[0].task, '爬山');
    assert.equal((await s.ok('GET', '/api/admin/reports', { token: admin })).items.length, 2);
    assert.equal((await s.ok('GET', '/api/admin/appeals', { token: admin })).items.length, 1);
    const stats = await s.ok('GET', '/api/admin/stats', { token: admin });
    assert.equal(stats.today.pendingProposals, 1);
    assert.equal(stats.today.pendingReports, 2);
    assert.equal(stats.today.pendingEvents, 1);
  });

  test('他人主页：阿野履约 98%，与栗子有共同点', async () => {
    const profile = await s.ok('GET', `/api/users/${ids.users.aye}`, { token });
    assert.equal(profile.user.avatarText, '野');
    assert.equal(profile.credit.rate, 98);
    assert.equal(profile.creditNote, '最近一次临时鸽是 3 个月前（开场前 20 小时说去不了），没有放鸽子记录。');
    assert.ok(profile.commonPoints.includes('都喜欢看日出'));
    assert.equal(profile.profileHidden, false);
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { seed } from '../src/seed.js';
import { startServer } from './helpers.js';

describe('演示数据', () => {
  let s;
  let token;
  let ids;
  before(async () => {
    s = await startServer();
    ids = seed(s.db, { uploadDir: s.config.uploadDir });
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
    assert.deepEqual(ongoing.items.map((i) => i.title), ['周六清晨 · 苍山看日出', '周日下午 · 洱海边骑行']);
    assert.equal(ongoing.items[0].status, 'formed');
    assert.equal(ongoing.items[0].dateLabel.endsWith('05:50'), true);
    assert.equal(ongoing.items[1].needMore, 1);
    const ended = await s.ok('GET', '/api/events/mine?tab=ended', { token });
    assert.equal(ended.items[0].title, '桌游夜 · 新手友好');
    assert.equal(ended.items[0].needReview, true);
    assert.ok(ended.items.slice(1).every((i) => i.reviewed));
  });

  test('消息中心：去评价、局聊未读 3、举报处理通知、AA 记账通知', async () => {
    const inbox = await s.ok('GET', '/api/inbox', { token });
    assert.ok(inbox.actions.some((a) => a.type === 'review' && a.title === '「桌游夜」结束啦'));
    assert.equal(inbox.chats[0].title, '苍山看日出 · 5 人');
    assert.equal(inbox.chats[0].unread, 3);
    assert.equal(inbox.chats[0].lastMessage.nickname, '阿野');
    assert.ok(inbox.notices.some((n) => n.type === 'report_result' && n.body === '对方已被限制使用'));
    const aa = inbox.notices.find((n) => n.type === 'aa_bill');
    assert.equal(aa.body, '阿野 记了这个局的 AA：共 ¥150（车费 + 早餐），每人 ¥30，转给阿野');
    assert.equal(aa.link, `chat:${ids.events.sunrise}`);
  });

  test('群聊与 AA：阿野一次记下 ¥150（车费 + 早餐），每人 ¥30', async () => {
    const msgs = await s.ok('GET', `/api/events/${ids.events.sunrise}/messages`, { token });
    assert.equal(msgs.items[0].text, '满员啦，群已自动建好 · 第一次见面，慢慢来');
    assert.ok(msgs.items.some((m) => m.user?.nickname === '阿野' && m.text === '车费和早餐我先垫了，一起记在 AA 里，最后大家转我就行'));
    const aa = await s.ok('GET', `/api/events/${ids.events.sunrise}/aa`, { token });
    assert.equal(aa.bill.payer.nickname, '阿野');
    assert.equal(aa.bill.amount, 150);
    assert.equal(aa.bill.note, '车费 + 早餐');
    assert.equal(aa.bill.mine, false);
    assert.equal(aa.canDeclare, false);
    assert.equal(aa.total, 150);
    assert.equal(aa.each, 30);
    assert.equal(aa.transfers.length, 4);
    const mine = aa.transfers.find((t) => t.role === 'from');
    assert.deepEqual([mine.to.nickname, mine.amount, mine.status], ['阿野', 30, 'pending']);
    assert.equal(aa.transfers.find((t) => t.from.nickname === '木木').status, 'confirmed');
    // 木木已经转过钱：阿野不能再改
    const ayeToken = await s.login(ids.users.aye);
    const ayeView = await s.ok('GET', `/api/events/${ids.events.sunrise}/aa`, { token: ayeToken });
    assert.equal(ayeView.bill.mine, true);
    assert.equal(ayeView.bill.editable, false);
  });

  test('广场 4 个 open 局（都有配图和最晚退出时间）；动态 10 条，大多带图；评论 5 条', async () => {
    const square = await s.ok('GET', '/api/events', { token });
    assert.deepEqual(square.items.map((e) => e.title).sort(), ['喜洲稻田边吃早餐', '安静读书局 · 不用聊天', '拼车去双廊', '洱海西岸骑行'].sort());
    for (const e of square.items) {
      assert.match(e.cover, /^http:\/\/localhost:3000\/uploads\/seed-\w+\.(png|jpg)$/);
      assert.ok(Date.parse(e.exitDeadline) > Date.parse('2026-10-26T02:00:00.000Z'));
      assert.ok(Date.parse(e.exitDeadline) <= Date.parse(e.startAt));
    }
    const posts = await s.ok('GET', '/api/posts', { token });
    assert.equal(posts.items.length, 10);
    const withImages = posts.items.filter((p) => p.images.length);
    assert.ok(withImages.length >= 8);
    assert.ok(withImages.every((p) => p.images.length >= 1 && p.images.length <= 4));
    const detail = await s.ok('GET', `/api/posts/${posts.items.find((p) => p.author.nickname === '阿野').id}`, { token });
    assert.equal(detail.images.length, 4);
    assert.equal(detail.comments.length, 5);
    assert.equal(detail.comments[4].replyTo.nickname, '南风');
  });

  test('配图复制进上传目录，能直接访问', async () => {
    const files = fs.readdirSync(s.config.uploadDir).filter((f) => f.startsWith('seed-'));
    assert.equal(files.length, 10);
    const detail = await s.ok('GET', `/api/events/${ids.events.sunrise}`, { token });
    assert.equal(detail.images.length, 2);
    const res = await fetch(`${s.base}${new URL(detail.images[0]).pathname}`);
    assert.equal(res.status, 200);
    assert.ok(Number(res.headers.get('content-length')) > 1000);
    assert.equal(detail.location.name, '大理古城南门');
    assert.equal(detail.exitDeadlineLabel, '10月30日 05:50');
    assert.equal(path.basename(new URL(detail.cover).pathname), 'seed-sunrise.png');
  });

  test('首页：3 张轮播图、热门标签、带图的动态、精选局、本周数据', async () => {
    const home = await s.ok('GET', '/api/home', { token });
    assert.deepEqual(
      home.banners.map((b) => [b.title, b.link]),
      [
        ['苍山日出', `event:${ids.events.sunrise}`],
        ['洱海骑行', 'square'],
        ['新人第一次来', 'rules'],
      ],
    );
    assert.equal(home.hotTags.length, 10);
    assert.deepEqual(home.hotTags[0], { name: '看日出', category: 'outdoor', cover: 'sunrise' });
    assert.ok(home.highlights.length >= 8 && home.highlights.length <= 10);
    assert.equal(home.highlights[0].user.nickname, '阿野');
    assert.equal(home.featuredEvents.length, 4);
    assert.ok(home.stats.weekPeople >= 5);
    assert.ok(home.stats.weekFormed >= 1);
  });

  test('后台：1 条待确认建议、2 条待处理举报、1 条申诉、1 个待审核局、默认标签', async () => {
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
    const hot = await s.ok('GET', '/api/admin/tags?scope=hot', { token: admin });
    assert.deepEqual(
      hot.items.map((t) => t.name),
      ['看日出', '爬山', '骑行', '咖啡', '吃饭', '桌游', '拼车', '随便走走', '读书', '拍照'],
    );
    assert.equal((await s.ok('GET', '/api/admin/banners', { token: admin })).items.length, 3);
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

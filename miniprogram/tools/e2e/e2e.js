// v0.3 端到端检查：真实页面 / 组件代码 + wx mock（./runtime.js），连真实后端。
// 用法（需要刚 seed 过的开发库，会用到 /api/dev/clock 时间穿越，结束时复原）：
//   cd server
//   DB_PATH=/tmp/dz-e2e.db UPLOAD_DIR=/tmp/dz-e2e-uploads node --no-warnings scripts/seed.js
//   DB_PATH=/tmp/dz-e2e.db UPLOAD_DIR=/tmp/dz-e2e-uploads PORT=3500 node --no-warnings src/index.js
//   cd miniprogram && BASE=http://localhost:3500 node tools/e2e/e2e.js
// 后台密码不是默认的 admin123 时用 ADMIN_PASSWORD 指定。
const rt = require('./runtime');
const { loadPage, loadComponent, idle, ev, MP, log, ctl, config, appInstance, doRequest, BASE, sleep } = rt;

const request = require(MP + '/utils/request.js');
const session = require(MP + '/utils/session.js');
const format = require(MP + '/utils/format.js');
const api = require(MP + '/utils/api.js');

let pass = 0;
let fail = 0;
const fails = [];
function check(name, cond, info) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    fails.push(name);
    console.log('  ✗ ' + name + (info !== undefined ? '  → ' + JSON.stringify(info).slice(0, 400) : ''));
  }
}
const section = (t) => console.log('\n## ' + t);
const lastModal = () => log.modals[log.modals.length - 1] || '';
const lastToast = () => log.toasts[log.toasts.length - 1] || '';
const lastNav = () => log.navs[log.navs.length - 1] || '';
const lastBody = (pathRe, method) => [...log.bodies].reverse().find((b) => pathRe.test(b.path) && (!method || b.method === method));

async function as(userId) {
  config.devUserId = userId || null;
  request.setToken('');
  appInstance.globalData.me = null;
  await session.loadMe(true);
  await idle();
}

async function raw(method, path, data, token) {
  const header = { 'content-type': 'application/json' };
  if (token !== false) header.Authorization = 'Bearer ' + (token || request.getToken());
  return doRequest({ url: BASE + path, method, data, header });
}

async function findEvent(title) {
  const res = await raw('GET', '/api/events', { limit: 50 });
  return (res.data.items || []).find((e) => e.title === title);
}

function bjDateOf(iso) {
  const p = format.bj(iso);
  return p.y + '-' + format.pad(p.m) + '-' + format.pad(p.d);
}

(async () => {
  require(MP + '/app.js');
  appInstance.onLaunch({ path: 'pages/home/home' });
  await idle();

  // ===================================================================
  section('首页：轮播、宫格、人气、大家最近在玩、还差人的局');
  await as(1);
  const home = loadPage('pages/home/home');
  home.onLoad();
  home.onShow();
  await idle();
  const hd = home.data;
  check('轮播图 3 张，带标题和跳转', hd.banners.length === 3 && hd.banners[0].title === '苍山日出' && hd.banners[0].link === 'event:1', hd.banners);
  check('宫格 10 格：8 个热门标签 + 更多 + 自己添加', hd.grid.length === 10 && hd.grid[8].kind === 'more' && hd.grid[9].kind === 'custom' && hd.grid[0].src === '/assets/covers/sunrise.svg', hd.grid.map((g) => g.name));
  check('大家最近在玩（带图动态）', hd.highlights.length > 0 && /^http/.test(hd.highlights[0].image) && !!hd.highlights[0].user.nickname, hd.highlights[0]);
  check('还差人的局（EventCard 带 cover / coverKey / tag）', hd.featured.length > 0 && 'coverKey' in hd.featured[0] && 'tag' in hd.featured[0], hd.featured[0]);
  check('人气（近 7 天）', hd.stats === null || typeof hd.stats.weekPeople === 'number', hd.stats);
  check('默认按钮文字「帮我选择 · 本周末 · 看日出」', hd.cta === '帮我选择 · 本周末 · 看日出', hd.cta);
  home.onBanner(ev({ index: 0 }));
  check('点轮播 event:1 → 局详情', lastNav() === 'navigateTo /pages/detail/detail?id=1', lastNav());
  home.onBanner(ev({ index: 2 }));
  check('点轮播 rules → 社区公约', lastNav() === 'navigateTo /pages/rules/rules', lastNav());

  section('首页：约搭子弹窗（标签 / 日期 / 上午下午晚上都可以 / 指定时间段）');
  const cyc = hd.grid.findIndex((g) => g.name === '骑行');
  home.onGrid(ev({ index: cyc }));
  check('点宫格「骑行」打开弹窗并选中', home.data.matchShow && home.data.task === '骑行' && home.data.taskSrc === '/assets/covers/cycling.svg', [home.data.matchShow, home.data.task]);
  home.pickWhen(ev({ value: 'tomorrow' }));
  home.pickSlot(ev({ value: 'afternoon', off: false }));
  check('明天下午 → 「帮我选择 · 明天下午 · 骑行」', home.data.cta === '帮我选择 · 明天下午 · 骑行', home.data.cta);
  home.openRange();
  const tr = loadComponent('timerange-sheet', { from: '14:00', to: '17:00' });
  tr.setData({ show: true });
  tr.onChange({ detail: { value: [9, 0, 0, 9, 30] } });
  check('时间段弹窗：不足 1 小时报错', tr.data.error === '至少留 1 小时，才好约到人', tr.data.error);
  tr.onChange({ detail: { value: [9, 0, 0, 11, 30] } });
  tr.onConfirm();
  const range = tr.events.find((e) => e.name === 'confirm');
  check('时间段弹窗：14:00–16:30（精确到分钟）', range && range.detail.from === '14:00' && range.detail.to === '16:30', tr.events);
  home.onRange({ detail: range.detail });
  check('指定时间 → 「帮我选择 · 明天 14:00–16:30 · 骑行」', home.data.cta === '帮我选择 · 明天 14:00–16:30 · 骑行' && home.data.slot === 'custom', home.data.cta);
  const day5 = format.dateStr(5);
  home.onDate({ detail: { date: day5 } });
  const [, m5, d5] = day5.split('-').map(Number);
  check('选日期 → 按钮带上「' + m5 + '月' + d5 + '日」', home.data.cta === '帮我选择 · ' + m5 + '月' + d5 + '日 14:00–16:30 · 骑行', home.data.cta);
  // 自己添加标签
  home.onGrid(ev({ index: 9 }));
  check('点「自己添加」打开标签弹窗并聚焦输入', home.data.tagShow && home.data.tagCustom, [home.data.tagShow, home.data.tagCustom]);
  const ts = loadComponent('tag-sheet', { tags: home.data.tags, custom: true });
  ts.setData({ show: true });
  ts.onInput({ detail: { value: '这个标签太长了超过八个字' } });
  check('标签超过 8 个字提示', ts.data.error === '标签最多 8 个字', ts.data.error);
  ts.onInput({ detail: { value: ' 溯溪 ' } });
  ts.onConfirm();
  const tagEv = ts.events.find((e) => e.name === 'confirm');
  check('自己添加「溯溪」', tagEv && tagEv.detail.name === '溯溪' && tagEv.detail.custom, ts.events);
  home.onTag({ detail: tagEv.detail });
  check('按钮跟着变成「… · 溯溪」', /· 溯溪$/.test(home.data.cta) && !home.data.tagShow, home.data.cta);
  home.submit();
  await idle();
  const intentReq = lastBody(/^\/api\/intents$/, 'POST');
  check('提交意向：task + when(日期) + timeFrom/timeTo', intentReq && intentReq.body.task === '溯溪' && intentReq.body.when === day5 && intentReq.body.timeFrom === '14:00' && intentReq.body.timeTo === '16:30' && !intentReq.body.slot && intentReq.status < 300, intentReq);
  check('提交后去「撮合中」页', /waiting\?id=\d+/.test(lastNav()), lastNav());
  const intentId = intentReq && intentReq.data && intentReq.data.id;
  const w = loadPage('pages/waiting/waiting');
  w.onLoad({ id: String(intentId) });
  await idle();
  w.onUnload();
  check('撮合中页显示自定义时间段和插画', /14:00–16:30/.test(w.data.meta) && w.data.coverKey === 'oldtown' && /溯溪/.test(w.data.intent.title), [w.data.meta, w.data.coverKey, w.data.intent && w.data.intent.title]);
  // 和已加入的局时间重叠（栗子周六清晨有「苍山看日出」）
  const sunrise = (await raw('GET', '/api/events/1')).data;
  const satDate = bjDateOf(sunrise.startAt);
  home.onGrid(ev({ index: 0 }));
  home.onDate({ detail: { date: satDate } });
  home.onRange({ detail: { from: '06:00', to: '09:00', label: '06:00–09:00' } });
  log.modals.length = 0;
  home.submit();
  await idle();
  check('意向时间被已加入的局占满 → 弹窗「时间冲突了」', /^时间冲突了 \| 这个时间你已经有局了/.test(lastModal()), log.modals);
  home.closeMatch();

  // ===================================================================
  section('发起一个局：标签、性别、照片、时间、地点、最晚退出时间');
  const cr = loadPage('pages/create/create');
  cr.onLoad({});
  await idle();
  check('热门标签（后台维护）', cr.data.hotTags.length === 10 && cr.data.hotTags[0].name === '看日出', cr.data.hotTags.map((t) => t.name));
  check('知道自己是女生', cr.data.myGender === 'female', cr.data.myGender);
  cr.openTagSheet();
  cr.onTagSheet({ detail: { name: '写生', custom: true } });
  check('自己添加标签「写生」并选中', cr.data.tag === '写生' && cr.data.customTag === '写生', [cr.data.tag, cr.data.customTag]);
  // 谁可以报名
  cr.openGender();
  log.toasts.length = 0;
  cr.toggleGender(ev({ g: 'female' }));
  check('不能取消自己的性别（「发起人自己也要能参加」）', cr.data.genderPick.female === true && lastToast() === '发起人自己也要能参加', [cr.data.genderPick, log.toasts]);
  cr.toggleGender(ev({ g: 'male' }));
  cr.confirmGender();
  check('只选女生 → 只限女生', cr.data.genderText === '只限女生', cr.data.genderText);
  cr.openGender();
  cr.toggleGender(ev({ g: 'any' }));
  check('点「不限」= 男女都选', cr.data.genderPick.female && cr.data.genderPick.male, cr.data.genderPick);
  cr.toggleGender(ev({ g: 'male' }));
  cr.confirmGender();
  // 开始时间（自己的弹窗，精确到分钟）
  const dt = loadComponent('datetime-sheet');
  dt.setData({ show: true });
  await sleep(10);
  check('时间弹窗默认明天 09:00', /09:00$/.test(dt.data.summary), dt.data.summary);
  dt.onChange({ detail: { value: [0, 0, 5] } });
  check('时间早于现在半小时 → 报错', /开始时间要晚于现在/.test(dt.data.error), dt.data.error);
  dt.onChange({ detail: { value: [3, 16, 25] } });
  dt.onConfirm();
  const tEv = dt.events.find((e) => e.name === 'confirm');
  check('选到 3 天后 16:25', tEv && /16:25$/.test(tEv.detail.label) && tEv.detail.date === format.dateStr(3), dt.events);
  cr.onTime({ detail: tEv.detail });
  check('标题建议跟着时间和标签走', /· 写生$/.test(cr.data.titleHint), cr.data.titleHint);
  cr.useHint();
  // 地点
  const ps = loadComponent('place-sheet');
  ps.setData({ show: true });
  ps.pickSpot(ev({ name: '才村码头' }));
  check('常用地点一键填入', ps.data.name === '才村码头', ps.data.name);
  ctl.location = 'ok';
  ps.openMap();
  await sleep(10);
  check('在地图上选 → 带坐标', ps.data.loc && ps.data.loc.latitude === 25.6899 && ps.data.name === '大理古城南门', ps.data.loc);
  ps.onConfirm();
  const pEv = ps.events.find((e) => e.name === 'confirm');
  cr.onPlace({ detail: pEv.detail });
  check('地点：名字 + location', cr.data.place === '大理古城南门' && cr.data.location.address === '大理市复兴路南端', [cr.data.place, cr.data.location]);
  // 最晚退出时间
  cr.openExit();
  check('退出时间 5 档、默认开始前 24 小时', cr.data.exitOptions.length === 5 && cr.data.exitPick === 24 && cr.data.exitOptions.every((o) => !o.off), cr.data.exitOptions);
  cr.pickExit(ev({ hours: 48, off: false }));
  cr.confirmExit();
  check('改成开始前 48 小时', cr.data.exitHours === 48 && cr.data.exitText === '开始前 48 小时' && /^\d+月\d+日 \d\d:\d\d 之前可以退出$/.test(cr.data.exitSub), [cr.data.exitText, cr.data.exitSub]);
  // 离开始很近时，来不及的档位变灰
  const keepStart = cr.data.startAt;
  cr.setData({ startAt: new Date(Date.now() + 5 * 3600000).toISOString() });
  cr.buildExit();
  const offs = cr.data.exitOptions.filter((o) => o.off).map((o) => o.hours);
  check('5 小时后开始：6/12/24/48 小时不能选，自动用 2 小时', offs.join(',') === '6,12,24,48' && cr.data.exitHours === 2, [offs, cr.data.exitHours]);
  log.toasts.length = 0;
  cr.pickExit(ev({ hours: 24, off: true }));
  check('点灰掉的档位有提示', lastToast() === '这个时间已经过了', log.toasts);
  cr.setData({ startAt: keepStart, exitHours: 48 });
  cr.buildExit(48);
  // 介绍 + 快捷短语
  cr.addPhrase(ev({ word: '慢热友好' }));
  cr.addPhrase(ev({ word: '不喝酒' }));
  cr.addPhrase(ev({ word: '慢热友好' }));
  check('快捷短语插入介绍（不重复）', cr.data.description === '慢热友好，不喝酒', cr.data.description);
  // 照片：逐张上传，有进度
  const up = loadComponent('uploader', { max: 9 });
  up.add();
  await sleep(5);
  const mid = up.data.items[0];
  check('上传中显示进度', mid && mid.status === 'uploading', up.data.items);
  await idle(50);
  const upEv = up.events.filter((e) => e.name === 'change').pop();
  check('上传完成，拿到 /uploads/ 地址', upEv && upEv.detail.urls.length === 1 && /\/uploads\//.test(upEv.detail.urls[0]) && !upEv.detail.uploading, up.events);
  up.add();
  await idle(50);
  const upEv2 = up.events.filter((e) => e.name === 'change').pop();
  up.remove(ev({ key: up.data.items[1].key }));
  const upEv3 = up.events.filter((e) => e.name === 'change').pop();
  check('可以删掉一张', upEv2.detail.urls.length === 2 && upEv3.detail.urls.length === 1, [upEv2.detail.urls.length, upEv3.detail.urls.length]);
  up.preview(ev({ key: up.data.items[0].key }));
  check('点开看大图', /^previewImage 1/.test(lastNav()), lastNav());
  cr.onImages({ detail: upEv3.detail });
  cr.incMin();
  cr.dec();
  cr.dec();
  cr.dec();
  check('至少几人成群不超过人数', cr.data.capacity === 2 && cr.data.minSize === 2, [cr.data.capacity, cr.data.minSize]);
  cr.inc();
  cr.inc();
  cr.incMin();
  cr.publish();
  await idle();
  const createReq = lastBody(/^\/api\/events$/, 'POST');
  const startMs = new Date(cr.data.startAt).getTime();
  check('发布请求带 tag / genderLimit / images / location / exitDeadline / minSize', createReq && createReq.body.tag === '写生' && createReq.body.genderLimit === 'female' && createReq.body.images.length === 1 && createReq.body.location.latitude === 25.6899 && new Date(createReq.body.exitDeadline).getTime() === startMs - 48 * 3600000 && createReq.body.minSize === 3 && createReq.body.capacity === 4, createReq && createReq.body);
  check('发布成功', cr.data.published && createReq.status < 300, [createReq && createReq.status, createReq && createReq.data]);
  const created = createReq.data;
  const createdDetail = (await raw('GET', '/api/events/' + created.id)).data;
  check('详情回来：标签、只限女生、照片、地点坐标、最晚退出时间、成群人数', createdDetail.minSize === 3 && createdDetail.tag === '写生' && createdDetail.genderLimit === 'female' && createdDetail.genderLabel === '只限女生' && createdDetail.images.length === 1 && /^http/.test(createdDetail.images[0]) && createdDetail.location.latitude === 25.6899 && new Date(createdDetail.exitDeadline).getTime() === startMs - 48 * 3600000, createdDetail);
  cr.openEvent();
  check('发布后去看这个局', lastNav() === 'redirectTo /pages/detail/detail?id=' + created.id, lastNav());
  // 发起时间重叠
  const cr2 = loadPage('pages/create/create');
  cr2.onLoad({});
  await idle();
  cr2.pickTag(ev({ name: '咖啡' }));
  cr2.onTitle(ev({}, { value: '再约一杯咖啡' }));
  cr2.onTime({ detail: { iso: new Date(startMs + 30 * 60000).toISOString(), label: 'x' } });
  cr2.onPlace({ detail: { name: '人民路', location: null } });
  log.modals.length = 0;
  cr2.publish();
  await idle();
  check('发起的局和自己已加入的重叠 → 弹窗写明是哪个局', /^时间冲突了 \| 和你已加入的「.*写生.*」（.*）时间重叠了/.test(lastModal()), log.modals);
  // 只选异性：服务端拒绝（界面上本来就选不了）
  log.toasts.length = 0;
  await api.createEvent({ title: '只限男生的局', tag: '咖啡', startAt: new Date(Date.now() + 10 * 86400000).toISOString(), place: '人民路', capacity: 3, feeType: 'aa', genderLimit: 'male' }).catch(() => {});
  check('只限异性 → 「发起人自己也要能参加」', lastToast() === '发起人自己也要能参加' || /发起人自己也要能参加/.test(lastModal()), [log.toasts, lastModal()]);

  // ===================================================================
  section('加入：确认弹窗 → 还差 N 人 / 满员进群');
  const reading = await findEvent('安静读书局 · 不用聊天');
  check('找到「安静读书局」（4 人局，已有 2 人）', reading && reading.capacity === 4 && reading.memberCount === 2, reading);
  const d1 = loadPage('pages/detail/detail');
  d1.onLoad({ id: String(reading.id) });
  await idle();
  check('详情：照片轮播（2 张）、地点有地图、最晚退出时间', d1.data.images.length === 2 && d1.data.hasMap && !!d1.data.event.exitDeadlineLabel, [d1.data.images.length, d1.data.hasMap, d1.data.event.exitDeadlineLabel]);
  d1.openMap();
  check('点地点打开地图', /^openLocation 人民路咖啡馆 25.6953,100.1597/.test(lastNav()), lastNav());
  d1.previewImage(ev({ index: 1 }));
  check('点照片看大图（可以左右滑）', /^previewImage 2 http/.test(lastNav()), lastNav());
  check('底部按钮「加入」', d1.data.bar.mode === 'action' && d1.data.bar.label === '加入' && d1.data.bar.action === 'join', d1.data.bar);
  d1.onCta();
  check('先弹确认：时间、地点、费用、最晚退出时间', d1.data.joinShow && /周五/.test(d1.data.joinInfo.when) && /人民路咖啡馆/.test(d1.data.joinInfo.place) && !!d1.data.joinInfo.fee && !!d1.data.joinInfo.exit, d1.data.joinInfo);
  const js = loadComponent('join-sheet', { info: d1.data.joinInfo });
  js.setData({ show: true });
  js.onConfirm();
  check('确认弹窗「同意并加入」→ confirm 事件', js.events.some((e) => e.name === 'confirm'), js.events);
  d1.confirmJoin();
  await idle();
  check('不是最后一个：已加入，还差 1 人成群', d1.data.joinResult && d1.data.joinResult.formed === false && d1.data.joinResult.remaining === 1, d1.data.joinResult);
  d1.closeJoin();
  await idle();
  check('加入后底部显示进度和「邀请朋友」，不是「进入群聊」', d1.data.bar.mode === 'waiting' && d1.data.bar.remaining === 1, d1.data.bar);
  check('还能退出（没过最晚退出时间）', d1.data.leave && !d1.data.leave.disabled && d1.data.leave.label === '退出这个局', d1.data.leave);
  const g0 = loadPage('pages/group/group');
  g0.onLoad({ id: String(reading.id) });
  await idle();
  check('没成群时群聊不开：「还差 1 人成群，群聊就开了」', g0.data.closed && g0.data.closedTitle === '还差 1 人成群，群聊就开了' && g0.data.closedShare, [g0.data.closed, g0.data.closedTitle]);
  const share = d1.onShareAppMessage();
  check('分享卡片「还差 1 人：…」', /^还差 1 人：安静读书局/.test(share.title) && /^http/.test(share.imageUrl || ''), share);
  // 最后一个人
  await as(10);
  const d2 = loadPage('pages/detail/detail');
  d2.onLoad({ id: String(reading.id) });
  await idle();
  d2.openJoin();
  d2.confirmJoin();
  await idle();
  check('最后一个人：满员啦，群已建好', d2.data.joinResult && d2.data.joinResult.formed === true && d2.data.joinResult.remaining === 0, d2.data.joinResult);
  d2.joinChat();
  check('「进入群聊」', lastNav() === 'navigateTo /pages/group/group?id=' + reading.id, lastNav());
  const g1 = loadPage('pages/group/group');
  g1.onLoad({ id: String(reading.id) });
  await idle();
  g1.onUnload();
  const formedMsg = g1.data.list.find((m) => m.kind === 'system' && /满员啦，群已自动建好/.test(m.text));
  check('成群后群聊打开，有系统消息「满员啦，群已自动建好…」', !g1.data.closed && !!formedMsg, [g1.data.closed, g1.data.list.map((m) => m.text)]);
  check('破冰话题跟在成群消息后面', formedMsg && g1.data.iceAfter === formedMsg.id && !!g1.data.icebreaker, [g1.data.iceAfter, formedMsg && formedMsg.id]);
  await as(1);
  const d3 = loadPage('pages/detail/detail');
  d3.onLoad({ id: String(reading.id) });
  await idle();
  check('先加入的人底部变成「进入群聊」', d3.data.bar.action === 'group' && d3.data.bar.label === '进入群聊', d3.data.bar);

  // ===================================================================
  section('撮合成功页：「加入这个局」走同一个确认');
  const adminLogin = await raw('POST', '/api/admin/login', { password: process.env.ADMIN_PASSWORD || 'admin123' }, false);
  const adminToken = adminLogin.data.token;
  const props = await raw('GET', '/api/admin/proposals', { status: 'pending' }, adminToken);
  const prop = props.data.items && props.data.items[0];
  if (prop) {
    const conf = await raw('POST', '/api/admin/proposals/' + prop.id + '/confirm', {}, adminToken);
    const evId = conf.data.eventId;
    const memberIds = prop.members.map((x) => x.user.id);
    check('后台确认建议局 → 撮合局', conf.statusCode < 300 && !!evId, conf.data);
    // 被邀请后，「撮合中」页自动跳到撮合成功
    await as(memberIds[0]);
    const wInv = loadPage('pages/waiting/waiting');
    wInv.onLoad({ id: String(prop.members[0].intentId) });
    await idle();
    wInv.onUnload();
    check('撮合中页：被邀请后自动跳到撮合成功', lastNav() === 'redirectTo /pages/match/match?eventId=' + evId, lastNav());
    for (let i = 0; i < memberIds.length; i++) {
      await as(memberIds[i]);
      const mt = loadPage('pages/match/match');
      mt.onLoad({ eventId: String(evId) });
      await idle();
      if (mt.data.myStatus !== 'invited') {
        check('成员 ' + memberIds[i] + ' 是被邀请状态', false, mt.data.myStatus);
        continue;
      }
      mt.accept();
      const okSheet = mt.data.joinShow && !!mt.data.joinInfo.title;
      mt.confirmJoin();
      await idle();
      const r = mt.data.joinResult || {};
      if (i < memberIds.length - 1) {
        if (i === 0) check('撮合页：先确认 → 已加入，还差 ' + r.remaining + ' 人', okSheet && r.formed === false && r.remaining === memberIds.length - 1, r);
        if (i === 0) {
          mt.closeJoin();
          await idle();
          check('撮合页加入后显示进度（不是进入群聊）', mt.data.myStatus === 'joined' && !mt.data.event.chatOpen && mt.data.remaining === memberIds.length - 1, [mt.data.myStatus, mt.data.remaining]);
        }
      } else {
        check('最后一位确认 → 满员啦，群已建好', okSheet && r.formed === true, r);
        mt.joinChat();
        check('撮合页「进入群聊」', lastNav() === 'redirectTo /pages/group/group?id=' + evId, lastNav());
      }
    }
  } else {
    check('有待确认的建议局可以测', false, props.data);
  }

  // ===================================================================
  section('需要发起人同意：申请 → 同意 → 还差 N 人；退出、发起人取消');
  await as(11);
  const apEv = await api.createEvent({ title: '周末喜洲骑行', tag: '骑行', startAt: format.toISO(format.dateStr(8), '19:00'), place: '喜洲古镇', capacity: 3, feeType: 'aa', requireApproval: true, genderLimit: 'any' });
  check('老周发起一个需要同意的局', apEv && apEv.id, apEv);
  await as(7);
  const da = loadPage('pages/detail/detail');
  da.onLoad({ id: String(apEv.id) });
  await idle();
  check('底部按钮「申请加入」', da.data.bar.label === '申请加入', da.data.bar);
  da.openJoin();
  da.confirmJoin();
  await idle();
  check('确认后：已申请，等发起人同意', da.data.joinResult && da.data.joinResult.myStatus === 'applied', da.data.joinResult);
  da.closeJoin();
  await idle();
  check('申请中：按钮「等发起人同意」，可以撤回申请', da.data.bar.label === '等发起人同意' && da.data.bar.disabled && da.data.leave && da.data.leave.label === '撤回申请', [da.data.bar, da.data.leave]);
  await as(11);
  const dh = loadPage('pages/detail/detail');
  dh.onLoad({ id: String(apEv.id) });
  await idle();
  check('发起人看到报名申请', dh.data.applications.length === 1 && dh.data.applications[0].id === 7, dh.data.applications);
  log.toasts.length = 0;
  dh.approveApp(ev({ id: 7 }));
  await idle();
  check('同意申请', lastToast() === '已同意' && dh.data.applications.length === 0, [log.toasts, dh.data.applications]);
  await as(7);
  da.load();
  await idle();
  check('申请人：已加入 · 还差 1 人成群', da.data.bar.mode === 'waiting' && da.data.bar.remaining === 1, da.data.bar);
  const gim = loadPage('pages/group-info/group-info');
  gim.onLoad({ id: String(apEv.id) });
  gim.onShow();
  await idle();
  ctl.modal = true;
  log.modals.length = 0;
  gim.leave();
  await idle();
  check('成员在局信息里退出（提示最晚退出时间）', /^确定退出这个局吗？ \| 最晚退出时间是 /.test(log.modals[0] || '') && /已退出/.test(lastToast()), [log.modals, log.toasts]);
  await as(11);
  const gih = loadPage('pages/group-info/group-info');
  gih.onLoad({ id: String(apEv.id) });
  gih.onShow();
  await idle();
  check('发起人在局信息里是「取消这个局」', gih.data.isHost === true && gih.data.leaveOff === false, [gih.data.isHost, gih.data.leaveOff]);
  gih.leave();
  await idle();
  check('发起人取消局', lastToast() === '已取消' && (await raw('GET', '/api/events/' + apEv.id)).data.status === 'cancelled', log.toasts);
  await idle(1000); // 等退出 / 取消后延时的回首页跳转走完
  check('退出 / 取消后回首页', lastNav() === 'switchTab /pages/home/home', lastNav());

  // ===================================================================
  section('报名时间重叠 → 409 弹窗');
  await as(11);
  const readingStart = new Date(reading.startAt).getTime();
  const overlapEv = await api.createEvent({ title: '午后爬山', tag: '爬山', startAt: new Date(readingStart + 60 * 60000).toISOString(), place: '苍山索道', capacity: 4, feeType: 'aa', genderLimit: 'any' });
  check('老周发起一个和读书局重叠的局', overlapEv && overlapEv.id, overlapEv);
  await as(1);
  const d4 = loadPage('pages/detail/detail');
  d4.onLoad({ id: String(overlapEv.id) });
  await idle();
  d4.openJoin();
  log.modals.length = 0;
  d4.confirmJoin();
  await idle();
  check('弹窗「时间冲突了 | 和你已加入的「安静读书局…」（…）时间重叠了」', /^时间冲突了 \| 和你已加入的「安静读书局[^」]*」（\d+月\d+日 \d\d:\d\d–\d\d:\d\d）时间重叠了$/.test(lastModal()), log.modals);
  check('出错后确认弹窗收起', d4.data.joinShow === false && d4.data.joinBusy === false, [d4.data.joinShow, d4.data.joinBusy]);

  // ===================================================================
  section('广场：吸顶标签栏 + ?tag= 筛选，切换不跳');
  const sq = loadPage('pages/square/square');
  sq.onLoad();
  sq.onShow();
  sq.onReady();
  await idle();
  check('标签栏 = 全部 + 热门标签', sq.data.tags.length === 10 && sq.data.tags[2] === '骑行', sq.data.tags);
  check('列表有局，都带封面字段', sq.data.events.length > 0 && sq.data.events.every((e) => 'coverKey' in e), sq.data.events.length);
  const before = sq.data.events.length;
  sq.scrollTop = 900;
  log.scrolls.length = 0;
  sq.pickTag(ev({ value: '骑行', index: 2 }));
  check('切换时保留旧列表（变淡），不清空不跳', sq.data.switching === true && sq.data.events.length === before && sq.data.loading === false, [sq.data.switching, sq.data.events.length]);
  check('已滚过标签栏 → 回到吸顶位置', log.scrolls[0] === 180, log.scrolls);
  await idle();
  const tagReq = lastBody(/^\/api\/events$/, 'GET');
  check('请求带 ?tag=骑行', tagReq && decodeURIComponent(tagReq.search).indexOf('tag=骑行') >= 0, tagReq && tagReq.search);
  check('筛选结果都是「骑行」', sq.data.events.length > 0 && sq.data.events.every((e) => e.tag === '骑行'), sq.data.events.map((e) => e.tag));
  check('选中的标签滚到可见', sq.data.tagView === 't2', sq.data.tagView);
  sq.pickTag(ev({ value: '冲浪', index: 99 }));
  await idle();
  check('没有的标签 → 空状态', sq.data.events.length === 0 && !sq.data.loading, sq.data.events.length);
  sq.goCreate();
  check('空状态「发起一个局」带上标签', lastNav() === 'navigateTo /pages/create/create?tag=' + encodeURIComponent('冲浪'), lastNav());
  sq.pickTag(ev({ value: '写生', index: 98 }));
  await idle();
  check('自己添加的新标签也能筛（刚发起的「写生」局）', sq.data.events.length === 1 && sq.data.events[0].tag === '写生', sq.data.events.map((e) => e.title));

  // ===================================================================
  section('动态：双列瀑布流 + 详情左右滑看大图 + 发 9 张图');
  const fd = loadPage('pages/feed/feed');
  fd.onLoad();
  fd.onShow();
  await idle();
  const all = fd.data.left.concat(fd.data.right);
  check('两列都有卡片', fd.data.left.length > 0 && fd.data.right.length > 0, [fd.data.left.length, fd.data.right.length]);
  check('带图的用第一张作封面，没图的是文字卡片', all.some((p) => p.images.length) && all.every((p) => p.images.every((u) => /^http/.test(u))), all.map((p) => p.images.length));
  const firstLeft = fd.data.left[0];
  fd.onSize({ detail: { id: firstLeft.id, ratio: 0.75 } });
  check('封面加载后修正列高（不挪动已有卡片）', fd.where[firstLeft.id].sized === true && fd.data.left[0].id === firstLeft.id, fd.where[firstLeft.id]);
  const likeTarget = all.find((p) => !p.liked);
  const likeBefore = likeTarget.likeCount;
  fd.onLike(ev({}, { id: likeTarget.id }));
  await idle();
  check('点赞', fd.find(likeTarget.id).post.liked === true && fd.find(likeTarget.id).post.likeCount === likeBefore + 1, fd.find(likeTarget.id).post);
  const multi = all.find((p) => p.images.length > 1) || all.find((p) => p.images.length);
  const pd = loadPage('pages/post/post');
  pd.onLoad({ id: String(multi.id) });
  await idle();
  check('动态详情：图片轮播', pd.data.post.images.length === multi.images.length, pd.data.post.images.length);
  pd.onImgLoad({ currentTarget: { dataset: { index: 0 } }, detail: { width: 600, height: 400 } });
  check('轮播高度跟第一张图（3:2 → 3:4 下限）', pd.data.galleryH === 563, pd.data.galleryH);
  pd.onSwiper({ detail: { current: multi.images.length - 1 } });
  pd.preview(ev({ index: multi.images.length - 1 }));
  check('点图看大图，从当前这张开始', lastNav() === 'previewImage ' + multi.images.length + ' ' + multi.images[multi.images.length - 1], lastNav());
  // 评论、回复、长按评论
  pd.onInput(ev({}, { value: '真好看，下次叫上我' }));
  pd.send();
  await idle();
  const cmt = lastBody(/\/api\/posts\/\d+\/comments$/, 'POST');
  check('详情页发评论', cmt && cmt.status < 300 && pd.data.comments[pd.data.comments.length - 1].text === '真好看，下次叫上我', cmt && cmt.status);
  const other = pd.data.comments.findIndex((c) => !c.mine);
  pd.reply(ev({ index: other }));
  pd.onInput(ev({}, { value: '同感' }));
  pd.send();
  await idle();
  const rep = lastBody(/\/api\/posts\/\d+\/comments$/, 'POST');
  check('回复某人带 replyToUserId', rep && rep.body.replyToUserId === pd.data.comments[other].author.id && /^回复 /.test(pd.data.comments[pd.data.comments.length - 1].display), rep && rep.body);
  ctl.sheet = 2;
  pd.onCommentLong(ev({ index: other }));
  await idle();
  check('长按别人的评论 → 举报', /report\?targetType=comment&targetId=\d+/.test(lastNav()), lastNav());
  ctl.sheet = 0;
  // 动态列表：自己的删掉、别人的不看 TA（之后整体重排）
  const fd2 = loadPage('pages/feed/feed');
  fd2.onLoad();
  await idle();
  const all2 = fd2.data.left.concat(fd2.data.right);
  const someone = all2.find((p) => !p.mine && p.author && p.author.id);
  const countBefore = all2.length;
  const theirs = all2.filter((p) => p.author && p.author.id === someone.author.id).length;
  ctl.sheet = 1;
  fd2.onMore(ev({}, { id: someone.id }));
  await idle();
  const after2 = fd2.data.left.concat(fd2.data.right);
  check('不看 TA 的动态 → 列表去掉 TA 的并重排', after2.length === countBefore - theirs && after2.every((p) => !p.author || p.author.id !== someone.author.id), [countBefore, theirs, after2.length]);
  ctl.sheet = 0;
  const cp = loadPage('pages/compose/compose');
  cp.onLoad({ eventId: String(reading.id), visibility: 'event' });
  await idle();
  check('从群聊发照片：默认关联这个局、只给同局的人看', cp.data.eventId === reading.id && cp.data.visibility === 'event', [cp.data.eventId, cp.data.visibility]);
  const up2 = loadComponent('uploader', { max: 9 });
  check('发动态最多 9 张', up2.data.max === 9);
  up2.add();
  await idle(50);
  cp.onImages({ detail: up2.events.filter((e) => e.name === 'change').pop().detail });
  cp.onText(ev({}, { value: '读书局结束，窗边的光很好。' }));
  cp.submit();
  await idle();
  const postReq = lastBody(/^\/api\/posts$/, 'POST');
  check('发动态带图片地址', postReq && postReq.body.images.length === 1 && /\/uploads\//.test(postReq.body.images[0]) && postReq.body.visibility === 'event' && postReq.body.eventId === reading.id && postReq.status < 300, postReq && postReq.body);
  // 举报带截图
  const rp = loadPage('pages/report/report');
  rp.onLoad({ targetType: 'post', targetId: String(multi.id) });
  rp.pickReason(ev({ value: rp.data.reasons ? rp.data.reasons[0].value || rp.data.reasons[0] : '其他' }));
  const up3 = loadComponent('uploader', { max: 3 });
  up3.add();
  await idle(50);
  rp.onImages({ detail: up3.events.filter((e) => e.name === 'change').pop().detail });
  rp.submit();
  await idle();
  const repReq = lastBody(/^\/api\/reports$/, 'POST');
  check('举报带 1 张截图', repReq && repReq.status < 300 && repReq.body.images.length === 1 && rp.data.done, repReq && [repReq.status, repReq.body, repReq.data]);

  // ===================================================================
  section('AA：一次声明 → 谁转给谁 → 我已转账 → 确认收到');
  const aa = loadPage('pages/aa/aa');
  aa.onLoad({ id: String(reading.id) });
  await idle();
  check('还没人记，可以记一笔', aa.data.bill === null && aa.data.canDeclare === true, [aa.data.bill, aa.data.canDeclare]);
  aa.openDeclare();
  const as1 = loadComponent('aa-sheet', { memberCount: aa.data.memberCount });
  as1.setData({ show: true });
  as1.onAmount({ detail: { value: '120' } });
  as1.addQuick(ev({ word: '车费' }));
  as1.addQuick(ev({ word: '午饭' }));
  as1.addQuick(ev({ word: '车费' }));
  check('记账弹窗：4 人平摊每人 ¥30，包含「车费 + 午饭」', as1.data.each === '30' && as1.data.noteText === '车费 + 午饭', [as1.data.each, as1.data.noteText]);
  as1.onConfirm();
  aa.onSheetConfirm({ detail: as1.events.find((e) => e.name === 'confirm').detail });
  await idle();
  check('记好了：我垫付 ¥120，3 人转给我', aa.data.bill && aa.data.bill.mine && aa.data.total === '120' && aa.data.each === '30' && aa.data.transfers.length === 3 && aa.data.transfers.every((t) => t.toName === '我'), [aa.data.bill, aa.data.transfers]);
  check('没人转账前可以改', aa.data.bill.editable === true);
  aa.openEdit();
  aa.onSheetConfirm({ detail: { amount: 160, note: '车费 + 午饭 + 门票' } });
  await idle();
  check('改成 ¥160，每人 ¥40', aa.data.total === '160' && aa.data.each === '40' && aa.data.bill.note === '车费 + 午饭 + 门票', [aa.data.total, aa.data.each]);
  const g2 = loadPage('pages/group/group');
  g2.onLoad({ id: String(reading.id) });
  await idle();
  g2.onUnload();
  check('群聊顶部 AA 卡片', g2.data.aa.show && g2.data.aa.title === 'AA · 我 垫付 ¥160（车费 + 午饭 + 门票）' && /每人 ¥40/.test(g2.data.aa.text), g2.data.aa);
  // 再记一笔 → 409
  await as(4);
  log.modals.length = 0;
  log.toasts.length = 0;
  await api.declareAA(reading.id, { amount: 50 }).catch(() => {});
  check('每个局只记一次（再记 → 提示）', /记|已经/.test(lastModal() + lastToast()), [log.modals, log.toasts]);
  await as(7);
  const aa2 = loadPage('pages/aa/aa');
  aa2.onLoad({ id: String(reading.id) });
  await idle();
  check('南风看到：你需要转 ¥40 给 栗子', aa2.data.myTodo === '你需要转 ¥40 给 栗子', aa2.data.myTodo);
  const g3 = loadPage('pages/group/group');
  g3.onLoad({ id: String(reading.id) });
  await idle();
  g3.onUnload();
  check('南风的群聊 AA 卡片：去转账', g3.data.aa.button === '去转账' && /你转给栗子/.test(g3.data.aa.text), g3.data.aa);
  const myIdx = aa2.data.transfers.findIndex((t) => t.action === 'pay');
  ctl.modal = true;
  aa2.pay(ev({ index: myIdx }));
  await idle();
  check('我已转账 → 等对方确认', aa2.data.transfers[myIdx].statusText === '等对方确认' && !aa2.data.myTodo, aa2.data.transfers[myIdx]);
  await as(1);
  const aa3 = loadPage('pages/aa/aa');
  aa3.onLoad({ id: String(reading.id) });
  await idle();
  check('有人转账后不能再改', aa3.data.bill.editable === false, aa3.data.bill);
  log.modals.length = 0;
  log.toasts.length = 0;
  await api.updateAA(reading.id, { amount: 200 }).catch(() => {});
  check('服务端也拒绝修改', (lastModal() + lastToast()).length > 0, [log.modals, log.toasts]);
  const cIdx = aa3.data.transfers.findIndex((t) => t.action === 'confirm');
  aa3.confirmPaid(ev({ index: cIdx }));
  await idle();
  check('确认收到 → 已结清', aa3.data.transfers[cIdx].statusText === '已结清', aa3.data.transfers[cIdx]);
  const gi = loadPage('pages/group-info/group-info');
  gi.onLoad({ id: String(reading.id) });
  gi.onShow();
  await idle();
  check('局信息里的 AA 行', gi.data.aaText === '我 垫付 ¥160 · 2 笔待转', gi.data.aaText);

  // ===================================================================
  section('过了最晚退出时间：「退出这个局」变灰并写明原因');
  await as(11);
  const soon = await api.createEvent({ title: '傍晚洱海边散步', tag: '随便走走', startAt: new Date(Date.now() + 3 * 3600000).toISOString(), exitDeadline: new Date(Date.now() + 40 * 60000).toISOString(), place: '才村码头', capacity: 4, feeType: 'free', genderLimit: 'any' });
  check('老周发起一个 40 分钟后截止退出的局', soon && soon.id, soon);
  await as(1);
  const dx = loadPage('pages/detail/detail');
  dx.onLoad({ id: String(soon.id) });
  await idle();
  dx.openJoin();
  dx.confirmJoin();
  await idle();
  dx.closeJoin();
  await idle();
  check('加入后可以退出', dx.data.leave && dx.data.leave.disabled === false, dx.data.leave);
  await raw('POST', '/api/dev/clock', { advanceMinutes: 45 }, false);
  await raw('POST', '/api/dev/tick', {}, false);
  dx.load();
  await idle();
  check('过了最晚退出时间：按钮变灰 + 原因', dx.data.leave && dx.data.leave.disabled === true && /已过最晚退出时间（\d+月\d+日 \d\d:\d\d），不能退出了/.test(dx.data.leave.reason), dx.data.leave);
  log.modals.length = 0;
  dx.leaveEvent();
  check('点灰按钮 → 弹窗说明，不发请求', /^不能退出了 \| 已过最晚退出时间/.test(lastModal()), log.modals);
  log.modals.length = 0;
  await api.leave(soon.id).catch(() => {});
  check('硬调接口 → 409「已过最晚退出时间…」弹窗', /^不能退出了 \| 已过最晚退出时间（\d+月\d+日 \d\d:\d\d），不能退出了$/.test(lastModal()), log.modals);
  const gi2 = loadPage('pages/group-info/group-info');
  gi2.onLoad({ id: String(soon.id) });
  gi2.onShow();
  await idle();
  check('局信息页的退出按钮也变灰', gi2.data.leaveOff === true && /最晚退出时间/.test(gi2.data.leaveReason), [gi2.data.leaveOff, gi2.data.leaveReason]);
  log.modals.length = 0;
  await api.attendance(soon.id, false).catch(() => {});
  check('提醒里点「去不了了」也被拦 → 弹窗', /^不能退出了 \| 已过最晚退出时间/.test(lastModal()), log.modals);
  const mine2 = loadPage('pages/my-events/my-events');
  mine2.onLoad({});
  mine2.onShow();
  await idle();
  const formedCard = mine2.data.lists.ongoing.find((c) => c.id === reading.id);
  check('我的局：成群的才「去群聊」', formedCard && /^已成群 · 4\/4 · 去群聊$/.test(formedCard.pill) && /group\?id=/.test(formedCard.url), formedCard);
  const intentCard = mine2.data.lists.ongoing.find((c) => c.isIntent);
  check('我的局：撮合中的意向带插画', intentCard && !!intentCard.coverKey, intentCard);
  await raw('POST', '/api/dev/clock', { reset: true }, false);

  // ===================================================================
  section('主页背景：默认插画 → 换成自己的照片 → 别人主页也能看到 → 恢复默认');
  const lastColor = () => log.navColors[log.navColors.length - 1] || '';
  await as(1);
  const mp = loadPage('pages/me/me');
  mp.onShow();
  await idle();
  const me0 = mp.data.me || {};
  check('默认没有自己的背景，用第一个兴趣的插画', me0.coverUrl === null && me0.coverKey === format.tagCover(me0.interests[0], [], 'outdoor'), [me0.coverUrl, me0.coverKey, me0.interests]);
  const pc = loadComponent('profile-cover', { image: '', coverKey: me0.coverKey, title: me0.nickname, editable: true });
  check('背景铺到状态栏下面：高度 = 屏宽 × 0.6 + 状态栏，顶栏 = 胶囊下沿 + 4', pc.data.coverH === 234 + 47 && pc.data.navH === 87 && pc.data.titleInset === 102 && pc.data.capSide === 7, [pc.data.coverH, pc.data.navH, pc.data.titleInset, pc.data.capSide]);
  check('插画背景 + 状态栏黑字', pc.data.src === format.coverSrc(me0.coverKey) && !pc.data.isPhoto && !pc.data.dark && lastColor() === '#000000', [pc.data.src, lastColor()]);
  check('监听背景底边滑到顶栏下面', pc._ioMargins && pc._ioMargins.top === -87, pc._ioMargins);
  pc._io({ intersectionRatio: 0 });
  check('往上滑过背景 → 出现顶栏', pc.data.solid === true && lastColor() === '#000000', [pc.data.solid, lastColor()]);
  pc._io({ intersectionRatio: 1 });
  check('滑回来 → 顶栏消失', pc.data.solid === false, pc.data.solid);
  pc.onTapCover();
  pc.onChange();
  check('点背景、点「更换背景」都触发 change', pc.events.filter((e) => e.name === 'change').length === 2, pc.events);
  const night = loadComponent('profile-cover', { coverKey: 'boardgame' });
  check('深色插画（桌游）→ 状态栏白字', night.data.dark === true && lastColor() === '#ffffff', [night.data.dark, lastColor()]);
  night._io({ intersectionRatio: 0 });
  check('深色背景滑出顶栏后 → 黑字', lastColor() === '#000000', lastColor());

  log.modals.length = 0;
  log.toasts.length = 0;
  mp.changeCover();
  await idle();
  const coverPut = lastBody(/^\/api\/me$/, 'PUT');
  const myCover = mp.data.me.coverUrl;
  check('没换过背景：直接打开相册，不弹选项', !log.modals.some((m) => m.indexOf('sheet:') === 0), log.modals);
  check('上传后马上保存（PUT /api/me {coverUrl}）', coverPut && /\/uploads\//.test(coverPut.body.coverUrl) && coverPut.status === 200, coverPut && [coverPut.body, coverPut.status]);
  check('我的页换成自己的照片', /^http.*\/uploads\//.test(myCover || '') && session.cachedMe().coverUrl === myCover && lastToast() === '背景换好了', [myCover, lastToast()]);

  await as(3);
  const lizi = loadPage('pages/user/user');
  lizi.onLoad({ id: '1' });
  await idle();
  check('阿野看栗子的主页：同一张背景', lizi.data.user && lizi.data.user.coverUrl === myCover, lizi.data.user && lizi.data.user.coverUrl);
  const pc2 = loadComponent('profile-cover', { image: lizi.data.user.coverUrl, coverKey: lizi.data.user.coverKey, title: lizi.data.user.nickname, back: true });
  check('照片背景：顶部压暗 + 状态栏白字', pc2.data.isPhoto && pc2.data.dark && lastColor() === '#ffffff', [pc2.data.isPhoto, pc2.data.dark, lastColor()]);
  pc2.onTapCover();
  check('别人主页点背景 → 看大图', lastNav() === 'previewImage 1 ' + myCover, lastNav());
  pc2.onImgError();
  check('照片加载失败 → 退回插画', !pc2.data.isPhoto && pc2.data.src === format.coverSrc(lizi.data.user.coverKey), pc2.data.src);
  pc2.goBack();
  check('左上角返回', lastNav() === 'navigateBack ', lastNav());
  const ayeRes = await api.user(3);
  check('阿野自己设了背景（种子数据）', /^http.*\/uploads\//.test(ayeRes.user.coverUrl || ''), ayeRes.user.coverUrl);

  await as(1);
  const ep = loadPage('pages/edit-profile/edit-profile');
  ep.onLoad();
  await idle();
  check('编辑资料：背景预览是自己的照片', ep.data.coverSrc === myCover && ep.data.coverNote === '用的是你上传的照片', [ep.data.coverSrc, ep.data.coverNote]);
  ctl.sheet = 1;
  log.modals.length = 0;
  ep.changeCover();
  await idle();
  check('换过背景：弹「从相册选择 / 恢复默认背景」', log.modals.indexOf('sheet: 从相册选择/恢复默认背景') >= 0, log.modals);
  const firstOn = ep.data.tags.filter((t) => t.on)[0].label;
  check('选恢复默认 → 预览变回第一个兴趣的插画', ep.data.coverUrl === null && ep.data.coverSrc === format.coverSrc(me0.coverKey) && ep.data.coverNote === '默认用第一个兴趣「' + firstOn + '」的插画', [ep.data.coverSrc, ep.data.coverNote]);
  const ti = ep.data.tags.findIndex((t) => t.label === firstOn);
  ep.toggleTag(ev({ index: ti }));
  const nextOn = (ep.data.tags.filter((t) => t.on)[0] || {}).label;
  check('取消第一个兴趣 → 预览跟着换', ep.data.coverSrc === (nextOn ? format.coverSrc(format.tagCover(nextOn, [], 'outdoor')) : format.coverSrc('lake')), [nextOn, ep.data.coverSrc]);
  ep.toggleTag(ev({ index: ti }));
  ctl.sheet = 0;
  ep.save();
  await idle(700);
  const resetPut = lastBody(/^\/api\/me$/, 'PUT');
  check('保存时带 coverUrl: null', resetPut && resetPut.body.coverUrl === null && resetPut.status === 200 && resetPut.data.coverUrl === null, resetPut && [resetPut.body.coverUrl, resetPut.status]);
  mp.onShow();
  await idle();
  check('回到我的页：恢复成插画', mp.data.me.coverUrl === null && mp.data.me.coverKey === me0.coverKey, [mp.data.me.coverUrl, mp.data.me.coverKey]);

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fails.length) console.log('失败：\n  - ' + fails.join('\n  - '));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});

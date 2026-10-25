#!/usr/bin/env node
// 运营后台端到端测试：用真实的 Chromium 把后台主要流程走一遍，顺带检查控制台报错、失败的请求和手机宽度。
//
// 用法（在仓库根目录）：
//   node admin/tools/e2e.mjs [baseUrl] [password] [--shots <截图目录>] [--headed]
//   baseUrl 默认 http://localhost:3100，password 默认 admin123
//
// 注意：会改数据！请对着一个刚 seed 过的测试数据库跑（步骤见 admin/README.md）。
// 测试前会用开发接口（/api/auth/dev-login，只有非生产环境才有）造两条待审动态和一个能被撮合的意向。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ---- 参数 ----

const argv = process.argv.slice(2);
const positional = [];
let shotsDir = null;
let headed = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--shots') shotsDir = argv[++i];
  else if (argv[i] === '--headed') headed = true;
  else positional.push(argv[i]);
}
const BASE = (positional[0] || 'http://localhost:3100').replace(/\/+$/, '');
const PASSWORD = positional[1] || 'admin123';
const ADMIN = `${BASE}/admin/`;
// 可选：E2E_VUE_DEV=<vue.esm-browser.js 开发版的路径>，测试时换成开发版，[Vue warn] 也算问题（能发现模板里写错的字段）
const VUE_DEV = process.env.E2E_VUE_DEV || '';
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

// playwright 可能装在全局（NODE_PATH），ES module 的 import 找不到时退回 require
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    return require('playwright');
  }
}

// ---- 小工具 ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function http(method, url, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // 不是 JSON
  }
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

async function textOf(locator) {
  return clean(await locator.textContent({ timeout: 1000 }));
}

/** 等某个元素的文字里出现 expected（字符串包含或正则） */
async function expectText(locator, expected, timeout = 8000) {
  const ok = (t) => (expected instanceof RegExp ? expected.test(t) : t.includes(expected));
  const end = Date.now() + timeout;
  let last = '';
  while (Date.now() < end) {
    last = await textOf(locator.first()).catch(() => '');
    if (ok(last)) return last;
    await sleep(100);
  }
  throw new Error(`没等到「${expected}」，实际是「${last.slice(0, 200)}」`);
}

async function expectAttr(locator, name, value, timeout = 8000) {
  const end = Date.now() + timeout;
  let last = null;
  while (Date.now() < end) {
    last = await locator.first().getAttribute(name, { timeout: 1000 }).catch(() => null);
    if (last === value) return;
    await sleep(100);
  }
  throw new Error(`${name} 应该是 ${value}，实际是 ${last}`);
}

async function expectCount(locator, n, timeout = 8000) {
  const end = Date.now() + timeout;
  let last = -1;
  while (Date.now() < end) {
    last = await locator.count();
    if (typeof n === 'function' ? n(last) : last === n) return last;
    await sleep(100);
  }
  throw new Error(`数量不对：期望 ${typeof n === 'function' ? '满足条件' : n}，实际 ${last}`);
}

async function until(fn, what, timeout = 8000) {
  const end = Date.now() + timeout;
  let lastErr = null;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(150);
  }
  throw new Error(`等不到：${what}${lastErr ? `（${lastErr.message}）` : ''}`);
}

let stepNo = 0;
async function step(name, fn) {
  stepNo += 1;
  const no = String(stepNo).padStart(2, '0');
  const start = Date.now();
  try {
    await fn();
    console.log(`  ok   ${no}  ${name}  (${Date.now() - start}ms)`);
  } catch (e) {
    console.log(`  FAIL ${no}  ${name}`);
    throw e;
  }
}

// ---- 主流程 ----

async function main() {
  const t0 = Date.now();
  console.log(`活动搭子运营后台 · 端到端测试\n  地址：${ADMIN}\n`);

  // 准备：接口能通、数据是刚 seed 的样子，再造几条测试数据
  let adminToken;
  const fx = {};
  await step('服务可用，后台密码正确', async () => {
    await http('GET', '/api/health');
    adminToken = (await http('POST', '/api/admin/login', { body: { password: PASSWORD } })).token;
  });
  const aget = (url) => http('GET', url, { token: adminToken });
  const userId = async (nickname) => {
    const u = (await aget(`/api/admin/users?q=${encodeURIComponent(nickname)}`)).items.find((x) => x.nickname === nickname);
    if (!u) throw new Error(`找不到用户「${nickname}」——请先用 seed 重置测试数据库`);
    return u.id;
  };

  await step('准备测试数据：待确认方案、待审动态、举报、申诉', async () => {
    const pending = (await aget('/api/admin/proposals')).items;
    fx.hike = pending.find((p) => p.task === '爬山');
    if (!fx.hike) throw new Error('没有待确认的「爬山」方案——请先用 seed 重置测试数据库');
    // 七七也想明天下午喝咖啡 → 和阿云、青青凑成第二个待确认方案（用来测「退回」）
    const pool = (await aget('/api/admin/intents')).items;
    const coffee = pool.find((i) => i.task === '咖啡');
    if (!coffee) throw new Error('撮合池里没有「咖啡」意向——请先用 seed 重置测试数据库');
    const qiqi = (await http('POST', '/api/auth/dev-login', { body: { userId: await userId('七七') } })).token;
    await http('POST', '/api/intents', { token: qiqi, body: { task: '咖啡', when: coffee.dateFrom, slot: coffee.slot, area: coffee.area } });
    fx.coffee = (await aget('/api/admin/proposals')).items.find((p) => p.task === '咖啡');
    if (!fx.coffee) throw new Error('七七提交意向后没有配出「咖啡」方案');
    // 两条会被系统拦下的动态（联系方式、广告）
    const lizi = (await http('POST', '/api/auth/dev-login', { body: {} })).token;
    fx.post1 = await http('POST', '/api/posts', { token: lizi, body: { text: 'E2E 待审动态一：周末想去才村拍晚霞，想一起的加我 vx：e2e_lizi_01', images: [], visibility: 'public' } });
    fx.post2 = await http('POST', '/api/posts', { token: lizi, body: { text: 'E2E 待审动态二：帮朋友代购面膜，私聊有优惠', images: [], visibility: 'public' } });
    if (fx.post1.status !== 'pending' || fx.post2.status !== 'pending') throw new Error('测试动态没有进入待审核');
    fx.reports = (await aget('/api/admin/reports')).items;
    fx.report = fx.reports.find((r) => r.targetType === 'message');
    if (!fx.report) throw new Error('没有针对群聊消息的待处理举报——请先用 seed 重置测试数据库');
    fx.appeal = (await aget('/api/admin/appeals')).items[0];
    if (!fx.appeal) throw new Error('没有待处理的申诉——请先用 seed 重置测试数据库');
    fx.pendingEvent = (await aget('/api/admin/events?status=pending_review')).items[0];
    if (!fx.pendingEvent) throw new Error('没有待审核的用户局——请先用 seed 重置测试数据库');
  });

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);

  // 控制台报错、脚本异常、失败的请求都算问题；「输错密码」「登录过期」那两步的 401 是预期的
  const problems = [];
  let expect401 = false;
  let closing = false;
  if (VUE_DEV) {
    await page.route('**/vendor/vue.esm-browser.prod.js', (route) =>
      route.fulfill({ path: VUE_DEV, contentType: 'text/javascript; charset=utf-8' }),
    );
    console.log(`  （用 Vue 开发版：${VUE_DEV}）`);
  }
  page.on('console', (m) => {
    if (m.type() === 'warning' && /\[Vue warn\]/.test(m.text())) problems.push(`Vue 警告：${m.text().slice(0, 300)}`);
    if (m.type() !== 'error') return;
    if (expect401 && /401/.test(m.text())) return;
    problems.push(`控制台报错：${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`页面脚本异常：${e.message}`));
  page.on('requestfailed', (r) => {
    if (closing) return;
    problems.push(`请求失败：${r.method()} ${r.url()} ${r.failure() ? r.failure().errorText : ''}`);
  });
  page.on('response', (r) => {
    if (r.status() < 400) return;
    if (expect401 && r.status() === 401) return;
    problems.push(`HTTP ${r.status()}：${r.request().method()} ${r.url()}`);
  });

  const shot = async (name) => {
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}.png`), fullPage: true });
  };
  const banner = () => page.locator('.banner');
  async function expectBanner(text) {
    await expectText(banner(), text);
    const role = await banner().first().getAttribute('role');
    if (role !== 'status') throw new Error(`提示条的 role 应该是 status，实际是 ${role}`);
  }
  async function noHorizontalScroll(label) {
    await sleep(150);
    const r = await page.evaluate(() => {
      const cw = document.documentElement.clientWidth;
      // 宽表格本来就在自己的框里横向滚动；这里只列出框外面、或者绝对定位逃出框的元素，方便定位
      const offenders = [...document.querySelectorAll('body *')]
        .filter((el) => el.getBoundingClientRect().right > cw + 1)
        .filter((el) => !el.closest('.table-wrap') || getComputedStyle(el).position === 'absolute')
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`);
      return { sw: document.documentElement.scrollWidth, cw, offenders };
    });
    if (r.sw > r.cw + 1) throw new Error(`${label}：页面可以横向滚动（${r.sw} > ${r.cw}）${r.offenders.join(', ')}`);
  }
  const goto = async (hash) => {
    await page.goto(`${ADMIN}#/${hash}`);
  };
  const h1 = () => page.locator('h1');
  const nav = (name) => page.getByRole('navigation', { name: '后台菜单' }).getByRole('link', { name });

  try {
    // ---- 登录 ----

    await step('打开后台会先到登录页；手机宽度下不横向滚动', async () => {
      await page.goto(ADMIN);
      await until(() => page.url().includes('#/login'), '跳到 #/login');
      await expectText(h1(), '登录后台');
      await noHorizontalScroll('登录页');
      await shot('m-login');
    });

    await step('登录：没填密码、密码不对都有提示，填对进入概览', async () => {
      await page.getByRole('button', { name: '进入后台' }).click();
      await expectText(page.getByRole('alert'), '先输入密码');
      expect401 = true;
      await page.getByLabel('后台密码').fill('not-the-password');
      await page.getByRole('button', { name: '进入后台' }).click();
      await expectText(page.getByRole('alert'), '密码不对');
      await sleep(300);
      expect401 = false;
      await page.getByLabel('后台密码').fill(PASSWORD);
      await page.getByRole('button', { name: '进入后台' }).click();
      await until(() => page.url().includes('#/dashboard'), '跳到 #/dashboard');
      await expectText(h1(), '概览');
      const token = await page.evaluate(() => localStorage.getItem('dazi.admin.token'));
      if (!token) throw new Error('登录后 localStorage 里没有 token');
      await expectAttr(nav(/^概览/), 'aria-current', 'page');
    });

    // ---- 手机宽度：每一页都不能横向滚动（宽表格在自己的框里滚） ----

    await step('390px 宽度：五个页面（含展开的详情、表单）都没有横向滚动', async () => {
      await expectText(page.locator('.kpi').first(), '今日新用户');
      await noHorizontalScroll('概览');
      await shot('m-dashboard');

      await goto('matching');
      await expectText(h1(), '撮合池');
      await page.locator('article.proposal').first().waitFor();
      await noHorizontalScroll('撮合池');
      const card = page.locator('article.proposal').first();
      await card.getByRole('button', { name: '确认成局' }).click();
      await card.getByLabel('标题').waitFor();
      await noHorizontalScroll('撮合池（确认表单）');
      await shot('m-matching');
      await card.getByRole('button', { name: '先不发' }).click();

      await goto('moderation');
      await expectText(h1(), '审核与举报');
      await page.locator('.detail').waitFor();
      await noHorizontalScroll('审核与举报');
      await shot('m-moderation');

      await goto('events');
      await expectText(h1(), '局管理');
      await expectCount(page.locator('table.table--events tbody tr td:nth-child(7)'), (n) => n > 0);
      await page.getByRole('button', { name: '发起平台局' }).click();
      await page.locator('#n-title').waitFor();
      await page.locator('table.table--events tbody tr td:nth-child(7) button').first().click();
      await page.locator('#ev-detail-title').waitFor();
      await noHorizontalScroll('局管理（表单 + 详情）');
      await shot('m-events');

      await goto('users');
      await expectText(h1(), '用户与信用');
      await expectCount(page.locator('table.table--users tbody tr td:nth-child(10)'), (n) => n > 0);
      await page.locator('table.table--users tbody tr td:nth-child(10) button').first().click();
      await page.locator('#user-detail-title').waitFor();
      await noHorizontalScroll('用户与信用（详情）');
      await shot('m-users');
      await page.getByRole('tab', { name: /申诉/ }).click();
      await page.locator('article.appeal').first().waitFor();
      await noHorizontalScroll('用户与信用（申诉）');
    });

    await page.setViewportSize({ width: 1440, height: 1000 });

    // ---- 概览 ----

    await step('概览：数字和接口一致，柱状图 7 根柱子、悬停有提示，可以切到表格', async () => {
      await goto('dashboard');
      await expectText(h1(), '概览');
      await page.locator('.kpi').first().waitFor();
      const stats = await aget('/api/admin/stats');
      const kpi = (label) => page.locator('.kpi', { hasText: label }).locator('.kpi__value');
      await expectText(kpi('今日新用户'), String(stats.today.newUsers));
      await expectText(kpi('今日新意向'), String(stats.today.newIntents));
      await expectText(kpi('等你确认的局'), String(stats.today.pendingProposals));
      await expectText(kpi('待处理举报'), String(stats.today.pendingReports));
      await expectText(kpi('本周履约率'), `${stats.week.attendanceRate}%`);
      const bars = page.locator('.chart__hit');
      await expectCount(bars, 7);
      const labels = await bars.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
      if (!labels.every((l) => /成局 \d+ 个/.test(l))) throw new Error(`柱子的 aria-label 不对：${labels.join(' / ')}`);
      if (labels.some((l, i) => !l.includes(`成局 ${stats.series[i].formed} 个`))) throw new Error('柱子的数字和接口对不上');
      await bars.last().hover();
      await expectText(page.getByRole('tooltip'), `今天到目前 · 成局 ${stats.series[6].formed} 个`);
      await bars.first().focus();
      await expectText(page.getByRole('tooltip'), '成局');
      await shot('d-dashboard');
      await page.getByRole('button', { name: '表格', exact: true }).click();
      await expectAttr(page.getByRole('button', { name: '表格', exact: true }), 'aria-pressed', 'true');
      const table = page.getByRole('table', { name: '近 7 天成局数' });
      await expectCount(table.locator('tbody tr'), 7);
      const total = stats.series.reduce((s, x) => s + x.formed, 0);
      await expectText(table.locator('tfoot th'), '合计');
      await expectText(table.locator('tfoot td'), String(total));
      await page.getByRole('button', { name: '图表', exact: true }).click();
      await expectCount(page.locator('.chart__hit'), 7);
      await expectText(page.locator('section[aria-labelledby="todo-match"]'), fx.hike.title);
    });

    // ---- 撮合池 ----

    const proposalCard = (title) =>
      page.locator('article.proposal', { has: page.getByRole('heading', { name: title, exact: true }) });

    await step('撮合池：调整成员——移出一个人再加回来，匹配度重新算', async () => {
      await nav(/^撮合池/).click();
      await expectText(h1(), '撮合池');
      await expectAttr(page.getByRole('tab', { name: /待确认/ }), 'aria-selected', 'true');
      const card = proposalCard(fx.hike.title);
      await card.waitFor();
      const who = fx.hike.members[1].user.nickname;
      await card.getByRole('button', { name: '调整成员' }).click();
      await card.getByRole('button', { name: `把 ${who} 移出这个方案` }).click();
      await expectBanner(`已把 ${who} 移出`);
      await expectCount(card.locator('.member'), fx.hike.members.length - 1);
      await expectText(card.locator('.panel__hint'), `现在 ${fx.hike.members.length - 1} 人`);
      await card.getByRole('button', { name: `把 ${who} 加进这个方案` }).click();
      await expectBanner(`已把 ${who} 加进`);
      await expectCount(card.locator('.member'), fx.hike.members.length);
      await card.getByRole('button', { name: '调整好了' }).click();
    });

    const newTitle = 'E2E · 周日一起爬苍山';
    await step('撮合池：确认成局（改了标题和时间）→ 离开「待确认」，出现在「已发邀请」', async () => {
      const card = proposalCard(fx.hike.title);
      const pendingTab = page.getByRole('tab', { name: /待确认/ });
      const before = Number((await textOf(pendingTab.locator('.tab__count'))) || 0);
      await card.getByRole('button', { name: '确认成局' }).click();
      await card.getByLabel('标题').fill(newTitle);
      await card.getByLabel('开始时间').fill('08:30');
      await card.getByLabel('预计每人 ¥').fill('20');
      await card.getByRole('button', { name: '多一个名额' }).click();
      await expectText(card.locator('.stepper__value'), String(fx.hike.members.length + 1));
      await card.getByRole('button', { name: '少一个名额' }).click();
      await expectText(card.locator('.stepper__value'), String(fx.hike.members.length));
      await shot('d-matching-confirm');
      await card.getByRole('button', { name: /^发出邀请/ }).click();
      await expectBanner(`已发邀请给 ${fx.hike.members.length} 人：「${newTitle}」`);
      await expectCount(proposalCard(fx.hike.title), 0);
      await expectText(pendingTab.locator('.tab__count'), String(before - 1));
      const inviting = (await aget('/api/admin/events?source=matched&status=inviting')).items.find((e) => e.title === newTitle);
      if (!inviting) throw new Error('接口里找不到新建的撮合局');
      const p = await page.evaluate((iso) => new Date(iso).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), inviting.startAt);
      if (p !== '08:30') throw new Error(`集合时间应该是北京时间 08:30，实际 ${p}`);
      await banner().getByRole('button', { name: '去看看' }).click();
      await expectAttr(page.getByRole('tab', { name: /已发邀请/ }), 'aria-selected', 'true');
      const invited = page.locator('article.proposal', { has: page.getByRole('heading', { name: newTitle }) });
      await expectText(invited, `0 / ${fx.hike.members.length} 人已加入`);
      await expectText(invited, '截止');
    });

    await step('撮合池：退回方案（必须选原因）→ 出现在「已退回」', async () => {
      await page.getByRole('tab', { name: /待确认/ }).click();
      const card = proposalCard(fx.coffee.title);
      await card.getByRole('button', { name: '退回' }).click();
      await card.getByRole('button', { name: '确认退回' }).click();
      await expectText(card.getByRole('alert'), '先选一个原因');
      await card.getByRole('button', { name: '时间对不上' }).click();
      await expectAttr(card.getByRole('button', { name: '时间对不上' }), 'aria-pressed', 'true');
      await card.getByLabel(/补充说明/).fill('E2E 退回测试');
      await card.getByRole('button', { name: '确认退回' }).click();
      await expectBanner(`已退回「${fx.coffee.title}」，${fx.coffee.members.length} 个意向回到撮合池`);
      await expectCount(proposalCard(fx.coffee.title), 0);
      await page.getByRole('tab', { name: /已退回/ }).click();
      await expectText(page.locator('#match-panel'), '退回原因：时间对不上：E2E 退回测试');
      const rejected = (await aget('/api/admin/proposals?status=rejected')).items.find((x) => x.id === fx.coffee.id);
      if (!rejected) throw new Error('接口里这个方案没有变成已退回');
    });

    await step('撮合池：立即撮合一次', async () => {
      await page.getByRole('button', { name: /立即撮合一次/ }).click();
      await expectBanner('撮合完成 · 新配出');
      await expectText(page.getByRole('button', { name: /再撮合一次/ }), '再撮合一次');
    });

    await step('撮合池：自动成局开关打开、改门槛、再关上（role="switch"）', async () => {
      const sw = page.getByRole('switch', { name: '自动成局' });
      await expectAttr(sw, 'aria-checked', 'false');
      await sw.click();
      await expectAttr(sw, 'aria-checked', 'true');
      await expectBanner('自动成局已打开');
      await page.getByRole('button', { name: '≥ 95' }).click();
      await expectAttr(page.getByRole('button', { name: '≥ 95' }), 'aria-pressed', 'true');
      await expectBanner('门槛改成 ≥ 95');
      await sw.click();
      await expectAttr(sw, 'aria-checked', 'false');
      await expectBanner('自动成局已关闭');
      const { autoConfirm } = await aget('/api/admin/settings');
      if (autoConfirm.enabled !== false || autoConfirm.threshold !== 95) throw new Error(`设置没存对：${JSON.stringify(autoConfirm)}`);
      await shot('d-matching');
    });

    // ---- 审核与举报 ----

    await step('审核：举报选「警告」处理，举报人收到通知，列表里变成已处理', async () => {
      await nav(/^审核与举报/).click();
      await expectText(h1(), '审核与举报');
      await page.getByRole('button', { name: /在群聊里的发言/ }).click();
      await expectText(page.locator('#mod-detail-title'), '在群聊里的发言');
      await expectText(page.locator('.detail blockquote'), fx.report.preview.slice(0, 10));
      await page.getByRole('button', { name: '确认处理' }).click();
      await expectText(page.locator('.detail').getByRole('alert'), '先选一种处理方式');
      await page.getByRole('group', { name: '处理方式' }).getByRole('button', { name: '警告' }).click();
      await expectAttr(page.getByRole('group', { name: '处理方式' }).getByRole('button', { name: '警告' }), 'aria-pressed', 'true');
      await page.getByLabel(/提醒内容/).fill('E2E：请不要在群里拉人去朋友的店');
      await page.getByRole('button', { name: '确认处理' }).click();
      await expectBanner('已处理：警告');
      await expectText(page.locator('.done-box'), '已处理 · 警告');
      await expectText(page.getByRole('button', { name: /在群聊里的发言/ }), '已处理');
      const all = (await aget('/api/admin/reports?status=all')).items.find((r) => r.id === fx.report.id);
      if (!all || all.action !== 'warn') throw new Error('接口里这条举报没有记成「警告」');
      await shot('d-moderation');
    });

    await step('审核：被举报人卡片能跳到「用户与信用」看信用记录', async () => {
      await page.getByRole('link', { name: '看信用记录' }).click();
      await expectText(h1(), '用户与信用');
      await expectText(page.locator('#user-detail-title'), fx.report.targetUser.nickname);
      await page.goBack();
      await expectText(h1(), '审核与举报');
    });

    await step('审核：动态待审——一条通过，一条不通过（必须选原因）', async () => {
      await page.getByRole('tab', { name: /动态待审/ }).click();
      await page.getByRole('button', { name: /E2E 待审动态一/ }).click();
      await expectText(page.locator('.detail blockquote'), 'E2E 待审动态一');
      await page.getByRole('button', { name: '通过，发出来' }).click();
      await expectBanner('已通过');
      await expectText(page.locator('.done-box'), '已通过');
      await page.getByRole('button', { name: /E2E 待审动态二/ }).click();
      await page.getByRole('button', { name: '不通过' }).click();
      await page.getByRole('button', { name: '确认不通过' }).click();
      await expectText(page.locator('.detail').getByRole('alert'), '先选一个原因');
      await page.getByRole('button', { name: '广告推销' }).click();
      await page.getByRole('button', { name: '确认不通过' }).click();
      await expectBanner('没有通过');
      await expectText(page.locator('.done-box'), '未通过：广告推销');
      const posts = (await aget('/api/admin/posts?status=all')).items;
      const s1 = posts.find((p) => p.id === fx.post1.id)?.status;
      const s2 = posts.find((p) => p.id === fx.post2.id)?.status;
      if (s1 !== 'approved' || s2 !== 'rejected') throw new Error(`动态状态不对：${s1} / ${s2}`);
    });

    await step('审核：局待审——看发起人写的介绍，不通过', async () => {
      await page.getByRole('tab', { name: /局待审/ }).click();
      await expectText(page.locator('#mod-detail-title'), fx.pendingEvent.title);
      await expectText(page.locator('.detail blockquote'), /\S/);
      await page.getByRole('button', { name: '不通过' }).click();
      await page.getByRole('button', { name: '广告推销' }).click();
      await page.getByRole('button', { name: '确认不通过' }).click();
      await expectBanner('没有通过');
      const ev = (await aget(`/api/admin/events/${fx.pendingEvent.id}`)).event;
      if (ev.status !== 'rejected') throw new Error(`局的状态应该是 rejected，实际 ${ev.status}`);
    });

    // ---- 局管理 ----

    const eventRows = () => page.locator('table.table--events tbody tr:has(td:nth-child(7))');
    const columnTexts = (n) => eventRows().locator(`td:nth-child(${n})`).allTextContents();

    await step('局管理：按来源、关键词、状态筛选', async () => {
      await nav(/^局管理/).click();
      await expectText(h1(), '局管理');
      await expectCount(eventRows(), (n) => n > 3);
      await page.getByRole('group', { name: '来源' }).getByRole('button', { name: '用户发起' }).click();
      await until(async () => {
        const src = (await columnTexts(5)).map(clean);
        return src.length > 0 && src.every((x) => x === '用户发起');
      }, '只剩「用户发起」的局');
      await page.getByRole('group', { name: '来源' }).getByRole('button', { name: '全部来源' }).click();
      await page.getByRole('searchbox', { name: '搜标题或地点' }).fill('读书');
      await until(async () => {
        const titles = (await columnTexts(1)).map(clean);
        return titles.length > 0 && titles.every((x) => x.includes('读书'));
      }, '搜「读书」只剩读书局');
      await page.getByRole('searchbox', { name: '搜标题或地点' }).fill('');
      await expectCount(eventRows(), (n) => n > 3);
      await page.getByRole('group', { name: '状态' }).getByRole('button', { name: '已结束' }).click();
      await until(async () => {
        const st = (await columnTexts(6)).map(clean);
        return st.length > 0 && st.every((x) => x === '已结束');
      }, '只剩「已结束」的局');
      await page.getByRole('group', { name: '状态' }).getByRole('button', { name: '全部', exact: true }).click();
      await expectCount(eventRows(), (n) => n > 3);
    });

    await step('局管理：查看详情（时间、地点、成员、群聊、AA）', async () => {
      await page.getByRole('button', { name: '查看 周六清晨 · 苍山看日出' }).click();
      const detail = page.locator('#event-detail');
      await expectText(detail.locator('#ev-detail-title'), '周六清晨 · 苍山看日出');
      await expectText(detail, '大理古城南门');
      await expectText(detail, '成员 5/5');
      await expectText(detail, '暖宝宝');
      await expectText(detail, 'AA 2 笔 ¥150');
      await page.getByRole('button', { name: '收起详情' }).click();
      await expectCount(page.locator('#event-detail'), 0);
    });

    const platformTitle = 'E2E 平台局 · 洱海边散步';
    await step('局管理：发起平台局，出现在列表里', async () => {
      await page.getByRole('button', { name: '发起平台局' }).click();
      await expectAttr(page.getByRole('button', { name: '发起平台局' }), 'aria-expanded', 'true');
      const form = page.locator('#new-event');
      await form.getByRole('button', { name: '发布到广场' }).click();
      await expectText(form.getByRole('alert'), '标题、日期、开始时间和地点都要填');
      await form.getByLabel('标题', { exact: true }).fill(platformTitle);
      await form.getByRole('group', { name: '分类' }).getByRole('button', { name: '户外' }).click();
      await form.getByLabel('开始时间').fill('09:30');
      await form.getByLabel('地点', { exact: true }).fill('才村码头');
      await form.getByLabel(/集合点/).fill('码头入口');
      await form.getByRole('button', { name: '多一个名额' }).click();
      await form.getByRole('button', { name: '免费' }).click();
      await form.getByLabel(/介绍/).fill('E2E 测试创建的平台局，沿着洱海慢慢走。');
      await shot('d-events-create');
      await form.getByRole('button', { name: '发布到广场' }).click();
      await expectBanner(`已发布到广场：「${platformTitle}」`);
      await expectText(page.locator('#ev-detail-title'), platformTitle);
      const row = eventRows().filter({ hasText: platformTitle });
      await expectCount(row, 1);
      await expectText(row.locator('td:nth-child(5)'), '平台');
      await expectText(row.locator('td:nth-child(4)'), '0/7');
      const created = (await aget('/api/admin/events?source=platform')).items.find((e) => e.title === platformTitle);
      if (!created || created.status !== 'open' || created.feeLabel !== '免费') throw new Error(`接口里的平台局不对：${JSON.stringify(created)}`);
    });

    await step('局管理：取消一个有人报名的局（必须选原因），通知成员', async () => {
      await page.getByRole('searchbox', { name: '搜标题或地点' }).fill('骑行');
      await page.getByRole('button', { name: '查看 洱海西岸骑行' }).click();
      const detail = page.locator('#event-detail');
      await expectText(detail.locator('#ev-detail-title'), '洱海西岸骑行');
      await detail.getByRole('button', { name: '取消这个局' }).click();
      await detail.getByRole('button', { name: /^确认取消/ }).click();
      await expectText(detail.getByRole('alert'), '先选一个原因');
      await detail.getByRole('button', { name: '天气不好' }).click();
      await detail.getByRole('button', { name: /^确认取消/ }).click();
      await expectBanner('已取消「洱海西岸骑行」（天气不好），已通知');
      await expectText(detail, '这个局已取消，只能查看');
      await expectText(eventRows().filter({ hasText: '洱海西岸骑行' }).locator('td:nth-child(6)'), '已取消');
      await shot('d-events');
    });

    // ---- 用户与信用 ----

    let aye;
    await step('用户：搜索、查看详情、撤销一条「临时鸽」→ 履约率变了', async () => {
      await nav(/^用户与信用/).click();
      await expectText(h1(), '用户与信用');
      aye = (await aget(`/api/admin/users/${await userId('阿野')}`));
      const before = aye.credit.rate;
      await page.getByRole('searchbox', { name: '搜昵称或手机尾号' }).fill('阿野');
      await expectCount(page.locator('table.table--users tbody tr:has(td:nth-child(10))'), 1);
      await page.getByRole('button', { name: '查看 阿野' }).click();
      await expectText(page.locator('#user-detail-title'), '阿野');
      await expectText(page.locator('.credit-tile__big'), `${before}%`);
      await page.getByRole('button', { name: /的「临时鸽」$/ }).first().click();
      await page.getByRole('button', { name: '确定撤销' }).click();
      const after = (await aget(`/api/admin/users/${aye.user.id}`)).credit.rate;
      if (after === before) throw new Error(`撤销后履约率没变（${before}%）`);
      await expectBanner(`履约率 ${before}% → ${after}%`);
      await expectText(page.locator('.credit-tile__big'), `${after}%`);
      await expectText(page.locator('.timeline'), '已撤销');
    });

    await step('用户：限制 7 天，再解除限制', async () => {
      await page.getByRole('button', { name: '限制 7 天' }).click();
      await page.getByLabel(/限制原因/).fill('E2E 测试限制');
      await page.getByRole('button', { name: '确认限制 7 天' }).click();
      await expectBanner('已限制 阿野 7 天');
      await expectText(page.locator('.account-box'), '受限到');
      await page.getByRole('button', { name: '解除限制' }).click();
      await expectBanner('已解除限制：阿野');
      const u = (await aget(`/api/admin/users/${aye.user.id}`)).user;
      if (u.status !== 'active') throw new Error(`解除限制后状态应该是 active，实际 ${u.status}`);
    });

    await step('用户：申诉——通过并撤销那条记录', async () => {
      await page.getByRole('tab', { name: /申诉/ }).click();
      await expectAttr(page.getByRole('tab', { name: /申诉/ }), 'aria-selected', 'true');
      const card = page.locator('article.appeal', { hasText: `${fx.appeal.user.nickname} 的申诉` });
      await card.getByLabel(/回复/).fill('E2E：核实了，你提前说过去不了，这条记录已经撤销。');
      await card.getByRole('button', { name: '通过，撤销这条记录' }).click();
      await expectBanner(`已通过 ${fx.appeal.user.nickname} 的申诉`);
      await expectText(card.locator('.done-box'), '已通过，这条记录已撤销');
      const a = (await aget('/api/admin/appeals?status=all')).items.find((x) => x.id === fx.appeal.id);
      if (!a || a.status !== 'approved') throw new Error('接口里申诉没有变成已通过');
      await expectText(page.getByRole('tab', { name: /申诉/ }).locator('.tab__count'), '0');
      await shot('d-users');
    });

    // ---- 登录过期、退出 ----

    await step('登录过期（任何接口 401）→ 清掉 token 回到登录页，登录后回到原来的页面', async () => {
      expect401 = true;
      await goto('events');
      await expectText(h1(), '局管理');
      await page.evaluate(() => localStorage.setItem('dazi.admin.token', 'a_expired_token_for_e2e'));
      await page.reload();
      await until(() => page.url().includes('#/login'), '跳到登录页');
      await expectText(h1(), '登录后台');
      const left = await page.evaluate(() => localStorage.getItem('dazi.admin.token'));
      if (left) throw new Error('401 之后 token 没有清掉');
      await sleep(300);
      expect401 = false;
      await page.getByLabel('后台密码').fill(PASSWORD);
      await page.getByRole('button', { name: '进入后台' }).click();
      await until(() => page.url().includes('#/events'), '登录后回到 #/events');
      await expectText(h1(), '局管理');
    });

    await step('退出登录 → 回到登录页，再打开后台页面会被挡回登录页', async () => {
      await page.getByRole('button', { name: '退出登录' }).click();
      await expectText(h1(), '登录后台');
      const left = await page.evaluate(() => localStorage.getItem('dazi.admin.token'));
      if (left) throw new Error('退出后 token 还在');
      await goto('users');
      await until(() => page.url().includes('#/login'), '没登录时被挡回登录页');
    });

    await step('整个过程没有控制台报错，也没有失败的请求', async () => {
      if (problems.length) throw new Error(`发现 ${problems.length} 个问题：\n    ${problems.join('\n    ')}`);
    });

    console.log(`\n全部通过：${stepNo} 步，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒${shotsDir ? `，截图在 ${shotsDir}` : ''}`);
  } catch (e) {
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'failure.png'), fullPage: true }).catch(() => {});
    console.error(`\n测试失败：${e.message}`);
    if (problems.length) console.error(`另外记录到的问题：\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
  } finally {
    closing = true;
    await browser.close();
  }
}

main().catch((e) => {
  console.error(`\n测试没能跑起来：${e.message}`);
  process.exitCode = 1;
});

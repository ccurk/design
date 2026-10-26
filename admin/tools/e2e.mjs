#!/usr/bin/env node
// 运营后台端到端测试：用真实的 Chromium 把后台主要流程走一遍，顺带检查控制台报错、失败的请求和手机宽度。
//
// 用法（在仓库根目录）：
//   node admin/tools/e2e.mjs [baseUrl] [password] [--shots <截图目录>] [--headed]
//   baseUrl 默认 http://localhost:3100，password 默认 admin123
//
// 注意：会改数据！请对着一个刚 seed 过的测试数据库跑（步骤见 admin/README.md）。
// 测试前会用开发接口（/api/auth/dev-login，只有非生产环境才有）造几条待审动态（有一条带照片）和几个能被撮合的意向，
// 也会用它以用户身份看通知（检查「给 TA 的说明」「提醒」「撤销记录」的通知内容）、报名局。
// 上传用的测试图片是脚本自己画的 PNG，不需要额外的文件。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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
/** 把一段文字变成「包含这段文字」的正则（按钮的名字里还有别的字时用） */
const has = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

// ---- 测试图片：画一张小 PNG（天空、太阳、两座山），不依赖任何图片库 ----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** colors：[天空, 太阳, 远山, 近山]，每个是 [r, g, b] */
function scenePng(w, h, [sky, sun, far, near]) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3); // 每行开头一个字节的过滤方式（0 = 不过滤）
    for (let x = 0; x < w; x++) {
      let c = sky;
      if ((x - w * 0.62) ** 2 + (y - h * 0.4) ** 2 < (h * 0.16) ** 2) c = sun;
      if (y > h * 0.45 + Math.abs(x - w * 0.3) * 0.7) c = far;
      if (y > h * 0.62 + Math.abs(x - w * 0.78) * 0.45) c = near;
      row.set(c, 1 + x * 3);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8 位
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
const IMG = {
  banner: { name: 'e2e-banner.png', mimeType: 'image/png', buffer: scenePng(480, 240, [[124, 202, 227], [255, 210, 122], [46, 74, 92], [25, 53, 67]]) },
  photo1: { name: 'e2e-photo-1.png', mimeType: 'image/png', buffer: scenePng(300, 200, [[252, 239, 217], [247, 190, 149], [130, 160, 120], [70, 110, 80]]) },
  photo2: { name: 'e2e-photo-2.png', mimeType: 'image/png', buffer: scenePng(300, 200, [[228, 242, 248], [255, 255, 255], [30, 132, 184], [25, 53, 67]]) },
  notImage: { name: 'e2e-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') },
};

/** 以用户身份上传一张图片（POST /api/upload）→ 图片地址 */
async function uploadAs(token, file) {
  const form = new FormData();
  form.append('file', new Blob([file.buffer], { type: file.mimeType }), file.name);
  const res = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.url) throw new Error(`上传失败：${res.status} ${JSON.stringify(data)}`);
  return data.url;
}

/** 发请求，不管成败都返回 { status, data } */
async function httpRaw(method, url, { body, token } = {}) {
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
  return { status: res.status, data };
}

async function http(method, url, opts) {
  const { status, data } = await httpRaw(method, url, opts);
  if (status >= 300) throw new Error(`${method} ${url} → ${status} ${typeof data === 'string' ? data : JSON.stringify(data)}`);
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

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** 北京时间今天往后 n 天的日期 YYYY-MM-DD */
function addDaysBJ(n) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  return new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}
/** 北京时间的「HH:MM」 */
const bjHHMM = (iso) =>
  new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** 和界面上一样的「比昨天 +5」「和前 7 天一样」 */
function compare(diff, than, unit = '') {
  if (!diff) return `和${than}一样`;
  return `比${than} ${diff > 0 ? '+' : '−'}${Math.abs(diff)}${unit}`;
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
  /** 以某个用户的身份看 TA 最近的通知 */
  const noticesOf = async (uid) => {
    const token = (await http('POST', '/api/auth/dev-login', { body: { userId: uid } })).token;
    return (await http('GET', '/api/inbox', { token })).notices;
  };

  await step('准备测试数据：待确认方案、待审动态、举报、申诉', async () => {
    const pending = (await aget('/api/admin/proposals')).items;
    fx.hike = pending.find((p) => p.task === '爬山');
    if (!fx.hike) throw new Error('没有待确认的「爬山」方案——请先用 seed 重置测试数据库');
    assert(fx.hike.minSize >= 3 && fx.hike.members.length === fx.hike.minSize, '「爬山」方案的人数应该正好是 minSize（seed 数据）');
    // 第一次参加的人：移出方案后回到撮合池，池子里要有「新人」标记
    fx.newcomer = fx.hike.members.find((m) => m.isNew);
    if (!fx.newcomer) throw new Error('「爬山」方案里没有第一次参加的人——请先用 seed 重置测试数据库');
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
    fx.postImages = [await uploadAs(lizi, IMG.photo1), await uploadAs(lizi, IMG.photo2)];
    fx.post1 = await http('POST', '/api/posts', { token: lizi, body: { text: 'E2E 待审动态一：周末想去才村拍晚霞，想一起的加我 vx：e2e_lizi_01', images: fx.postImages, visibility: 'public' } });
    fx.post2 = await http('POST', '/api/posts', { token: lizi, body: { text: 'E2E 待审动态二：帮朋友代购面膜，私聊有优惠', images: [], visibility: 'public' } });
    if (fx.post1.status !== 'pending' || fx.post2.status !== 'pending') throw new Error('测试动态没有进入待审核');
    fx.reports = (await aget('/api/admin/reports')).items;
    fx.report = fx.reports.find((r) => r.targetType === 'message');
    if (!fx.report || !fx.report.context || !fx.report.context.eventTitle) {
      throw new Error('没有带群聊信息的待处理举报——请先用 seed 重置测试数据库');
    }
    fx.appeal = (await aget('/api/admin/appeals')).items[0];
    if (!fx.appeal || !fx.appeal.evidence || !fx.appeal.evidence.length || fx.appeal.creditEvent.type !== 'no_show') {
      throw new Error('没有带群聊证据的「放鸽子」申诉——请先用 seed 重置测试数据库');
    }
    fx.pendingEvent = (await aget('/api/admin/events?status=pending_review')).items[0];
    if (!fx.pendingEvent) throw new Error('没有待审核的用户局——请先用 seed 重置测试数据库');

    // v0.3：轮播图、热门标签、一次声明的 AA（seed 数据）
    fx.banners = (await aget('/api/admin/banners')).items;
    if (fx.banners.length !== 3) throw new Error(`seed 里应该有 3 张轮播图，实际 ${fx.banners.length} 张——请先用 seed 重置测试数据库`);
    fx.hot = (await aget('/api/admin/tags?scope=hot')).items;
    if (fx.hot.length !== 10 || fx.hot[0].name !== '看日出') throw new Error('seed 里应该是 10 个默认热门标签，第一个是「看日出」');
    fx.walkTag = (await aget('/api/admin/tags?scope=all&days=30')).items.find((t) => t.name === '徒步');
    if (!fx.walkTag || fx.walkTag.hot) throw new Error('「徒步」应该是不在热门里的默认标签');
    fx.sunrise = (await aget(`/api/admin/events?q=${encodeURIComponent('苍山看日出')}`)).items.find((e) => e.status === 'formed');
    if (!fx.sunrise) throw new Error('没有已成局的「苍山看日出」——请先用 seed 重置测试数据库');
    fx.sunriseDetail = await aget(`/api/admin/events/${fx.sunrise.id}`);
    if (!fx.sunriseDetail.aa || !fx.sunriseDetail.aa.bill) throw new Error('「苍山看日出」应该有一笔记好的 AA（seed 数据）');

    // 小满、木木后天都想拍照，各自填了具体时间段 → 配出一个「大家都有空：14:30–17:00」的方案
    fx.photoDay = addDaysBJ(2);
    for (const [who, from, to] of [['小满', '14:00', '17:00'], ['木木', '14:30', '18:00']]) {
      const token = (await http('POST', '/api/auth/dev-login', { body: { userId: await userId(who) } })).token;
      await http('POST', '/api/intents', { token, body: { task: '拍照', when: fx.photoDay, timeFrom: from, timeTo: to, area: '古城', sizeMin: 2, sizeMax: 4 } });
    }
    fx.photo = (await aget('/api/admin/proposals')).items.find((p) => p.task === '拍照');
    if (!fx.photo) throw new Error('小满、木木提交了带时间段的「拍照」意向，但没有配出方案');
    assert(fx.photo.windowLabel === '14:30–17:00', `「拍照」方案的 windowLabel 应该是 14:30–17:00，实际 ${fx.photo.windowLabel}`);
  });

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);

  // 控制台报错、脚本异常、失败的请求都算问题。只有 allowing([...]) 包起来的那几步里，故意触发的状态码不算
  const problems = [];
  const notes = []; // 不算失败、但要告诉跑测试的人的事（比如接口少了某个字段）
  const allowed = new Set();
  let closing = false;
  async function allowing(statuses, fn) {
    statuses.forEach((s) => allowed.add(s));
    try {
      await fn();
      await sleep(300); // 浏览器的「Failed to load resource」会晚一点打出来
    } finally {
      statuses.forEach((s) => allowed.delete(s));
    }
  }
  if (VUE_DEV) {
    await page.route('**/vendor/vue.esm-browser.prod.js', (route) =>
      route.fulfill({ path: VUE_DEV, contentType: 'text/javascript; charset=utf-8' }),
    );
    console.log(`  （用 Vue 开发版：${VUE_DEV}）`);
  }
  page.on('console', (m) => {
    if (m.type() === 'warning' && /\[Vue warn\]/.test(m.text())) problems.push(`Vue 警告：${m.text().slice(0, 300)}`);
    if (m.type() !== 'error') return;
    const code = (m.text().match(/status of (\d{3})/) || [])[1];
    if (code && allowed.has(Number(code))) return;
    problems.push(`控制台报错：${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`页面脚本异常：${e.message}`));
  page.on('requestfailed', (r) => {
    if (closing) return;
    problems.push(`请求失败：${r.method()} ${r.url()} ${r.failure() ? r.failure().errorText : ''}`);
  });
  page.on('response', (r) => {
    if (r.status() < 400 || allowed.has(r.status())) return;
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
  const proposalCard = (title) =>
    page.locator('article.proposal', { has: page.getByRole('heading', { name: title, exact: true }) });

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
      await allowing([401], async () => {
        await page.getByLabel('后台密码').fill('not-the-password');
        await page.getByRole('button', { name: '进入后台' }).click();
        await expectText(page.getByRole('alert'), '密码不对');
      });
      await page.getByLabel('后台密码').fill(PASSWORD);
      await page.getByRole('button', { name: '进入后台' }).click();
      await until(() => page.url().includes('#/dashboard'), '跳到 #/dashboard');
      await expectText(h1(), '概览');
      const token = await page.evaluate(() => localStorage.getItem('dazi.admin.token'));
      if (!token) throw new Error('登录后 localStorage 里没有 token');
      await expectAttr(nav(/^概览/), 'aria-current', 'page');
    });

    // ---- 手机宽度：每一页都不能横向滚动（宽表格在自己的框里滚） ----

    await step('390px 宽度：六个页面（含展开的详情、表单、申诉证据、轮播图和标签）都没有横向滚动', async () => {
      await expectText(page.locator('.kpi').first(), '今日新用户');
      await noHorizontalScroll('概览');
      await shot('m-dashboard');

      await goto('matching');
      await expectText(h1(), '撮合池');
      const card = proposalCard(fx.hike.title);
      await card.waitFor();
      await noHorizontalScroll('撮合池');
      await card.getByRole('button', { name: '确认成局' }).click();
      await card.getByLabel('标题').waitFor();
      await noHorizontalScroll('撮合池（确认表单）');
      await shot('m-matching');
      await card.getByRole('button', { name: '先不发' }).click();

      await goto('moderation');
      await expectText(h1(), '审核与举报');
      await page.locator('.detail').waitFor();
      await page.getByRole('button', { name: /在「.*」群聊/ }).click();
      await page.getByRole('group', { name: '处理方式' }).getByRole('button', { name: '警告' }).click();
      await page.locator('#mod-message').waitFor();
      await noHorizontalScroll('审核与举报（处理表单）');
      await shot('m-moderation');

      await goto('events');
      await expectText(h1(), '局管理');
      await expectCount(page.locator('table.table--events tbody tr td:nth-child(7)'), (n) => n > 0);
      await page.getByRole('button', { name: '发起平台局' }).click();
      await page.locator('#n-title').waitFor();
      await page.getByRole('button', { name: `查看 ${fx.sunrise.title}` }).click();
      await page.locator('#event-detail .aa-box').waitFor();
      await noHorizontalScroll('局管理（表单 + 详情：照片、AA）');
      await shot('m-events');

      await goto('users');
      await expectText(h1(), '用户与信用');
      await expectCount(page.locator('table.table--users tbody tr td:nth-child(10)'), (n) => n > 0);
      await page.locator('table.table--users tbody tr td:nth-child(10) button').first().click();
      await page.locator('#user-detail-title').waitFor();
      await noHorizontalScroll('用户与信用（详情）');
      await shot('m-users');
      await page.getByRole('tab', { name: /申诉/ }).click();
      await page.locator('article.appeal .evidence').first().waitFor();
      await noHorizontalScroll('用户与信用（申诉和证据）');
      await shot('m-appeals');

      await goto('content');
      await expectText(h1(), '内容运营');
      await expectCount(page.locator('.banner-row'), fx.banners.length);
      await page.getByRole('button', { name: '添加轮播图' }).click();
      await page.locator('#banner-form').waitFor();
      await page.getByRole('group', { name: '点了去哪' }).getByRole('button', { name: '某个局' }).click();
      await page.getByRole('searchbox', { name: '搜局的标题或地点' }).waitFor();
      const searchH = await page.locator('#banner-form .search').evaluate((el) => el.getBoundingClientRect().height);
      assert(searchH < 64, `添加轮播图里的搜索框被撑高了（${Math.round(searchH)}px）`);
      await noHorizontalScroll('内容运营（轮播图 + 添加表单）');
      await shot('m-content-banners');
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await page.getByRole('tab', { name: /热门标签/ }).click();
      await expectCount(page.locator('.tag-row'), (n) => n >= fx.hot.length);
      await noHorizontalScroll('内容运营（热门标签）');
      await shot('m-content-tags');
    });

    await page.setViewportSize({ width: 1440, height: 1000 });

    // ---- 概览 ----

    await step('概览：数字、比昨天 / 比前 7 天和接口一致，柱状图 7 根柱子、悬停有提示，可以切到表格', async () => {
      await goto('dashboard');
      await expectText(h1(), '概览');
      await page.locator('.kpi').first().waitFor();
      const stats = await aget('/api/admin/stats');
      const kpi = (label) => page.locator('.kpi', { hasText: label });
      await expectText(kpi('今日新用户').locator('.kpi__value'), String(stats.today.newUsers));
      await expectText(kpi('今日新用户').locator('.kpi__sub'), compare(stats.today.newUsers - stats.yesterday.newUsers, '昨天'));
      await expectText(kpi('今日新意向').locator('.kpi__value'), String(stats.today.newIntents));
      await expectText(kpi('今日新意向').locator('.kpi__sub'), compare(stats.today.newIntents - stats.yesterday.newIntents, '昨天'));
      await expectText(kpi('等你确认的局').locator('.kpi__value'), String(stats.today.pendingProposals));
      await expectText(kpi('待处理举报').locator('.kpi__value'), String(stats.today.pendingReports));
      await expectText(kpi('近 7 天履约率').locator('.kpi__value'), `${stats.week.attendanceRate}%`);
      await expectText(
        kpi('近 7 天履约率').locator('.kpi__sub'),
        compare(stats.week.attendanceRate - stats.prevWeek.attendanceRate, '前 7 天', ' 个百分点'),
      );
      await expectText(page.locator('section[aria-labelledby="watch"]'), `近 7 天放鸽子 ${stats.week.noShowCount} 次`);
      // 待处理的举报里能看到是哪个局的群聊
      await expectText(page.locator('section[aria-labelledby="todo-report"]'), `「${fx.report.context.eventTitle}」群聊`);
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

    await step('撮合池：调整成员——少于约好的最少人数（minSize）时不能确认（界面和接口都拦），加回来后恢复', async () => {
      await nav(/^撮合池/).click();
      await expectText(h1(), '撮合池');
      await expectAttr(page.getByRole('tab', { name: /待确认/ }), 'aria-selected', 'true');
      const card = proposalCard(fx.hike.title);
      await card.waitFor();
      await expectText(card.locator('.proposal__meta'), `大家约好 ${fx.hike.minSize}–${fx.hike.maxSize} 人`);
      // 移出第一次参加的那个人：方案里、撮合池里、候选人里都标着是新人
      const who = fx.newcomer.user.nickname;
      const n = fx.hike.members.length;
      await expectText(card.locator('.member', { hasText: who }).locator('.tags'), '新人');
      await card.getByRole('button', { name: '调整成员' }).click();
      await card.getByRole('button', { name: `把 ${who} 移出这个方案` }).click();
      await expectBanner(`已把 ${who} 移出`);
      await expectCount(card.locator('.member'), n - 1);
      await expectText(page.locator('.pool__item', { hasText: who }).locator('.pool__name'), '新人');
      await expectText(card.locator('.cand', { hasText: who }), `${who} · 第一次参加`);
      await expectText(card.locator('.panel__hint'), `至少 ${fx.hike.minSize} 人才能成局，现在 ${n - 1} 人，还差 1 人`);
      await card.getByRole('button', { name: '调整好了' }).click();
      const confirmBtn = card.getByRole('button', { name: '确认成局' });
      assert(await confirmBtn.isDisabled(), '人数不够时「确认成局」应该不能点');
      await expectText(card.locator('.actions'), '还差 1 人，先调整成员');
      const res = await httpRaw('POST', `/api/admin/proposals/${fx.hike.id}/confirm`, { token: adminToken, body: {} });
      assert(
        res.status === 400 && res.data.error.code === 'VALIDATION' && res.data.error.message.includes(`至少 ${fx.hike.minSize} 人`),
        `人数不够时接口应该返回 400，实际 ${res.status} ${JSON.stringify(res.data)}`,
      );
      await card.getByRole('button', { name: '调整成员' }).click();
      await card.getByRole('button', { name: `把 ${who} 加进这个方案` }).click();
      await expectBanner(`已把 ${who} 加进`);
      await expectCount(card.locator('.member'), n);
      await card.getByRole('button', { name: '调整好了' }).click();
      assert(!(await confirmBtn.isDisabled()), '人数够了「确认成局」应该能点');
    });

    const newTitle = 'E2E · 周日一起爬苍山';
    await step('撮合池：确认成局（改了标题和时间，人数上限不超过 maxSize）→ 离开「待确认」，出现在「已发邀请」', async () => {
      const card = proposalCard(fx.hike.title);
      const pendingTab = page.getByRole('tab', { name: /待确认/ });
      const before = Number((await textOf(pendingTab.locator('.tab__count'))) || 0);
      await card.getByRole('button', { name: '确认成局' }).click();
      await card.getByLabel('标题').fill(newTitle);
      await card.getByLabel('开始时间').fill('08:30');
      await card.getByLabel('预计每人 ¥').fill('20');
      // 人数上限：最少是已配的人数，最多是大家约好的 maxSize
      const inc = card.getByRole('button', { name: '多一个名额' });
      const dec = card.getByRole('button', { name: '少一个名额' });
      const n = fx.hike.members.length;
      await expectText(card.locator('.stepper__value'), String(n));
      await expectAttr(dec, 'aria-disabled', 'true');
      for (let i = n; i < fx.hike.maxSize; i++) await inc.click();
      await expectText(card.locator('.stepper__value'), String(fx.hike.maxSize));
      await expectAttr(inc, 'aria-disabled', 'true');
      await inc.click({ force: true }); // 到顶了硬点也不会超过
      await expectText(card.locator('.stepper__value'), String(fx.hike.maxSize));
      for (let i = n; i < fx.hike.maxSize; i++) await dec.click();
      await expectText(card.locator('.stepper__value'), String(n));
      await expectAttr(dec, 'aria-disabled', 'true');
      await shot('d-matching-confirm');
      await card.getByRole('button', { name: /^发出邀请/ }).click();
      await expectBanner(`已发邀请给 ${fx.hike.members.length} 人：「${newTitle}」`);
      await expectCount(proposalCard(fx.hike.title), 0);
      await expectText(pendingTab.locator('.tab__count'), String(before - 1));
      const inviting = (await aget('/api/admin/events?source=matched&status=inviting')).items.find((e) => e.title === newTitle);
      if (!inviting) throw new Error('接口里找不到新建的撮合局');
      fx.invitingEvent = inviting;
      const p = await page.evaluate((iso) => new Date(iso).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), inviting.startAt);
      if (p !== '08:30') throw new Error(`集合时间应该是北京时间 08:30，实际 ${p}`);
      await banner().getByRole('button', { name: '去看看' }).click();
      await expectAttr(page.getByRole('tab', { name: /已发邀请/ }), 'aria-selected', 'true');
      const invited = page.locator('article.proposal', { has: page.getByRole('heading', { name: newTitle }) });
      await expectText(invited, `0 / ${fx.hike.members.length} 人已加入`);
      assert(inviting.inviteDeadline, '邀请中的撮合局应该有 inviteDeadline');
      await expectText(invited, '截止');
      await expectCount(invited.locator('.tag', { hasText: '待回复' }), fx.hike.members.length);
    });

    await step('撮合池：「提醒还没回复的人」→ 每个被邀请的人收到提醒', async () => {
      const invited = page.locator('article.proposal', { has: page.getByRole('heading', { name: newTitle }) });
      await invited.getByRole('button', { name: '提醒还没回复的人' }).click();
      await expectBanner(`已用微信服务通知提醒 ${fx.hike.members.length} 位还没回复的人`);
      const notices = await noticesOf(fx.hike.members[0].user.id);
      const reminder = notices.find((x) => x.type === 'match_reminder');
      assert(reminder && reminder.title.includes(newTitle), `被邀请的人没收到提醒：${JSON.stringify(notices.slice(0, 3))}`);
      await shot('d-matching-invited');
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
      await expectText(page.locator('#match-panel article').first(), '退回原因：时间对不上：E2E 退回测试'); // 最新退回的排在最前
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
      await expectText(page.locator('.info-box', { hasText: '待确认里' }), /待确认里(暂时没有符合条件的方案|有 \d+ 个符合)/);
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

    await step('撮合池：有人填了具体时间段 → 卡片写「大家都有空」、成员写各自的时间，集合时间默认是大家都有空的开始；成员这时已经有局 → 确认被拦，原因写在表单里', async () => {
      await page.getByRole('tab', { name: /待确认/ }).click();
      const card = proposalCard(fx.photo.title);
      await card.waitFor();
      await expectText(card.locator('.proposal__window'), `大家都有空：${fx.photo.windowLabel}`);
      for (const m of fx.photo.members) {
        await expectText(card.locator('.member', { hasText: m.user.nickname }).locator('.tags'), m.timeLabel);
      }
      await card.getByRole('button', { name: '确认成局' }).click();
      const want = bjHHMM(fx.photo.defaultStartAt);
      await until(async () => (await card.getByLabel('开始时间').inputValue()) === want, `集合时间默认是 ${want}`);
      // 小满刚报名了同一时间的一个平台局 → 再确认，她的时间就重叠了
      const clash = await http('POST', '/api/admin/events', {
        token: adminToken,
        body: { title: 'E2E 同一时间的平台局', tag: '随便走走', startAt: new Date(`${fx.photoDay}T15:00:00+08:00`).toISOString(), durationMin: 120, place: '古城', capacity: 6, feeType: 'free' },
      });
      const xm = (await http('POST', '/api/auth/dev-login', { body: { userId: await userId('小满') } })).token;
      await http('POST', `/api/events/${clash.eventId}/join`, { token: xm, body: {} });
      await allowing([409], async () => {
        await card.getByRole('button', { name: /^发出邀请/ }).click();
        await expectText(card.locator('.form-error'), '时间重叠了');
      });
      await expectText(card.locator('.form-error'), '小满');
      await expectCount(proposalCard(fx.photo.title), 1); // 方案还在待确认里，可以调整成员或退回
      await shot('d-matching-window');
      await card.getByRole('button', { name: '先不发' }).click();
    });

    // ---- 审核与举报 ----

    const reportTitle = `${fx.report.targetUser.nickname} 在「${fx.report.context.eventTitle}」群聊`;
    const userMessage = 'E2E 给 TA 的说明：请不要在群里拉大家去朋友的店';
    const adminNote = 'E2E 后台备注：第二次被举报推销，下次直接限制';

    await step('审核：举报显示来自哪个局的群聊；「警告」时备注只留后台，给 TA 的说明发给 TA（带联系方式会被拦）', async () => {
      await nav(/^审核与举报/).click();
      await expectText(h1(), '审核与举报');
      await page.getByRole('button', { name: has(reportTitle) }).click();
      await expectText(page.locator('#mod-detail-title'), reportTitle);
      await expectText(page.locator('.report-where'), `来自「${fx.report.context.eventTitle}」群聊`);
      await expectText(page.locator('.detail blockquote'), fx.report.preview.slice(0, 10));
      await page.getByRole('button', { name: '确认处理' }).click();
      await expectText(page.locator('.detail').getByRole('alert'), '先选一种处理方式');
      const group = page.getByRole('group', { name: '处理方式' });
      await group.getByRole('button', { name: '警告' }).click();
      await expectAttr(group.getByRole('button', { name: '警告' }), 'aria-pressed', 'true');
      await expectText(page.locator('.detail .info-box'), '给 TA 发一条提醒，内容保留。');
      await expectText(page.locator('#mod-message-hint'), '不填会发：「有人反馈你的言行让人不舒服');
      // 「给 TA 的说明」里带联系方式 → 服务端 422，提示在输入框下面
      await allowing([422], async () => {
        await page.getByLabel(/给 TA 的说明/).fill('有事加我微信 abc12345 聊');
        await page.getByRole('button', { name: '确认处理' }).click();
        await expectText(page.locator('#mod-message-err'), '不能有手机号、微信号或网址');
      });
      await page.getByLabel(/给 TA 的说明/).fill(userMessage);
      await page.getByLabel(/备注（选填，只有后台能看到）/).fill(adminNote);
      await page.getByRole('button', { name: '确认处理' }).click();
      await expectBanner('已处理：警告');
      await expectText(page.locator('.done-box'), '已处理 · 警告');
      await expectText(page.locator('.done-box'), `发给 TA 的说明：${userMessage}`);
      await expectText(page.locator('.done-box'), `备注（只有后台能看到）：${adminNote}`);
      await expectText(page.getByRole('button', { name: has(reportTitle) }), '已处理');
      const all = (await aget('/api/admin/reports?status=all')).items.find((r) => r.id === fx.report.id);
      assert(all && all.action === 'warn' && all.adminNote === adminNote && all.message === userMessage, `接口里这条举报记得不对：${JSON.stringify(all)}`);
      // 被举报的人：收到的提醒正文就是「给 TA 的说明」，任何通知里都没有后台备注
      const notices = await noticesOf(fx.report.targetUser.id);
      const warning = notices.find((x) => x.type === 'warning');
      assert(warning && warning.body === userMessage, `被举报的人收到的提醒不对：${JSON.stringify(warning)}`);
      assert(!notices.some((x) => `${x.title}${x.body}`.includes('E2E 后台备注')), '后台备注出现在了用户的通知里');
      await shot('d-moderation');
    });

    await step('审核：被举报人卡片能跳到「用户与信用」看信用记录', async () => {
      await page.getByRole('link', { name: '看信用记录' }).click();
      await expectText(h1(), '用户与信用');
      await expectText(page.locator('#user-detail-title'), fx.report.targetUser.nickname);
      await page.goBack();
      await expectText(h1(), '审核与举报');
    });

    await step('审核：动态待审——照片是缩略图、点开看大图；一条通过，一条不通过（必须选原因）', async () => {
      await page.getByRole('tab', { name: /动态待审/ }).click();
      await page.getByRole('button', { name: /E2E 待审动态一/ }).click();
      await expectText(page.locator('.detail blockquote'), 'E2E 待审动态一');
      const thumbs = page.locator('.detail .thumbs .thumb');
      await expectCount(thumbs, fx.postImages.length);
      await thumbs.first().click();
      const dialog = page.getByRole('dialog');
      await expectAttr(dialog, 'aria-label', `栗子 的动态照片，第 1 张，共 ${fx.postImages.length} 张`);
      const big = await dialog.locator('img').getAttribute('src');
      assert(big && big.includes(fx.postImages[0].split('/uploads/')[1]), `大图不是第一张照片：${big}`);
      await page.keyboard.press('ArrowLeft'); // 第一张往左 → 最后一张
      await expectAttr(dialog, 'aria-label', `栗子 的动态照片，第 ${fx.postImages.length} 张，共 ${fx.postImages.length} 张`);
      await shot('d-moderation-lightbox');
      await dialog.getByRole('button', { name: '关闭大图' }).click();
      await expectCount(page.getByRole('dialog'), 0);
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

    await step('局管理：按来源、关键词、状态筛选（「已结束」由服务端 status=ended 筛）', async () => {
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
      const ended = (await aget('/api/admin/events?status=ended')).items;
      await Promise.all([
        page.waitForRequest((r) => r.url().includes('/api/admin/events?') && r.url().includes('status=ended')),
        page.getByRole('group', { name: '状态' }).getByRole('button', { name: '已结束' }).click(),
      ]);
      await expectCount(eventRows(), ended.length);
      const st = (await columnTexts(6)).map(clean);
      assert(st.every((x) => x === '已结束'), `「已结束」里混进了别的状态：${st.join(',')}`);
      await page.getByRole('group', { name: '状态' }).getByRole('button', { name: '招募中' }).click();
      await until(async () => {
        const s = (await columnTexts(6)).map(clean);
        return s.length > 0 && s.every((x) => x === '招募中');
      }, '「招募中」不含已经结束的局');
      await page.getByRole('group', { name: '状态' }).getByRole('button', { name: '全部', exact: true }).click();
      await expectCount(eventRows(), (n) => n > 3);
    });

    await step('局管理：查看详情（时间、地点、成员、群聊、AA：谁记的、一共多少、每笔转账的状态）；邀请中的撮合局能看到进度、提醒还没回复的人', async () => {
      await page.getByRole('button', { name: `查看 ${fx.sunrise.title}` }).click();
      const detail = page.locator('#event-detail');
      const d = fx.sunriseDetail;
      await expectText(detail.locator('#ev-detail-title'), fx.sunrise.title);
      await expectText(detail, d.event.place);
      await expectText(detail, `成员 ${d.members.filter((m) => m.status === 'joined').length}/${d.event.capacity}`);
      await expectText(detail.locator('.chat-box'), d.messages[d.messages.length - 1].text.slice(0, 12));
      if (d.event.images && d.event.images.length) await expectCount(detail.locator('.thumbs .thumb'), d.event.images.length);
      // AA：一个人一次记下总花费，其他人平摊转给 TA
      const { bill, transfers } = d.aa;
      await expectText(detail.locator('.aa-box__title'), `${bill.payer.nickname} 记的 AA：共 ¥${bill.amount}${bill.note ? `（${bill.note}）` : ''}`);
      await expectText(detail.locator('.aa-box'), `每人 ¥${d.aa.each}`);
      if (Array.isArray(transfers)) {
        await expectCount(detail.locator('.aa-list__row'), transfers.length);
        const TRANSFER = { pending: '还没转', paid: '说已转，等确认', confirmed: '已确认收到' };
        for (const t of transfers) {
          const row = detail.locator('.aa-list__row', { hasText: `${t.from.nickname} → ${t.to.nickname}` });
          await expectText(row, `¥${t.amount}`);
          await expectText(row, TRANSFER[t.status]);
        }
      } else {
        notes.push('GET /api/admin/events/:id 的 aa 里没有 transfers，局详情看不到每笔转账的状态');
      }
      await shot('d-events-aa');
      await page.getByRole('button', { name: `查看 ${newTitle}` }).click();
      await expectText(detail.locator('#ev-detail-title'), newTitle);
      await expectText(detail.locator('.invite-box'), `0 人已加入，${fx.hike.members.length} 人还没回复`);
      await detail.getByRole('button', { name: '提醒还没回复的人' }).click();
      await expectBanner('已用微信服务通知提醒');
      await page.getByRole('button', { name: '收起详情' }).click();
      await expectCount(page.locator('#event-detail'), 0);
    });

    const platformTitle = 'E2E 平台局 · 洱海边散步';
    let platformEvent;
    await step('局管理：发起平台局（标签、只限女生、最晚退出时间、两张照片、详细地址，时间精确到分钟）→ 列表和详情里都对，照片点开看大图', async () => {
      await page.getByRole('button', { name: '发起平台局' }).click();
      await expectAttr(page.getByRole('button', { name: '发起平台局' }), 'aria-expanded', 'true');
      const form = page.locator('#new-event');
      await form.getByRole('button', { name: '发布到广场' }).click();
      await expectText(form.getByRole('alert'), '标题、日期、开始时间和地点都要填');
      await form.getByLabel('标题', { exact: true }).fill(platformTitle);
      // 标签：先点一个热门标签，再改成自己写的，最后又点回热门的（自己写的要清掉）
      const tags = form.getByRole('group', { name: /^标签/ });
      await tags.getByRole('button', { name: '骑行', exact: true }).click();
      await expectAttr(tags.getByRole('button', { name: '骑行', exact: true }), 'aria-pressed', 'true');
      await form.getByLabel('或者自己写').fill('湖边散步');
      await expectAttr(tags.getByRole('button', { name: '骑行', exact: true }), 'aria-pressed', 'false');
      await expectText(form, '这个局的标签：湖边散步');
      await tags.getByRole('button', { name: '随便走走', exact: true }).click();
      await expectText(form, '这个局的标签：随便走走');
      await form.getByLabel('开始时间').fill('09:37');
      await form.getByLabel('地点', { exact: true }).fill('才村码头');
      await form.getByLabel(/详细地址/).fill('大理市才村码头');
      await form.getByLabel(/集合点/).fill('码头入口');
      await form.getByRole('button', { name: '多一个名额' }).click();
      await form.getByRole('button', { name: '免费' }).click();
      await form.getByRole('group', { name: '谁可以报名' }).getByRole('button', { name: '只限女生' }).click();
      const exit = form.getByRole('group', { name: '最晚退出时间' });
      await expectAttr(exit.getByRole('button', { name: '开始前 24 小时' }), 'aria-pressed', 'true'); // 默认
      await exit.getByRole('button', { name: '开始前 6 小时' }).click();
      await expectText(form.locator('#n-exit-hint'), '前可以退出');
      // 照片：不是图片的文件在本地就挡掉，不发请求；两张 PNG 上传
      await form.locator('input[type=file]').setInputFiles(IMG.notImage);
      await expectText(form.locator('.uploader .form-error'), '不是 jpg / png / gif / webp 图片');
      await form.locator('input[type=file]').setInputFiles([IMG.photo1, IMG.photo2]);
      await expectCount(form.locator('.uploader .thumb'), 2, 15000);
      await form.getByLabel(/介绍/).fill('E2E 测试创建的平台局，沿着洱海慢慢走。');
      await shot('d-events-create');
      await form.getByRole('button', { name: '发布到广场' }).click();
      await expectBanner(`已发布到广场：「${platformTitle}」`);
      await expectText(page.locator('#ev-detail-title'), platformTitle);
      const row = eventRows().filter({ hasText: platformTitle });
      await expectCount(row, 1);
      await expectText(row.locator('td:nth-child(1)'), '随便走走');
      await expectText(row.locator('td:nth-child(1)'), '只限女生');
      await expectText(row.locator('td:nth-child(5)'), '平台');
      await expectText(row.locator('td:nth-child(4)'), '0/7');
      platformEvent = (await aget('/api/admin/events?source=platform')).items.find((e) => e.title === platformTitle);
      const ev = (await aget(`/api/admin/events/${platformEvent.id}`)).event;
      const startHHMM = bjHHMM(ev.startAt);
      assert(ev.status === 'open' && ev.feeLabel === '免费', `接口里的平台局不对：${ev.status} ${ev.feeLabel}`);
      assert(startHHMM === '09:37', `开始时间应该是 09:37（精确到分钟），实际 ${startHHMM}`);
      assert(ev.tag === '随便走走', `标签应该是「随便走走」，实际 ${ev.tag}`);
      assert(ev.genderLimit === 'female' && ev.genderLabel === '只限女生', `谁可以报名不对：${ev.genderLimit} ${ev.genderLabel}`);
      assert(Date.parse(ev.startAt) - Date.parse(ev.exitDeadline) === 6 * 3600 * 1000, `最晚退出时间应该是开始前 6 小时：${ev.exitDeadline}`);
      assert(ev.images && ev.images.length === 2 && ev.images.every((u) => /\/uploads\//.test(u)), `照片不对：${JSON.stringify(ev.images)}`);
      assert(ev.location && ev.location.address === '大理市才村码头', `地址不对：${JSON.stringify(ev.location)}`);
      assert(platformEvent.cover === ev.images[0], `列表里的封面应该是第一张照片：${platformEvent.cover}`);
      // 详情：谁可以报名、最晚退出时间、地址；照片点开看大图
      const detail = page.locator('#event-detail');
      await expectText(detail, '只限女生');
      await expectText(detail, `${bjHHMM(ev.exitDeadline)} · 之前可以退出`);
      await expectText(detail, '大理市才村码头');
      await detail.locator('.thumbs .thumb').nth(1).click();
      const dialog = page.getByRole('dialog');
      await expectAttr(dialog, 'aria-label', `「${platformTitle}」的照片，第 2 张，共 2 张`);
      await page.keyboard.press('ArrowRight');
      await expectAttr(dialog, 'aria-label', `「${platformTitle}」的照片，第 1 张，共 2 张`);
      await shot('d-events-lightbox');
      await page.keyboard.press('Escape');
      await expectCount(page.getByRole('dialog'), 0);
      const focused = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('aria-label'));
      assert(focused === `看大图：「${platformTitle}」的照片 2`, `关掉大图后焦点应该回到缩略图，实际在「${focused}」`);
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

    // ---- 内容运营 ----

    const bannerTitle = 'E2E 轮播 · 洱海边散步';
    const homeBanners = async () => (await http('GET', '/api/home')).banners;
    await step('内容运营 · 首页轮播：列表和接口一致；点开看大图；添加一张（上传图片、链接到刚发起的平台局），小程序首页马上有', async () => {
      await nav(/^内容运营/).click();
      await expectText(h1(), '内容运营');
      await expectAttr(page.getByRole('tab', { name: /首页轮播/ }), 'aria-selected', 'true');
      const rows = page.locator('.banner-row');
      await expectCount(rows, fx.banners.length);
      for (const [i, b] of fx.banners.entries()) await expectText(rows.nth(i).locator('.banner-row__title'), b.title);
      const linked = fx.banners.find((b) => /^event:\d+$/.test(b.link || ''));
      if (linked) await expectText(rows.nth(fx.banners.indexOf(linked)), /点了去：局「.+」/);
      // 点开看大图，Esc 关掉，焦点回到图片上
      await rows.first().locator('.banner-row__img').click();
      await expectAttr(page.getByRole('dialog'), 'aria-label', `轮播图「${fx.banners[0].title}」，第 1 张，共 1 张`);
      await page.keyboard.press('Escape');
      await expectCount(page.getByRole('dialog'), 0);
      // 添加：没传图不能保存
      await page.getByRole('button', { name: '添加轮播图' }).click();
      const form = page.locator('#banner-form');
      await form.getByRole('button', { name: '添加', exact: true }).click();
      await expectText(form.locator('.form-error'), '先上传一张图片');
      await form.locator('input[type=file]').setInputFiles(IMG.banner);
      await expectCount(form.locator('.thumb'), 1, 15000);
      await form.getByLabel('标题', { exact: true }).fill(bannerTitle);
      await form.getByLabel(/副标题/).fill('周日上午，沿着洱海慢慢走');
      await form.getByRole('group', { name: '点了去哪' }).getByRole('button', { name: '某个局' }).click();
      await form.getByRole('searchbox', { name: '搜局的标题或地点' }).fill('E2E 平台局');
      await form.getByRole('button', { name: has(platformTitle) }).click();
      await expectText(form.locator('.picked'), `已选：局「${platformTitle}」`);
      await shot('d-content-banner-form');
      await form.getByRole('button', { name: '添加', exact: true }).click();
      await expectBanner(`已添加轮播图「${bannerTitle}」，排在第 ${fx.banners.length + 1} 张`);
      await expectCount(rows, fx.banners.length + 1);
      await expectText(rows.last(), `点了去：局「${platformTitle}」`);
      const added = (await aget('/api/admin/banners')).items.find((b) => b.title === bannerTitle);
      fx.addedBanner = added;
      assert(added && added.link === `event:${platformEvent.id}` && added.enabled && /\/uploads\//.test(added.image), `接口里的轮播图不对：${JSON.stringify(added)}`);
      assert((await homeBanners()).some((b) => b.title === bannerTitle), '小程序首页（GET /api/home）里没有新加的轮播图');
    });

    await step('内容运营 · 首页轮播：关掉展示（首页就不出现）、上移、编辑、删除（要确认）', async () => {
      const rows = page.locator('.banner-row');
      const row = () => rows.filter({ hasText: bannerTitle });
      await row().getByRole('switch').click();
      await expectBanner(`「${bannerTitle}」已从首页撤下`);
      await expectText(row(), '已关闭');
      assert(!(await homeBanners()).some((b) => b.title === bannerTitle), '关掉展示后小程序首页还有这张轮播图');
      await row().getByRole('button', { name: `把「${bannerTitle}」上移` }).click();
      await expectBanner(`已把「${bannerTitle}」上移到第 ${fx.banners.length} 张`);
      let ids = (await aget('/api/admin/banners')).items.map((b) => b.id);
      assert(ids.indexOf(fx.addedBanner.id) === fx.banners.length - 1, `上移后顺序不对：${ids.join(',')}`);
      await expectText(rows.nth(fx.banners.length - 1), bannerTitle);
      await row().getByRole('button', { name: `编辑「${bannerTitle}」` }).click();
      const form = page.locator('#banner-form');
      await expectText(form.locator('#bf-title'), '编辑轮播图');
      await form.getByLabel(/副标题/).fill('E2E 改过的副标题');
      await form.getByRole('button', { name: '保存', exact: true }).click();
      await expectBanner(`已保存轮播图「${bannerTitle}」`);
      await expectText(row(), 'E2E 改过的副标题');
      const edited = (await aget('/api/admin/banners')).items.find((b) => b.id === fx.addedBanner.id);
      assert(edited.subtitle === 'E2E 改过的副标题' && edited.link === `event:${platformEvent.id}` && !edited.enabled, `编辑后接口里的轮播图不对：${JSON.stringify(edited)}`);
      await row().getByRole('button', { name: `删掉「${bannerTitle}」` }).click();
      await expectText(row().locator('.banner-row__ask'), '删了不能恢复');
      await shot('d-content-banners');
      await row().getByRole('button', { name: '确定删除' }).click();
      await expectBanner(`已删掉轮播图「${bannerTitle}」`);
      await expectCount(rows, fx.banners.length);
      ids = (await aget('/api/admin/banners')).items.map((b) => b.id);
      assert(!ids.includes(fx.addedBanner.id), '删掉后接口里还有这张轮播图');
    });

    const newTag = 'E2E露营';
    const hotNames = async () => (await aget('/api/admin/tags?scope=hot')).items.map((t) => t.name);
    await step('内容运营 · 热门标签：添加（审核不过、太长都写在输入框下面）→ 排在最后，小程序拿到的热门标签也变了', async () => {
      await page.getByRole('tab', { name: /热门标签/ }).click();
      const hotRows = page.locator('section[aria-labelledby="hot-title"] .tag-row');
      await expectCount(hotRows, fx.hot.length);
      for (const [i, t] of fx.hot.entries()) await expectText(hotRows.nth(i).locator('.tag-row__name'), t.name);
      const input = page.getByLabel(/^标签/);
      const submit = page.getByRole('button', { name: '加到热门', exact: true });
      await allowing([422], async () => {
        await input.fill('代购');
        await submit.click();
        await expectText(page.locator('#nt-err'), '这个标签不能用');
      });
      await allowing([400], async () => {
        await input.fill('洱海边露营看星星啊');
        await submit.click();
        await expectText(page.locator('#nt-err'), '最多 8 个字');
      });
      await expectAttr(input, 'aria-invalid', 'true');
      await input.fill(newTag);
      await page.getByRole('group', { name: '分类' }).getByRole('button', { name: '户外' }).click();
      await page.getByRole('group', { name: /^插画/ }).getByRole('button', { name: '洱海', exact: true }).click();
      await submit.click();
      await expectBanner(`已把「${newTag}」加到热门，排在第 ${fx.hot.length + 1} 个`);
      await expectCount(hotRows, fx.hot.length + 1);
      await expectText(hotRows.last().locator('.tag-row__name'), newTag);
      const created = (await aget('/api/admin/tags?scope=hot')).items.find((t) => t.name === newTag);
      assert(created && created.category === 'outdoor' && created.cover === 'lake', `新标签不对：${JSON.stringify(created)}`);
      const pub = (await http('GET', '/api/tags/hot')).items.map((t) => t.name);
      assert(pub[pub.length - 1] === newTag, `小程序的热门标签（GET /api/tags/hot）最后一个应该是新加的：${pub.join('、')}`);
    });

    await step('内容运营 · 热门标签：上移、移出热门（可以撤销）、从「大家最近在用的标签」加到热门', async () => {
      const hotRows = page.locator('section[aria-labelledby="hot-title"] .tag-row');
      await page.getByRole('button', { name: `把「${newTag}」上移` }).click();
      await expectBanner(`已把「${newTag}」上移到第 ${fx.hot.length} 个`);
      let names = await hotNames();
      assert(names.indexOf(newTag) === fx.hot.length - 1, `上移后顺序不对：${names.join('、')}`);
      await expectText(hotRows.nth(fx.hot.length - 1).locator('.tag-row__name'), newTag);
      const dropped = fx.hot[2].name; // 骑行
      await page.getByRole('button', { name: `把「${dropped}」移出热门` }).click();
      await expectBanner(`已把「${dropped}」移出热门`);
      names = await hotNames();
      assert(!names.includes(dropped), `移出后热门里还有「${dropped}」`);
      await banner().getByRole('button', { name: '撤销' }).click();
      await expectBanner(`已把「${dropped}」放回热门`);
      names = await hotNames();
      assert(names[2] === dropped, `撤销后「${dropped}」应该回到第 3 个：${names.join('、')}`);
      // 大家最近在用的标签：「徒步」不是热门，加进来排在最后
      const recent = page.locator('section[aria-labelledby="recent-title"]');
      await recent.getByRole('button', { name: `把「${fx.walkTag.name}」加到热门` }).click();
      await expectBanner(`已把「${fx.walkTag.name}」加到热门`);
      names = await hotNames();
      assert(names[names.length - 1] === fx.walkTag.name, `「${fx.walkTag.name}」应该排在热门最后：${names.join('、')}`);
      await expectText(recent.locator('.tag-row', { hasText: fx.walkTag.name }), `热门第 ${names.length} 个`);
      await shot('d-content-tags');
    });

    // ---- 用户与信用 ----

    let aye;
    await step('用户：搜索、查看详情、撤销一条「临时鸽」→ 履约率变了，本人收到通知', async () => {
      await nav(/^用户与信用/).click();
      await expectText(h1(), '用户与信用');
      aye = await aget(`/api/admin/users/${await userId('阿野')}`);
      const before = aye.credit.rate;
      await page.getByRole('searchbox', { name: '搜昵称或手机尾号' }).fill('阿野');
      await expectCount(page.locator('table.table--users tbody tr:has(td:nth-child(10))'), 1);
      await page.getByRole('button', { name: '查看 阿野' }).click();
      await expectText(page.locator('#user-detail-title'), '阿野');
      await expectText(page.locator('.credit-tile__big'), `${before}%`);
      await page.getByRole('button', { name: /的「临时鸽」$/ }).first().click();
      await expectText(page.locator('.revoke-ask'), '撤销后这条不再算进履约率，会通知 阿野');
      await page.getByRole('button', { name: '确定撤销' }).click();
      const after = (await aget(`/api/admin/users/${aye.user.id}`)).credit.rate;
      if (after === before) throw new Error(`撤销后履约率没变（${before}%）`);
      await expectBanner(`履约率 ${before}% → ${after}%，已通知 TA`);
      await expectText(page.locator('.credit-tile__big'), `${after}%`);
      await expectText(page.locator('.timeline'), '已撤销');
      const notices = await noticesOf(aye.user.id);
      assert(notices.some((x) => x.type === 'credit_revoked'), '撤销记录后本人没收到通知');
    });

    await step('用户：限制 7 天（详情显示「受限到 … · 原因」），再解除限制', async () => {
      await page.getByRole('button', { name: '限制 7 天' }).click();
      await page.getByLabel(/限制原因/).fill('E2E 测试限制');
      await page.getByRole('button', { name: '确认限制 7 天' }).click();
      await expectBanner('已限制 阿野 7 天');
      await expectText(page.locator('.account-box'), /受限到 .* · E2E 测试限制/);
      const u1 = (await aget(`/api/admin/users/${aye.user.id}`)).user;
      assert(u1.status === 'restricted' && u1.restrictedReason === 'E2E 测试限制', `受限原因没存对：${JSON.stringify(u1.restrictedReason)}`);
      await page.getByRole('button', { name: '解除限制' }).click();
      await expectBanner('已解除限制：阿野');
      const u = (await aget(`/api/admin/users/${aye.user.id}`)).user;
      if (u.status !== 'active') throw new Error(`解除限制后状态应该是 active，实际 ${u.status}`);
    });

    await step('用户：封号（显示「已封号 · 原因」）→ 「已封号」筛选只有 TA、「受限」不含 TA → 解封', async () => {
      const name = '小满';
      await page.getByRole('searchbox', { name: '搜昵称或手机尾号' }).fill(name);
      await expectCount(page.locator('table.table--users tbody tr:has(td:nth-child(10))'), 1);
      await page.getByRole('button', { name: `查看 ${name}` }).click();
      await expectText(page.locator('#user-detail-title'), name);
      await page.getByRole('button', { name: '封号', exact: true }).click();
      await page.getByLabel(/封号原因/).fill('E2E 测试封号');
      await page.getByRole('button', { name: '确定封号' }).click();
      await expectBanner(`已封号：${name}`);
      await expectText(page.locator('.account-box'), '已封号 · E2E 测试封号');
      await page.getByRole('searchbox', { name: '搜昵称或手机尾号' }).fill('');
      const levels = page.getByRole('group', { name: '信用等级' });
      const userRows = page.locator('table.table--users tbody tr:has(td:nth-child(10))');
      await Promise.all([
        page.waitForRequest((r) => r.url().includes('/api/admin/users?') && r.url().includes('level=banned')),
        levels.getByRole('button', { name: '已封号' }).click(),
      ]);
      await expectCount(userRows, 1);
      await expectText(userRows.first(), name);
      await expectText(userRows.first(), '封号：E2E 测试封号');
      await levels.getByRole('button', { name: '受限' }).click();
      await until(async () => {
        const names = (await userRows.locator('.user-cell__name').allTextContents()).map(clean);
        return names.length > 0 && !names.includes(name) && names.includes(fx.report.targetUser.nickname);
      }, '「受限」里有大鹏、没有被封号的人');
      await levels.getByRole('button', { name: '全部' }).click();
      await page.getByRole('button', { name: '解封' }).click();
      await expectBanner(`已解封：${name}`);
      const banned = (await aget('/api/admin/users?level=banned')).items;
      assert(banned.length === 0, '解封后「已封号」里还有人');
    });

    await step('用户：申诉——看系统找到的群聊证据和提示，通过并撤销那条记录', async () => {
      await page.getByRole('tab', { name: /申诉/ }).click();
      await expectAttr(page.getByRole('tab', { name: /申诉/ }), 'aria-selected', 'true');
      const card = page.locator('article.appeal', { hasText: `${fx.appeal.user.nickname} 的申诉` });
      // seed：木木那次「放鸽子」，她开场前 3 小时在群里说发烧去不了（docs/api.md 3.1：24 小时内说算「临时鸽」）
      const ev = fx.appeal.evidence;
      const earliest = Math.max(...ev.map((m) => m.hoursBeforeStart));
      const h = String(Math.round(earliest * 10) / 10);
      await expectText(card.locator('.evidence'), ev[0].text);
      await expectText(card.locator('.evidence'), `开场前 ${h} 小时`);
      const hint = earliest >= 24 ? '提前 24 小时以上说了，按规则不记录，建议通过' : `开场前 ${h} 小时才说，按规则应记「临时鸽」而不是「放鸽子」`;
      await expectText(card.locator('.evidence__hint'), hint);
      const reply = 'E2E：核实了，你开场前说过去不了，这条「放鸽子」撤销。';
      await card.getByLabel(/回复/).fill(reply);
      await card.getByRole('button', { name: '通过，撤销这条记录' }).click();
      await expectBanner(`已通过 ${fx.appeal.user.nickname} 的申诉`);
      await expectText(card.locator('.done-box'), '已通过，这条记录已撤销');
      await expectText(card.locator('.done-box'), `回复已发给 ${fx.appeal.user.nickname}：${reply}`);
      const a = (await aget('/api/admin/appeals?status=all')).items.find((x) => x.id === fx.appeal.id);
      if (!a || a.status !== 'approved') throw new Error('接口里申诉没有变成已通过');
      await expectText(page.getByRole('tab', { name: /申诉/ }).locator('.tab__count'), '0');
      await shot('d-users');
    });

    // ---- 登录过期、退出 ----

    await step('登录过期（任何接口 401）→ 清掉 token 回到登录页，登录后回到原来的页面', async () => {
      await allowing([401], async () => {
        await goto('events');
        await expectText(h1(), '局管理');
        await page.evaluate(() => localStorage.setItem('dazi.admin.token', 'a_expired_token_for_e2e'));
        await page.reload();
        await until(() => page.url().includes('#/login'), '跳到登录页');
        await expectText(h1(), '登录后台');
        const left = await page.evaluate(() => localStorage.getItem('dazi.admin.token'));
        if (left) throw new Error('401 之后 token 没有清掉');
      });
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

    if (notes.length) console.log(`\n注意：\n  ${notes.join('\n  ')}`);
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

// npm run smoke：内存数据库 + 演示数据，随机端口启动服务，用 HTTP 走一遍主流程，最后打印 PASS / FAIL。
// 登录 → 首页 → 提交意向 → 后台撮合 → 确认建议 → 成员加入 → 群聊 → AA → 时间穿越到局结束后 → 互评 → 信用更新
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { clock } from '../src/clock.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';

const results = [];
let base;

async function api(method, url, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload = form;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + url, { method, headers, body: payload });
  const data = await res.json().catch(() => null);
  if (!res.ok && !(res.status === 422 && url.includes('/messages'))) {
    throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(data)}`);
  }
  return { status: res.status, data };
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`  FAIL  ${name} — ${err.message}`);
    throw err;
  }
}

async function main() {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dazi-smoke-'));
  const config = loadConfig({
    NODE_ENV: 'development',
    DB_PATH: ':memory:',
    UPLOAD_DIR: uploadDir,
    ADMIN_PASSWORD: 'smoke-admin',
    LOG_LEVEL: 'warn',
    PORT: '0',
  });
  const db = openDb(':memory:');
  seed(db, { uploadDir });
  const app = createApp({ db, config });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(`smoke：服务已在 ${base} 启动（内存数据库 + 演示数据）\n`);

  const ctx = {};
  try {
    await step('健康检查', async () => {
      const { data } = await api('GET', '/api/health');
      check(data.ok === true, 'health 不是 ok');
      return `wechat=${data.wechat}`;
    });

    await step('开发登录（默认「栗子」）', async () => {
      const { data } = await api('POST', '/api/auth/dev-login', { body: {} });
      ctx.lizi = data.token;
      ctx.liziId = data.user.id;
      ctx.attendedBefore = data.user.credit.attended;
      check(data.user.nickname === '栗子', `登录成了 ${data.user.nickname}`);
      return `履约 ${data.user.credit.rate}% · 参加 ${data.user.credit.eventsCount} 个局`;
    });

    await step('首页：轮播图、热门标签、动态配图可以访问', async () => {
      const { data } = await api('GET', '/api/home', { token: ctx.lizi });
      check(data.banners.length === 3, `轮播图 ${data.banners.length} 张`);
      check(data.hotTags.length >= 5, '热门标签太少');
      const img = await fetch(data.highlights[0].image.replace(config.publicBaseUrl, base));
      check(img.ok, '动态配图访问不到');
      return `轮播 ${data.banners.length} · 热门标签 ${data.hotTags.map((t) => t.name).slice(0, 5).join('/')} · 精选局 ${data.featuredEvents.length} 个 · 本周 ${data.stats.weekPeople} 人`;
    });

    await step('提交意向：明天下午喝咖啡（提交即撮合）', async () => {
      const { data } = await api('POST', '/api/intents', {
        token: ctx.lizi,
        body: { task: '咖啡', when: 'tomorrow', slot: 'afternoon', area: '古城' },
      });
      ctx.intentId = data.id;
      check(['open', 'proposed'].includes(data.status), `意向状态 ${data.status}`);
      return `${data.title}（${data.status}）`;
    });

    await step('后台登录 + 立即撮合 + 找到建议局', async () => {
      ctx.admin = (await api('POST', '/api/admin/login', { body: { password: 'smoke-admin' } })).data.token;
      const run = (await api('POST', '/api/admin/match/run', { token: ctx.admin })).data;
      const { items } = (await api('GET', '/api/admin/proposals?status=pending', { token: ctx.admin })).data;
      const proposal = items.find((p) => p.members.some((m) => m.user.id === ctx.liziId));
      check(proposal, '没有包含栗子的建议局');
      ctx.proposal = proposal;
      return `本次新建 ${run.created} 条；「${proposal.title}」${proposal.members.length} 人，匹配度 ${proposal.score}，理由：${proposal.reasons.join(' / ')}`;
    });

    await step('后台确认成局 → 邀请', async () => {
      const { data } = await api('POST', `/api/admin/proposals/${ctx.proposal.id}/confirm`, {
        token: ctx.admin,
        body: { title: '明天下午 · 慢书房咖啡', place: '人民路 · 慢书房咖啡', meetingPoint: '靠窗的长桌', feeType: 'aa', feeEstimate: 35 },
      });
      ctx.eventId = data.eventId;
      const match = (await api('GET', `/api/matches/${ctx.eventId}`, { token: ctx.lizi })).data;
      check(match.myStatus === 'invited', `myStatus=${match.myStatus}`);
      const inbox = (await api('GET', '/api/inbox', { token: ctx.lizi })).data;
      check(inbox.actions.some((a) => a.type === 'match' && a.eventId === ctx.eventId), '消息中心没有「撮合成功」');
      return `局 #${ctx.eventId}，截止 ${match.deadline}`;
    });

    await step('成员全部加入 → 成局', async () => {
      ctx.members = {};
      let last;
      for (const m of ctx.proposal.members) {
        const token =
          m.user.id === ctx.liziId
            ? ctx.lizi
            : (await api('POST', '/api/auth/dev-login', { body: { userId: m.user.id } })).data.token;
        ctx.members[m.user.id] = { token, nickname: m.user.nickname };
        last = (await api('POST', `/api/matches/${ctx.eventId}/accept`, { token })).data;
      }
      check(last.eventStatus === 'formed', `局状态 ${last.eventStatus}`);
      return Object.values(ctx.members).map((m) => m.nickname).join('、');
    });

    await step('群聊：系统消息、发言、联系方式被拦截、换破冰话题', async () => {
      const list = (await api('GET', `/api/events/${ctx.eventId}/messages`, { token: ctx.lizi })).data;
      check(list.items.some((m) => m.kind === 'system'), '没有系统消息');
      await api('POST', `/api/events/${ctx.eventId}/messages`, { token: ctx.lizi, body: { text: '大家好，我会早到一点占座' } });
      const blocked = await api('POST', `/api/events/${ctx.eventId}/messages`, { token: ctx.lizi, body: { text: '加我微信 lizi2024' } });
      check(blocked.status === 422 && blocked.data.error.code === 'CONTENT_BLOCKED', '联系方式没有被拦截');
      const ice = (await api('POST', `/api/events/${ctx.eventId}/icebreaker/next`, { token: ctx.lizi })).data;
      return `破冰 ${ice.index + 1}/${ice.total}：${ice.question}`;
    });

    await step('AA：栗子一次记下总花费，大家平摊、我已转账 / 确认收到', async () => {
      const others = Object.entries(ctx.members).filter(([id]) => Number(id) !== ctx.liziId);
      const n = Object.keys(ctx.members).length;
      const aa = (await api('POST', `/api/events/${ctx.eventId}/aa`, { token: ctx.lizi, body: { amount: 45 * n, note: '咖啡 + 甜点' } })).data;
      check(aa.bill.mine && aa.total === 45 * n && aa.each === 45, `总额 ${aa.total} 每人 ${aa.each}`);
      check(aa.transfers.length === others.length && aa.transfers.every((t) => t.to.id === ctx.liziId), '转账应该都转给栗子');
      const [, second] = others[0];
      const dup = await fetch(`${base}/api/events/${ctx.eventId}/aa`, {
        method: 'POST',
        headers: { authorization: `Bearer ${second.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ amount: 30 }),
      });
      check(dup.status === 409, `第二笔应该被拒绝，实际 ${dup.status}`);
      const payer = aa.transfers[0].from;
      await api('POST', `/api/events/${ctx.eventId}/aa/paid`, { token: ctx.members[payer.id].token, body: { toUserId: ctx.liziId } });
      const after = (await api('POST', `/api/events/${ctx.eventId}/aa/confirm`, { token: ctx.lizi, body: { fromUserId: payer.id } })).data;
      check(after.transfers.find((t) => t.from.id === payer.id).status === 'confirmed', '没有确认收到');
      check(after.bill.editable === false, '有人转账后账单应该锁定');
      return `共 ¥${aa.total}（${aa.bill.note}），每人 ¥${aa.each}：` + aa.transfers.map((t) => `${t.from.nickname}→${t.to.nickname} ¥${t.amount}`).join('，');
    });

    await step('上传图片', async () => {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      );
      const form = new FormData();
      form.append('file', new Blob([png], { type: 'image/png' }), 'dot.png');
      const { data } = await api('POST', '/api/upload', { token: ctx.lizi, form });
      const file = await fetch(data.url.replace(config.publicBaseUrl, base));
      check(file.ok, '上传的图片访问不到');
      return data.url.replace(config.publicBaseUrl, '');
    });

    await step('时间穿越到局结束后 + 跑一遍定时任务', async () => {
      const detail = (await api('GET', `/api/events/${ctx.eventId}`, { token: ctx.lizi })).data;
      const target = new Date(Date.parse(detail.endAt) + 60 * 60 * 1000).toISOString();
      await api('POST', '/api/dev/clock', { body: { now: target } });
      const tick = (await api('POST', '/api/dev/tick', { body: {} })).data;
      const inbox = (await api('GET', '/api/inbox', { token: ctx.lizi })).data;
      check(inbox.actions.some((a) => a.type === 'review' && a.eventId === ctx.eventId), '没有「去评价」');
      return `现在 ${tick.now}；提醒：评价 ${tick.reminders.review} 条、报平安 ${tick.reminders.safe} 条`;
    });

    await step('互评（一人被两票评为迟到）', async () => {
      const ids = Object.keys(ctx.members).map(Number);
      ctx.lateId = ids.find((id) => id !== ctx.liziId);
      for (const id of ids) {
        const attendance = {};
        for (const other of ids) if (other !== id) attendance[other] = other === ctx.lateId ? 'late' : 'on_time';
        await api('POST', `/api/events/${ctx.eventId}/reviews`, {
          token: ctx.members[id].token,
          body: { attendance, feelings: ['很放松', '节奏刚好'] },
        });
      }
      const view = (await api('GET', `/api/events/${ctx.eventId}/review`, { token: ctx.lizi })).data;
      check(view.submitted, '评价没记上');
      return `${ids.length} 人都交了评价`;
    });

    await step('信用已更新', async () => {
      const me = (await api('GET', '/api/me', { token: ctx.lizi })).data;
      check(me.credit.attended === ctx.attendedBefore + 1, `栗子 attended ${ctx.attendedBefore} → ${me.credit.attended}`);
      const late = (await api('GET', '/api/me', { token: ctx.members[ctx.lateId].token })).data;
      check(late.credit.late === 1, `${late.nickname} 的迟到次数 ${late.credit.late}`);
      return `栗子参加 ${ctx.attendedBefore} → ${me.credit.attended} 个局；${late.nickname} 记一次迟到，履约率 ${late.credit.rate}%`;
    });

    await step('局后发动态 + 评论', async () => {
      const post = (await api('POST', '/api/posts', {
        token: ctx.lizi,
        body: { text: '第一次在大理和陌生人喝咖啡，没想到这么自在。', images: [], eventId: ctx.eventId, visibility: 'public' },
      })).data;
      check(post.status === 'approved', `动态状态 ${post.status}`);
      const other = ctx.members[ctx.lateId];
      await api('POST', `/api/posts/${post.id}/comments`, { token: other.token, body: { text: '下次还约！' } });
      const detail = (await api('GET', `/api/posts/${post.id}`, { token: ctx.lizi })).data;
      return `动态 #${post.id}，${detail.comments.length} 条评论`;
    });
  } catch {
    // 失败的步骤已经打印
  } finally {
    clock.reset();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${failed ? 'FAIL' : 'PASS'}：${passed}/${results.length} 步通过${failed ? `，失败于「${results.find((r) => !r.ok).name}」` : ''}`);
  process.exit(failed ? 1 : 0);
}

main();

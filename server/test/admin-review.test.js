// 后台评审发现的问题（编号对应评审清单 #1–#15）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { clock } from '../src/clock.js';
import { openDb } from '../src/db.js';
import { addCreditEvent } from '../src/services/credit.js';
import { runMatching } from '../src/services/matching.js';
import { setSetting } from '../src/services/settings.js';
import { DAY, HOUR, addCredit, makeIntent, makeUser, startServer } from './helpers.js';

let s;
let admin;

beforeEach(async () => {
  s = await startServer(); // 北京时间 2026-10-26（周一）10:00
  admin = await s.adminToken();
});
afterEach(() => s.close());

const notices = (userId, type) => s.db.all('SELECT * FROM notices WHERE user_id = ? AND type = ? ORDER BY id', userId, type);
const resolve = (id, body) => s.ok('POST', `/api/admin/reports/${id}/resolve`, { token: admin, body });

/** 用户 a 举报用户 b，返回举报 id */
async function reportUser(reporter, target) {
  const token = await s.login(reporter);
  return (await s.ok('POST', '/api/reports', { token, body: { targetType: 'user', targetId: target, reason: '骚扰或不当言行' } })).id;
}

/** 发起人 + 一个成员的用户局（周六 14:00），返回 { eventId, hostToken, memberToken } */
async function smallEvent(host, member, overrides = {}) {
  const hostToken = await s.login(host);
  const memberToken = await s.login(member);
  const ev = await s.ok('POST', '/api/events', {
    token: hostToken,
    body: { title: '洱海边散步', category: 'outdoor', startAt: '2026-10-31T06:00:00.000Z', place: '才村码头', capacity: 4, feeType: 'free', ...overrides },
  });
  await s.ok('POST', `/api/events/${ev.id}/join`, { token: memberToken });
  return { eventId: ev.id, hostToken, memberToken };
}

/** n 个人的看日出建议局，返回 { proposal, users, tokens } */
async function proposalOf(n, intentOverrides = {}) {
  const users = Array.from({ length: n }, () => makeUser(s.db));
  users.forEach((u) => addCredit(s.db, u, 'attended', 2));
  users.forEach((u) => makeIntent(s.db, u, intentOverrides));
  runMatching(s.db);
  const { items } = await s.ok('GET', '/api/admin/proposals', { token: admin });
  const tokens = await Promise.all(users.map((u) => s.login(u)));
  return { proposal: items[0], users, tokens };
}

describe('#1 封禁不会被「限制」降级', () => {
  test('后台限制 / 举报 restrict_7d 遇到已封禁账号 → 409，仍是 banned', async () => {
    const [reporter, bad] = [makeUser(s.db), makeUser(s.db)];
    await s.ok('POST', `/api/admin/users/${bad}/ban`, { token: admin, body: { reason: '诈骗' } });

    const r = await s.api('POST', `/api/admin/users/${bad}/restrict`, { token: admin, body: { days: 7, reason: '再限制一下' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.message, '账号已封禁，先解封再处理');

    const reportId = await reportUser(reporter, bad);
    const viaReport = await s.api('POST', `/api/admin/reports/${reportId}/resolve`, { token: admin, body: { action: 'restrict_7d' } });
    assert.equal(viaReport.status, 409);
    assert.equal(s.db.get('SELECT status FROM users WHERE id = ?', bad).status, 'banned');
    assert.equal(s.db.get('SELECT status FROM reports WHERE id = ?', reportId).status, 'pending'); // 整个处理回滚

    // 自动受限也不会碰封禁的人
    addCreditEvent(s.db, { userId: bad, type: 'no_show', source: 'review' });
    addCreditEvent(s.db, { userId: bad, type: 'no_show', source: 'review' });
    assert.equal(s.db.get('SELECT status FROM users WHERE id = ?', bad).status, 'banned');

    // 举报 ban 一个已封禁的人：不重复处理，举报照常结案
    const view = await resolve(reportId, { action: 'ban' });
    assert.equal(view.status, 'resolved');
    assert.equal(notices(bad, 'banned').length, 1);
  });
});

describe('#2 举报处理：note 只给后台看，message 发给被处理的人', () => {
  test('warn：message 替换默认提醒；note 不会出现在任何通知里', async () => {
    const [reporter, target] = [makeUser(s.db), makeUser(s.db)];
    const id = await reportUser(reporter, target);
    const view = await resolve(id, { action: 'warn', note: '内部记录：第二次被举报', message: '请不要在群里打听别人住哪' });
    assert.equal(view.adminNote, '内部记录：第二次被举报');
    assert.equal(view.message, '请不要在群里打听别人住哪');
    assert.equal(notices(target, 'warning')[0].body, '请不要在群里打听别人住哪');
    const leaked = s.db.get("SELECT COUNT(*) AS n FROM notices WHERE title LIKE '%内部记录%' OR body LIKE '%内部记录%'");
    assert.equal(leaked.n, 0);
  });

  test('不填 message 用默认文案；restrict_7d / ban 的 message 也会替换默认说明', async () => {
    const [reporter, a, b, c] = [makeUser(s.db), makeUser(s.db), makeUser(s.db), makeUser(s.db)];
    await resolve(await reportUser(reporter, a), { action: 'warn', note: '只是备注' });
    assert.equal(notices(a, 'warning')[0].body, '有人反馈你的言行让人不舒服，请遵守社区公约。再次违反会被限制使用。');

    await resolve(await reportUser(reporter, b), { action: 'restrict_7d', note: '内部', message: '多次在局里推销，暂停 7 天' });
    assert.equal(notices(b, 'restricted')[0].body, '多次在局里推销，暂停 7 天');
    assert.equal(s.db.get('SELECT restricted_reason FROM users WHERE id = ?', b).restricted_reason, '多次在局里推销，暂停 7 天');

    await resolve(await reportUser(reporter, c), { action: 'restrict_7d', note: '内部' });
    assert.equal(notices(c, 'restricted')[0].body, '原因：被举报并核实违反社区公约。到期后自动恢复。');

    const d = makeUser(s.db);
    await resolve(await reportUser(reporter, d), { action: 'ban', note: '内部', message: '诈骗他人钱财' });
    assert.equal(notices(d, 'banned')[0].body, '诈骗他人钱财');
  });

  test('message 不能带联系方式（点名违规内容没关系），最长 200 字', async () => {
    const [reporter, target] = [makeUser(s.db), makeUser(s.db)];
    const id = await reportUser(reporter, target);
    for (const message of ['有事打 13812345678', '加我微信 admin2024 细聊', '规则见 https://example.com']) {
      const bad = await s.api('POST', `/api/admin/reports/${id}/resolve`, { token: admin, body: { action: 'warn', message } });
      assert.equal(bad.status, 422, message);
      assert.equal(bad.body.error.code, 'CONTENT_BLOCKED');
    }
    const long = await s.api('POST', `/api/admin/reports/${id}/resolve`, { token: admin, body: { action: 'warn', message: '长'.repeat(201) } });
    assert.equal(long.status, 400);
    const ok = await resolve(id, { action: 'warn', message: '请不要在群里推销代购、拉人头' });
    assert.equal(ok.message, '请不要在群里推销代购、拉人头');
  });
});

describe('#3 delete_content 通知作者', () => {
  test('动态 / 评论 / 群聊消息 / 局 / 简介被删时，作者收到「……因违反社区公约被删除」（附 message）', async () => {
    const [reporter, author] = [makeUser(s.db), makeUser(s.db, { bio: '加我私聊有优惠' })];
    const tr = await s.login(reporter);
    const ta = await s.login(author);
    const post = await s.ok('POST', '/api/posts', { token: ta, body: { text: '今天的洱海好安静', images: [] } });
    const comment = await s.ok('POST', `/api/posts/${post.id}/comments`, { token: ta, body: { text: '私聊我有更好玩的' } });
    const { eventId, memberToken } = await smallEvent(reporter, author);
    const msg = await s.ok('POST', `/api/events/${eventId}/messages`, { token: memberToken, body: { text: '回头私下找我' } });
    const ev2 = await s.ok('POST', '/api/events', {
      token: ta,
      body: { title: '夜市小吃局', category: 'food', startAt: '2026-10-31T11:00:00.000Z', place: '人民路', capacity: 4, feeType: 'aa' },
    });
    await s.ok('POST', `/api/events/${ev2.id}/join`, { token: tr });

    const cases = [
      ['post', post.id, '你的一条动态因违反社区公约被删除'],
      ['comment', comment.id, '你的一条评论因违反社区公约被删除'],
      ['message', msg.id, '你的一条群聊消息因违反社区公约被删除'],
      ['event', ev2.id, '你发起的局「夜市小吃局」因违反社区公约被取消'],
      ['user', author, '你的个人简介因违反社区公约被清空'],
    ];
    for (const [targetType, targetId] of cases) {
      const { id } = await s.ok('POST', '/api/reports', { token: tr, body: { targetType, targetId, reason: '推销 / 拉人头' } });
      await resolve(id, { action: 'delete_content', message: targetType === 'post' ? '动态里不要留联系方式' : undefined });
    }
    const got = notices(author, 'content_deleted');
    assert.deepEqual(got.map((n) => n.title), cases.map((c) => c[2]));
    assert.equal(got[0].body, '动态里不要留联系方式');
    assert.equal(got[1].body, '');
    // 被取消的局：作者收到的是删除通知，不会再收一条「局已取消」；其他成员照常收到
    assert.equal(notices(author, 'event_cancelled').length, 0);
    assert.equal(notices(reporter, 'event_cancelled').length, 1);
    assert.equal(s.db.get('SELECT bio FROM users WHERE id = ?', author).bio, '');
  });

  test('内容本来就删了：不再通知作者', async () => {
    const [reporter, author] = [makeUser(s.db), makeUser(s.db)];
    const ta = await s.login(author);
    const post = await s.ok('POST', '/api/posts', { token: ta, body: { text: '随手拍', images: [] } });
    const { id } = await s.ok('POST', '/api/reports', { token: await s.login(reporter), body: { targetType: 'post', targetId: post.id, reason: '其他' } });
    await s.ok('DELETE', `/api/posts/${post.id}`, { token: ta });
    await resolve(id, { action: 'delete_content' });
    assert.equal(notices(author, 'content_deleted').length, 0);
  });
});

describe('#4 #5 举报列表：真实状态 + 上下文', () => {
  test('targetUser.status 用当前状态：限制到期后显示 active', async () => {
    const [reporter, target] = [makeUser(s.db), makeUser(s.db)];
    s.db.update('users', target, { status: 'restricted', restricted_until: new Date(clock.now().getTime() - HOUR).toISOString() });
    await reportUser(reporter, target);
    const { items } = await s.ok('GET', '/api/admin/reports', { token: admin });
    assert.equal(items[0].targetUser.status, 'active');
  });

  test('context：消息 → 局；评论 → 动态；动态 / 局 → 自己；用户 → null', async () => {
    const [reporter, author] = [makeUser(s.db), makeUser(s.db)];
    const tr = await s.login(reporter);
    const ta = await s.login(author);
    const post = await s.ok('POST', '/api/posts', { token: ta, body: { text: '凌晨爬起来真的值，一路上没人尬聊，刚刚好。', images: [] } });
    const comment = await s.ok('POST', `/api/posts/${post.id}/comments`, { token: ta, body: { text: '下次带上我' } });
    const { eventId, hostToken } = await smallEvent(author, reporter); // 作者发起，举报人是成员
    const msg = await s.ok('POST', `/api/events/${eventId}/messages`, { token: hostToken, body: { text: '回头私下找我' } });
    for (const [targetType, targetId] of [
      ['message', msg.id],
      ['comment', comment.id],
      ['post', post.id],
      ['event', eventId],
      ['user', author],
    ]) {
      await s.ok('POST', '/api/reports', { token: tr, body: { targetType, targetId, reason: '其他' } });
    }
    const { items } = await s.ok('GET', '/api/admin/reports', { token: admin });
    const ctx = Object.fromEntries(items.map((r) => [r.targetType, r.context]));
    assert.deepEqual(ctx.message, { eventId, eventTitle: '洱海边散步' });
    assert.deepEqual(ctx.comment, { postId: post.id, postPreview: '凌晨爬起来真的值，一路上没人尬聊，刚刚好。' });
    assert.deepEqual(ctx.post, { postId: post.id });
    assert.deepEqual(ctx.event, { eventId, eventTitle: '洱海边散步' });
    assert.equal(ctx.user, null);
  });
});

describe('#6 撤销信用记录', () => {
  test('通知本人，并自动通过这条记录上待处理的申诉；重复撤销不再通知', async () => {
    const [host, member] = [makeUser(s.db), makeUser(s.db)];
    const { eventId } = await smallEvent(host, member);
    s.db.insert('credit_events', {
      user_id: member,
      event_id: eventId,
      type: 'no_show',
      source: 'review',
      note: '互评结果',
      revoked: 0,
      created_at: clock.iso(),
    });
    const ce = s.db.get('SELECT * FROM credit_events WHERE user_id = ?', member);
    const tm = await s.login(member);
    const appeal = await s.ok('POST', `/api/credit-events/${ce.id}/appeal`, { token: tm, body: { text: '那天我提前在群里说过去不了' } });

    const r = await s.ok('POST', `/api/admin/users/${member}/credit`, { token: admin, body: { revokeId: ce.id } });
    assert.equal(r.credit.noShow, 0);
    const [n] = notices(member, 'credit_revoked');
    assert.equal(n.title, '你的一条信用记录已撤销');
    assert.equal(n.body, '10月31日 洱海边散步 放鸽子');
    assert.equal(n.link, 'credit');
    const a = s.db.get('SELECT * FROM appeals WHERE id = ?', appeal.id);
    assert.equal(a.status, 'approved');
    assert.equal(a.admin_note, '后台已撤销这条记录');
    assert.ok(a.resolved_at);

    await s.ok('POST', `/api/admin/users/${member}/credit`, { token: admin, body: { revokeId: ce.id } });
    assert.equal(notices(member, 'credit_revoked').length, 1);
  });
});

describe('申诉处理的回复', () => {
  test('通过时 note 也会附在给申诉人的通知里', async () => {
    const u = makeUser(s.db);
    addCredit(s.db, u, 'late', 1, { daysAgo: 2 });
    const ce = s.db.get('SELECT id FROM credit_events WHERE user_id = ?', u).id;
    const appeal = await s.ok('POST', `/api/credit-events/${ce}/appeal`, { token: await s.login(u), body: { text: '那天堵车，提前在群里说了' } });
    const view = await s.ok('POST', `/api/admin/appeals/${appeal.id}/resolve`, { token: admin, body: { approve: true, note: '核实了群聊记录' } });
    assert.equal(view.status, 'approved');
    assert.equal(notices(u, 'appeal_result')[0].body, '这条记录已撤销，你的履约率已经更新。核实了群聊记录');
  });
});

describe('#7 自动成局：每次撮合都检查所有待确认的建议', () => {
  test('先生成的建议，打开自动成局后下一次撮合就确认', async () => {
    const { proposal } = await proposalOf(3, {});
    assert.equal(proposal.risks.length, 0);
    assert.ok(proposal.score >= 80);
    setSetting(s.db, 'autoConfirm', { enabled: true, threshold: 80 });
    const run = await s.ok('POST', '/api/admin/match/run', { token: admin });
    assert.equal(run.created, 0);
    assert.equal(run.autoConfirmed, 1);
    assert.equal(s.db.get('SELECT status FROM proposals WHERE id = ?', proposal.id).status, 'confirmed');
  });

  test('有风险或分数不够的不会自动确认', async () => {
    const users = [1, 2, 3].map(() => makeUser(s.db)); // 都是新人 → 有风险
    users.forEach((u) => makeIntent(s.db, u));
    runMatching(s.db);
    setSetting(s.db, 'autoConfirm', { enabled: true, threshold: 0 });
    assert.equal(runMatching(s.db).autoConfirmed, 0);
    assert.equal(s.db.get("SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'").n, 1);
  });
});

describe('#8 确认时校验大家约好的人数', () => {
  test('建议带 minSize / maxSize；调整成员可以低于 minSize，确认时拦下', async () => {
    const { proposal, users } = await proposalOf(3, { size_min: 3, size_max: 4 });
    assert.equal(proposal.minSize, 3);
    assert.equal(proposal.maxSize, 4);

    // 后台把一个人移出去：允许（界面会提示），但不能确认
    const adjusted = await s.ok('POST', `/api/admin/proposals/${proposal.id}/members`, { token: admin, body: { remove: [users[2]] } });
    assert.equal(adjusted.members.length, 2);
    assert.equal(adjusted.minSize, 3);
    let r = await s.api('POST', `/api/admin/proposals/${proposal.id}/confirm`, { token: admin, body: {} });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /至少 3 人/);

    // 加回来以后：人数上限不能超过 maxSize，也不能少于人数
    const pool = await s.ok('GET', '/api/admin/intents?status=open', { token: admin });
    await s.ok('POST', `/api/admin/proposals/${proposal.id}/members`, { token: admin, body: { add: [pool.items[0].id] } });
    const proposed = await s.ok('GET', '/api/admin/intents?status=proposed', { token: admin });
    assert.equal(proposed.items.length, 3);
    assert.ok(proposed.items.every((i) => i.proposalId === proposal.id));
    r = await s.api('POST', `/api/admin/proposals/${proposal.id}/confirm`, { token: admin, body: { capacity: 5 } });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /不能超过 4 人/);
    r = await s.api('POST', `/api/admin/proposals/${proposal.id}/confirm`, { token: admin, body: { capacity: 2 } });
    assert.equal(r.status, 400);
    const { eventId } = await s.ok('POST', `/api/admin/proposals/${proposal.id}/confirm`, { token: admin, body: { capacity: 4 } });
    const event = s.db.get('SELECT capacity, min_size FROM events WHERE id = ?', eventId);
    assert.deepEqual({ ...event }, { capacity: 4, min_size: 3 });
  });

  test('开了「2–6 人都可以」按 2–6 算', async () => {
    const { proposal } = await proposalOf(2, { relax_size: 1 });
    assert.deepEqual([proposal.minSize, proposal.maxSize], [2, 6]);
    const r = await s.api('POST', `/api/admin/proposals/${proposal.id}/confirm`, { token: admin, body: { capacity: 6 } });
    assert.equal(r.status, 200);
  });
});

describe('#9 退回的建议按处理时间倒序', () => {
  test('?status=rejected 最新退回的在前', async () => {
    const first = await proposalOf(3, {});
    await s.ok('POST', `/api/admin/proposals/${first.proposal.id}/reject`, { token: admin, body: { note: '先退回' } });
    clock.advance(HOUR);
    const second = await proposalOf(3, { task: '爬山' });
    await s.ok('POST', `/api/admin/proposals/${second.proposal.id}/reject`, { token: admin, body: { note: '后退回' } });
    const { items } = await s.ok('GET', '/api/admin/proposals?status=rejected', { token: admin });
    assert.deepEqual(items.map((p) => p.reviewNote), ['后退回', '先退回']);
    assert.equal((await s.api('GET', '/api/admin/proposals?status=bogus', { token: admin })).status, 400);
  });
});

describe('#10 邀请进度与「催一下」', () => {
  test('列表带 joinedCount / invitedCount / inviteDeadline；详情带每个人的状态和期限；催还没回复的人', async () => {
    const { proposal, users, tokens } = await proposalOf(4, {});
    const { eventId } = await s.ok('POST', `/api/admin/proposals/${proposal.id}/confirm`, { token: admin, body: {} });
    for (const t of tokens.slice(0, 2)) await s.ok('POST', `/api/matches/${eventId}/accept`, { token: t });

    const deadline = new Date(clock.now().getTime() + 24 * HOUR).toISOString(); // 早于开场前 12 小时
    const { items } = await s.ok('GET', '/api/admin/events?source=matched&status=inviting', { token: admin });
    assert.equal(items.length, 1);
    assert.equal(items[0].joinedCount, 2);
    assert.equal(items[0].invitedCount, 2);
    assert.equal(items[0].inviteDeadline, deadline);

    const remind = await s.ok('POST', `/api/admin/events/${eventId}/remind`, { token: admin });
    assert.deepEqual(remind, { reminded: 2 });
    const [n] = notices(users[3], 'match_reminder');
    assert.equal(n.title, '还没回复：周六清晨 · 一起看日出');
    assert.equal(n.body, '明天 10:00 前点「加入」');
    assert.equal(n.link, `match:${eventId}`);
    assert.equal(notices(users[0], 'match_reminder').length, 0);

    await s.ok('POST', `/api/matches/${eventId}/accept`, { token: tokens[2] });
    clock.advance(24 * HOUR + 60000);
    await s.ok('POST', '/api/dev/tick');
    const detail = await s.ok('GET', `/api/admin/events/${eventId}`, { token: admin });
    assert.equal(detail.event.status, 'formed');
    const byId = Object.fromEntries(detail.members.map((m) => [m.id, m]));
    assert.equal(byId[users[0]].status, 'joined');
    assert.equal(byId[users[3]].status, 'expired');
    assert.equal(byId[users[3]].inviteDeadline, deadline);
    // 用户那边仍然是 declined
    assert.equal((await s.ok('GET', `/api/matches/${eventId}`, { token: tokens[3] })).myStatus, 'declined');

    const late = await s.api('POST', `/api/admin/events/${eventId}/remind`, { token: admin });
    assert.equal(late.status, 409);
  });

  test('换一批的人显示 declined，不是 expired', async () => {
    const { proposal, users, tokens } = await proposalOf(3, {});
    const { eventId } = await s.ok('POST', `/api/admin/proposals/${proposal.id}/confirm`, { token: admin, body: {} });
    await s.ok('POST', `/api/matches/${eventId}/decline`, { token: tokens[0] });
    const detail = await s.ok('GET', `/api/admin/events/${eventId}`, { token: admin });
    assert.equal(detail.members.find((m) => m.id === users[0]).status, 'declined');
    assert.equal(detail.event.invitedCount, 2);
  });
});

describe('#11 #12 #13', () => {
  test('#11 后台看群聊：系统消息不算「我的」', async () => {
    const { proposal, tokens } = await proposalOf(3, {});
    const { eventId } = await s.ok('POST', `/api/admin/proposals/${proposal.id}/confirm`, { token: admin, body: {} });
    for (const t of tokens) await s.ok('POST', `/api/matches/${eventId}/accept`, { token: t });
    const detail = await s.ok('GET', `/api/admin/events/${eventId}`, { token: admin });
    assert.equal(detail.messages[0].kind, 'system');
    assert.equal(detail.messages[0].mine, false);
  });

  test('#12 动态只能审核一次', async () => {
    const author = makeUser(s.db);
    const post = await s.ok('POST', '/api/posts', { token: await s.login(author), body: { text: '兼职日结，私聊', images: [] } });
    assert.equal(post.status, 'pending');
    await s.ok('POST', `/api/admin/posts/${post.id}/approve`, { token: admin });
    assert.equal((await s.api('POST', `/api/admin/posts/${post.id}/approve`, { token: admin })).status, 409);
    assert.equal((await s.api('POST', `/api/admin/posts/${post.id}/reject`, { token: admin })).status, 409);
    assert.equal(s.db.get("SELECT COUNT(*) AS n FROM notices WHERE user_id = ? AND type LIKE 'post_%'", author).n, 1);
  });

  test('#13 已结束 / 已取消的局不能再取消', async () => {
    const { eventId } = await smallEvent(makeUser(s.db), makeUser(s.db));
    const { eventId: other } = await smallEvent(makeUser(s.db), makeUser(s.db));
    await s.ok('POST', `/api/admin/events/${other}/cancel`, { token: admin, body: { reason: '场地关闭' } });
    assert.equal((await s.api('POST', `/api/admin/events/${other}/cancel`, { token: admin, body: { reason: '再取消' } })).status, 409);
    clock.set('2026-10-31T09:00:00.000Z'); // 局已结束
    const r = await s.api('POST', `/api/admin/events/${eventId}/cancel`, { token: admin, body: { reason: '补取消' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.message, '局已经结束了，不能取消');
  });
});

describe('#14 筛选', () => {
  test('用户：level=banned 只看封禁的；restricted 不含封禁；非法值 400', async () => {
    const banned = makeUser(s.db, { nickname: '封禁的人' });
    const restricted = makeUser(s.db, { nickname: '受限的人' });
    await s.ok('POST', `/api/admin/users/${banned}/ban`, { token: admin, body: { reason: '诈骗' } });
    await s.ok('POST', `/api/admin/users/${restricted}/restrict`, { token: admin, body: { days: 3, reason: '多次迟到' } });
    const b = await s.ok('GET', '/api/admin/users?level=banned', { token: admin });
    assert.deepEqual(b.items.map((u) => u.id), [banned]);
    const r = await s.ok('GET', '/api/admin/users?level=restricted', { token: admin });
    assert.deepEqual(r.items.map((u) => u.id), [restricted]);
    assert.equal((await s.api('GET', '/api/admin/users?level=vip', { token: admin })).status, 400);
  });

  test('局：status=ended 按时间算；open / formed 不含已结束的；非法值 400', async () => {
    const { eventId: past } = await smallEvent(makeUser(s.db), makeUser(s.db), { startAt: '2026-10-26T03:00:00.000Z', durationMin: 60 });
    const { eventId: future } = await smallEvent(makeUser(s.db), makeUser(s.db));
    clock.set('2026-10-26T05:00:00.000Z'); // past 已结束
    const ended = await s.ok('GET', '/api/admin/events?status=ended', { token: admin });
    assert.deepEqual(ended.items.map((e) => e.id), [past]);
    assert.equal(ended.items[0].phase, 'ended');
    const open = await s.ok('GET', '/api/admin/events?status=open', { token: admin });
    assert.deepEqual(open.items.map((e) => e.id), [future]);
    assert.equal((await s.api('GET', '/api/admin/events?status=done', { token: admin })).status, 400);
    assert.equal((await s.api('GET', '/api/admin/events?source=nope', { token: admin })).status, 400);
  });
});

describe('#15 补充字段', () => {
  test('撮合池意向带 isNew', async () => {
    const fresh = makeUser(s.db);
    const regular = makeUser(s.db);
    addCredit(s.db, regular, 'attended', 1);
    makeIntent(s.db, fresh, { task: '咖啡' });
    makeIntent(s.db, regular, { task: '桌游' });
    const { items } = await s.ok('GET', '/api/admin/intents', { token: admin });
    const byUser = Object.fromEntries(items.map((i) => [i.user.id, i.isNew]));
    assert.deepEqual(byUser, { [fresh]: true, [regular]: false });
  });

  test('申诉带 evidence：本人开场前 72 小时到开场之间在那个局里说过的话', async () => {
    const [host, member] = [makeUser(s.db), makeUser(s.db)];
    const { eventId } = await smallEvent(host, member); // 周六 06:00Z 开场
    const start = Date.parse('2026-10-31T06:00:00.000Z');
    const say = (userId, text, hoursBefore) =>
      s.db.insert('messages', { event_id: eventId, user_id: userId, kind: 'text', text, created_at: new Date(start - hoursBefore * HOUR).toISOString() });
    say(member, '太早了，不算', 80);
    say(member, '我可能去不了', 20.5);
    say(host, '别人的话不算', 10);
    say(member, '发烧了，今天去不了，抱歉', 3);
    say(member, '开场后才说的不算', -1);
    const ce = s.db.insert('credit_events', { user_id: member, event_id: eventId, type: 'no_show', source: 'review', revoked: 0, created_at: clock.iso() });
    await s.ok('POST', `/api/credit-events/${ce}/appeal`, { token: await s.login(member), body: { text: '我提前在群里说过去不了' } });
    // 没有关联局的记录：evidence 为空
    const other = makeUser(s.db);
    addCredit(s.db, other, 'no_show', 1, { daysAgo: 3 });
    const otherCe = s.db.get('SELECT id FROM credit_events WHERE user_id = ?', other).id;
    await s.ok('POST', `/api/credit-events/${otherCe}/appeal`, { token: await s.login(other), body: { text: '那天下大雨，提前说了' } });

    const { items } = await s.ok('GET', '/api/admin/appeals', { token: admin });
    const mine = items.find((a) => a.user.id === member);
    assert.deepEqual(
      mine.evidence.map((e) => [e.text, e.hoursBeforeStart]),
      [
        ['我可能去不了', 20.5],
        ['发烧了，今天去不了，抱歉', 3],
      ],
    );
    assert.ok(mine.evidence.every((e) => e.createdAt));
    assert.deepEqual(items.find((a) => a.user.id === other).evidence, []);
  });

  test('restrictedReason：后台限制、自动受限、封禁都会记下原因；恢复后为 null', async () => {
    const [a, b, c] = [makeUser(s.db), makeUser(s.db), makeUser(s.db)];
    await s.ok('POST', `/api/admin/users/${a}/restrict`, { token: admin, body: { days: 3, reason: '多次在局里推销' } });
    addCredit(s.db, b, 'no_show', 1, { daysAgo: 5 });
    addCreditEvent(s.db, { userId: b, type: 'no_show', source: 'review' });
    await s.ok('POST', `/api/admin/users/${c}/ban`, { token: admin, body: { reason: '诈骗' } });

    const { items } = await s.ok('GET', '/api/admin/users', { token: admin });
    const reason = Object.fromEntries(items.map((u) => [u.id, u.restrictedReason]));
    assert.equal(reason[a], '多次在局里推销');
    assert.equal(reason[b], '一个月内放鸽子 2 次');
    assert.equal(reason[c], '诈骗');
    assert.equal((await s.ok('GET', `/api/admin/users/${a}`, { token: admin })).user.restrictedReason, '多次在局里推销');

    await s.ok('POST', `/api/admin/users/${a}/unban`, { token: admin });
    assert.equal((await s.ok('GET', `/api/admin/users/${a}`, { token: admin })).user.restrictedReason, null);
    // 到期自动恢复后也是 null（后台会话 7 天过期，重新登录）
    clock.advance(8 * DAY);
    admin = await s.adminToken();
    assert.equal((await s.ok('GET', `/api/admin/users/${b}`, { token: admin })).user.restrictedReason, null);
  });

  test('数据概览：yesterday 和 prevWeek 用来算环比', async () => {
    // 昨天（北京时间 10-25）注册 2 人、提交 1 个意向
    const yesterday = '2026-10-25T04:00:00.000Z';
    const u1 = makeUser(s.db, { created_at: yesterday });
    makeUser(s.db, { created_at: yesterday });
    makeIntent(s.db, u1, { created_at: yesterday });
    // 8–14 天前：2 次到场 + 1 次放鸽子；最近 7 天：1 次到场
    addCredit(s.db, u1, 'attended', 2, { daysAgo: 10 });
    addCredit(s.db, u1, 'no_show', 1, { daysAgo: 9 });
    addCredit(s.db, u1, 'attended', 1, { daysAgo: 2 });
    const st = await s.ok('GET', '/api/admin/stats', { token: admin });
    assert.deepEqual(st.yesterday, { newUsers: 2, newIntents: 1, formed: 0 });
    assert.deepEqual(st.prevWeek, { attendanceRate: 67, noShowCount: 1 });
    assert.equal(st.week.attendanceRate, 100);
    assert.equal(st.week.noShowCount, 0);
  });
});

describe('数据库迁移', () => {
  test('旧库缺新列时自动补上，数据不丢', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dazi-migrate-'));
    const file = path.join(dir, 'old.db');
    const raw = new DatabaseSync(file);
    raw.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, openid TEXT NOT NULL UNIQUE, phone TEXT, nickname TEXT NOT NULL,
        avatar_url TEXT, bio TEXT NOT NULL DEFAULT '', gender TEXT NOT NULL DEFAULT 'unknown', pace TEXT, interests TEXT NOT NULL DEFAULT '[]',
        phone_verified INTEGER NOT NULL DEFAULT 0, id_verified INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
        restricted_until TEXT, settings TEXT NOT NULL DEFAULT '{}', emergency_contact TEXT, onboarded INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE event_members (event_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL,
        attendance TEXT NOT NULL DEFAULT 'pending', arrived_at TEXT, safe_at TEXT, muted INTEGER NOT NULL DEFAULT 0,
        last_read_message_id INTEGER NOT NULL DEFAULT 0, invited_at TEXT, applied_at TEXT, joined_at TEXT, left_at TEXT, PRIMARY KEY (event_id, user_id));
      CREATE TABLE reports (id INTEGER PRIMARY KEY AUTOINCREMENT, reporter_id INTEGER NOT NULL, target_type TEXT NOT NULL, target_id INTEGER NOT NULL,
        target_user_id INTEGER, reason TEXT NOT NULL, detail TEXT, images TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending',
        action TEXT, admin_note TEXT, created_at TEXT NOT NULL, resolved_at TEXT);
      INSERT INTO users (openid, nickname, status, created_at) VALUES ('old_1', '老用户', 'restricted', '2026-01-01T00:00:00.000Z');
    `);
    raw.close();

    const db = openDb(file);
    const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
    assert.ok(cols('users').includes('restricted_reason'));
    assert.ok(cols('event_members').includes('invite_expired'));
    assert.ok(cols('reports').includes('user_message'));
    assert.equal(db.get('SELECT nickname FROM users WHERE id = 1').nickname, '老用户');
    db.close();
    openDb(file).close(); // 再开一次不会重复加列
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

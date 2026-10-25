// AA 记账：平台不经手钱，只算账（docs/api.md 3.7）。金额内部按「分」计算，避免浮点误差。
import { clock } from '../clock.js';
import { blocked, forbidden, invalid, notFound } from '../errors.js';
import { checkText } from '../moderation.js';
import { num, str } from '../validate.js';
import { joinedMembers, memberRow, requireEvent } from './events.js';
import { notify } from './notices.js';
import { getUser, userBrief } from './users.js';

const toCents = (x) => Math.round(Number(x) * 100);
const toYuan = (cents) => Math.round(cents) / 100;

/**
 * 「欠钱最多的人先还给垫钱最多的人」贪心生成转账清单。
 * balances: Map<userId, cents>（正数 = 别人该给 TA 钱）
 */
export function settleTransfers(balances) {
  const debtors = [];
  const creditors = [];
  for (const [userId, cents] of balances) {
    if (cents < 0) debtors.push({ userId, left: -cents });
    else if (cents > 0) creditors.push({ userId, left: cents });
  }
  const byAmount = (a, b) => b.left - a.left || a.userId - b.userId;
  debtors.sort(byAmount);
  creditors.sort(byAmount);
  const transfers = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].left, creditors[j].left);
    if (amount > 0) transfers.push({ from: debtors[i].userId, to: creditors[j].userId, cents: amount });
    debtors[i].left -= amount;
    creditors[j].left -= amount;
    if (debtors[i].left <= 0) i++;
    if (creditors[j].left <= 0) j++;
  }
  return transfers;
}

/** 汇总：总额、每人、转账（含状态） */
export function aaSummary(db, event, viewerId) {
  const items = db.all('SELECT * FROM aa_items WHERE event_id = ? ORDER BY id', event.id);
  const members = joinedMembers(db, event.id).map((m) => m.user_id);
  const totalCents = items.reduce((sum, it) => sum + toCents(it.amount), 0);
  const eachCents = members.length ? Math.round(totalCents / members.length) : 0;

  const balances = new Map(members.map((id) => [id, -eachCents]));
  for (const it of items) {
    // 垫钱的人如果已经退出，不再分摊，但仍然要拿回垫付的钱
    balances.set(it.payer_id, (balances.get(it.payer_id) ?? 0) + toCents(it.amount));
  }
  const statusRows = db.all('SELECT * FROM aa_transfers WHERE event_id = ?', event.id);
  const statusOf = (from, to) =>
    statusRows.find((r) => r.from_user_id === from && r.to_user_id === to)?.status ?? 'pending';

  const transfers = settleTransfers(balances).map((t) => ({
    fromId: t.from,
    toId: t.to,
    amount: toYuan(t.cents),
    status: statusOf(t.from, t.to),
    role: t.from === viewerId ? 'from' : t.to === viewerId ? 'to' : null,
  }));
  return { items, total: toYuan(totalCents), each: toYuan(eachCents), memberCount: members.length, transfers };
}

function requireAaMember(db, user, eventId) {
  const event = requireEvent(db, eventId);
  const mine = memberRow(db, eventId, user.id);
  if (!mine || mine.status !== 'joined') throw forbidden('加入这个局后才能记账');
  return event;
}

export function aaView(db, user, eventId) {
  const event = requireAaMember(db, user, eventId);
  const summary = aaSummary(db, event, user.id);
  const cache = new Map();
  const brief = (id) => {
    if (!cache.has(id)) cache.set(id, userBrief(db, id));
    return cache.get(id);
  };
  return {
    items: summary.items.map((it) => ({
      id: it.id,
      name: it.name,
      payer: brief(it.payer_id),
      amount: toYuan(toCents(it.amount)),
      mine: it.payer_id === user.id,
      createdAt: it.created_at,
    })),
    total: summary.total,
    each: summary.each,
    memberCount: summary.memberCount,
    transfers: summary.transfers.map((t) => ({
      from: brief(t.fromId),
      to: brief(t.toId),
      amount: t.amount,
      status: t.status,
      role: t.role,
    })),
  };
}

export function addItem(db, user, eventId, body) {
  const event = requireAaMember(db, user, eventId);
  if (['cancelled', 'rejected'].includes(event.status)) throw invalid('这个局已经取消了');
  const name = str(body?.name, '花在哪', { min: 1, max: 20 });
  const check = checkText(name);
  if (!check.ok) throw blocked('记账名称里不能有联系方式或广告', check.reasons);
  const amount = num(body?.amount, '金额', { min: 0.01, max: 100000 });
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) throw invalid('金额最多保留两位小数');
  db.insert('aa_items', {
    event_id: eventId,
    payer_id: user.id,
    name,
    amount: toYuan(toCents(amount)),
    created_at: clock.iso(),
  });
  return aaView(db, user, eventId);
}

export function deleteItem(db, user, eventId, itemId) {
  requireAaMember(db, user, eventId);
  const item = db.get('SELECT * FROM aa_items WHERE id = ? AND event_id = ?', itemId, eventId);
  if (!item) throw notFound('这笔账不存在');
  if (item.payer_id !== user.id) throw forbidden('只能删除自己记的账');
  db.run('DELETE FROM aa_items WHERE id = ?', itemId);
  return aaView(db, user, eventId);
}

function setTransferStatus(db, eventId, from, to, status) {
  db.run(
    `INSERT INTO aa_transfers (event_id, from_user_id, to_user_id, status, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(event_id, from_user_id, to_user_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
    eventId,
    from,
    to,
    status,
    clock.iso(),
  );
}

/** 付款方：我已转账 */
export function markPaid(db, user, eventId, toUserId) {
  const event = requireAaMember(db, user, eventId);
  const t = aaSummary(db, event, user.id).transfers.find((x) => x.fromId === user.id && x.toId === toUserId);
  if (!t) throw invalid('没有需要转给 TA 的钱');
  if (t.status !== 'confirmed') {
    setTransferStatus(db, eventId, user.id, toUserId, 'paid');
    notify(db, toUserId, {
      type: 'aa_paid',
      title: 'AA 转账提醒',
      body: `${user.nickname} 说已经转给你 ¥${t.amount}，收到后点一下「确认收到」`,
      link: `chat:${eventId}`,
    });
  }
  return aaView(db, user, eventId);
}

/** 收款方：确认收到 */
export function confirmReceived(db, user, eventId, fromUserId) {
  const event = requireAaMember(db, user, eventId);
  const t = aaSummary(db, event, user.id).transfers.find((x) => x.fromId === fromUserId && x.toId === user.id);
  if (!t) throw invalid('TA 不需要转钱给你');
  setTransferStatus(db, eventId, fromUserId, user.id, 'confirmed');
  if (getUser(db, fromUserId)) {
    notify(db, fromUserId, {
      type: 'aa_confirmed',
      title: 'AA 已清账',
      body: `${user.nickname} 确认收到了你的 ¥${t.amount}`,
      link: `chat:${eventId}`,
    });
  }
  return aaView(db, user, eventId);
}

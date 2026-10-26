// AA 记账：平台不经手钱，只算账（docs/api.md 3.7）。金额内部按「分」计算，避免浮点误差。
// 每个局只有一笔 AA：由一个成员把总花费一次性记下（可写包含哪些），其他人按人数平摊转给 TA。
// 记了就锁定，不能再加第二笔；记账人在还没人点「我已转账」之前可以改或撤回。
import { clock } from '../clock.js';
import { blocked, conflict, forbidden, invalid } from '../errors.js';
import { checkText } from '../moderation.js';
import { num, str } from '../validate.js';
import { joinedMembers, memberRow, requireEvent, shortTitle } from './events.js';
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

export function getBill(db, eventId) {
  return db.get('SELECT * FROM aa_bills WHERE event_id = ?', eventId) || null;
}

/** 有人点过「我已转账」（或收款人已经确认收到）之后，账单就不能再改 / 撤回 */
function anyTransferMarked(db, eventId) {
  return Boolean(db.get('SELECT 1 FROM aa_transfers WHERE event_id = ? LIMIT 1', eventId));
}

/** 汇总：账单、总额、每人、转账（含状态） */
export function aaSummary(db, event, viewerId) {
  const bill = getBill(db, event.id);
  const members = joinedMembers(db, event.id).map((m) => m.user_id);
  const totalCents = bill ? toCents(bill.amount) : 0;
  const eachCents = members.length ? Math.round(totalCents / members.length) : 0;

  const balances = new Map(members.map((id) => [id, -eachCents]));
  // 记账人如果已经退出，不再分摊，但仍然要拿回垫付的钱
  if (bill) balances.set(bill.payer_id, (balances.get(bill.payer_id) ?? 0) + totalCents);
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
  return { bill, total: toYuan(totalCents), each: toYuan(eachCents), memberCount: members.length, transfers };
}

function requireAaMember(db, user, eventId) {
  const event = requireEvent(db, eventId);
  const mine = memberRow(db, eventId, user.id);
  if (!mine || mine.status !== 'joined') throw forbidden('加入这个局后才能记账');
  return event;
}

const closed = (event) => ['cancelled', 'rejected'].includes(event.status);

export function aaView(db, user, eventId) {
  const event = requireAaMember(db, user, eventId);
  const summary = aaSummary(db, event, user.id);
  const cache = new Map();
  const brief = (id) => {
    if (!cache.has(id)) cache.set(id, userBrief(db, id));
    return cache.get(id);
  };
  const { bill } = summary;
  const mine = Boolean(bill && bill.payer_id === user.id);
  return {
    bill: bill
      ? {
          payer: brief(bill.payer_id),
          amount: toYuan(toCents(bill.amount)),
          note: bill.note || null,
          createdAt: bill.created_at,
          mine,
          editable: mine && !closed(event) && !anyTransferMarked(db, eventId),
        }
      : null,
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
    canDeclare: !bill && !closed(event),
  };
}

/** {amount, note?}：金额 0.01–100000，最多两位小数；note 写包含哪些（≤ 40 字，过内容审核） */
function parseBill(body) {
  const amount = num(body?.amount, '金额', { min: 0.01, max: 100000 });
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) throw invalid('金额最多保留两位小数');
  const note = str(body?.note, '说明', { max: 40, optional: true }) || null;
  if (note) {
    const check = checkText(note);
    if (!check.ok) throw blocked('AA 说明里不能有联系方式或广告', check.reasons);
  }
  return { amount: toYuan(toCents(amount)), note };
}

const money = (yuan) => `¥${Number(yuan)}`;

/** 通知其他成员：「阿野 记了这个局的 AA：共 ¥150（车费 + 早餐），每人 ¥30，转给阿野」 */
function notifyBill(db, event, payer, verb) {
  const summary = aaSummary(db, event, payer.id);
  const bill = summary.bill;
  const body = bill
    ? `${payer.nickname} ${verb}这个局的 AA：共 ${money(summary.total)}${bill.note ? `（${bill.note}）` : ''}，每人 ${money(summary.each)}，转给${payer.nickname}`
    : `${payer.nickname} 撤回了这个局的 AA`;
  for (const m of joinedMembers(db, event.id)) {
    if (m.user_id === payer.id) continue;
    notify(db, m.user_id, {
      type: 'aa_bill',
      title: `AA 记账 · ${shortTitle(event.title)}`,
      body,
      link: `chat:${event.id}`,
    });
  }
}

/** 声明 AA：任何已加入的成员，每个局只能一次 */
export function declareBill(db, user, eventId, body) {
  return db.tx(() => {
    const event = requireAaMember(db, user, eventId);
    if (closed(event)) throw invalid('这个局已经取消了');
    if (getBill(db, eventId)) throw conflict('这个局已经有人记过 AA 了');
    const { amount, note } = parseBill(body);
    const now = clock.iso();
    db.insert('aa_bills', { event_id: eventId, payer_id: user.id, amount, note, created_at: now, updated_at: now });
    notifyBill(db, event, user, '记了');
    return aaView(db, user, eventId);
  });
}

/** 只有记账人，且还没人点过「我已转账」 */
function requireEditableBill(db, user, event) {
  const bill = getBill(db, event.id);
  if (!bill) throw conflict('这个局还没有记 AA');
  if (bill.payer_id !== user.id) throw forbidden('只有记账的人可以修改');
  if (closed(event)) throw invalid('这个局已经取消了');
  if (anyTransferMarked(db, event.id)) throw conflict('已经有人转账了，不能再改');
  return bill;
}

export function updateBill(db, user, eventId, body) {
  return db.tx(() => {
    const event = requireAaMember(db, user, eventId);
    requireEditableBill(db, user, event);
    const { amount, note } = parseBill(body);
    db.run('UPDATE aa_bills SET amount = ?, note = ?, updated_at = ? WHERE event_id = ?', amount, note, clock.iso(), eventId);
    notifyBill(db, event, user, '改了');
    return aaView(db, user, eventId);
  });
}

export function deleteBill(db, user, eventId) {
  return db.tx(() => {
    const event = requireAaMember(db, user, eventId);
    requireEditableBill(db, user, event);
    db.run('DELETE FROM aa_bills WHERE event_id = ?', eventId);
    notifyBill(db, event, user, '撤回了');
    return aaView(db, user, eventId);
  });
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

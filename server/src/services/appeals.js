// 信用记录申诉：用户提交，后台通过后该记录 revoked=1。
import { clock, HOUR } from '../clock.js';
import { conflict, invalid, notFound } from '../errors.js';
import { oneOf, str } from '../validate.js';
import { creditEventView } from './credit.js';
import { notify } from './notices.js';
import { userBrief } from './users.js';

const APPEALABLE = ['late', 'cancel_late', 'no_show'];
const EVIDENCE_WINDOW = 72 * HOUR;

export function createAppeal(db, user, creditEventId, body) {
  const ce = db.get('SELECT * FROM credit_events WHERE id = ?', creditEventId);
  if (!ce || ce.user_id !== user.id) throw notFound('信用记录不存在');
  if (ce.revoked) throw conflict('这条记录已经撤销了');
  if (!APPEALABLE.includes(ce.type)) throw invalid('这条记录不需要申诉');
  const text = str(body?.text, '申诉理由', { min: 5, max: 500 });
  const pending = db.get("SELECT id FROM appeals WHERE credit_event_id = ? AND status = 'pending'", creditEventId);
  if (pending) throw conflict('这条记录已经在申诉中了');
  const id = db.insert('appeals', {
    user_id: user.id,
    credit_event_id: creditEventId,
    text,
    status: 'pending',
    created_at: clock.iso(),
  });
  return { id, status: 'pending' };
}

/**
 * 申诉的佐证：申诉人自己在那个局里、开场前 72 小时到开场之间发过的群聊消息
 * （比如「发烧了去不了」），帮后台判断是不是提前说过。记录不关联局时为空。
 */
function appealEvidence(db, a, ce) {
  if (!ce?.event_id) return [];
  const event = db.get('SELECT start_at FROM events WHERE id = ?', ce.event_id);
  if (!event) return [];
  const start = Date.parse(event.start_at);
  return db
    .all(
      `SELECT * FROM messages WHERE event_id = ? AND user_id = ? AND kind = 'text' AND created_at >= ? AND created_at <= ?
       ORDER BY id`,
      ce.event_id,
      a.user_id,
      new Date(start - EVIDENCE_WINDOW).toISOString(),
      event.start_at,
    )
    .map((m) => ({
      text: m.text,
      createdAt: m.created_at,
      hoursBeforeStart: Math.round(((start - Date.parse(m.created_at)) / HOUR) * 10) / 10,
    }));
}

export function appealView(db, a) {
  const ce = db.get(
    'SELECT c.*, e.title AS event_title FROM credit_events c LEFT JOIN events e ON e.id = c.event_id WHERE c.id = ?',
    a.credit_event_id,
  );
  return {
    id: a.id,
    user: userBrief(db, a.user_id),
    creditEvent: ce ? creditEventView(ce) : null,
    text: a.text,
    evidence: appealEvidence(db, a, ce),
    status: a.status,
    adminNote: a.admin_note,
    createdAt: a.created_at,
    resolvedAt: a.resolved_at,
  };
}

export function listAppeals(db, status = 'pending') {
  oneOf(status, '状态筛选', ['pending', 'approved', 'rejected', 'all']);
  const rows =
    status === 'all'
      ? db.all('SELECT * FROM appeals ORDER BY id DESC LIMIT 200')
      : db.all('SELECT * FROM appeals WHERE status = ? ORDER BY id DESC LIMIT 200', status);
  return { items: rows.map((a) => appealView(db, a)) };
}

export function resolveAppeal(db, id, { approve, note = null }) {
  return db.tx(() => {
    const a = db.get('SELECT * FROM appeals WHERE id = ?', id);
    if (!a) throw notFound('申诉不存在');
    if (a.status !== 'pending') throw conflict('这条申诉已经处理过了');
    if (typeof approve !== 'boolean') throw invalid('请选择通过或驳回');
    db.update('appeals', id, {
      status: approve ? 'approved' : 'rejected',
      admin_note: note,
      resolved_at: clock.iso(),
    });
    if (approve) db.update('credit_events', a.credit_event_id, { revoked: 1 });
    notify(db, a.user_id, {
      type: 'appeal_result',
      title: approve ? '申诉通过了' : '申诉没有通过',
      body: approve ? `这条记录已撤销，你的履约率已经更新${note ? `。${note}` : ''}` : note || '经核实，这条记录维持不变',
      link: 'credit',
    });
    return appealView(db, db.get('SELECT * FROM appeals WHERE id = ?', id));
  });
}

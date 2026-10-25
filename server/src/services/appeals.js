// 信用记录申诉：用户提交，后台通过后该记录 revoked=1。
import { clock } from '../clock.js';
import { conflict, invalid, notFound } from '../errors.js';
import { str } from '../validate.js';
import { creditEventView } from './credit.js';
import { notify } from './notices.js';
import { userBrief } from './users.js';

const APPEALABLE = ['late', 'cancel_late', 'no_show'];

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
    status: a.status,
    adminNote: a.admin_note,
    createdAt: a.created_at,
    resolvedAt: a.resolved_at,
  };
}

export function listAppeals(db, status = 'pending') {
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
      body: approve ? '这条记录已撤销，你的履约率已经更新' : note || '经核实，这条记录维持不变',
      link: 'credit',
    });
    return appealView(db, db.get('SELECT * FROM appeals WHERE id = ?', id));
  });
}

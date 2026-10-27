// 官方带队：用户报名（需手机号认证 + 资质说明/图片）→ 后台审核 → 通过即成为官方带队（users.is_leader）。
import { clock } from '../clock.js';
import { json } from '../db.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { parseImages } from '../urls.js';
import { str } from '../validate.js';
import { notify } from './notices.js';
import { getUser, userBrief } from './users.js';

function applicationView(row) {
  return {
    id: row.id,
    intro: row.intro,
    images: json.parse(row.images, []),
    status: row.status, // pending / approved / rejected
    note: row.note ?? null,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at ?? null,
  };
}

/** 我的带队状态：是否已是带队 + 最近一条申请（给小程序「申请成为官方带队」页用） */
export function myLeaderStatus(db, user) {
  const row = db.get('SELECT * FROM leader_applications WHERE user_id = ? ORDER BY id DESC LIMIT 1', user.id);
  return { isLeader: Boolean(user.is_leader), application: row ? applicationView(row) : null };
}

/** 申请成为官方带队：要先完成手机号认证；一次只能有一个待审核的申请；已是带队不用再申请 */
export function applyLeader(db, user, body = {}) {
  if (user.is_leader) throw conflict('你已经是官方带队了');
  if (!user.phone_verified) throw forbidden('先完成手机号认证，才能申请成为官方带队');
  const intro = str(body.intro, '自我介绍 / 带队经验', { min: 10, max: 500 });
  const images = parseImages(body.images, { max: 9 });
  return db.tx(() => {
    if (db.get("SELECT 1 FROM leader_applications WHERE user_id = ? AND status = 'pending'", user.id)) {
      throw conflict('你有一个申请正在审核中，请耐心等待');
    }
    db.insert('leader_applications', {
      user_id: user.id,
      intro,
      images: JSON.stringify(images),
      status: 'pending',
      created_at: clock.iso(),
    });
    return myLeaderStatus(db, getUser(db, user.id));
  });
}

/** 后台：带队申请列表（默认只看待审核；all 看全部，待审核在前） */
export function listLeaderApplications(db, status = 'pending') {
  const rows = db.all(
    status === 'all'
      ? "SELECT * FROM leader_applications ORDER BY status = 'pending' DESC, id DESC LIMIT 300"
      : 'SELECT * FROM leader_applications WHERE status = ? ORDER BY id DESC LIMIT 300',
    ...(status === 'all' ? [] : [status]),
  );
  return { items: rows.map((r) => ({ ...applicationView(r), user: userBrief(db, getUser(db, r.user_id)) })) };
}

/** 后台：通过 / 驳回带队申请。通过即置 users.is_leader = 1，并通知本人 */
export function reviewLeaderApplication(db, id, approve, note = null) {
  return db.tx(() => {
    const row = db.get('SELECT * FROM leader_applications WHERE id = ?', id);
    if (!row) throw notFound('申请不存在');
    if (row.status !== 'pending') throw conflict('这条申请已经处理过了');
    db.update('leader_applications', row.id, {
      status: approve ? 'approved' : 'rejected',
      note: note || null,
      reviewed_at: clock.iso(),
    });
    if (approve) db.update('users', row.user_id, { is_leader: 1 });
    notify(db, row.user_id, {
      type: 'leader_result',
      title: approve ? '恭喜，你已成为官方带队' : '带队申请未通过',
      body: approve
        ? '现在可以带队组织官方局了，去发起一个吧'
        : `这次带队申请没通过${note ? `：${note}` : ''}。完善资料后可以再申请。`,
      link: null,
    });
    return { ok: true, status: approve ? 'approved' : 'rejected' };
  });
}

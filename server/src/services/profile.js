// 我的资料、安全设置、他人主页。
import { clock, DAY } from '../clock.js';
import { CREDIT_TYPE_LABELS } from '../constants.js';
import { json } from '../db.js';
import { blocked, invalid } from '../errors.js';
import { checkAll } from '../moderation.js';
import { dateLabel } from '../time.js';
import { absUrl, storeUrl, uploadPath } from '../urls.js';
import { bool, oneOf, str, strArray } from '../validate.js';
import { creditOf, effectiveStatus } from './credit.js';
import { phaseOf } from './events.js';
import { coverKeyFor } from './tags.js';
import { ongoingCount } from './myEvents.js';
import {
  avatarText,
  blockedList,
  maskPhone,
  requireUserRow,
  userBrief,
  userSettings,
} from './users.js';

export const PHONE_RE = /^1[3-9]\d{9}$/;

/** 主页背景：自己上传的图；没传就用第一个兴趣对应的插画（没有兴趣用洱海） */
function coverFields(db, user) {
  const first = json.parse(user.interests, [])[0];
  return {
    coverUrl: absUrl(db, user.cover_url) ?? null,
    coverKey: first ? coverKeyFor(db, first, 'outdoor') : 'lake',
  };
}

/** Me */
export function meView(db, user) {
  const brief = userBrief(db, user);
  return {
    id: user.id,
    nickname: user.nickname,
    avatarUrl: brief.avatarUrl,
    avatarText: brief.avatarText,
    avatarColor: brief.avatarColor,
    bio: user.bio,
    gender: user.gender,
    pace: user.pace,
    interests: json.parse(user.interests, []),
    phoneVerified: Boolean(user.phone_verified),
    idVerified: Boolean(user.id_verified),
    status: effectiveStatus(user),
    onboarded: Boolean(user.onboarded),
    credit: creditOf(db, user),
    ongoingCount: ongoingCount(db, user),
    // 补充字段
    phoneMasked: maskPhone(user.phone),
    restrictedUntil: effectiveStatus(user) === 'restricted' ? user.restricted_until : null,
    ...coverFields(db, user),
  };
}

export function updateMe(db, user, body = {}) {
  const patch = {};
  if (body.nickname !== undefined) patch.nickname = str(body.nickname, '昵称', { min: 1, max: 12 });
  if (body.bio !== undefined) patch.bio = str(body.bio ?? '', '简介', { max: 60, optional: true }) ?? '';
  if (body.avatarUrl !== undefined) {
    const url = str(body.avatarUrl, '头像', { max: 500, optional: true });
    if (url && !/^(https?:\/\/|\/uploads\/)/.test(url)) throw invalid('头像地址不正确');
    patch.avatar_url = url ? storeUrl(url) : null; // 本站上传的存相对路径
  }
  if (body.coverUrl !== undefined) {
    // 只收本站上传的图片；传 null / 空串恢复默认背景
    if (body.coverUrl === null || body.coverUrl === '') patch.cover_url = null;
    else {
      const p = uploadPath(body.coverUrl);
      if (!p) throw invalid('背景图地址不正确，请先上传');
      patch.cover_url = p;
    }
  }
  if (body.gender !== undefined) {
    patch.gender = oneOf(body.gender, '性别', ['female', 'male', 'unknown']);
    // 开了「只参加同性局」就不能把性别改回未填，否则会被撮合静默排除（与 updateSafety 的校验对称）
    if (patch.gender === 'unknown' && userSettings(user).sameSexOnly) {
      throw invalid('开了「只参加同性局」，先去安全设置里关掉才能把性别改回未填');
    }
  }
  if (body.pace !== undefined) patch.pace = oneOf(body.pace, '社交节奏', ['slow', 'warm', 'open']);
  if (body.interests !== undefined) {
    patch.interests = JSON.stringify(strArray(body.interests, '兴趣', { maxItems: 12, maxLen: 10 }));
  }
  if (body.onboarded !== undefined) patch.onboarded = bool(body.onboarded, '引导状态');

  const check = checkAll(patch.nickname, patch.bio);
  if (!check.ok) throw blocked('昵称或简介里不能有联系方式、广告或不当内容', check.reasons);
  db.update('users', user.id, patch);
  return meView(db, requireUserRow(db, user.id));
}

export function safetyView(db, user) {
  const settings = userSettings(user);
  const contact = json.parse(user.emergency_contact, null);
  return {
    sameSexOnly: settings.sameSexOnly,
    checkInReminder: settings.checkInReminder,
    profileOpen: settings.profileOpen,
    emergencyContact: contact ? { name: contact.name, phoneMasked: maskPhone(contact.phone) } : null,
    blocked: blockedList(db, user.id),
  };
}

export function updateSafety(db, user, body = {}) {
  const settings = userSettings(user);
  const labels = { sameSexOnly: '只参加同性局', checkInReminder: '报平安提醒', profileOpen: '主页可见' };
  for (const [key, label] of Object.entries(labels)) {
    const v = bool(body[key], label, { optional: true });
    if (v !== null) settings[key] = v;
  }
  if (settings.sameSexOnly && !['female', 'male'].includes(user.gender) && body.sameSexOnly === true) {
    throw invalid('先在资料里填写性别，才能只参加同性局');
  }
  const patch = { settings: JSON.stringify(settings) };
  if (body.emergencyContact !== undefined) {
    if (body.emergencyContact === null) {
      patch.emergency_contact = null;
    } else {
      const name = str(body.emergencyContact?.name, '紧急联系人称呼', { min: 1, max: 12 });
      const phone = str(body.emergencyContact?.phone, '紧急联系人手机号', { min: 11, max: 11 });
      if (!PHONE_RE.test(phone)) throw invalid('紧急联系人手机号格式不正确');
      patch.emergency_contact = JSON.stringify({ name, phone });
    }
  }
  db.update('users', user.id, patch);
  return safetyView(db, requireUserRow(db, user.id));
}

// ---- 他人主页 ----

/** 两个人一起加入过的局 */
function sharedEventIds(db, a, b) {
  return db
    .all(
      `SELECT m1.event_id FROM event_members m1 JOIN event_members m2 ON m1.event_id = m2.event_id
       WHERE m1.user_id = ? AND m2.user_id = ? AND m1.joined_at IS NOT NULL AND m2.joined_at IS NOT NULL
       AND m1.status IN ('joined', 'left') AND m2.status IN ('joined', 'left')`,
      a,
      b,
    )
    .map((r) => r.event_id);
}

const PACE_POINTS = { slow: '都偏安静', warm: '都是熟了就话多', open: '都随时能聊' };

function agoLabel(iso, now) {
  const days = Math.floor((now.getTime() - Date.parse(iso)) / DAY);
  if (days < 1) return '今天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

/** 信用说明：「最近一次临时鸽是 3 个月前（开场前 20 小时说去不了），没有放鸽子记录。」 */
function creditNote(db, userId, credit, now) {
  const last = db.get(
    "SELECT * FROM credit_events WHERE user_id = ? AND revoked = 0 AND type IN ('late', 'cancel_late', 'no_show') ORDER BY created_at DESC LIMIT 1",
    userId,
  );
  if (!last) return null;
  const note = last.note && !last.note.startsWith('历史记录') ? `（${last.note}）` : '';
  const tail = credit.noShow === 0 ? '，没有放鸽子记录' : '';
  const ago = agoLabel(last.created_at, now);
  return `最近一次${CREDIT_TYPE_LABELS[last.type]}是${/^\d/.test(ago) ? ' ' : ''}${ago}${note}${tail}。`;
}

function commonPoints(db, me, other, shared) {
  const points = [];
  const mine = json.parse(me.interests, []);
  const theirs = json.parse(other.interests, []);
  for (const x of mine.filter((i) => theirs.includes(i)).slice(0, 2)) points.push(`都喜欢${x}`);
  if (me.pace && me.pace === other.pace) points.push(PACE_POINTS[me.pace]);
  if (shared.length) points.push(`一起参加过 ${shared.length} 个局`);
  return points;
}

export function publicProfile(db, viewer, targetId) {
  const target = requireUserRow(db, targetId);
  const isMe = viewer.id === target.id;
  const shared = isMe ? [] : sharedEventIds(db, viewer.id, target.id);
  const blockedByMe = Boolean(db.get('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?', viewer.id, target.id));
  const brief = userBrief(db, target);
  const credit = creditOf(db, target);
  const profileHidden = !isMe && !userSettings(target).profileOpen && shared.length === 0;
  if (profileHidden) {
    return {
      user: {
        id: target.id,
        nickname: target.nickname,
        avatarUrl: null,
        avatarText: avatarText(target.nickname),
        avatarColor: brief.avatarColor,
        creditRate: credit.rate,
        creditLevel: credit.level,
        bio: null,
        interests: [],
        phoneVerified: false,
        idVerified: false,
        coverUrl: null,
        coverKey: 'lake',
      },
      credit: { rate: credit.rate },
      creditNote: null,
      commonPoints: [],
      recentEvents: [],
      blockedByMe,
      profileHidden: true,
    };
  }
  const now = clock.now();
  const recent = db
    .all(
      `SELECT e.* FROM event_members m JOIN events e ON e.id = m.event_id
       WHERE m.user_id = ? AND m.status = 'joined' AND e.status IN ('open', 'formed')
       ORDER BY e.start_at DESC LIMIT 20`,
      target.id,
    )
    .filter((e) => {
      const sharedWithMe = shared.includes(e.id);
      // 撮合局只有成员能看到（README「可见性」）：没一起参加过的撮合局一律不展示，已结束的也不例外
      return sharedWithMe || e.source !== 'matched';
    })
    .slice(0, 5)
    .map((e) => ({
      id: e.id,
      title: e.title,
      dateLabel: dateLabel(new Date(e.start_at), now),
      sharedWithMe: shared.includes(e.id),
      ended: phaseOf(e, now) === 'ended',
    }));
  return {
    user: {
      ...brief,
      bio: target.bio,
      interests: json.parse(target.interests, []),
      phoneVerified: Boolean(target.phone_verified),
      idVerified: Boolean(target.id_verified),
      ...coverFields(db, target),
    },
    credit,
    creditNote: creditNote(db, target.id, credit, now),
    commonPoints: isMe ? [] : commonPoints(db, viewer, target, shared),
    recentEvents: recent,
    blockedByMe,
    profileHidden: false,
  };
}

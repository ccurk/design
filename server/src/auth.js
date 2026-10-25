// 鉴权：用户 token（sessions 表）和后台 token（admin_sessions 表）互不通用。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { clock, DAY } from './clock.js';
import { forbidden, unauthorized } from './errors.js';

const USER_TTL = 30 * DAY;
const ADMIN_TTL = 7 * DAY;

export function createSession(db, userId) {
  const token = `u_${randomBytes(24).toString('hex')}`;
  const now = clock.now();
  db.insert('sessions', {
    token,
    user_id: userId,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + USER_TTL).toISOString(),
  });
  return token;
}

export function createAdminSession(db) {
  const token = `a_${randomBytes(24).toString('hex')}`;
  const now = clock.now();
  db.insert('admin_sessions', {
    token,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ADMIN_TTL).toISOString(),
  });
  return token;
}

export function bearer(req) {
  const header = req.get('authorization') || '';
  const m = header.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

/** 用户鉴权中间件；optional=true 时未登录 / token 无效也放行（req.user 为 null） */
export function requireUser(db, { optional = false } = {}) {
  return (req, res, next) => {
    req.user = null;
    const token = bearer(req);
    if (!token) {
      if (optional) return next();
      throw unauthorized('请先登录');
    }
    const session = db.get('SELECT * FROM sessions WHERE token = ?', token);
    if (!session || session.expires_at <= clock.iso()) {
      if (optional) return next();
      throw unauthorized('登录已过期，请重新登录');
    }
    const user = db.get('SELECT * FROM users WHERE id = ?', session.user_id);
    if (!user) throw unauthorized('登录已过期，请重新登录');
    if (user.status === 'banned') throw forbidden('账号已被封禁');
    req.user = user;
    next();
  };
}

export function requireAdmin(db) {
  return (req, res, next) => {
    const token = bearer(req);
    const session = token && db.get('SELECT * FROM admin_sessions WHERE token = ?', token);
    if (!session || session.expires_at <= clock.iso()) throw unauthorized('请先登录后台');
    next();
  };
}

/** 后台密码比较（定长哈希后做时间安全比较） */
export function checkPassword(input, expected) {
  if (typeof input !== 'string' || !expected) return false;
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

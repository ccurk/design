// 后台接口 /api/admin/*（后台 token，用户 token 不能调用）。
import { Router } from 'express';
import { checkPassword, createAdminSession, requireAdmin } from '../auth.js';
import { clock, MINUTE } from '../clock.js';
import { invalid, tooMany, unauthorized } from '../errors.js';
import { bool, int, str } from '../validate.js';
import {
  adjustCredit,
  adminBan,
  adminCancelEvent,
  adminEventDetail,
  adminListEvents,
  adminListUsers,
  adminRestrict,
  adminUnban,
  adminUserDetail,
  reviewUserEvent,
  stats,
} from '../services/admin.js';
import { listAppeals, resolveAppeal } from '../services/appeals.js';
import { createPlatformEvent } from '../services/events.js';
import { confirmProposal } from '../services/invites.js';
import {
  adjustProposalMembers,
  listPoolIntents,
  listProposals,
  rejectProposal,
  runMatching,
} from '../services/matching.js';
import { adminListPosts, moderatePost } from '../services/posts.js';
import { adminListReports, resolveReport } from '../services/reports.js';
import { allSettings, setSetting } from '../services/settings.js';
import { body, pid } from './util.js';

const statusQuery = (req, fallback) => (req.query.status ? String(req.query.status) : fallback);
const note = (req) => str(body(req).note, '备注', { max: 200, optional: true });

const LOGIN_WINDOW = 15 * MINUTE;
const LOGIN_MAX_FAILS = 10;

/** 后台登录防暴力猜密码：同一个 IP 在 15 分钟内输错 10 次，就锁到这 15 分钟结束 */
function loginGuard() {
  const fails = new Map(); // ip -> { count, until }
  return {
    lockedMinutes(ip) {
      const f = fails.get(ip);
      const now = clock.now().getTime();
      return f && f.until > now && f.count >= LOGIN_MAX_FAILS ? Math.ceil((f.until - now) / MINUTE) : 0;
    },
    fail(ip) {
      const now = clock.now().getTime();
      const f = fails.get(ip);
      if (f && f.until > now) f.count += 1;
      else fails.set(ip, { count: 1, until: now + LOGIN_WINDOW });
      if (fails.size > 1000) for (const [k, v] of fails) if (v.until <= now) fails.delete(k);
    },
    clear(ip) {
      fails.delete(ip);
    },
  };
}

export function adminRoutes({ db, config }) {
  const r = Router();
  const guard = loginGuard();

  r.post('/login', (req, res) => {
    const locked = guard.lockedMinutes(req.ip);
    if (locked) throw tooMany(`密码输错太多次了，请 ${locked} 分钟后再试`);
    if (!checkPassword(body(req).password, config.adminPassword)) {
      guard.fail(req.ip);
      throw unauthorized('密码不对');
    }
    guard.clear(req.ip);
    res.json({ token: createAdminSession(db) });
  });

  r.use(requireAdmin(db));

  r.get('/stats', (req, res) => res.json(stats(db)));

  // 撮合
  r.get('/proposals', (req, res) => res.json(listProposals(db, statusQuery(req, 'pending'))));
  r.post('/proposals/:id/confirm', (req, res) => res.json(confirmProposal(db, pid(req), body(req))));
  r.post('/proposals/:id/reject', (req, res) => res.json(rejectProposal(db, pid(req), note(req))));
  r.post('/proposals/:id/members', (req, res) => {
    const { remove = [], add = [] } = body(req);
    const toIds = (list) => (Array.isArray(list) ? list.map(Number) : list);
    res.json(adjustProposalMembers(db, pid(req), { remove: toIds(remove), add: toIds(add) }));
  });
  r.get('/intents', (req, res) => res.json(listPoolIntents(db, statusQuery(req, 'open'))));
  r.post('/match/run', (req, res) => res.json(runMatching(db)));
  r.get('/settings', (req, res) => res.json(allSettings(db)));
  r.put('/settings', (req, res) => {
    const { autoConfirm } = body(req);
    if (autoConfirm !== undefined) {
      if (!autoConfirm || typeof autoConfirm !== 'object') throw invalid('autoConfirm 格式不正确');
      const current = allSettings(db).autoConfirm;
      setSetting(db, 'autoConfirm', {
        enabled: bool(autoConfirm.enabled, '是否开启', { optional: true }) ?? current.enabled,
        threshold: int(autoConfirm.threshold, '阈值', { min: 0, max: 100, optional: true }) ?? current.threshold,
      });
    }
    res.json(allSettings(db));
  });

  // 局
  r.get('/events', (req, res) =>
    res.json(
      adminListEvents(db, {
        status: req.query.status ? String(req.query.status) : null,
        source: req.query.source ? String(req.query.source) : null,
        q: req.query.q ? String(req.query.q).trim() : null,
      }),
    ),
  );
  r.get('/events/:id', (req, res) => res.json(adminEventDetail(db, pid(req))));
  r.post('/events', (req, res) => res.json({ eventId: createPlatformEvent(db, body(req)).id }));
  r.post('/events/:id/approve', (req, res) => res.json(reviewUserEvent(db, pid(req), true, note(req))));
  r.post('/events/:id/reject', (req, res) => res.json(reviewUserEvent(db, pid(req), false, note(req))));
  r.post('/events/:id/cancel', (req, res) => res.json(adminCancelEvent(db, pid(req), body(req).reason)));

  // 举报、动态、申诉
  r.get('/reports', (req, res) => res.json(adminListReports(db, statusQuery(req, 'pending'))));
  r.post('/reports/:id/resolve', (req, res) =>
    res.json(resolveReport(db, pid(req), { action: body(req).action, note: note(req) })),
  );
  r.get('/posts', (req, res) => res.json(adminListPosts(db, statusQuery(req, 'pending'))));
  r.post('/posts/:id/approve', (req, res) => res.json(moderatePost(db, pid(req), true, note(req))));
  r.post('/posts/:id/reject', (req, res) => res.json(moderatePost(db, pid(req), false, note(req))));
  r.get('/appeals', (req, res) => res.json(listAppeals(db, statusQuery(req, 'pending'))));
  r.post('/appeals/:id/resolve', (req, res) =>
    res.json(resolveAppeal(db, pid(req), { approve: body(req).approve, note: note(req) })),
  );

  // 用户
  r.get('/users', (req, res) =>
    res.json(
      adminListUsers(db, {
        q: req.query.q ? String(req.query.q).trim() : null,
        level: req.query.level ? String(req.query.level) : null,
        status: req.query.status ? String(req.query.status) : null,
      }),
    ),
  );
  r.get('/users/:id', (req, res) => res.json(adminUserDetail(db, pid(req))));
  r.post('/users/:id/credit', (req, res) => res.json(adjustCredit(db, pid(req), body(req))));
  r.post('/users/:id/restrict', (req, res) => res.json(adminRestrict(db, pid(req), body(req))));
  r.post('/users/:id/ban', (req, res) => res.json(adminBan(db, pid(req), body(req))));
  r.post('/users/:id/unban', (req, res) => res.json(adminUnban(db, pid(req))));

  return r;
}

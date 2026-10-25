// 后台接口 /api/admin/*（后台 token，用户 token 不能调用）。
import { Router } from 'express';
import { checkPassword, createAdminSession, requireAdmin } from '../auth.js';
import { invalid, unauthorized } from '../errors.js';
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

export function adminRoutes({ db, config }) {
  const r = Router();

  r.post('/login', (req, res) => {
    if (!checkPassword(body(req).password, config.adminPassword)) throw unauthorized('密码不对');
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

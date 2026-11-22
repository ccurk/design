// 局：广场、详情、发起、报名 / 退出、轻确认、到场、群聊、AA、互评、搜索。
import { Router } from 'express';
import { requireUser } from '../auth.js';
import { invalid } from '../errors.js';
import { bool, int } from '../validate.js';
import { aaView, confirmReceived, declareBill, deleteBill, markPaid, updateBill } from '../services/aa.js';
import { eventInfo, listMessages, nextIcebreaker, postMessage, setMuted } from '../services/chat.js';
import {
  approveApplication,
  arrive,
  cancelByHost,
  createUserEvent,
  eventDetail,
  eventRanking,
  hotTerms,
  joinEvent,
  leaveEvent,
  listApplications,
  rejectApplication,
  reportSafe,
  requireVisibleEvent,
  searchEvents,
  setAttendance,
  squareList,
} from '../services/events.js';
import { declineInvite } from '../services/invites.js';
import { myEvents } from '../services/myEvents.js';
import { reviewView, submitReview } from '../services/reviews.js';
import { body, page, pid } from './util.js';

const TABS = ['ongoing', 'ended', 'created'];

export function eventRoutes({ db }) {
  const r = Router();
  const auth = requireUser(db);
  const maybeAuth = requireUser(db, { optional: true });
  const leaveDeps = { declineInvite };

  // 广场与搜索（未登录也能看）
  r.get('/events', maybeAuth, async (req, res) => {
    const category = req.query.category && req.query.category !== 'all' ? String(req.query.category) : null;
    const tag = req.query.tag ? String(req.query.tag) : null; // 按标签筛（规范化后比较）
    const source = req.query.source === 'official' || req.query.source === 'platform' ? 'platform' : null; // 只看官方
    const area = req.query.area && req.query.area !== 'all' ? String(req.query.area) : null; // 按片区
    const sort = req.query.sort ? String(req.query.sort) : undefined; // soon / new / filling
    res.json(await squareList(db, req.user, { category, tag, source, area, sort, ...page(req) }));
  });
  r.get('/search', maybeAuth, async (req, res) => res.json(await searchEvents(db, req.user, req.query.q)));
  r.get('/search/hot', async (req, res) => res.json(await hotTerms(db)));
  r.get('/events/ranking', maybeAuth, async (req, res) => res.json(await eventRanking(db, req.user))); // 本周人气榜（在 /events/:id 之前注册）

  r.get('/events/mine', auth, async (req, res) => {
    const tab = req.query.tab ? String(req.query.tab) : 'ongoing';
    if (!TABS.includes(tab)) throw invalid('tab 只能是 ongoing / ended / created');
    res.json(await myEvents(db, req.user, tab));
  });

  r.get('/events/:id', maybeAuth, async (req, res) => {
    const event = await requireVisibleEvent(db, pid(req), req.user);
    res.json(await eventDetail(db, event, req.user));
  });

  r.post('/events', auth, async (req, res) => {
    const event = await createUserEvent(db, req.user, body(req));
    res.json(await eventDetail(db, event, req.user));
  });

  r.post('/events/:id/join', auth, async (req, res) => res.json(await joinEvent(db, req.user, pid(req), body(req))));
  r.post('/events/:id/leave', auth, async (req, res) => res.json(await leaveEvent(db, req.user, pid(req), leaveDeps)));
  r.post('/events/:id/cancel', auth, async (req, res) => res.json(await cancelByHost(db, req.user, pid(req))));

  r.get('/events/:id/applications', auth, async (req, res) => res.json(await listApplications(db, req.user, pid(req))));
  r.post('/events/:id/applications/:userId/approve', auth, async (req, res) =>
    res.json(await approveApplication(db, req.user, pid(req), pid(req, 'userId'))),
  );
  r.post('/events/:id/applications/:userId/reject', auth, async (req, res) =>
    res.json(await rejectApplication(db, req.user, pid(req), pid(req, 'userId'))),
  );

  r.post('/events/:id/attendance', auth, async (req, res) => {
    const going = bool(body(req).going, '是否出席');
    res.json(await db.tx(() => setAttendance(db, req.user, pid(req), going, leaveDeps)));
  });
  r.post('/events/:id/arrive', auth, async (req, res) => res.json(await arrive(db, req.user, pid(req))));
  r.post('/events/:id/safe', auth, async (req, res) => res.json(await reportSafe(db, req.user, pid(req))));

  // 群聊
  r.get('/events/:id/messages', auth, async (req, res) => {
    const after = req.query.after === undefined ? null : int(req.query.after, 'after', { min: 0 });
    res.json(await listMessages(db, req.user, pid(req), { after }));
  });
  r.post('/events/:id/messages', auth, async (req, res) => res.json(await postMessage(db, req.user, pid(req), body(req))));
  r.post('/events/:id/icebreaker/next', auth, async (req, res) => res.json(await nextIcebreaker(db, req.user, pid(req))));
  r.get('/events/:id/info', auth, async (req, res) => res.json(await eventInfo(db, req.user, pid(req))));
  r.put('/events/:id/mute', auth, async (req, res) =>
    res.json(await setMuted(db, req.user, pid(req), bool(body(req).muted, '免打扰'))),
  );

  // AA 记账：每个局一笔，一次声明
  r.get('/events/:id/aa', auth, async (req, res) => res.json(await aaView(db, req.user, pid(req))));
  r.post('/events/:id/aa', auth, async (req, res) => res.json(await declareBill(db, req.user, pid(req), body(req))));
  r.put('/events/:id/aa', auth, async (req, res) => res.json(await updateBill(db, req.user, pid(req), body(req))));
  r.delete('/events/:id/aa', auth, async (req, res) => res.json(await deleteBill(db, req.user, pid(req))));
  r.post('/events/:id/aa/paid', auth, async (req, res) =>
    res.json(await markPaid(db, req.user, pid(req), int(body(req).toUserId, '收款人', { min: 1 }))),
  );
  r.post('/events/:id/aa/confirm', auth, async (req, res) =>
    res.json(await confirmReceived(db, req.user, pid(req), int(body(req).fromUserId, '付款人', { min: 1 }))),
  );

  // 互评
  r.get('/events/:id/review', auth, async (req, res) => res.json(await reviewView(db, req.user, pid(req))));
  r.post('/events/:id/reviews', auth, async (req, res) => res.json(await submitReview(db, req.user, pid(req), body(req))));

  return r;
}

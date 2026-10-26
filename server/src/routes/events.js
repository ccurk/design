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
  r.get('/events', maybeAuth, (req, res) => {
    const category = req.query.category && req.query.category !== 'all' ? String(req.query.category) : null;
    const tag = req.query.tag ? String(req.query.tag) : null; // 按标签筛（规范化后比较）
    res.json(squareList(db, req.user, { category, tag, ...page(req) }));
  });
  r.get('/search', maybeAuth, (req, res) => res.json(searchEvents(db, req.user, req.query.q)));
  r.get('/search/hot', (req, res) => res.json(hotTerms(db)));

  r.get('/events/mine', auth, (req, res) => {
    const tab = req.query.tab ? String(req.query.tab) : 'ongoing';
    if (!TABS.includes(tab)) throw invalid('tab 只能是 ongoing / ended / created');
    res.json(myEvents(db, req.user, tab));
  });

  r.get('/events/:id', maybeAuth, (req, res) => {
    const event = requireVisibleEvent(db, pid(req), req.user);
    res.json(eventDetail(db, event, req.user));
  });

  r.post('/events', auth, (req, res) => {
    const event = createUserEvent(db, req.user, body(req));
    res.json(eventDetail(db, event, req.user));
  });

  r.post('/events/:id/join', auth, (req, res) => res.json(joinEvent(db, req.user, pid(req))));
  r.post('/events/:id/leave', auth, (req, res) => res.json(leaveEvent(db, req.user, pid(req), leaveDeps)));
  r.post('/events/:id/cancel', auth, (req, res) => res.json(cancelByHost(db, req.user, pid(req))));

  r.get('/events/:id/applications', auth, (req, res) => res.json(listApplications(db, req.user, pid(req))));
  r.post('/events/:id/applications/:userId/approve', auth, (req, res) =>
    res.json(approveApplication(db, req.user, pid(req), pid(req, 'userId'))),
  );
  r.post('/events/:id/applications/:userId/reject', auth, (req, res) =>
    res.json(rejectApplication(db, req.user, pid(req), pid(req, 'userId'))),
  );

  r.post('/events/:id/attendance', auth, (req, res) => {
    const going = bool(body(req).going, '是否出席');
    res.json(db.tx(() => setAttendance(db, req.user, pid(req), going, leaveDeps)));
  });
  r.post('/events/:id/arrive', auth, (req, res) => res.json(arrive(db, req.user, pid(req))));
  r.post('/events/:id/safe', auth, (req, res) => res.json(reportSafe(db, req.user, pid(req))));

  // 群聊
  r.get('/events/:id/messages', auth, (req, res) => {
    const after = req.query.after === undefined ? null : int(req.query.after, 'after', { min: 0 });
    res.json(listMessages(db, req.user, pid(req), { after }));
  });
  r.post('/events/:id/messages', auth, (req, res) => res.json(postMessage(db, req.user, pid(req), body(req))));
  r.post('/events/:id/icebreaker/next', auth, (req, res) => res.json(nextIcebreaker(db, req.user, pid(req))));
  r.get('/events/:id/info', auth, (req, res) => res.json(eventInfo(db, req.user, pid(req))));
  r.put('/events/:id/mute', auth, (req, res) =>
    res.json(setMuted(db, req.user, pid(req), bool(body(req).muted, '免打扰'))),
  );

  // AA 记账：每个局一笔，一次声明
  r.get('/events/:id/aa', auth, (req, res) => res.json(aaView(db, req.user, pid(req))));
  r.post('/events/:id/aa', auth, (req, res) => res.json(declareBill(db, req.user, pid(req), body(req))));
  r.put('/events/:id/aa', auth, (req, res) => res.json(updateBill(db, req.user, pid(req), body(req))));
  r.delete('/events/:id/aa', auth, (req, res) => res.json(deleteBill(db, req.user, pid(req))));
  r.post('/events/:id/aa/paid', auth, (req, res) =>
    res.json(markPaid(db, req.user, pid(req), int(body(req).toUserId, '收款人', { min: 1 }))),
  );
  r.post('/events/:id/aa/confirm', auth, (req, res) =>
    res.json(confirmReceived(db, req.user, pid(req), int(body(req).fromUserId, '付款人', { min: 1 }))),
  );

  // 互评
  r.get('/events/:id/review', auth, (req, res) => res.json(reviewView(db, req.user, pid(req))));
  r.post('/events/:id/reviews', auth, (req, res) => res.json(submitReview(db, req.user, pid(req), body(req))));

  return r;
}

// 撮合意向与撮合结果（被邀请人）。
import { Router } from 'express';
import { requireUser } from '../auth.js';
import { cancelIntent, createIntent, intentDetail, myIntents, updateIntent } from '../services/intents.js';
import { acceptInvite, declineInvite, matchView } from '../services/invites.js';
import { runMatching } from '../services/matching.js';
import { body, pid } from './util.js';

export function matchingRoutes({ db }) {
  const r = Router();
  const auth = requireUser(db);

  r.post('/intents', auth, async (req, res) => res.json(await createIntent(db, req.user, body(req))));
  r.get('/intents/mine', auth, async (req, res) => res.json(await myIntents(db, req.user)));
  r.get('/intents/:id', auth, async (req, res) => res.json(await intentDetail(db, req.user, pid(req))));
  // wx.request 不支持 PATCH，小程序用 PUT；两个方法等价
  const update = async (req, res) => res.json(await updateIntent(db, req.user, pid(req), body(req)));
  r.put('/intents/:id', auth, update);
  r.patch('/intents/:id', auth, update);
  r.delete('/intents/:id', auth, async (req, res) => res.json(await cancelIntent(db, req.user, pid(req))));

  r.get('/matches/:eventId', auth, async (req, res) => res.json(await matchView(db, req.user, pid(req, 'eventId'))));
  r.post('/matches/:eventId/accept', auth, async (req, res) => res.json(await acceptInvite(db, req.user, pid(req, 'eventId'))));
  r.post('/matches/:eventId/decline', auth, async (req, res) => {
    const result = await declineInvite(db, req.user, pid(req, 'eventId'));
    await runMatching(db); // 意向回到撮合池后立刻重新撮合一次
    res.json(result);
  });

  return r;
}

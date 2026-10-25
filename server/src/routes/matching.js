// 撮合意向与撮合结果（被邀请人）。
import { Router } from 'express';
import { requireUser } from '../auth.js';
import { cancelIntent, createIntent, intentDetail, myIntents, updateIntent } from '../services/intents.js';
import { acceptInvite, declineInvite, matchView } from '../services/invites.js';
import { body, pid } from './util.js';

export function matchingRoutes({ db }) {
  const r = Router();
  const auth = requireUser(db);

  r.post('/intents', auth, (req, res) => res.json(createIntent(db, req.user, body(req))));
  r.get('/intents/mine', auth, (req, res) => res.json(myIntents(db, req.user)));
  r.get('/intents/:id', auth, (req, res) => res.json(intentDetail(db, req.user, pid(req))));
  r.patch('/intents/:id', auth, (req, res) => res.json(updateIntent(db, req.user, pid(req), body(req))));
  r.delete('/intents/:id', auth, (req, res) => res.json(cancelIntent(db, req.user, pid(req))));

  r.get('/matches/:eventId', auth, (req, res) => res.json(matchView(db, req.user, pid(req, 'eventId'))));
  r.post('/matches/:eventId/accept', auth, (req, res) => res.json(acceptInvite(db, req.user, pid(req, 'eventId'))));
  r.post('/matches/:eventId/decline', auth, (req, res) => res.json(declineInvite(db, req.user, pid(req, 'eventId'))));

  return r;
}

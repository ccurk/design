// 登录、我的资料、安全设置、信用记录、他人主页、拉黑 / 不看。
import { Router } from 'express';
import { clock } from '../clock.js';
import { createSession, requireUser } from '../auth.js';
import { forbidden, invalid, notFound } from '../errors.js';
import { str } from '../validate.js';
import { createAppeal } from '../services/appeals.js';
import { listCreditEvents } from '../services/credit.js';
import { meView, publicProfile, safetyView, updateMe, updateSafety } from '../services/profile.js';
import { block, getUser, maskPhone, mute, unblock, unmute } from '../services/users.js';
import { body, pid } from './util.js';

export const DEMO_OPENID = 'demo_lizi';

/** 按 openid 找用户，没有就新建 */
function findOrCreateUser(db, openid) {
  const existing = db.get('SELECT * FROM users WHERE openid = ?', openid);
  if (existing) return { user: existing, isNew: false };
  const nickname = `旅人${Math.floor(1000 + Math.random() * 9000)}`;
  const id = db.insert('users', {
    openid,
    nickname,
    bio: '',
    gender: 'unknown',
    interests: '[]',
    settings: '{}',
    status: 'active',
    onboarded: 0,
    created_at: clock.iso(),
  });
  return { user: getUser(db, id), isNew: true };
}

function loginResult(db, user, isNew) {
  if (user.status === 'banned') throw forbidden('账号已被封禁');
  return { token: createSession(db, user.id), user: meView(db, user), isNew };
}

export function accountRoutes({ db, config, wechat }) {
  const r = Router();
  const auth = requireUser(db);

  r.post('/auth/login', async (req, res) => {
    const code = str(body(req).code, '登录凭证 code', { min: 1, max: 200 });
    const { openid } = await wechat.code2Session(code);
    const { user, isNew } = findOrCreateUser(db, openid);
    res.json(loginResult(db, user, isNew));
  });

  r.post('/auth/dev-login', (req, res) => {
    if (!config.devTools) throw notFound('接口不存在');
    const { userId } = body(req);
    let user;
    let isNew = false;
    if (userId !== undefined && userId !== null) {
      user = getUser(db, Number(userId));
      if (!user) throw notFound('用户不存在');
    } else {
      user = db.get('SELECT * FROM users WHERE openid = ?', DEMO_OPENID);
      if (!user) {
        // 没跑 seed 时，现建一个演示账号「栗子」
        ({ user, isNew } = findOrCreateUser(db, DEMO_OPENID));
        db.update('users', user.id, { nickname: '栗子', bio: '慢热，但很靠谱。', gender: 'female', pace: 'slow', onboarded: 1 });
        user = getUser(db, user.id);
      }
    }
    res.json(loginResult(db, user, isNew));
  });

  r.post('/auth/phone', auth, async (req, res) => {
    const code = str(body(req).code, '手机号凭证 code', { min: 1, max: 200 });
    const { phoneNumber } = await wechat.getPhoneNumber(code);
    if (!/^1\d{10}$/.test(phoneNumber)) throw invalid('暂不支持这个手机号');
    db.update('users', req.user.id, { phone: phoneNumber, phone_verified: 1 });
    res.json({ phoneMasked: maskPhone(phoneNumber), phoneVerified: true });
  });

  r.get('/me', auth, (req, res) => res.json(meView(db, req.user)));
  r.put('/me', auth, (req, res) => res.json(updateMe(db, req.user, body(req))));
  r.get('/me/safety', auth, (req, res) => res.json(safetyView(db, req.user)));
  r.put('/me/safety', auth, (req, res) => res.json(updateSafety(db, req.user, body(req))));
  r.get('/me/credit-events', auth, (req, res) => res.json({ items: listCreditEvents(db, req.user.id) }));
  r.post('/credit-events/:id/appeal', auth, (req, res) => res.json(createAppeal(db, req.user, pid(req), body(req))));

  r.get('/users/:id', auth, (req, res) => res.json(publicProfile(db, req.user, pid(req))));
  r.post('/blocks/:userId', auth, (req, res) => res.json(block(db, req.user.id, pid(req, 'userId'))));
  r.delete('/blocks/:userId', auth, (req, res) => res.json(unblock(db, req.user.id, pid(req, 'userId'))));
  r.post('/mutes/:userId', auth, (req, res) => res.json(mute(db, req.user.id, pid(req, 'userId'))));
  r.delete('/mutes/:userId', auth, (req, res) => res.json(unmute(db, req.user.id, pid(req, 'userId'))));

  return r;
}

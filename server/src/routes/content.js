// 首页内容与标签（不需要登录；登录了按拉黑和性别过滤）。
import { Router } from 'express';
import { requireUser } from '../auth.js';
import { homeView } from '../services/home.js';
import { hotTags } from '../services/tags.js';

export function contentRoutes({ db }) {
  const r = Router();
  const maybeAuth = requireUser(db, { optional: true });

  r.get('/tags/hot', (req, res) => res.json(hotTags(db)));
  r.get('/home', maybeAuth, (req, res) => res.json(homeView(db, req.user)));

  return r;
}

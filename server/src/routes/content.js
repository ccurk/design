// 首页内容与标签（不需要登录；登录了按拉黑和性别过滤）。
import { Router } from 'express';
import { requireUser } from '../auth.js';
import { bannerDetail, clickBanner } from '../services/banners.js';
import { homeView } from '../services/home.js';
import { hotTags } from '../services/tags.js';

export function contentRoutes({ db }) {
  const r = Router();
  const maybeAuth = requireUser(db, { optional: true });

  r.get('/tags/hot', (req, res) => res.json(hotTags(db)));
  r.get('/home', maybeAuth, (req, res) => res.json(homeView(db, req.user)));

  // 轮播广告：平台内落地页 + 点击统计（都不需要登录）
  r.get('/banners/:id', (req, res) => res.json(bannerDetail(db, Number(req.params.id))));
  r.post('/banners/:id/click', (req, res) => res.json(clickBanner(db, Number(req.params.id))));

  return r;
}

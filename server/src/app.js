// createApp({ db, config? }) → Express 应用（测试和 smoke 直接用它）。
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { clock } from './clock.js';
import { loadConfig } from './config.js';
import { AppError, errorBody, internal, notFound } from './errors.js';
import { createLogger } from './logger.js';
import { accountRoutes } from './routes/account.js';
import { adminRoutes } from './routes/admin.js';
import { devRoutes } from './routes/dev.js';
import { eventRoutes } from './routes/events.js';
import { matchingRoutes } from './routes/matching.js';
import { socialRoutes } from './routes/social.js';
import { getUser } from './services/users.js';
import { createWechat } from './wechat.js';

/** 宽松的 CORS：后台和本地调试页面都能直接调 */
function cors(req, res, next) {
  res.set('Access-Control-Allow-Origin', req.get('origin') || '*');
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', req.get('access-control-request-headers') || 'Authorization, Content-Type');
  res.set('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

/** 后台前端：静态文件 + 客户端路由回退到 index.html */
function adminStatic(dir) {
  const router = express.Router();
  router.use(express.static(dir, { index: 'index.html' }));
  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (path.extname(req.path)) return res.status(404).type('text/plain; charset=utf-8').send('文件不存在');
    const index = path.join(dir, 'index.html');
    if (fs.existsSync(index)) return res.sendFile(index);
    res.status(404).type('text/plain; charset=utf-8').send('后台页面还没有构建（admin/index.html 不存在）');
  });
  return router;
}

function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    let appErr = err;
    if (!(err instanceof AppError)) {
      if (err instanceof multer.MulterError) {
        appErr = new AppError('VALIDATION', err.code === 'LIMIT_FILE_SIZE' ? '图片不能超过 5MB' : '上传失败，请重试');
      } else if (err.type === 'entity.parse.failed') {
        appErr = new AppError('VALIDATION', '请求体不是合法的 JSON');
      } else if (err.type === 'entity.too.large') {
        appErr = new AppError('VALIDATION', '请求体太大了');
      } else if (err.status === 404 || err.statusCode === 404) {
        appErr = notFound('文件不存在');
      } else if (err.status >= 400 && err.status < 500) {
        appErr = new AppError('VALIDATION', '请求不正确');
      } else {
        logger.error(`[${req.method} ${req.originalUrl}]`, err);
        appErr = internal();
      }
    }
    res.status(appErr.status).json(errorBody(appErr));
  };
}

export function createApp({ db, config = loadConfig(), logger, wechat } = {}) {
  if (!db) throw new Error('createApp 需要传入 db');
  logger ??= createLogger(config.logLevel);
  wechat ??= createWechat({ appId: config.wxAppId, secret: config.wxSecret, isProd: config.isProd, logger });
  const ctx = { db, config, logger, wechat };

  // 站内通知同时尝试发微信订阅消息（目前为占位实现）
  db.hooks.notice = (notice) => {
    const user = getUser(db, notice.userId);
    wechat.sendSubscribeMessage({ openid: user?.openid, ...notice }).catch(() => {});
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(cors);
  app.use(express.json({ limit: '1mb' }));

  const api = express.Router();
  api.get('/health', (req, res) =>
    res.json({ ok: true, time: clock.iso(), env: config.nodeEnv, wechat: wechat.configured ? 'configured' : 'dev' }),
  );
  api.use(accountRoutes(ctx));
  api.use(matchingRoutes(ctx));
  api.use(eventRoutes(ctx));
  api.use(socialRoutes(ctx));
  api.use('/admin', adminRoutes(ctx));
  if (config.devTools) api.use('/dev', devRoutes(ctx));
  api.use(() => {
    throw notFound('接口不存在');
  });
  app.use('/api', api);

  fs.mkdirSync(config.uploadDir, { recursive: true });
  app.use('/uploads', express.static(config.uploadDir, { fallthrough: false, maxAge: '7d' }));
  app.use('/admin', adminStatic(config.adminDir));
  app.get('/', (req, res) => res.redirect('/admin/'));

  app.use(errorHandler(logger));
  app.locals.ctx = ctx;
  return app;
}

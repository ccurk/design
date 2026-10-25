// 动态、举报、上传、消息中心。
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { Router } from 'express';
import multer from 'multer';
import { requireUser } from '../auth.js';
import { invalid } from '../errors.js';
import { inbox } from '../services/inbox.js';
import { markAllRead, markRead } from '../services/notices.js';
import { addComment, createPost, deletePost, listPosts, postDetail, setLike } from '../services/posts.js';
import { createReport } from '../services/reports.js';
import { body, pid } from './util.js';

const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
export const MAX_UPLOAD = 5 * 1024 * 1024;

function uploader(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: dir,
      filename: (req, file, cb) => {
        cb(null, `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}.${IMAGE_TYPES[file.mimetype]}`);
      },
    }),
    limits: { fileSize: MAX_UPLOAD, files: 1 },
    fileFilter: (req, file, cb) => {
      if (IMAGE_TYPES[file.mimetype]) cb(null, true);
      else cb(invalid('只能上传图片（jpg / png / gif / webp）'));
    },
  });
}

export function socialRoutes({ db, config }) {
  const r = Router();
  const auth = requireUser(db);
  const maybeAuth = requireUser(db, { optional: true });

  r.get('/posts', maybeAuth, (req, res) => {
    const cursor = Number(req.query.cursor);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    res.json(listPosts(db, req.user, { cursor: Number.isInteger(cursor) && cursor > 0 ? cursor : null, limit }));
  });
  r.get('/posts/:id', maybeAuth, (req, res) => res.json(postDetail(db, req.user, pid(req))));
  r.post('/posts', auth, (req, res) => res.json(createPost(db, req.user, body(req))));
  r.delete('/posts/:id', auth, (req, res) => res.json(deletePost(db, req.user, pid(req))));
  r.post('/posts/:id/like', auth, (req, res) => res.json(setLike(db, req.user, pid(req), true)));
  r.delete('/posts/:id/like', auth, (req, res) => res.json(setLike(db, req.user, pid(req), false)));
  r.post('/posts/:id/comments', auth, (req, res) => res.json(addComment(db, req.user, pid(req), body(req))));

  r.post('/reports', auth, (req, res) => res.json(createReport(db, req.user, body(req))));

  const upload = uploader(config.uploadDir);
  r.post('/upload', auth, upload.single('file'), (req, res) => {
    if (!req.file) throw invalid('请选择要上传的图片（字段名 file）');
    res.json({ url: `${config.publicBaseUrl}/uploads/${req.file.filename}` });
  });

  r.get('/inbox', auth, (req, res) => res.json(inbox(db, req.user)));
  r.post('/notices/read-all', auth, (req, res) => res.json(markAllRead(db, req.user.id)));
  r.post('/notices/:id/read', auth, (req, res) => res.json(markRead(db, req.user.id, pid(req))));

  return r;
}

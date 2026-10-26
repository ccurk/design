// 首页轮播图（后台维护）。image 存相对路径 /uploads/…，返回绝对地址；link 用通知 link 的写法，再加 square / create / feed / rules。
import { clock } from '../clock.js';
import { invalid, notFound } from '../errors.js';
import { absUrl, parseImage } from '../urls.js';
import { str } from '../validate.js';

const LINK_RE = /^((match|event|chat|review|post):[1-9]\d*|credit|square|create|feed|rules)$/;

export function bannerView(db, b, { admin = false } = {}) {
  const view = { id: b.id, image: absUrl(db, b.image), title: b.title, subtitle: b.subtitle || null, link: b.link || null };
  if (admin) Object.assign(view, { sort: b.sort, enabled: Boolean(b.enabled), createdAt: b.created_at });
  return view;
}

/** 首页用：只要开着的，按顺序 */
export function homeBanners(db) {
  return db.all('SELECT * FROM banners WHERE enabled = 1 ORDER BY sort, id').map((b) => bannerView(db, b));
}

export function adminListBanners(db) {
  return { items: db.all('SELECT * FROM banners ORDER BY sort, id').map((b) => bannerView(db, b, { admin: true })) };
}

function parseLink(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !LINK_RE.test(value.trim())) {
    throw invalid('跳转链接不正确：可以是 event:<局id>、post:<动态id>、square、create、feed、rules 等');
  }
  return value.trim();
}

function parseEnabled(value) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw invalid('是否显示格式不正确');
}

function requireBanner(db, id) {
  const b = db.get('SELECT * FROM banners WHERE id = ?', id);
  if (!b) throw notFound('轮播图不存在');
  return b;
}

const view = (db, id) => bannerView(db, requireBanner(db, id), { admin: true });

/** {image, title, subtitle?, link?, enabled?}：新的排在最后 */
export function adminCreateBanner(db, body = {}) {
  const row = {
    image: parseImage(body.image),
    title: str(body.title, '标题', { min: 1, max: 20 }),
    subtitle: str(body.subtitle, '副标题', { max: 40, optional: true }) || null,
    link: parseLink(body.link),
    enabled: body.enabled === undefined || body.enabled === null ? 1 : parseEnabled(body.enabled),
    sort: Number(db.get('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM banners').n),
    created_at: clock.iso(),
  };
  return view(db, db.insert('banners', row));
}

export function adminUpdateBanner(db, id, body = {}) {
  requireBanner(db, id);
  const patch = {};
  if (body.image !== undefined) patch.image = parseImage(body.image);
  if (body.title !== undefined) patch.title = str(body.title, '标题', { min: 1, max: 20 });
  if (body.subtitle !== undefined) patch.subtitle = str(body.subtitle, '副标题', { max: 40, optional: true }) || null;
  if (body.link !== undefined) patch.link = parseLink(body.link);
  if (body.enabled !== undefined) patch.enabled = parseEnabled(body.enabled);
  db.update('banners', id, patch);
  return view(db, id);
}

/** 排序：ids 里的按顺序排在前面，没列出的保持原来的先后排在后面 */
export function adminOrderBanners(db, ids) {
  if (!Array.isArray(ids)) throw invalid('ids 需要是数组');
  const list = ids.map(Number);
  if (list.some((x) => !Number.isInteger(x) || x <= 0)) throw invalid('ids 格式不正确');
  if (new Set(list).size !== list.length) throw invalid('ids 有重复');
  return db.tx(() => {
    for (const id of list) requireBanner(db, id);
    const rest = db
      .all('SELECT id FROM banners ORDER BY sort, id')
      .map((b) => b.id)
      .filter((id) => !list.includes(id));
    [...list, ...rest].forEach((id, i) => db.run('UPDATE banners SET sort = ? WHERE id = ?', i, id));
    return adminListBanners(db);
  });
}

export function adminDeleteBanner(db, id) {
  requireBanner(db, id);
  db.run('DELETE FROM banners WHERE id = ?', id);
  return { ok: true };
}

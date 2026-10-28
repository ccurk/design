// 首页轮播图（后台维护）。image 存相对路径 /uploads/…，返回绝对地址；link 用通知 link 的写法，再加 square / create / feed / rules。
import { clock } from '../clock.js';
import { invalid, notFound } from '../errors.js';
import { absUrl, parseImage } from '../urls.js';
import { str } from '../validate.js';

const LINK_RE = /^((match|event|chat|review|post):[1-9]\d*|credit|square|create|feed|rules)$/;

export function bannerView(db, b, { admin = false } = {}) {
  const view = {
    id: b.id,
    image: absUrl(db, b.image),
    title: b.title,
    subtitle: b.subtitle || null,
    link: b.link || null,
    promo: Boolean(b.body), // 有落地页正文 → 点击打开平台内落地页，而不是直接跳 link
  };
  if (admin) {
    Object.assign(view, {
      body: b.body || null,
      ctaLabel: b.cta_label || null,
      ctaLink: b.cta_link || null,
      startsAt: b.starts_at || null,
      endsAt: b.ends_at || null,
      impressions: b.impressions || 0,
      clicks: b.clicks || 0,
      sort: b.sort,
      enabled: Boolean(b.enabled),
      createdAt: b.created_at,
    });
  }
  return view;
}

/** 首页用：开着的、在排期内的，按顺序；每返回一次给某个人展示就记一次曝光 */
export function homeBanners(db) {
  const now = clock.iso();
  const rows = db.all(
    `SELECT * FROM banners WHERE enabled = 1
       AND (starts_at IS NULL OR starts_at <= ?)
       AND (ends_at IS NULL OR ends_at >= ?)
     ORDER BY sort, id`,
    now,
    now,
  );
  if (rows.length) {
    const marks = rows.map(() => '?').join(',');
    db.run(`UPDATE banners SET impressions = impressions + 1 WHERE id IN (${marks})`, ...rows.map((b) => b.id));
  }
  return rows.map((b) => bannerView(db, b));
}

/** 平台内广告落地页：图文 + 可选按钮（按钮跳转仍是站内 link） */
export function bannerDetail(db, id) {
  const b = requireBanner(db, id);
  return {
    id: b.id,
    image: absUrl(db, b.image),
    title: b.title,
    subtitle: b.subtitle || null,
    body: b.body || '',
    ctaLabel: b.cta_label || null,
    ctaLink: b.cta_link || null,
  };
}

/** 记一次点击（点轮播图时调用） */
export function clickBanner(db, id) {
  requireBanner(db, id);
  db.run('UPDATE banners SET clicks = clicks + 1 WHERE id = ?', id);
  return { ok: true };
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

/** 排期时间：ISO 字符串，空 = 不限 */
function parseWhen(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw invalid(`${label}格式不正确`);
  return new Date(t).toISOString();
}

function requireBanner(db, id) {
  const b = db.get('SELECT * FROM banners WHERE id = ?', id);
  if (!b) throw notFound('轮播图不存在');
  return b;
}

const view = (db, id) => bannerView(db, requireBanner(db, id), { admin: true });

/** {image, title, subtitle?, link?, body?, ctaLabel?, ctaLink?, startsAt?, endsAt?, enabled?}：新的排在最后 */
export function adminCreateBanner(db, body = {}) {
  const startsAt = parseWhen(body.startsAt, '开始时间');
  const endsAt = parseWhen(body.endsAt, '结束时间');
  if (startsAt && endsAt && endsAt < startsAt) throw invalid('结束时间要晚于开始时间');
  const row = {
    image: parseImage(body.image),
    title: str(body.title, '标题', { min: 1, max: 20 }),
    subtitle: str(body.subtitle, '副标题', { max: 40, optional: true }) || null,
    link: parseLink(body.link),
    body: str(body.body, '落地页正文', { max: 2000, optional: true }) || null,
    cta_label: str(body.ctaLabel, '按钮文案', { max: 12, optional: true }) || null,
    cta_link: parseLink(body.ctaLink),
    starts_at: startsAt,
    ends_at: endsAt,
    enabled: body.enabled === undefined || body.enabled === null ? 1 : parseEnabled(body.enabled),
    sort: Number(db.get('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM banners').n),
    created_at: clock.iso(),
  };
  return view(db, db.insert('banners', row));
}

export function adminUpdateBanner(db, id, body = {}) {
  const b = requireBanner(db, id);
  const patch = {};
  if (body.image !== undefined) patch.image = parseImage(body.image);
  if (body.title !== undefined) patch.title = str(body.title, '标题', { min: 1, max: 20 });
  if (body.subtitle !== undefined) patch.subtitle = str(body.subtitle, '副标题', { max: 40, optional: true }) || null;
  if (body.link !== undefined) patch.link = parseLink(body.link);
  if (body.body !== undefined) patch.body = str(body.body, '落地页正文', { max: 2000, optional: true }) || null;
  if (body.ctaLabel !== undefined) patch.cta_label = str(body.ctaLabel, '按钮文案', { max: 12, optional: true }) || null;
  if (body.ctaLink !== undefined) patch.cta_link = parseLink(body.ctaLink);
  if (body.startsAt !== undefined) patch.starts_at = parseWhen(body.startsAt, '开始时间');
  if (body.endsAt !== undefined) patch.ends_at = parseWhen(body.endsAt, '结束时间');
  if (body.enabled !== undefined) patch.enabled = parseEnabled(body.enabled);
  const effStarts = patch.starts_at !== undefined ? patch.starts_at : b.starts_at;
  const effEnds = patch.ends_at !== undefined ? patch.ends_at : b.ends_at;
  if (effStarts && effEnds && effEnds < effStarts) throw invalid('结束时间要晚于开始时间');
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

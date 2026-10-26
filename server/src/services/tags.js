// 标签：意向的「想做的事」（task）和局的标签（tag）是同一套自由标签（docs/api.md 3.9）。
// 名字：NFKC → 去首尾空格 → 合并连续空白；1–8 个字；只允许文字、数字、空格和 ·-_；过内容审核。
// 撮合和筛选按 key 比较（名字再把拉丁字母转小写），所以「KTV」和「ktv」是同一个标签。
import { clock, DAY } from '../clock.js';
import { CATEGORIES, categoryOfTask } from '../constants.js';
import { blocked, conflict, invalid, notFound } from '../errors.js';
import { checkText } from '../moderation.js';
import { int, oneOf } from '../validate.js';

/** 插画 key（design/illustrations/<key>.svg） */
export const COVER_KEYS = ['sunrise', 'mountain', 'cycling', 'lake', 'coffee', 'reading', 'food', 'boardgame', 'carpool', 'oldtown'];

/** 标签没设插画时按分类给的默认插画 */
export const CATEGORY_COVERS = {
  outdoor: 'mountain',
  food: 'food',
  coffee: 'coffee',
  game: 'boardgame',
  carpool: 'carpool',
  other: 'oldtown',
};

/** 默认标签：[名字, 分类, 插画, 是否热门]；热门的按这个顺序 */
export const DEFAULT_TAGS = [
  ['看日出', 'outdoor', 'sunrise', true],
  ['爬山', 'outdoor', 'mountain', true],
  ['骑行', 'outdoor', 'cycling', true],
  ['咖啡', 'coffee', 'coffee', true],
  ['吃饭', 'food', 'food', true],
  ['桌游', 'game', 'boardgame', true],
  ['拼车', 'carpool', 'carpool', true],
  ['随便走走', 'outdoor', 'oldtown', true],
  ['读书', 'coffee', 'reading', true],
  ['拍照', 'outdoor', 'lake', true],
  ['徒步', 'outdoor', 'mountain', false],
  ['早餐', 'food', 'food', false],
  ['夜市', 'food', 'food', false],
];

const MAX_CHARS = 8;
const ALLOWED = /^[\p{L}\p{M}\p{N} ·\-_]+$/u;

/** 规范化：NFKC、去首尾空格、合并连续空白 */
export function normalizeTagName(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 撮合 / 筛选用的 key：规范化后拉丁字母转小写 */
export function tagKey(name) {
  return normalizeTagName(name).toLowerCase();
}

/** 校验并返回规范化后的标签名；不合格抛 VALIDATION，审核不过抛 CONTENT_BLOCKED */
export function parseTag(raw, label = '标签') {
  if (raw === undefined || raw === null) throw invalid(`请填写${label}`);
  if (typeof raw !== 'string') throw invalid(`${label}格式不正确`);
  const name = normalizeTagName(raw);
  const chars = Array.from(name).length;
  if (chars < 1) throw invalid(`请填写${label}`);
  if (chars > MAX_CHARS) throw invalid(`${label}最多 ${MAX_CHARS} 个字`);
  if (!ALLOWED.test(name)) throw invalid(`${label}只能用文字、数字、空格和 ·-_`);
  const check = checkText(name);
  if (!check.ok) throw blocked('这个标签不能用', check.reasons);
  return name;
}

export function tagRow(db, name) {
  const key = tagKey(name);
  return key ? db.get('SELECT * FROM tags WHERE key = ?', key) || null : null;
}

/** 标签的插画：设了用设的，没设按分类 */
export function coverOf(row) {
  return row?.cover || CATEGORY_COVERS[row?.category] || CATEGORY_COVERS.other;
}

/** 标签的分类：标签表里有就用表里的，否则按内置的任务表推，都没有算 other */
export function tagCategory(db, name) {
  return tagRow(db, name)?.category ?? categoryOfTask(normalizeTagName(name));
}

/** 局卡片的 coverKey：标签的插画；标签表里没有就按局的分类 */
export function coverKeyFor(db, name, category) {
  const row = name ? tagRow(db, name) : null;
  return row ? coverOf(row) : CATEGORY_COVERS[category] || CATEGORY_COVERS.other;
}

/** 表是空的就写入默认标签（启动时、seed 时调用） */
export function ensureDefaultTags(db) {
  if (Number(db.get('SELECT COUNT(*) AS n FROM tags').n) > 0) return false;
  const now = clock.iso();
  let hotIndex = 0;
  for (const [name, category, cover, hot] of DEFAULT_TAGS) {
    db.insert('tags', {
      name,
      key: tagKey(name),
      category,
      cover,
      hot: hot ? 1 : 0,
      sort: hot ? hotIndex++ : 0,
      created_at: now,
      last_used_at: null,
    });
  }
  return true;
}

/**
 * 用到一个标签：已有就更新 last_used_at；没有就新建一条（hot=0）。
 * category 是新建时的分类提示（发起局时旧的 category 字段），不合法或没给时按内置任务表推。
 * 返回标签行（name 是标签表里的写法，比如用户输入 ktv、表里是 KTV 时返回 KTV）。
 */
export function useTag(db, name, { category = null } = {}) {
  const now = clock.iso();
  const existing = tagRow(db, name);
  if (existing) {
    db.run('UPDATE tags SET last_used_at = ? WHERE id = ?', now, existing.id);
    return { ...existing, last_used_at: now };
  }
  const clean = normalizeTagName(name);
  const id = db.insert('tags', {
    name: clean,
    key: tagKey(clean),
    category: CATEGORIES.includes(category) ? category : categoryOfTask(clean),
    cover: null,
    hot: 0,
    sort: 0,
    created_at: now,
    last_used_at: now,
  });
  return db.get('SELECT * FROM tags WHERE id = ?', id);
}

/** GET /api/tags/hot：热门标签（按后台排的顺序） */
export function hotTags(db) {
  return {
    items: db
      .all('SELECT * FROM tags WHERE hot = 1 ORDER BY sort, id')
      .map((t) => ({ name: t.name, category: t.category, cover: coverOf(t) })),
  };
}

// ---- 后台 ----

/** 每个 key 被用过的次数：撮合意向 + 用户发起的局；recent 只算 since 之后的 */
function usageCounts(db, since) {
  const counts = new Map();
  const rows = [
    ...db.all('SELECT task, created_at FROM intents'),
    ...db.all("SELECT task, created_at FROM events WHERE source = 'user' AND task IS NOT NULL"),
  ];
  for (const r of rows) {
    const key = tagKey(r.task);
    const c = counts.get(key) ?? { use: 0, recent: 0 };
    c.use++;
    if (r.created_at >= since) c.recent++;
    counts.set(key, c);
  }
  return counts;
}

function adminTagView(t, counts) {
  const c = counts.get(t.key) ?? { use: 0, recent: 0 };
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    cover: coverOf(t),
    hot: Boolean(t.hot),
    sort: t.sort,
    useCount: c.use,
    recentCount: c.recent,
    lastUsedAt: t.last_used_at ?? null,
  };
}

/** scope=hot：热门标签（按顺序）；scope=all：全部，按最近 days 天的使用次数倒序 */
export function adminListTags(db, { scope = 'all', days = 30 } = {}) {
  oneOf(scope, '范围', ['hot', 'all']);
  const n = int(days, '天数', { min: 1, max: 365 });
  const counts = usageCounts(db, new Date(clock.now().getTime() - n * DAY).toISOString());
  if (scope === 'hot') {
    return { items: db.all('SELECT * FROM tags WHERE hot = 1 ORDER BY sort, id').map((t) => adminTagView(t, counts)) };
  }
  const items = db.all('SELECT * FROM tags').map((t) => adminTagView(t, counts));
  items.sort(
    (a, b) =>
      b.recentCount - a.recentCount ||
      b.useCount - a.useCount ||
      (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') ||
      a.id - b.id,
  );
  return { items };
}

function requireTag(db, id) {
  const t = db.get('SELECT * FROM tags WHERE id = ?', id);
  if (!t) throw notFound('标签不存在');
  return t;
}

/** true / false（也接受 0 / 1） */
function flag(value, label) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw invalid(`${label}格式不正确`);
}

function parseCover(value) {
  if (value === undefined || value === null || value === '') return null;
  return oneOf(value, '插画', COVER_KEYS);
}

const nextHotSort = (db) => Number(db.get('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM tags WHERE hot = 1').n);

function tagView(db, id) {
  const t = requireTag(db, id);
  const counts = usageCounts(db, new Date(clock.now().getTime() - 30 * DAY).toISOString());
  return adminTagView(t, counts);
}

/** 新建标签：{name, category, cover?, hot?}；hot=true 时排在热门的最后 */
export function adminCreateTag(db, body = {}) {
  const name = parseTag(body.name, '标签名');
  const category = oneOf(body.category, '分类', CATEGORIES);
  const cover = parseCover(body.cover);
  const hot = body.hot === undefined || body.hot === null ? false : flag(body.hot, '是否热门');
  if (tagRow(db, name)) throw conflict('已经有这个标签了');
  const id = db.insert('tags', {
    name,
    key: tagKey(name),
    category,
    cover,
    hot: hot ? 1 : 0,
    sort: hot ? nextHotSort(db) : 0,
    created_at: clock.iso(),
    last_used_at: null,
  });
  return tagView(db, id);
}

/** 修改标签：{name?, category?, cover?, hot?}。改名不影响已经用了旧名字的局和意向 */
export function adminUpdateTag(db, id, body = {}) {
  const t = requireTag(db, id);
  const patch = {};
  if (body.name !== undefined) {
    const name = parseTag(body.name, '标签名');
    const other = tagRow(db, name);
    if (other && other.id !== t.id) throw conflict('已经有这个标签了');
    patch.name = name;
    patch.key = tagKey(name);
  }
  if (body.category !== undefined) patch.category = oneOf(body.category, '分类', CATEGORIES);
  if (body.cover !== undefined) patch.cover = parseCover(body.cover);
  if (body.hot !== undefined) {
    const hot = flag(body.hot, '是否热门');
    if (hot && !t.hot) patch.sort = nextHotSort(db);
    patch.hot = hot ? 1 : 0;
  }
  db.update('tags', t.id, patch);
  return tagView(db, t.id);
}

/** 整体替换热门列表及顺序：ids 里的按顺序成为热门，其余都不是热门 */
export function adminSetHotTags(db, ids) {
  if (!Array.isArray(ids)) throw invalid('ids 需要是数组');
  const list = ids.map(Number);
  if (list.some((x) => !Number.isInteger(x) || x <= 0)) throw invalid('ids 格式不正确');
  if (new Set(list).size !== list.length) throw invalid('ids 有重复');
  return db.tx(() => {
    for (const id of list) requireTag(db, id);
    db.run('UPDATE tags SET hot = 0, sort = 0');
    list.forEach((id, i) => db.run('UPDATE tags SET hot = 1, sort = ? WHERE id = ?', i, id));
    return adminListTags(db, { scope: 'hot' });
  });
}

export function adminDeleteTag(db, id) {
  requireTag(db, id);
  db.run('DELETE FROM tags WHERE id = ?', id);
  return { ok: true };
}

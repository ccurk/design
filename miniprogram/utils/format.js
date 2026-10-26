// 日期、标签、金额格式化。业务时区固定北京时间（UTC+8），与设备时区无关。
const config = require('../config');

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const OFFSET = 8 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;

const CATEGORY = { outdoor: '户外', food: '吃饭', coffee: '咖啡', game: '桌游', carpool: '拼车', other: '其他' };
const SLOT = { morning: '上午', afternoon: '下午', evening: '晚上', allday: '全天' };
const PACE = { slow: '比较慢热', warm: '熟了就话多', open: '随时都能聊' };
const GENDER = { female: '女', male: '男', unknown: '不填' };
const FEE_NOTE = { aa: '平台不经手钱，钱在微信里直接转', free: '不用花钱，人到就行', host: '不用 AA，人到就行', split: '各自付自己的，平台不经手钱' };
// 意向的时间段（v0.3）：上午 / 下午 / 晚上 / 都可以，或自定义时间段
const TIME_SLOTS = [
  { value: 'morning', label: '上午', from: '05:00', to: '12:00' },
  { value: 'afternoon', label: '下午', from: '12:00', to: '18:00' },
  { value: 'evening', label: '晚上', from: '18:00', to: '23:00' },
  { value: 'allday', label: '都可以', from: '05:00', to: '23:00' }
];
const GENDER_LIMIT = { any: '不限', female: '只限女生', male: '只限男生' };
// 插画 key（design/illustrations）→ 本地文件；分类没有标签插画时的默认值
const COVER_KEYS = ['sunrise', 'mountain', 'cycling', 'lake', 'coffee', 'reading', 'food', 'boardgame', 'carpool', 'oldtown'];
const CATEGORY_COVER = { outdoor: 'mountain', food: 'food', coffee: 'coffee', game: 'boardgame', carpool: 'carpool', other: 'oldtown' };
const COVER_SRC = {
  sunrise: '/assets/covers/sunrise.svg',
  mountain: '/assets/covers/mountain.svg',
  cycling: '/assets/covers/cycling.svg',
  lake: '/assets/covers/lake.svg',
  coffee: '/assets/covers/coffee.svg',
  reading: '/assets/covers/reading.svg',
  food: '/assets/covers/food.svg',
  boardgame: '/assets/covers/boardgame.svg',
  carpool: '/assets/covers/carpool.svg',
  oldtown: '/assets/covers/oldtown.svg'
};
// 接口拿不到时用的默认热门标签（与 docs/changes-v0.3.md A 一致）
const DEFAULT_TAGS = [
  { name: '看日出', category: 'outdoor', cover: 'sunrise' },
  { name: '爬山', category: 'outdoor', cover: 'mountain' },
  { name: '骑行', category: 'outdoor', cover: 'cycling' },
  { name: '咖啡', category: 'coffee', cover: 'coffee' },
  { name: '吃饭', category: 'food', cover: 'food' },
  { name: '桌游', category: 'game', cover: 'boardgame' },
  { name: '拼车', category: 'carpool', cover: 'carpool' },
  { name: '随便走走', category: 'outdoor', cover: 'oldtown' },
  { name: '读书', category: 'coffee', cover: 'reading' },
  { name: '拍照', category: 'outdoor', cover: 'lake' }
];

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

// 把时间点拆成北京时间的年月日时分
function bj(input) {
  const t = input instanceof Date ? input.getTime() : new Date(input).getTime();
  if (!input || isNaN(t)) return null;
  const d = new Date(t + OFFSET);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), wd: d.getUTCDay(), t };
}

function dayIndex(p) {
  return Math.floor(Date.UTC(p.y, p.m - 1, p.d) / DAY);
}

function dayDiff(iso) {
  const p = bj(iso);
  if (!p) return 0;
  return dayIndex(p) - dayIndex(bj(Date.now()));
}

function hm(iso) {
  const p = bj(iso);
  return p ? pad(p.h) + ':' + pad(p.mi) : '';
}

function md(iso) {
  const p = bj(iso);
  return p ? p.m + '月' + p.d + '日' : '';
}

function weekday(iso) {
  const p = bj(iso);
  return p ? WEEK[p.wd] : '';
}

// 10月31日 05:50
function mdhm(iso) {
  return iso ? md(iso) + ' ' + hm(iso) : '';
}

// 周六 10月31日 05:50
function fullDate(iso) {
  return iso ? weekday(iso) + ' ' + md(iso) + ' ' + hm(iso) : '';
}

// 今天 / 明天 / 周六 / 11月8日（用于「周六见」）
function dayWord(iso) {
  const diff = dayDiff(iso);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff > 1 && diff < 7) return weekday(iso);
  return md(iso);
}

// 今天 10:24 / 昨天 10:24 / 10月24日 10:24
function stamp(iso) {
  if (!iso) return '';
  const diff = dayDiff(iso);
  if (diff === 0) return '今天 ' + hm(iso);
  if (diff === -1) return '昨天 ' + hm(iso);
  return md(iso) + ' ' + hm(iso);
}

// 动态、评论：刚刚 / 5 分钟前 / 2 小时前 / 昨天 / 10月24日
function relative(iso) {
  const p = bj(iso);
  if (!p) return '';
  const sec = (Date.now() - p.t) / 1000;
  if (sec < 60) return '刚刚';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
  const diff = dayDiff(iso);
  if (diff === 0) return Math.floor(sec / 3600) + ' 小时前';
  if (diff === -1) return '昨天';
  return md(iso);
}

// 消息列表：10:32 / 昨天 / 周三 / 10月24日
function chatTime(iso) {
  if (!iso) return '';
  const diff = dayDiff(iso);
  if (diff === 0) return hm(iso);
  if (diff === -1) return '昨天';
  if (diff > -7 && diff < 0) return weekday(iso);
  return md(iso);
}

function hoursUntil(iso) {
  const t = new Date(iso).getTime();
  return isNaN(t) ? Infinity : (t - Date.now()) / 3600000;
}

// 北京日期字符串 YYYY-MM-DD
function dateStr(offsetDays) {
  const p = bj(Date.now() + (offsetDays || 0) * DAY);
  return p.y + '-' + pad(p.m) + '-' + pad(p.d);
}

// 北京时间的日期 + 时刻 → ISO UTC
function toISO(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, mi) - OFFSET).toISOString();
}

// 10月31日 周六（来自 YYYY-MM-DD）
function dateLabel(date) {
  if (!date) return '';
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return m + '月' + d + '日 ' + WEEK[wd];
}

function duration(min) {
  const n = Number(min);
  if (!n) return '';
  if (n < 60) return '约 ' + n + ' 分钟';
  const h = Math.round((n / 60) * 2) / 2;
  return '约 ' + h + ' 小时';
}

// 清晨 / 上午 / 中午 / 下午 / 晚上 / 深夜
function daypart(iso) {
  const p = bj(iso);
  if (!p) return '';
  const h = p.h;
  if (h < 4) return '深夜';
  if (h < 8) return '清晨';
  if (h < 11) return '上午';
  if (h < 13) return '中午';
  if (h < 18) return '下午';
  return '晚上';
}

// 30 → "30"，37.5 → "37.5"，33.333 → "33.33"
function money(n) {
  const v = Math.round(Number(n || 0) * 100) / 100;
  return String(v);
}

function sizeLabel(min, max, relaxSize) {
  if (relaxSize) return '2–6 人';
  if (!min && !max) return '';
  if (!max || min === max) return (min || max) + ' 人';
  return min + '–' + max + ' 人';
}

// 服务端可能返回 /uploads/xx.jpg 这样的相对地址，显示时补全
function imageUrl(url) {
  if (!url) return '';
  if (/^(https?:|wxfile:|data:)/.test(url)) return url;
  if (url.charAt(0) === '/') return config.baseURL + url;
  return url;
}

// 「周六清晨 · 苍山看日出」→「苍山看日出」；没有时间前缀的标题原样返回
function shortTitle(title) {
  const s = String(title || '');
  const i = s.indexOf(' · ');
  if (i > 0 && /^(周|今天|明天|后天|本周|下周|这周)/.test(s.slice(0, i))) return s.slice(i + 3);
  return s;
}

// 北京日期 YYYY-MM-DD 往后的日期列表：[{ date, label: '今天 10月26日 周一' }]
function dateOptions(days, from) {
  const out = [];
  for (let i = from || 0; i < (from || 0) + days; i++) {
    const date = dateStr(i);
    const prefix = i === 0 ? '今天 ' : i === 1 ? '明天 ' : i === 2 ? '后天 ' : '';
    out.push({ date, label: prefix + dateLabel(date) });
  }
  return out;
}

function range(from, to) {
  const out = [];
  for (let i = from; i <= to; i++) out.push(pad(i));
  return out;
}

// "HH:MM" ↔ 分钟数
function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(n) {
  return pad(Math.floor(n / 60)) + ':' + pad(n % 60);
}

// 时长文字：90 → 「1.5 小时」，60 → 「1 小时」，45 → 「45 分钟」
function spanLabel(minutes) {
  if (minutes < 60) return minutes + ' 分钟';
  const h = Math.round((minutes / 60) * 10) / 10;
  return h + ' 小时';
}

// 「本周末」「今天」「10月30日 周五」
function whenLabel(when) {
  if (when === 'today') return '今天';
  if (when === 'tomorrow') return '明天';
  if (when === 'weekend') return '本周末';
  return /^\d{4}-\d{2}-\d{2}$/.test(when || '') ? dateLabel(when) : '';
}

// 局的封面插画 key：优先接口给的 coverKey，其次按分类
function coverKey(key, category) {
  if (COVER_KEYS.indexOf(key) >= 0) return key;
  return CATEGORY_COVER[category] || 'oldtown';
}

// 标签的插画 key：在热门标签里找，找不到按分类
function tagCover(name, hotTags, category) {
  const hit = (hotTags || []).concat(DEFAULT_TAGS).filter((t) => t.name === name)[0];
  return coverKey(hit && hit.cover, (hit && hit.category) || category);
}

function coverSrc(key) {
  return COVER_SRC[key] || COVER_SRC.oldtown;
}

// 规范化用户自己写的标签：去首尾空格、合并空白；返回 { name, error }
const TAG_CHARS = /^[\u3400-\u9fff\uf900-\ufaffA-Za-z0-9\uff10-\uff19\uff21-\uff3a\uff41-\uff5a ·\-_]+$/;
function normalizeTag(raw) {
  const name = String(raw || '').replace(/\s+/g, ' ').trim();
  const len = Array.from(name).length;
  if (!len) return { name, error: '先写一个标签' };
  if (len > 8) return { name, error: '标签最多 8 个字' };
  if (!TAG_CHARS.test(name)) return { name, error: '只能用文字、数字、空格和 ·-_' };
  return { name, error: '' };
}

function creditText(level) {
  if (level === 'restricted') return '账号受限 · 只能看，暂时不能报名';
  if (level === 'fair') return '信用一般 · 大一点的局需要发起人同意';
  return '信用良好 · 可以参加所有类型的局';
}

module.exports = {
  WEEK,
  CATEGORY,
  SLOT,
  PACE,
  GENDER,
  FEE_NOTE,
  pad,
  bj,
  dayDiff,
  hm,
  md,
  mdhm,
  weekday,
  fullDate,
  dayWord,
  stamp,
  relative,
  chatTime,
  hoursUntil,
  dateStr,
  toISO,
  dateLabel,
  duration,
  daypart,
  money,
  sizeLabel,
  imageUrl,
  shortTitle,
  creditText,
  TIME_SLOTS,
  GENDER_LIMIT,
  COVER_KEYS,
  CATEGORY_COVER,
  COVER_SRC,
  DEFAULT_TAGS,
  coverSrc,
  dateOptions,
  range,
  toMinutes,
  fromMinutes,
  spanLabel,
  whenLabel,
  coverKey,
  tagCover,
  normalizeTag
};

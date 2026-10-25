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
  creditText
};

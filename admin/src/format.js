// 时间与文案：时间一律按北京时间（Asia/Shanghai）显示；各种状态 → 中文标签和配色。

export const TZ = 'Asia/Shanghai';
const DAY = 24 * 60 * 60 * 1000;
const WEEK = '日一二三四五六';
const pad = (n) => String(n).padStart(2, '0');

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 某个时间点在北京时间下的年月日时分；date 为 YYYY-MM-DD */
export function bj(input) {
  if (input === null || input === undefined || input === '') return null;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const p = {};
  for (const { type, value } of PARTS.formatToParts(d)) p[type] = value;
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    hh: p.hour === '24' ? '00' : p.hour,
    mm: p.minute,
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

/** 北京时间的今天 YYYY-MM-DD */
export const todayStr = () => bj(new Date()).date;

export function addDays(dateStr, n) {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** b - a 相差几天（两个 YYYY-MM-DD） */
export function dayDiff(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
}

export function weekday(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : `周${WEEK[d.getUTCDay()]}`;
}

/** 「10月31日」；不是今年的带上年份 */
export function md(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${y !== bj(new Date()).y ? `${y}年` : ''}${m}月${d}日`;
}

/** 「10/31」 */
export function slash(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${m}/${d}`;
}

/** 「10月31日 周六」 */
export const dateLabel = (dateStr) => `${md(dateStr)} ${weekday(dateStr)}`;

/** 「10月31日 周六 05:50」 */
export function dateTime(iso) {
  const p = bj(iso);
  return p ? `${dateLabel(p.date)} ${p.hh}:${p.mm}` : '—';
}

/** 「10月31日」 */
export function shortDate(iso) {
  const p = bj(iso);
  return p ? md(p.date) : '—';
}

/** 「今天 05:50」「明天 09:00」「昨天 23:10」「10月31日 05:50」 */
export function when(iso) {
  const p = bj(iso);
  if (!p) return '—';
  const diff = dayDiff(todayStr(), p.date);
  const day = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === -1 ? '昨天' : md(p.date);
  return `${day} ${p.hh}:${p.mm}`;
}

/** 「刚刚」「12 分钟前」「3 小时前」「昨天 23:10」「10月18日」 */
export function ago(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const p = bj(iso);
  const diff = dayDiff(todayStr(), p.date);
  if (min < 24 * 60 && (diff === 0 || min < 6 * 60)) return `${Math.floor(min / 60)} 小时前`;
  if (diff === -1) return `昨天 ${p.hh}:${p.mm}`;
  return md(p.date);
}

/** 「2 小时」「1.5 小时」「45 分钟」 */
export function duration(min) {
  const n = Number(min);
  if (!n) return '—';
  if (n < 60) return `${n} 分钟`;
  return `${String(Math.round((n / 60) * 10) / 10)} 小时`;
}

/** 撮合池里等了多久 */
export function waitText(hours) {
  const h = Number(hours) || 0;
  if (h < 1) return '刚进池子';
  if (h < 72) return `等了 ${h} 小时`;
  return `等了 ${Math.floor(h / 24)} 天`;
}

/** 北京时间的日期 + 时刻（表单里填的）→ UTC ISO 字符串；格式不对返回 null */
export function bjToISO(dateStr, timeStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '') || !/^\d{2}:\d{2}$/.test(timeStr || '')) return null;
  const d = new Date(`${dateStr}T${timeStr}:00+08:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---- 业务标签 ----

export const CATEGORY = { outdoor: '户外', food: '吃饭', coffee: '咖啡', game: '桌游', carpool: '拼车', other: '其他' };
export const categoryLabel = (key) => CATEGORY[key] || '其他';

export const SOURCE = { matched: '撮合', user: '用户发起', platform: '平台' };
export const sourceLabel = (key) => SOURCE[key] || key || '—';

/** 局的显示状态：open / inviting / formed 已经过了结束时间的，显示成「已结束」 */
export const EVENT_STATUS = {
  open: { label: '招募中', tone: 'tint' },
  inviting: { label: '邀请中', tone: 'accent' },
  formed: { label: '已成局', tone: 'primary' },
  pending_review: { label: '待审核', tone: 'warn' },
  ended: { label: '已结束', tone: 'stone' },
  cancelled: { label: '已取消', tone: 'outline' },
  rejected: { label: '未通过', tone: 'danger' },
};
/** 和 GET /api/admin/events?status=ended 同一个口径：已经结束的 open / formed 局显示「已结束」 */
export function displayStatus(event) {
  return ['open', 'formed'].includes(event.status) && event.phase === 'ended' ? 'ended' : event.status;
}

/** 信用等级；封号的人单独显示「已封号」 */
export const LEVEL = {
  good: { label: '良好', tone: 'tint' },
  fair: { label: '一般', tone: 'warn' },
  restricted: { label: '受限', tone: 'danger' },
  banned: { label: '已封号', tone: 'danger-solid' },
};
export function userLevel(user) {
  if (!user) return 'good';
  if (user.status === 'banned') return 'banned';
  return user.creditLevel || (user.credit && user.credit.level) || 'good';
}

export const CREDIT_TYPE = {
  attended: { label: '准时到场', tone: 'tint' },
  late: { label: '迟到', tone: 'stone' },
  cancel_late: { label: '临时鸽', tone: 'warn' },
  no_show: { label: '放鸽子', tone: 'danger' },
  admin_adjust: { label: '人工调整', tone: 'gray' },
};
export const CREDIT_SOURCE = { system: '系统记录', review: '互评', admin: '后台' };

export const PACE = { slow: '慢热', warm: '熟了就话多', open: '随时都能聊' };

/** 费用方式（后台表单里只给这三种；host「发起人请客」对撮合局 / 平台局不适用） */
export const FEE_OPTIONS = [
  { key: 'aa', label: 'AA 分摊' },
  { key: 'split', label: '各付各' },
  { key: 'free', label: '免费' },
];

/** 头像底色，与 docs/api.md 1.1、小程序 components/avatar 一致 */
export const AVATAR = {
  ink: ['#193543', '#FFFFFF'],
  stone: ['#E3E8EC', '#15171C'],
  accent: ['#7CCAE3', '#15171C'],
  slate: ['#2E4A5C', '#FFFFFF'],
};

export const REPORT_KIND = { user: '用户资料', post: '动态', comment: '评论', message: '群聊', event: '局' };
const DANGER_WORDS = ['骚扰', '色情', '低俗', '金钱', '冒充', '诈骗', '违法', '安全'];
/** 举报原因的配色：骚扰、色情这类用红色，推销、爽约这类用橙色 */
export const reasonTone = (reason) => (DANGER_WORDS.some((w) => String(reason || '').includes(w)) ? 'danger' : 'warn');

export const REPORT_ACTION = {
  dismiss: '驳回',
  warn: '警告',
  delete_content: '删除内容',
  restrict_7d: '限制 7 天',
  ban: '封号',
};

/** 举报的标题：「南风 的动态」「大鹏 在「桌游夜 · 新手友好」群聊」 */
export function reportTitle(r) {
  const n = r.targetUser && r.targetUser.nickname;
  const c = r.context || {};
  switch (r.targetType) {
    case 'user':
      return n ? `${n} 的个人资料` : '一位用户的资料';
    case 'post':
      return n ? `${n} 的动态` : '一条动态';
    case 'comment':
      return n ? `${n} 的评论` : '一条评论';
    case 'message':
      if (c.eventTitle) return `${n || '有人'} 在「${c.eventTitle}」群聊`;
      return n ? `${n} 在群聊里的发言` : '一条群聊消息';
    case 'event':
      if (c.eventTitle) return n ? `${n} 发起的局「${c.eventTitle}」` : `局「${c.eventTitle}」`;
      return n ? `${n} 发起的局` : '一个局';
    default:
      return '被举报的内容';
  }
}

/** 被举报的内容在哪：「来自「桌游夜 · 新手友好」群聊」「评论在动态「…」下面」 */
export function reportWhere(r) {
  const c = r.context;
  if (r.targetType === 'user') return '被举报的是 TA 的昵称和简介';
  if (!c) return '内容已经不在了';
  switch (r.targetType) {
    case 'post':
      return '发在「动态」';
    case 'comment':
      return c.postPreview ? `评论在动态「${c.postPreview}」下面` : '发在动态下面的评论里';
    case 'message':
      return c.eventTitle ? `来自「${c.eventTitle}」群聊` : '发在局的群聊里';
    case 'event':
      return c.eventTitle ? `用户发起的局「${c.eventTitle}」` : '用户发起的局';
    default:
      return '';
  }
}

/** 概览列表里的一行：「大鹏 · 「桌游夜」群聊」「南风 · 动态」 */
export function reportWho(r) {
  const n = r.targetUser ? `${r.targetUser.nickname} · ` : '';
  if (r.targetType === 'message' && r.context && r.context.eventTitle) return `${n}「${r.context.eventTitle}」群聊`;
  return `${n}${REPORT_KIND[r.targetType] || '内容'}`;
}

/** 和之前比：「比昨天 +5」「比前 7 天 −2 个百分点」「和昨天一样」 */
export function compare(diff, than, unit = '') {
  const n = Number(diff) || 0;
  if (n === 0) return `和${than}一样`;
  return `比${than} ${n > 0 ? '+' : '−'}${Math.abs(n)}${unit}`;
}

// ---- 撮合相关（默认值与 server/src/time.js defaultStartTime、constants.js defaultDurationForTask 一致）----

export const SLOT = { morning: '上午', afternoon: '下午', evening: '晚上', allday: '全天' };

/** 撮合局默认集合时刻「HH:MM」 */
export function defaultStart(task, slot) {
  if (task === '看日出') return '05:50';
  if (task === '早餐') return '08:30';
  return { morning: '09:00', afternoon: '15:00', evening: '19:00' }[slot] || '10:00';
}

/** 撮合局默认时长（分钟） */
export function defaultDuration(task) {
  if (['看日出', '爬山', '徒步'].includes(task)) return 240;
  if (['骑行', '桌游'].includes(task)) return 180;
  return 120;
}

export const DURATIONS = [60, 90, 120, 150, 180, 240, 300, 360, 480, 600];

const TASK_VERB = { 早餐: '吃早餐', 夜市: '逛夜市', 咖啡: '喝咖啡', 桌游: '玩桌游', 拼车: '拼车出发' };
/** 「池子里同样想{喝咖啡}的人」 */
export const taskVerb = (task) => TASK_VERB[task] || task;

// ---- 其他 ----

/** 用户上传的图片 / 头像地址：只放行 http(s) 和本站相对路径，防止 javascript: 之类的链接 */
export function safeUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const u = new URL(url, window.location.origin);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export { pad };

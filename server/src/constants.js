// 业务常量：分类、任务、破冰话题等。

export const CATEGORIES = ['outdoor', 'food', 'coffee', 'game', 'carpool', 'other'];

export const CATEGORY_LABELS = {
  outdoor: '户外',
  food: '吃饭',
  coffee: '咖啡',
  game: '桌游',
  carpool: '拼车',
  other: '其他',
};

export const CATEGORY_TASKS = {
  outdoor: ['看日出', '爬山', '徒步', '骑行', '随便走走'],
  food: ['吃饭', '早餐', '夜市'],
  coffee: ['咖啡', '读书'],
  game: ['桌游'],
  carpool: ['拼车'],
};

export function categoryOfTask(task) {
  for (const [category, tasks] of Object.entries(CATEGORY_TASKS)) {
    if (tasks.includes(task)) return category;
  }
  return 'other';
}

/** 撮合意向默认的时间段 */
export function defaultSlotForTask(task) {
  if (task === '看日出' || task === '早餐') return 'morning';
  if (task === '夜市') return 'evening';
  return 'allday';
}

/** 撮合局默认时长（分钟） */
export function defaultDurationForTask(task) {
  if (['看日出', '爬山', '徒步'].includes(task)) return 240;
  if (['骑行', '桌游'].includes(task)) return 180;
  return 120;
}

export const DEFAULT_AREA = '古城';

export const ICEBREAKERS = [
  '来大理以后，你最喜欢的一个瞬间是什么？',
  '如果只能带一样东西上山，你会带什么？',
  '最近一次觉得「刚刚好」，是什么时候？',
  '有没有一首歌，一听就想到旅行？',
  '你最近在读或在看什么？',
];

export const FEELINGS = ['很放松', '不尴尬', '下次还来', '节奏刚好'];

export const PACE_LABELS = { slow: '比较慢热', warm: '熟了就话多', open: '随时都能聊' };

export const FEE_TYPES = ['aa', 'free', 'host', 'split'];

export const SYSTEM_MESSAGES = {
  formed: '满员啦，群已自动建好 · 第一次见面，慢慢来',
};

/** 信用记录类型的中文名 */
export const CREDIT_TYPE_LABELS = {
  attended: '准时到场',
  late: '迟到',
  cancel_late: '临时鸽',
  no_show: '放鸽子',
  admin_adjust: '人工调整',
};

export const REPORT_TARGETS = ['user', 'event', 'post', 'comment', 'message'];
export const REPORT_ACTIONS = ['dismiss', 'warn', 'delete_content', 'restrict_7d', 'ban'];

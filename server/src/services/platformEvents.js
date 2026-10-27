// 运营组织的平台局：冷启动模板池、运营账号、每天自动发布。
//
// 原则（冷启动不骗真人）：真人会线下见面的「未来局」里只放运营和真人，
// 绝不塞假的种子账号占位；种子账号只出现在「历史已成团的局」里撑场面
// （历史局已结束、不进广场、真人加不到，见 scripts/seed-coldstart.js）。
import { clock, DAY } from '../clock.js';
import { json } from '../db.js';
import { addDays, bjDate, bjDateTime, slotLabel, weekdayName } from '../time.js';
import { createPlatformEvent } from './events.js';
import { markOnce } from './notices.js';

export const OPERATOR_OPENID = 'operator_official';

/**
 * 大理场景的活动模板池：运营带队的平台局、每天自动发布、历史撑场面局都从这里出。
 * start = [时, 分]（北京时间）；category 用 constants.CATEGORIES 里的合法值。
 */
export const EVENT_TEMPLATES = [
  { task: '看日出', category: 'outdoor', title: '苍山看日出', slot: 'morning', start: [5, 50], place: '大理古城南门', meetingPoint: '南门城楼下集合，拼车上山', durationMin: 240, capacity: 5, minSize: 3, description: '凌晨集合拼车上苍山看日出，看完一起吃个早饭。只分摊车费和早餐，平台不经手钱。' },
  { task: '骑行', category: 'outdoor', title: '洱海西岸骑行', slot: 'afternoon', start: [15, 30], place: '才村码头', meetingPoint: '才村码头停车场租车点', durationMin: 180, capacity: 6, minSize: 3, description: '沿洱海西岸慢骑，边骑边停拍照，不赶路。自带或现场租车。' },
  { task: '咖啡', category: 'coffee', title: '人民路喝咖啡', slot: 'afternoon', start: [15, 0], place: '大理古城人民路', meetingPoint: '人民路中段的咖啡馆（报名后群里定）', durationMin: 90, capacity: 4, minSize: 2, description: '找家安静的咖啡馆坐坐，聊不聊天都行，i 人友好。' },
  { task: '桌游', category: 'game', title: '古城桌游夜', slot: 'evening', start: [19, 30], place: '床单厂艺术区', meetingPoint: '床单厂的桌游吧（报名后群里定）', durationMin: 180, capacity: 6, minSize: 3, description: '轻度桌游，新手友好，有人带。AA 场地费。' },
  { task: '徒步', category: 'outdoor', title: '喜洲田野徒步', slot: 'morning', start: [8, 30], place: '喜洲古镇', meetingPoint: '喜洲古镇牌坊下', durationMin: 240, capacity: 8, minSize: 3, description: '沿喜洲稻田慢走一圈，拍拍照，中午一起吃个饭。' },
  { task: '夜市', category: 'food', title: '大理夜市逛吃', slot: 'evening', start: [19, 0], place: '大理古城', meetingPoint: '古城红龙井入口', durationMin: 120, capacity: 5, minSize: 2, description: '一起逛夜市吃小吃，各付各的也行，图个热闹。' },
  { task: '读书', category: 'coffee', title: '安静读书会', slot: 'afternoon', start: [15, 0], place: '床单厂艺术区', meetingPoint: '床单厂的书店（报名后群里定）', durationMin: 120, capacity: 6, minSize: 2, description: '各看各的书，不用社交，结束想聊再聊。' },
  { task: '拼车', category: 'carpool', title: '周末拼车去沙溪', slot: 'allday', start: [8, 0], place: '大理古城', meetingPoint: '古城西门停车场', durationMin: 600, capacity: 4, minSize: 2, description: '拼车去沙溪古镇玩一天，分摊油费过路费，当天往返。' },
];

/** 运营账号：平台局的组织者，会真实到场。没有就建一个（按 openid 幂等）。 */
export function ensureOperator(db) {
  const row = db.get('SELECT id FROM users WHERE openid = ?', OPERATOR_OPENID);
  if (row) return row.id;
  return db.insert('users', {
    openid: OPERATOR_OPENID,
    nickname: '大理活动小助手',
    bio: '官方组织的兴趣局，带你认识同频的人。',
    gender: 'unknown',
    pace: 'open',
    interests: json.str(['看日出', '骑行', '咖啡', '徒步']),
    status: 'active',
    settings: json.str({ sameSexOnly: false, checkInReminder: true, profileOpen: true }),
    onboarded: 1,
    created_at: clock.iso(),
  });
}

/** 这个模板在某天的局标题，如「周六下午 · 洱海西岸骑行」（不超过 30 字）。 */
export function templateTitle(template, startAt) {
  const label = template.slot === 'allday' ? '' : slotLabel(template.slot, template.task);
  return `${weekdayName(startAt)}${label} · ${template.title}`.slice(0, 30);
}

/**
 * 发一个运营带队的平台局：开放报名，运营号先占一位（会到场），其余名额留给真人。
 * 返回 eventId。整个过程在一个事务里。
 */
export function publishPlatformEvent(db, template, { date, operatorId } = {}) {
  const [h, m] = template.start;
  const startAt = bjDateTime(date, h, m);
  return db.tx(() => {
    const opId = operatorId ?? ensureOperator(db);
    const event = createPlatformEvent(db, {
      title: templateTitle(template, startAt),
      tag: template.task,
      startAt: startAt.toISOString(),
      durationMin: template.durationMin,
      place: template.place,
      meetingPoint: template.meetingPoint,
      capacity: template.capacity,
      minSize: template.minSize,
      feeType: 'aa',
      description: template.description,
    });
    // 运营带队：运营号先加入一位，其余名额留给真人（绝不塞假的种子账号占位）
    db.insert('event_members', {
      event_id: event.id,
      user_id: opId,
      role: 'host',
      status: 'joined',
      attendance: 'pending',
      joined_at: clock.iso(),
    });
    return event.id;
  });
}

/**
 * 每天自动发布运营局：当天只发一次（markOnce 幂等，由 jobs.js 每小时调用、启动时也调）。
 * 给未来 1..aheadDays 天各发 perDay 个局，轮换模板、运营带队、开放报名。
 * 返回 { created } 或 { created: 0, skipped: true }（当天已发过）。
 */
export function publishDailyEvents(db, { perDay = 2, aheadDays = 3 } = {}) {
  const today = bjDate(clock.now());
  if (!markOnce(db, `daily-platform:${today}`)) return { created: 0, skipped: true };
  const operatorId = ensureOperator(db);
  // 不同天从模板池不同位置起头，内容更丰富
  let i = Math.floor(clock.now().getTime() / DAY) * perDay * aheadDays;
  let created = 0;
  for (let d = 1; d <= aheadDays; d++) {
    const date = addDays(today, d);
    for (let n = 0; n < perDay; n++) {
      const template = EVENT_TEMPLATES[i++ % EVENT_TEMPLATES.length];
      try {
        publishPlatformEvent(db, template, { date, operatorId });
        created++;
      } catch {
        // 单个局校验 / 时间重叠失败就跳过，不影响其它
      }
    }
  }
  return { created };
}

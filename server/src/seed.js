// 演示数据（docs/api.md 第 6 节），与设计稿一致。所有时间都相对「现在」生成，演示时总是新鲜的。
// 配图来自 server/seed-assets/（由 design/illustrations/*.svg 渲染，见 scripts/render-seed-images.mjs），
// 传了 uploadDir 时复制进上传目录，库里存相对路径 /uploads/seed-<key>.png。
import fs from 'node:fs';
import path from 'node:path';
import { clock, DAY, HOUR, MINUTE } from './clock.js';
import { SERVER_DIR } from './config.js';
import { SYSTEM_MESSAGES } from './constants.js';
import { json, resetDb } from './db.js';
import { enrichIntent, proposalTitle, scoreGroup } from './services/matchRules.js';
import { runMatching } from './services/matching.js';
import { ensureDefaultTags, syncTagUsage } from './services/tags.js';
import { addDays, bjDate, bjDateTime, dayDiff, lastWeekday, nextWeekday, weekdayName } from './time.js';

export const SEED_ASSETS_DIR = path.join(SERVER_DIR, 'seed-assets');
const ASSET_KEYS = ['sunrise', 'mountain', 'cycling', 'lake', 'coffee', 'reading', 'food', 'boardgame', 'carpool', 'oldtown'];

/** 把配图复制进上传目录，返回 key → /uploads/seed-<key>.<ext> */
export function installSeedImages(uploadDir) {
  const files = fs.existsSync(SEED_ASSETS_DIR) ? fs.readdirSync(SEED_ASSETS_DIR) : [];
  const images = {};
  for (const key of ASSET_KEYS) {
    const file = files.find((f) => f === `${key}.png` || f === `${key}.jpg`) ?? `${key}.png`;
    const name = `seed-${file}`;
    images[key] = `/uploads/${name}`;
    const src = path.join(SEED_ASSETS_DIR, file);
    if (uploadDir && fs.existsSync(src)) {
      fs.mkdirSync(uploadDir, { recursive: true });
      fs.copyFileSync(src, path.join(uploadDir, name));
    }
  }
  return images;
}

const USERS = [
  // key, 昵称, 性别, 节奏, 兴趣, 简介, 额外字段
  ['lizi', '栗子', 'female', 'slow', ['看日出', '咖啡', '骑行', '读书'], '慢热，但很靠谱。喜欢清晨和安静的地方。', { phone: '13800001234', phone_verified: 1, emergency_contact: { name: '妈妈', phone: '13800005678' }, days: 40 }],
  ['xiaoman', '小满', 'female', 'slow', ['看日出', '拍照', '咖啡'], '第一次来大理，想看一次苍山日出。', { phone: '13900002345', phone_verified: 1, days: 30 }],
  ['aye', '阿野', 'male', 'slow', ['爬山', '骑行', '看日出'], '户外爱好者，话不多。爬山会多带暖宝宝和一份早饭。', { phone: '13700003456', phone_verified: 1, id_verified: 1, days: 200 }],
  ['qiqi', '七七', 'female', 'warm', ['看日出', '桌游', '吃饭', '拍照'], '熟了就话多，先听大家聊。', { phone: '13600004567', phone_verified: 1, days: 90 }],
  ['mumu', '木木', 'female', 'open', ['桌游', '咖啡', '看日出', '读书'], '在古城开了家小书店，周末出来玩。', { phone: '13500005678', phone_verified: 1, days: 150 }],
  ['dapeng', '大鹏', 'male', 'open', ['拼车', '吃饭', '夜市'], '到处走走。', { phone: '13300006789', phone_verified: 1, days: 60 }],
  ['nanfeng', '南风', 'male', 'slow', ['骑行', '读书', '咖啡', '看日出'], '骑车环过三次洱海，慢慢来。', { phone: '15800007890', phone_verified: 1, days: 120 }],
  ['xiaolin', '小林', 'male', 'warm', ['爬山', '徒步', '拍照'], '刚到大理，想找人一起爬苍山。', { days: 1 }],
  ['ayun', '阿云', 'female', 'slow', ['咖啡', '读书', '瑜伽'], '在大理旅居一个月。', { days: 0 }],
  ['qingqing', '青青', 'female', 'warm', ['咖啡', '拍照', '画画'], '喜欢画画和发呆。', { phone: '18800008901', phone_verified: 1, days: 20 }],
  ['laozhou', '老周', 'male', 'slow', ['爬山', '拍照', '看日出'], '退休了，每天爬一点山。', { phone: '18900009012', phone_verified: 1, days: 300 }],
];

// 历史信用记录（不关联具体局）：[attended, late, cancel_late, no_show]
const HISTORY = {
  lizi: [4, 0, 0, 0],
  xiaoman: [7, 0, 0, 0],
  aye: [43, 0, 1, 0],
  qiqi: [10, 0, 0, 0],
  mumu: [22, 1, 0, 0], // 那次「放鸽子」挂在下面的历史局上（有群聊记录，申诉时当佐证）
  dapeng: [5, 0, 0, 1],
  nanfeng: [6, 0, 0, 0],
  laozhou: [14, 0, 0, 0],
  qingqing: [2, 0, 0, 0],
};

/** 清空数据库并写入演示数据。uploadDir：把配图复制到这个上传目录（不传就只写库） */
export function seed(db, { uploadDir = null } = {}) {
  resetDb(db);
  const now = clock.now();
  const t = now.getTime();
  const ago = (ms) => new Date(t - ms).toISOString();
  const today = bjDate(now);
  const U = {};
  const E = {};
  const IMG = installSeedImages(uploadDir);
  const images = (...keys) => json.str(keys.map((k) => IMG[k]));
  /** 已成群 / 已结束的局：最晚退出时间 = 开始前 24 小时 */
  const exitBefore = (start) => new Date(start.getTime() - DAY).toISOString();
  /** 广场上还在报名的局：开始前 24 小时；离开始不到一天时留到开始前 2 小时（至少比现在晚，演示时不会马上截止） */
  const exitOpen = (start) =>
    new Date(Math.max(start.getTime() - DAY, Math.min(start.getTime() - 2 * HOUR, t + 12 * HOUR))).toISOString();

  return db.tx(() => {
    ensureDefaultTags(db);

    // ---- 用户 ----
    for (const [key, nickname, gender, pace, interests, bio, extra] of USERS) {
      U[key] = db.insert('users', {
        openid: `demo_${key}`,
        phone: extra.phone ?? null,
        nickname,
        bio,
        gender,
        pace,
        interests: json.str(interests),
        phone_verified: extra.phone_verified ?? 0,
        id_verified: extra.id_verified ?? 0,
        status: 'active',
        settings: json.str({ sameSexOnly: false, checkInReminder: true, profileOpen: true }),
        emergency_contact: extra.emergency_contact ? json.str(extra.emergency_contact) : null,
        onboarded: 1,
        created_at: ago(extra.days * DAY + 3 * HOUR),
      });
    }

    // ---- 历史信用记录 ----
    for (const [key, [attended, late, cancelLate, noShow]] of Object.entries(HISTORY)) {
      const add = (type, n, source, note, daysAgo) => {
        for (let i = 0; i < n; i++) {
          db.insert('credit_events', {
            user_id: U[key],
            event_id: null,
            type,
            source,
            note,
            revoked: 0,
            created_at: ago((daysAgo ?? 35 + i * 3) * DAY),
          });
        }
      };
      add('attended', attended, 'review', '历史记录');
      add('late', late, 'review', '历史记录 · 迟到 20 分钟', 75);
      add('cancel_late', cancelLate, 'system', '开场前 20 小时说去不了', 90);
      add('no_show', noShow, 'review', '没来也没说', key === 'dapeng' ? 20 : 60);
    }

    // ---- 工具 ----
    const event = (row) =>
      db.insert('events', {
        description: '',
        meeting_point: '',
        min_size: 2,
        fee_type: 'aa',
        fee_estimate: null,
        require_approval: 0,
        same_sex_only: 0,
        gender: null,
        icebreaker_index: 0,
        moderation: '[]',
        ...row,
      });
    const member = (eventId, key, row = {}) =>
      db.insert('event_members', {
        event_id: eventId,
        user_id: U[key],
        role: 'member',
        status: 'joined',
        attendance: 'pending',
        ...row,
      });
    const say = (eventId, key, text, at) =>
      db.insert('messages', { event_id: eventId, user_id: key ? U[key] : null, kind: key ? 'text' : 'system', text, created_at: at });
    const readAll = (eventId) =>
      db.run(
        'UPDATE event_members SET last_read_message_id = (SELECT COALESCE(MAX(id), 0) FROM messages WHERE event_id = ?) WHERE event_id = ?',
        eventId,
        eventId,
      );
    const reviewed = (eventId, keys, endIso) => {
      for (const key of keys) {
        db.insert('review_feelings', { event_id: eventId, reviewer_id: U[key], feelings: json.str(['很放松', '不尴尬']), created_at: endIso });
        for (const other of keys) {
          if (other !== key) {
            db.insert('reviews', { event_id: eventId, reviewer_id: U[key], target_id: U[other], attendance: 'on_time', created_at: endIso });
          }
        }
        db.insert('credit_events', { user_id: U[key], event_id: eventId, type: 'attended', source: 'review', note: '互评结果', revoked: 0, created_at: endIso });
      }
    };

    const sat = nextWeekday(6, now);
    const sun = nextWeekday(0, now);
    const fri = nextWeekday(5, now);
    let lastFri = lastWeekday(5, now);
    if (dayDiff(lastFri, today) > 5) lastFri = addDays(today, -2);

    // ---- 周六清晨 · 苍山看日出（撮合局，已成局，含群聊和 AA）----
    const sunriseKeys = ['aye', 'xiaoman', 'mumu', 'qiqi', 'lizi'];
    const sunriseIntents = sunriseKeys.map((key, i) =>
      db.insert('intents', {
        user_id: U[key],
        task: '看日出',
        category: 'outdoor',
        date_from: sat,
        date_to: sat,
        slot: 'morning',
        area: '古城',
        size_min: 3,
        size_max: 5,
        status: 'matched',
        created_at: ago(DAY + (5 - i) * HOUR),
      }),
    );
    const group = sunriseIntents.map((id) => enrichIntent(db, db.get('SELECT * FROM intents WHERE id = ?', id), now));
    const scored = scoreGroup(group, { date: sat, slot: 'morning' });
    const proposalId = db.insert('proposals', {
      task: '看日出',
      category: 'outdoor',
      date: sat,
      slot: 'morning',
      area: '古城',
      title: proposalTitle('看日出', sat, 'morning'),
      intent_ids: json.str(sunriseIntents),
      user_ids: json.str(sunriseKeys.map((k) => U[k])),
      score: scored.score,
      reasons: json.str(scored.reasons),
      risks: json.str(scored.risks),
      status: 'confirmed',
      created_at: ago(9 * HOUR),
      reviewed_at: ago(8 * HOUR),
    });
    const sunriseStart = bjDateTime(sat, 5, 50);
    E.sunrise = event({
      title: '周六清晨 · 苍山看日出',
      category: 'outdoor',
      task: '看日出',
      description: '凌晨在古城南门集合，拼车上山看日出，看完一起吃早饭。只分摊车费和早餐，平台不经手钱。',
      images: images('sunrise', 'mountain'),
      location: json.str({ name: '大理古城南门', address: '云南省大理市大理古城复兴路南端', latitude: 25.6918, longitude: 100.1622 }),
      exit_deadline: exitBefore(sunriseStart),
      start_at: sunriseStart.toISOString(),
      duration_min: 240,
      place: '大理古城南门',
      meeting_point: '南门城楼下集合，拼车上山',
      capacity: 5,
      min_size: 3,
      fee_type: 'aa',
      fee_estimate: 30,
      source: 'matched',
      status: 'formed',
      proposal_id: proposalId,
      slot: 'morning',
      area: '古城',
      formed_at: ago(6 * HOUR),
      created_at: ago(8 * HOUR),
    });
    db.update('proposals', proposalId, { event_id: E.sunrise });
    sunriseKeys.forEach((key, i) => {
      member(E.sunrise, key, { invited_at: ago(8 * HOUR), joined_at: ago(7 * HOUR - i * 10 * MINUTE) });
      db.update('intents', sunriseIntents[i], { event_id: E.sunrise, proposal_id: proposalId });
    });
    say(E.sunrise, null, SYSTEM_MESSAGES.formed, ago(6 * HOUR));
    say(E.sunrise, 'xiaoman', '第一次看日出，有点期待', ago(5 * HOUR));
    const liziLast = say(E.sunrise, 'lizi', '我也是第一次！', ago(4 * HOUR + 50 * MINUTE));
    say(E.sunrise, 'qiqi', '山上会冷吗？要不要带厚外套', ago(3 * HOUR));
    say(E.sunrise, 'aye', '车费和早餐我先垫了，一起记在 AA 里，最后大家转我就行', ago(2 * HOUR));
    say(E.sunrise, 'aye', '我带了几个暖宝宝，山上清晨挺冷的', ago(HOUR));
    readAll(E.sunrise);
    db.run('UPDATE event_members SET last_read_message_id = ? WHERE event_id = ? AND user_id = ?', liziLast, E.sunrise, U.lizi);
    // AA：阿野一次记下 ¥150（车费 + 早餐），5 人每人 ¥30；木木已经转过、阿野确认收到
    db.insert('aa_bills', { event_id: E.sunrise, payer_id: U.aye, amount: 150, note: '车费 + 早餐', created_at: ago(2 * HOUR), updated_at: ago(2 * HOUR) });
    db.insert('aa_transfers', { event_id: E.sunrise, from_user_id: U.mumu, to_user_id: U.aye, status: 'confirmed', updated_at: ago(30 * MINUTE) });

    // ---- 桌游夜 · 新手友好（已结束，待评价）----
    const gameStart = bjDateTime(lastFri, 20, 0);
    const gameFormed = new Date(gameStart.getTime() - DAY - 5 * MINUTE).toISOString(); // 到最晚退出时间够人，成群
    E.boardgame = event({
      title: '桌游夜 · 新手友好',
      category: 'game',
      task: '桌游',
      description: '新手友好，规则现场教。玩累了就聊聊天，不想说话也没关系。',
      images: images('boardgame'),
      exit_deadline: exitBefore(gameStart),
      start_at: gameStart.toISOString(),
      duration_min: 180,
      place: '古城内 · 一苇桌游馆',
      meeting_point: '人民路一苇桌游馆二楼',
      capacity: 8,
      fee_type: 'aa',
      fee_estimate: 25,
      source: 'user',
      creator_id: U.nanfeng,
      status: 'formed',
      formed_at: gameFormed,
      created_at: new Date(gameStart.getTime() - 5 * DAY).toISOString(),
    });
    const gameKeys = ['nanfeng', 'lizi', 'mumu', 'aye', 'qiqi'];
    gameKeys.forEach((key, i) =>
      member(E.boardgame, key, {
        role: key === 'nanfeng' ? 'host' : 'member',
        attendance: 'yes',
        joined_at: new Date(gameStart.getTime() - (5 - i * 0.5) * DAY).toISOString(),
      }),
    );
    say(E.boardgame, null, SYSTEM_MESSAGES.formedAtDeadline, gameFormed);
    say(E.boardgame, 'nanfeng', '欢迎大家，规则我来讲，不会玩完全没关系', new Date(gameStart.getTime() - DAY).toISOString());
    say(E.boardgame, 'qiqi', '好期待！我带点零食', new Date(gameStart.getTime() - 20 * HOUR).toISOString());
    say(E.boardgame, 'mumu', '下次还来！', new Date(gameStart.getTime() + 3.5 * HOUR).toISOString());
    readAll(E.boardgame);

    // ---- 历史局（已结束、已评价）----
    const h1Date = addDays(today, -6);
    const h1Start = bjDateTime(h1Date, 5, 50);
    E.pastSunrise = event({
      title: `${weekdayName(h1Date)}清晨 · 苍山看日出`,
      category: 'outdoor',
      task: '看日出',
      description: '拼车上山看日出。',
      images: images('sunrise'),
      exit_deadline: exitBefore(h1Start),
      start_at: h1Start.toISOString(),
      duration_min: 240,
      place: '大理古城南门',
      capacity: 5,
      min_size: 3,
      fee_estimate: 30,
      source: 'matched',
      status: 'formed',
      slot: 'morning',
      area: '古城',
      formed_at: new Date(h1Start.getTime() - 2 * DAY).toISOString(),
      created_at: new Date(h1Start.getTime() - 2.2 * DAY).toISOString(),
    });
    const h1Keys = ['aye', 'xiaoman', 'qiqi', 'laozhou', 'nanfeng'];
    h1Keys.forEach((key) =>
      member(E.pastSunrise, key, {
        attendance: 'yes',
        invited_at: new Date(h1Start.getTime() - 2.2 * DAY).toISOString(),
        joined_at: new Date(h1Start.getTime() - 2 * DAY).toISOString(),
        arrived_at: new Date(h1Start.getTime() - 5 * MINUTE).toISOString(),
      }),
    );
    say(E.pastSunrise, null, SYSTEM_MESSAGES.formed, new Date(h1Start.getTime() - 2 * DAY).toISOString());
    readAll(E.pastSunrise);
    reviewed(E.pastSunrise, h1Keys, new Date(h1Start.getTime() + 5 * HOUR).toISOString());

    const h2Start = bjDateTime(addDays(today, -8), 8, 30);
    E.pastBreakfast = event({
      title: '喜洲稻田边吃早餐',
      category: 'food',
      task: '早餐',
      description: '稻田边的早餐铺，吃完沿着田埂走一走。',
      images: images('food'),
      exit_deadline: exitBefore(h2Start),
      start_at: h2Start.toISOString(),
      duration_min: 120,
      place: '喜洲古镇',
      capacity: 4,
      source: 'user',
      creator_id: U.qiqi,
      status: 'formed',
      formed_at: exitBefore(h2Start),
      created_at: new Date(h2Start.getTime() - 3 * DAY).toISOString(),
    });
    ['qiqi', 'lizi', 'nanfeng'].forEach((key, i) =>
      member(E.pastBreakfast, key, {
        role: key === 'qiqi' ? 'host' : 'member',
        attendance: 'yes',
        joined_at: new Date(h2Start.getTime() - (3 - i) * DAY).toISOString(),
      }),
    );
    reviewed(E.pastBreakfast, ['qiqi', 'lizi', 'nanfeng'], new Date(h2Start.getTime() + 3 * HOUR).toISOString());

    const h3Start = bjDateTime(addDays(today, -9), 14, 0);
    E.pastReading = event({
      title: '安静读书局 · 不用聊天',
      category: 'coffee',
      task: '读书',
      description: '各自带书，安静读两个小时。',
      images: images('reading'),
      exit_deadline: exitBefore(h3Start),
      start_at: h3Start.toISOString(),
      duration_min: 120,
      place: '人民路 · 慢书房咖啡',
      capacity: 4,
      fee_type: 'split',
      source: 'user',
      creator_id: U.nanfeng,
      status: 'formed',
      formed_at: exitBefore(h3Start),
      created_at: new Date(h3Start.getTime() - 2 * DAY).toISOString(),
    });
    ['nanfeng', 'lizi', 'mumu'].forEach((key, i) =>
      member(E.pastReading, key, {
        role: key === 'nanfeng' ? 'host' : 'member',
        attendance: 'yes',
        joined_at: new Date(h3Start.getTime() - (2 - i * 0.5) * DAY).toISOString(),
      }),
    );
    reviewed(E.pastReading, ['nanfeng', 'lizi', 'mumu'], new Date(h3Start.getTime() + 3 * HOUR).toISOString());

    const h4Start = bjDateTime(addDays(today, -4), 19, 0);
    E.pastNightMarket = event({
      title: '人民路夜市 · 边走边吃',
      category: 'food',
      task: '夜市',
      description: '人民路夜市边走边吃，吃到哪算哪。',
      images: images('food', 'oldtown'),
      exit_deadline: exitBefore(h4Start),
      start_at: h4Start.toISOString(),
      duration_min: 150,
      place: '古城人民路',
      capacity: 4,
      source: 'user',
      creator_id: U.qiqi,
      status: 'formed',
      formed_at: exitBefore(h4Start),
      created_at: new Date(h4Start.getTime() - 2 * DAY).toISOString(),
    });
    ['qiqi', 'dapeng', 'qingqing'].forEach((key, i) =>
      member(E.pastNightMarket, key, {
        role: key === 'qiqi' ? 'host' : 'member',
        attendance: 'yes',
        joined_at: new Date(h4Start.getTime() - (2 - i * 0.5) * DAY).toISOString(),
      }),
    );
    say(E.pastNightMarket, null, SYSTEM_MESSAGES.formedAtDeadline, exitBefore(h4Start));
    say(E.pastNightMarket, 'qiqi', '七点人民路口见～', new Date(h4Start.getTime() - 3 * HOUR).toISOString());
    const spam = say(
      E.pastNightMarket,
      'dapeng',
      '下次去双廊我带你们去个朋友的店，能拿内部价，回头私下找我',
      new Date(h4Start.getTime() - 2 * HOUR).toISOString(),
    );
    say(E.pastNightMarket, 'qingqing', '我就随便吃吃～', new Date(h4Start.getTime() - HOUR).toISOString());
    readAll(E.pastNightMarket);
    reviewed(E.pastNightMarket, ['qiqi', 'dapeng', 'qingqing'], new Date(h4Start.getTime() + 3 * HOUR).toISOString());

    // 60 天前的咖啡局：木木开场前 3 小时在群里说发烧去不了，但没点退出，被大家评成「没来」
    const h5Start = bjDateTime(addDays(today, -60), 14, 0);
    E.pastCoffee = event({
      title: '慢书房咖啡局',
      category: 'coffee',
      task: '咖啡',
      description: '人民路慢书房，喝咖啡、翻翻书。',
      images: images('coffee'),
      exit_deadline: exitBefore(h5Start),
      start_at: h5Start.toISOString(),
      duration_min: 120,
      place: '人民路 · 慢书房咖啡',
      capacity: 4,
      fee_type: 'split',
      source: 'user',
      creator_id: U.nanfeng,
      status: 'formed',
      formed_at: exitBefore(h5Start),
      created_at: new Date(h5Start.getTime() - 3 * DAY).toISOString(),
    });
    ['nanfeng', 'qiqi', 'mumu'].forEach((key, i) =>
      member(E.pastCoffee, key, {
        role: key === 'nanfeng' ? 'host' : 'member',
        attendance: key === 'mumu' ? 'pending' : 'yes',
        joined_at: new Date(h5Start.getTime() - (3 - i * 0.5) * DAY).toISOString(),
      }),
    );
    say(E.pastCoffee, null, SYSTEM_MESSAGES.formedAtDeadline, exitBefore(h5Start));
    say(E.pastCoffee, 'nanfeng', '明天下午两点慢书房见～', new Date(h5Start.getTime() - 20 * HOUR).toISOString());
    say(E.pastCoffee, 'mumu', '抱歉，我发烧了，今天去不了了', new Date(h5Start.getTime() - 3 * HOUR).toISOString());
    readAll(E.pastCoffee);
    const h5End = new Date(h5Start.getTime() + 3 * HOUR).toISOString();
    for (const [from, to, attendance] of [
      ['nanfeng', 'qiqi', 'on_time'],
      ['nanfeng', 'mumu', 'no_show'],
      ['qiqi', 'nanfeng', 'on_time'],
      ['qiqi', 'mumu', 'no_show'],
    ]) {
      db.insert('reviews', { event_id: E.pastCoffee, reviewer_id: U[from], target_id: U[to], attendance, created_at: h5End });
    }
    for (const key of ['nanfeng', 'qiqi']) {
      db.insert('review_feelings', { event_id: E.pastCoffee, reviewer_id: U[key], feelings: '[]', created_at: h5End });
      db.insert('credit_events', { user_id: U[key], event_id: E.pastCoffee, type: 'attended', source: 'review', note: '互评结果', revoked: 0, created_at: h5End });
    }
    const mumuNoShow = db.insert('credit_events', {
      user_id: U.mumu,
      event_id: E.pastCoffee,
      type: 'no_show',
      source: 'review',
      note: '互评结果（2 票）',
      revoked: 0,
      created_at: h5End,
    });

    // ---- 广场上的 open 局 ----
    const squareEvent = (key, title, row, memberKeys) => {
      const id = event({
        title,
        source: 'user',
        creator_id: U[memberKeys[0]],
        status: 'open',
        exit_deadline: exitOpen(new Date(row.start_at)),
        created_at: ago(2 * DAY),
        ...row,
      });
      memberKeys.forEach((k, i) =>
        member(id, k, { role: i === 0 ? 'host' : 'member', joined_at: ago(2 * DAY - i * 3 * HOUR) }),
      );
      E[key] = id;
      return id;
    };
    squareEvent(
      'reading',
      '安静读书局 · 不用聊天',
      {
        category: 'coffee',
        task: '读书',
        description: '各自带书，安静读两个小时。想聊再聊，不聊也很好。',
        images: images('reading', 'coffee'),
        location: json.str({ name: '人民路咖啡馆', address: '大理古城人民路中段', latitude: 25.6953, longitude: 100.1597 }),
        start_at: bjDateTime(fri, 14, 0).toISOString(),
        duration_min: 120,
        place: '人民路咖啡馆',
        meeting_point: '靠窗的长桌',
        capacity: 4,
        fee_type: 'split',
      },
      ['nanfeng', 'qiqi'],
    );
    squareEvent(
      'breakfast',
      '喜洲稻田边吃早餐',
      {
        category: 'food',
        task: '早餐',
        description: '稻田边的早餐铺，吃完沿着田埂走一走。',
        images: images('food', 'lake'),
        location: json.str({ name: '喜洲古镇四方街', address: '大理市喜洲镇四方街', latitude: 25.8524, longitude: 100.1301 }),
        start_at: bjDateTime(sun, 8, 30).toISOString(),
        duration_min: 120,
        place: '喜洲古镇',
        meeting_point: '喜洲古镇四方街',
        capacity: 4,
        fee_type: 'aa',
      },
      ['qiqi', 'nanfeng', 'xiaoman'],
    );
    squareEvent(
      'carpool',
      '拼车去双廊',
      {
        category: 'carpool',
        task: '拼车',
        description: '包车去双廊，下午在海边随便逛，傍晚一起回。车费 AA。',
        images: images('carpool', 'lake'),
        location: json.str({ name: '大理古城北门', address: '大理古城复兴路北端停车场', latitude: 25.7012, longitude: 100.1589 }),
        start_at: bjDateTime(sat, 10, 30).toISOString(),
        duration_min: 480,
        place: '古城北门',
        meeting_point: '北门停车场',
        capacity: 4,
        fee_type: 'aa',
        fee_estimate: 40,
      },
      ['aye', 'qiqi', 'mumu'],
    );
    squareEvent(
      'cycling',
      '洱海西岸骑行',
      {
        category: 'outdoor',
        task: '骑行',
        description: '沿洱海西岸慢慢骑，租车自理，骑累了就停下来拍照。',
        images: images('cycling', 'lake'),
        location: json.str({ name: '才村码头', address: '大理市才村洱海边', latitude: 25.6745, longitude: 100.1993 }),
        start_at: bjDateTime(sun, 15, 0).toISOString(),
        duration_min: 180,
        place: '才村码头',
        meeting_point: '才村码头租车点',
        capacity: 6,
        fee_type: 'split',
      },
      ['mumu', 'xiaoman'],
    );

    // 待审核的用户局（内容审核命中）
    E.pendingReview = event({
      title: '夜市小吃 · 包车接送',
      category: 'food',
      task: '夜市',
      description: '加我vx dapeng888，优惠价包车接送，吃完送回客栈。',
      exit_deadline: exitOpen(bjDateTime(sat, 19, 0)),
      start_at: bjDateTime(sat, 19, 0).toISOString(),
      duration_min: 150,
      place: '古城人民路夜市',
      capacity: 6,
      source: 'user',
      creator_id: U.dapeng,
      status: 'pending_review',
      moderation: json.str(['包含微信 / QQ 等联系方式']),
      created_at: ago(2 * DAY),
    });
    member(E.pendingReview, 'dapeng', { role: 'host', joined_at: ago(2 * DAY) });

    // ---- 撮合意向（撮合池）----
    const intent = (key, row) =>
      db.insert('intents', { user_id: U[key], area: '古城', size_min: 3, size_max: 5, status: 'open', ...row });
    const lizIntent = intent('lizi', { task: '骑行', category: 'outdoor', label: '洱海边骑行', date_from: sun, date_to: sun, slot: 'afternoon', created_at: ago(2 * HOUR) });
    intent('nanfeng', { task: '骑行', category: 'outdoor', label: '环洱海骑一段', date_from: sun, date_to: sun, slot: 'afternoon', created_at: ago(5 * HOUR) });
    intent('aye', { task: '爬山', category: 'outdoor', date_from: sun, date_to: sun, slot: 'morning', created_at: ago(10 * HOUR) });
    intent('xiaolin', { task: '爬山', category: 'outdoor', date_from: sun, date_to: sun, slot: 'morning', created_at: ago(6 * HOUR) });
    intent('laozhou', { task: '爬山', category: 'outdoor', date_from: sun, date_to: sun, slot: 'morning', created_at: ago(4 * HOUR) });
    const tomorrow = addDays(today, 1);
    intent('ayun', { task: '咖啡', category: 'coffee', date_from: tomorrow, date_to: tomorrow, slot: 'afternoon', created_at: ago(3 * HOUR) });
    intent('qingqing', { task: '咖啡', category: 'coffee', date_from: tomorrow, date_to: tomorrow, slot: 'afternoon', created_at: ago(HOUR) });

    // ---- 动态 + 评论（大多带 1–4 张图）----
    const post = (key, text, imgKeys, at, extra = {}) =>
      db.insert('posts', {
        user_id: U[key],
        text,
        images: images(...imgKeys),
        event_id: null,
        visibility: 'public',
        status: 'approved',
        created_at: at,
        ...extra,
      });
    // 按时间先后插入（id 越大越新，列表按 id 倒序）
    post('ayun', '刚到大理一周，还在适应慢下来的节奏。', [], ago(5 * DAY + 2 * HOUR));
    post('xiaoman', '古城里随便走走，拐进一家很安静的咖啡馆，坐了一下午。', ['oldtown', 'coffee'], ago(5 * DAY));
    post('qingqing', '在洱海边画了一下午，水的颜色一直在变。', ['lake'], ago(4 * DAY + 3 * HOUR));
    post('laozhou', '退休以后每天爬一点苍山，今天走到了中和寺，山上的云很低。', ['mountain'], ago(4 * DAY));
    post('nanfeng', '安静读书局真的一句话都没聊，读完各自说了说在读什么，很舒服。', ['reading', 'coffee'], ago(3 * DAY + 6 * HOUR), {
      event_id: E.pastReading,
    });
    post('lizi', '喜洲稻田边的早餐，吃完沿着田埂慢慢走，风里都是稻子的味道。', ['food', 'lake'], ago(3 * DAY), {
      event_id: E.pastBreakfast,
    });
    post('qiqi', '人民路夜市从头吃到尾，烤乳扇和木瓜水都很好吃，下次还来。', ['food', 'oldtown'], ago(2 * DAY), {
      event_id: E.pastNightMarket,
    });
    post('nanfeng', '环洱海骑了第三次，这次骑得最慢，停下来看了好几次水鸟。', ['cycling', 'lake', 'sunrise'], ago(DAY + 5 * HOUR));
    const post2 = post(
      'mumu',
      '第一次参加桌游局，前五分钟有点紧张，后来笑了一整晚。新手友好是真的。',
      ['boardgame'],
      ago(DAY),
      { event_id: E.boardgame },
    );
    const post1 = post(
      'aye',
      '凌晨爬起来真的值。一路上没人尬聊，太阳出来那一刻大家都没说话，刚刚好。',
      ['sunrise', 'mountain', 'carpool', 'food'],
      ago(2 * HOUR),
      { event_id: E.pastSunrise },
    );
    const comment = (postId, key, text, at, replyTo = null) =>
      db.insert('comments', { post_id: postId, user_id: U[key], reply_to_user_id: replyTo ? U[replyTo] : null, text, status: 'approved', created_at: at });
    comment(post1, 'xiaoman', '那天的云太好看了，下次还一起', ago(HOUR));
    comment(post1, 'mumu', '求下次带上我！', ago(58 * MINUTE));
    comment(post1, 'qiqi', '照片拍得好安静', ago(40 * MINUTE));
    comment(post1, 'nanfeng', '想问下几点出发能赶上日出？', ago(20 * MINUTE));
    comment(post1, 'aye', '5:50 古城南门集合刚好', ago(18 * MINUTE), 'nanfeng');
    for (const key of ['xiaoman', 'mumu', 'qiqi', 'nanfeng', 'laozhou']) {
      db.insert('post_likes', { post_id: post1, user_id: U[key], created_at: ago(HOUR) });
    }
    for (const key of ['qiqi', 'aye', 'nanfeng']) {
      db.insert('post_likes', { post_id: post2, user_id: U[key], created_at: ago(20 * HOUR) });
    }

    // ---- 首页轮播图 ----
    const banner = (sort, image, title, subtitle, link) =>
      db.insert('banners', { image: IMG[image], title, subtitle, link, sort, enabled: 1, created_at: ago(3 * DAY) });
    banner(0, 'sunrise', '苍山日出', '周六清晨，古城南门集合，一起上山看日出', `event:${E.sunrise}`);
    banner(1, 'cycling', '洱海骑行', '沿着西岸慢慢骑，累了就停下来拍照', 'square');
    banner(2, 'oldtown', '新人第一次来', '先看看社区公约：不尬聊、不推销，守约就好', 'rules');

    // ---- 举报、拉黑、限制 ----
    db.insert('blocks', { user_id: U.lizi, blocked_id: U.dapeng, created_at: ago(2 * DAY) });
    db.insert('reports', {
      reporter_id: U.lizi,
      target_type: 'user',
      target_id: U.dapeng,
      target_user_id: U.dapeng,
      reason: '骚扰或不当言行',
      detail: '拼车的时候一直打听我住哪个客栈，让人很不舒服',
      images: '[]',
      status: 'resolved',
      action: 'restrict_7d',
      admin_note: '核实属实，限制 7 天',
      created_at: ago(2 * DAY),
      resolved_at: ago(DAY),
    });
    db.update('users', U.dapeng, {
      status: 'restricted',
      restricted_until: new Date(t - DAY + 7 * DAY).toISOString(),
      restricted_reason: '被举报并核实违反社区公约',
    });
    db.insert('reports', {
      reporter_id: U.qiqi,
      target_type: 'message',
      target_id: spam,
      target_user_id: U.dapeng,
      reason: '推销 / 拉人头',
      detail: '在夜市局的群里拉大家去他朋友的店',
      images: '[]',
      status: 'pending',
      created_at: ago(5 * HOUR),
    });
    db.insert('reports', {
      reporter_id: U.aye,
      target_type: 'user',
      target_id: U.dapeng,
      target_user_id: U.dapeng,
      reason: '骚扰或不当言行',
      detail: '在群里反复问女生住哪个客栈',
      images: '[]',
      status: 'pending',
      created_at: ago(3 * HOUR),
    });

    // ---- 申诉：木木那次「放鸽子」----
    db.insert('appeals', {
      user_id: U.mumu,
      credit_event_id: mumuNoShow,
      text: '那天发高烧在客栈躺了一天，提前在群里说过，可能大家没看到',
      status: 'pending',
      created_at: ago(DAY),
    });

    // ---- 通知 ----
    const notice = (key, row) => db.insert('notices', { user_id: U[key], body: '', link: null, read: 0, ...row });
    notice('lizi', { type: 'match', title: '撮合成功', body: '配到了！「苍山看日出」，去看看同行的人，确认加入吧', link: `match:${E.sunrise}`, read: 1, created_at: ago(8 * HOUR) });
    notice('lizi', { type: 'formed', title: '满员啦，群已建好', body: '「苍山看日出」5 人，群聊已开启。第一次见面，慢慢来', link: `chat:${E.sunrise}`, read: 1, created_at: ago(6 * HOUR) });
    notice('lizi', { type: 'aa_bill', title: 'AA 记账 · 苍山看日出', body: '阿野 记了这个局的 AA：共 ¥150（车费 + 早餐），每人 ¥30，转给阿野', link: `chat:${E.sunrise}`, created_at: ago(2 * HOUR) });
    notice('lizi', { type: 'report_result', title: '你的举报已处理', body: '对方已被限制使用', created_at: ago(DAY) });
    notice('dapeng', { type: 'restricted', title: '账号暂停撮合和报名 7 天', body: '原因：被举报并核实违反社区公约。到期后自动恢复。', link: 'credit', created_at: ago(DAY) });

    // ---- 标签：按上面的意向和局补上「最近一次用到」的时间 ----
    syncTagUsage(db);

    // ---- 跑一次撮合：生成 1 条待后台确认的建议局（爬山）----
    const matching = runMatching(db);

    return { users: U, events: E, intents: { liziCycling: lizIntent }, matching };
  });
}

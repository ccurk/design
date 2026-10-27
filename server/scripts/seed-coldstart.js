// npm run seed:cold：冷启动数据，不清库、可叠加（按种子账号判断是否已播过）。
//
// 造两类数据：
//   1) 历史「已成团」的局 + 一批种子用户当成员 —— 撑场面 / 社会证明。这些局已结束、
//      不进广场、真人加不到,所以不存在「假人不到场」的问题,只体现在首页统计和个人主页。
//   2) 未来「运营带队」的开放局 —— 运营号先占一位,其余留给真人。真人能看到也能加入。
// 日常新鲜度由服务进程里的每日自动发布(jobs.js → publishDailyEvents)持续补充。
import { clock, DAY, HOUR } from '../src/clock.js';
import { loadConfig, loadEnvFile } from '../src/config.js';
import { json, openDb } from '../src/db.js';
import { addDays, bjDate, bjDateTime, slotLabel, weekdayName } from '../src/time.js';
import { EVENT_TEMPLATES, ensureOperator, publishPlatformEvent } from '../src/services/platformEvents.js';
import { ensureDefaultTags } from '../src/services/tags.js';

// 种子用户（撑场面用,只进历史已成团的局）。openid 以 seedc_ 开头,便于识别和去重。
const SEED_USERS = [
  ['阿柯', 'female', 'slow', ['看日出', '咖啡', '读书']],
  ['南风', 'male', 'warm', ['骑行', '徒步', '拼车']],
  ['小鹿', 'female', 'slow', ['读书', '咖啡']],
  ['老陈', 'male', 'open', ['桌游', '夜市']],
  ['橙子', 'female', 'warm', ['看日出', '徒步']],
  ['大林', 'male', 'slow', ['骑行', '看日出']],
  ['可可', 'female', 'open', ['咖啡', '桌游', '夜市']],
  ['阿海', 'male', 'warm', ['徒步', '骑行']],
  ['糖糖', 'female', 'slow', ['读书', '咖啡']],
  ['七月', 'female', 'warm', ['看日出', '夜市', '拼车']],
  ['阿布', 'male', 'open', ['桌游', '骑行']],
  ['芒果', 'female', 'slow', ['徒步', '读书']],
  ['老周', 'male', 'warm', ['拼车', '夜市']],
  ['小满', 'female', 'open', ['咖啡', '看日出']],
  ['竹子', 'male', 'slow', ['读书', '徒步']],
  ['阿远', 'male', 'open', ['骑行', '桌游', '夜市']],
];

loadEnvFile();
const config = loadConfig();
const force = process.argv.includes('--force');

const db = openDb(config.dbPath);

const already = db.get("SELECT COUNT(*) AS n FROM users WHERE openid LIKE 'seedc_%'").n;
if (already > 0 && !force) {
  console.error(`检测到已有 ${already} 个冷启动种子账号,看起来已经播过了。要再播一次请加 --force。`);
  db.close();
  process.exit(1);
}

const result = db.tx(() => {
  ensureDefaultTags(db);
  const operatorId = ensureOperator(db);

  // ---- 种子用户 ----
  const userIds = SEED_USERS.map(([nickname, gender, pace, interests], i) =>
    db.insert('users', {
      openid: `seedc_${i + 1}`,
      nickname,
      bio: '',
      gender,
      pace,
      interests: json.str(interests),
      status: 'active',
      settings: json.str({ sameSexOnly: false, checkInReminder: true, profileOpen: true }),
      onboarded: 1,
      created_at: new Date(clock.now().getTime() - (20 + i) * DAY).toISOString(),
    }),
  );

  // ---- 历史已成团的局（撑场面）----
  const today = bjDate(clock.now());
  let member = 0; // 轮换取成员,保证分布均匀
  let historical = 0;
  for (let k = 0; k < 12; k++) {
    const template = EVENT_TEMPLATES[k % EVENT_TEMPLATES.length];
    const [h, m] = template.start;
    const daysAgo = 2 + k * 2; // 散在过去约 3 周
    const startAt = bjDateTime(addDays(today, -daysAgo), h, m);
    const size = 3 + (k % 4); // 3~6 人
    const label = template.slot === 'allday' ? '' : slotLabel(template.slot, template.task);
    const eventId = db.insert('events', {
      title: `${weekdayName(startAt)}${label} · ${template.title}`.slice(0, 30),
      category: template.category,
      task: template.task,
      description: template.description,
      start_at: startAt.toISOString(),
      duration_min: template.durationMin,
      place: template.place,
      meeting_point: template.meetingPoint,
      capacity: template.capacity,
      min_size: template.minSize,
      fee_type: 'aa',
      require_approval: 0,
      same_sex_only: 0,
      source: 'platform',
      creator_id: null,
      status: 'formed',
      formed_at: new Date(startAt.getTime() - 2 * DAY).toISOString(),
      exit_deadline: new Date(startAt.getTime() - DAY).toISOString(),
      created_at: new Date(startAt.getTime() - 5 * DAY).toISOString(),
    });
    for (let j = 0; j < size; j++) {
      db.insert('event_members', {
        event_id: eventId,
        user_id: userIds[member++ % userIds.length],
        role: 'member',
        status: 'joined',
        attendance: 'pending',
        joined_at: new Date(startAt.getTime() - 3 * DAY).toISOString(),
      });
    }
    historical++;
  }

  // ---- 未来运营带队的开放局（真人能加入）----
  let future = 0;
  let i = 0;
  for (let d = 1; d <= 5; d++) {
    for (let n = 0; n < 2; n++) {
      publishPlatformEvent(db, EVENT_TEMPLATES[i++ % EVENT_TEMPLATES.length], { date: addDays(today, d), operatorId });
      future++;
    }
  }

  return { users: userIds.length, historical, future };
});

const count = (sql, ...a) => db.get(sql, ...a).n;
console.log(`冷启动数据已写入 ${config.dbPath}（不清库、可叠加）`);
console.log(`  运营账号「大理活动小助手」已就位`);
console.log(`  种子用户 ${result.users} 个`);
console.log(`  历史已成团的局 ${result.historical} 个（撑场面：进首页统计和个人主页,不进广场）`);
console.log(`  未来运营带队的开放局 ${result.future} 个（真人可在广场看到并加入）`);
console.log(`  当前平台局总数 ${count("SELECT COUNT(*) AS n FROM events WHERE source = 'platform'")}`);
console.log(`  之后每天由服务进程自动再发布运营局（jobs.js → publishDailyEvents）`);
db.close();

// npm run seed：清空数据库并写入演示数据（docs/api.md 第 6 节）。
import { loadConfig, loadEnvFile } from '../src/config.js';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';

loadEnvFile();
const config = loadConfig();

if (config.isProd && !process.argv.includes('--force')) {
  console.error('生产环境下 seed 会清空数据库。确定要这样做请加 --force');
  process.exit(1);
}

const db = openDb(config.dbPath);
const result = seed(db);
const count = (table) => db.get(`SELECT COUNT(*) AS n FROM ${table}`).n;

console.log(`演示数据已写入 ${config.dbPath}`);
console.log(
  `  用户 ${count('users')} · 局 ${count('events')} · 意向 ${count('intents')} · 待确认建议 ${
    db.get("SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'").n
  } · 动态 ${count('posts')} · 评论 ${count('comments')} · 待处理举报 ${
    db.get("SELECT COUNT(*) AS n FROM reports WHERE status = 'pending'").n
  } · 申诉 ${count('appeals')}`,
);
console.log(`  演示账号：栗子（userId=${result.users.lizi}），开发环境 POST /api/auth/dev-login 不传 userId 即登录`);
console.log(`  后台密码：${config.adminPasswordMissing ? 'admin123（开发默认）' : '见 ADMIN_PASSWORD'}`);
db.close();

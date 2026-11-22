// npm run seed：清空数据库并写入演示数据（docs/api.md 第 6 节）。
import { loadConfig, loadEnvFile } from '../src/config.js';
import { ensureDatabase, openDb } from '../src/db.js';
import { seed } from '../src/seed.js';

loadEnvFile();
const config = loadConfig();

if (config.isProd && !process.argv.includes('--force')) {
  console.error('生产环境下 seed 会清空数据库。确定要这样做请加 --force');
  process.exit(1);
}

await ensureDatabase(config.db);
const db = await openDb(config.db);
const result = await seed(db, { uploadDir: config.uploadDir }); // 配图复制进上传目录
const count = async (table) => (await db.get(`SELECT COUNT(*) AS n FROM ${table}`)).n;
const pending = async (sql) => (await db.get(sql)).n;

console.log(`演示数据已写入 MySQL ${config.db.database}`);
console.log(
  `  用户 ${await count('users')} · 局 ${await count('events')} · 意向 ${await count('intents')} · 待确认建议 ${await pending(
    "SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'",
  )} · 动态 ${await count('posts')} · 评论 ${await count('comments')} · 轮播图 ${await count('banners')} · 标签 ${await count('tags')} · 待处理举报 ${await pending(
    "SELECT COUNT(*) AS n FROM reports WHERE status = 'pending'",
  )} · 申诉 ${await count('appeals')}`,
);
console.log(`  配图已复制到 ${config.uploadDir}（seed-*.png）`);
console.log(`  演示账号：栗子（userId=${result.users.lizi}），开发环境 POST /api/auth/dev-login 不传 userId 即登录`);
console.log(`  后台密码：${config.adminPasswordMissing ? 'admin123（开发默认）' : '见 ADMIN_PASSWORD'}`);
await db.close();

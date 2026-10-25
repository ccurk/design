// 入口：读配置 → 打开数据库 → 启动 HTTP 服务和定时任务。
import { createApp } from './app.js';
import { loadConfig, loadEnvFile } from './config.js';
import { openDb } from './db.js';
import { startJobs } from './jobs.js';
import { createLogger } from './logger.js';

loadEnvFile();
const config = loadConfig();
const logger = createLogger(config.logLevel);

if (!config.adminPassword) {
  logger.error('生产环境必须设置 ADMIN_PASSWORD');
  process.exit(1);
}
if (config.adminPasswordMissing) logger.warn('未设置 ADMIN_PASSWORD，后台密码使用开发默认值 admin123（不要用于生产）');
if (!config.wechatConfigured) {
  logger.warn(
    config.isProd
      ? '未配置 WX_APPID / WX_SECRET：生产环境下微信登录和手机号验证将不可用'
      : '未配置 WX_APPID / WX_SECRET：开发模式，openid = dev_<code>，手机号随机生成',
  );
}

const db = openDb(config.dbPath);
const app = createApp({ db, config, logger });
const server = app.listen(config.port, () => {
  logger.info(`活动搭子后端已启动：http://localhost:${config.port}（数据库 ${config.dbPath}）`);
});

const jobs = process.env.JOBS === 'off' || config.isTest ? null : startJobs({ db, config, logger });

function shutdown(signal) {
  logger.info(`收到 ${signal}，正在关闭…`);
  jobs?.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

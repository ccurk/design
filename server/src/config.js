// 配置：全部来自环境变量；server/.env 会被自动加载（不覆盖已存在的变量）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 读取 .env：KEY=VALUE，支持 # 注释和引号；已存在的环境变量优先 */
export function loadEnvFile(file = path.join(SERVER_DIR, '.env'), env = process.env) {
  if (!fs.existsSync(file)) return false;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (env[key] === undefined) env[key] = value;
  }
  return true;
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';
  const port = Number(env.PORT) || 3000;
  const resolve = (p) => (path.isAbsolute(p) ? p : path.resolve(SERVER_DIR, p));
  const dbPath = env.DB_PATH === ':memory:' ? ':memory:' : resolve(env.DB_PATH || 'data/dazi.db');
  const adminPasswordMissing = !env.ADMIN_PASSWORD;
  return {
    nodeEnv,
    isProd,
    isTest: nodeEnv === 'test',
    port,
    dbPath,
    adminPassword: env.ADMIN_PASSWORD || (isProd ? null : 'admin123'),
    adminPasswordMissing,
    wxAppId: env.WX_APPID || '',
    wxSecret: env.WX_SECRET || '',
    wechatConfigured: Boolean(env.WX_APPID && env.WX_SECRET),
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    uploadDir: resolve(env.UPLOAD_DIR || 'uploads'),
    adminDir: resolve(env.ADMIN_DIR || '../admin'),
    logLevel: env.LOG_LEVEL || (nodeEnv === 'test' ? 'silent' : 'info'),
    // 开发辅助接口（dev-login、时间穿越）只在非生产环境开放
    devTools: !isProd,
  };
}

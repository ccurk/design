// 测试工具：每个测试进程用一个独立的 MySQL 库（按 pid 命名，互不干扰），每个测试前清表；
// createApp + app.listen(0)，通过 fetch 走 HTTP。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { createApp } from '../src/app.js';
import { clock } from '../src/clock.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';

export const ADMIN_PASSWORD = 'test-admin-pass';

/** 北京时间 2026-10-26（周一）10:00 */
export const MONDAY_10AM = '2026-10-26T02:00:00.000Z';

const MYSQL = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT) || 3306,
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || 'root',
};
// 每个测试进程一个库，并行跑也不会互相踩
const TEST_DB = `dazi_test_${process.pid}`;
let dbReady = null;
function ensureTestDb() {
  if (!dbReady) {
    dbReady = (async () => {
      const admin = await mysql.createConnection(MYSQL);
      await admin.query(`CREATE DATABASE IF NOT EXISTS \`${TEST_DB}\` CHARACTER SET utf8mb4`);
      await admin.end();
    })();
  }
  return dbReady;
}

/** 开一个独立的干净库（不经过 createApp，所以不会写入默认标签）——用于测老库/初始化逻辑 */
export async function openFreshDb(suffix = Math.random().toString(36).slice(2, 8)) {
  const name = `dazi_test_${process.pid}_${suffix}`;
  const admin = await mysql.createConnection(MYSQL);
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4`);
  await admin.end();
  const db = await openDb({ ...MYSQL, database: name, connectionLimit: 1 });
  await db.reset();
  return db;
}

/** 用一段「老库」DDL + 数据建一个独立库，再用 openDb 打开（会触发补列迁移）。
 * 返回 {db, cols(table), reopen()}，用于测老库升级不丢数据、不重复加列。 */
export async function openMigratedDb(suffix, setupSql) {
  const name = `dazi_test_${process.pid}_${suffix}`;
  const admin = await mysql.createConnection({ ...MYSQL, multipleStatements: true });
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\`; CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4;`);
  await admin.end();
  const raw = await mysql.createConnection({ ...MYSQL, database: name, multipleStatements: true });
  await raw.query(setupSql);
  await raw.end();
  const reopen = () => openDb({ ...MYSQL, database: name, connectionLimit: 1 });
  const db = await reopen();
  const cols = async (table) =>
    (
      await db.all(
        'SELECT column_name AS c FROM information_schema.columns WHERE table_schema = ? AND table_name = ?',
        name,
        table,
      )
    ).map((r) => r.c);
  return { db, cols, reopen };
}

export async function startServer({ now = MONDAY_10AM } = {}) {
  clock.set(now);
  await ensureTestDb();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dazi-test-uploads-'));
  // 测试用单连接池：让 Promise.all 的插入在同一连接上按调用顺序串行，AUTO_INCREMENT 的 id 才确定
  const config = loadConfig({ NODE_ENV: 'test', MYSQL_DATABASE: TEST_DB, MYSQL_POOL: '1', UPLOAD_DIR: uploadDir, ADMIN_PASSWORD, LOG_LEVEL: process.env.LOG_LEVEL });
  const db = await openDb(config.db);
  await db.reset(); // 清掉上一个测试留下的数据
  const app = await createApp({ db, config });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function api(method, url, { body, token, form } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body: payload });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, body: data };
  }

  /** 断言 2xx 并返回 body */
  async function ok(method, url, opts) {
    const res = await api(method, url, opts);
    if (res.status >= 300) {
      throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body;
  }

  async function login(userId) {
    return (await ok('POST', '/api/auth/dev-login', { body: { userId } })).token;
  }

  async function adminToken() {
    return (await ok('POST', '/api/admin/login', { body: { password: ADMIN_PASSWORD } })).token;
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    await db.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
    clock.reset();
  }

  return { db, config, base, api, ok, login, adminToken, close };
}

let seq = 0;
/** 直接在数据库里建用户 */
export async function makeUser(db, overrides = {}) {
  seq++;
  const { settings, interests, ...rest } = overrides;
  return db.insert('users', {
    openid: `test_${seq}_${Math.random().toString(36).slice(2)}`,
    nickname: `用户${seq}`,
    bio: '',
    gender: 'female',
    pace: 'slow',
    interests: JSON.stringify(interests ?? ['看日出']),
    status: 'active',
    settings: JSON.stringify({ sameSexOnly: false, checkInReminder: true, profileOpen: true, ...(settings || {}) }),
    onboarded: 1,
    created_at: clock.iso(),
    ...rest,
  });
}

/** 直接写信用记录 */
export async function addCredit(db, userId, type, n = 1, { daysAgo = 40, eventId = null, source = 'review' } = {}) {
  for (let i = 0; i < n; i++) {
    await db.insert('credit_events', {
      user_id: userId,
      event_id: eventId,
      type,
      source,
      note: 'test',
      revoked: 0,
      created_at: new Date(clock.now().getTime() - daysAgo * 86400000).toISOString(),
    });
  }
}

/** 直接写一条撮合意向 */
export async function makeIntent(db, userId, overrides = {}) {
  return db.insert('intents', {
    user_id: userId,
    task: '看日出',
    category: 'outdoor',
    date_from: '2026-10-31',
    date_to: '2026-10-31',
    slot: 'morning',
    area: '古城',
    size_min: 3,
    size_max: 5,
    relax_time: 0,
    relax_size: 0,
    status: 'open',
    created_at: clock.iso(),
    ...overrides,
  });
}

export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;

// 测试工具：内存数据库 + createApp + app.listen(0)，通过 fetch 走 HTTP。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { clock } from '../src/clock.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';

export const ADMIN_PASSWORD = 'test-admin-pass';

/** 北京时间 2026-10-26（周一）10:00 */
export const MONDAY_10AM = '2026-10-26T02:00:00.000Z';

export async function startServer({ now = MONDAY_10AM } = {}) {
  clock.set(now);
  const db = openDb(':memory:');
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dazi-test-uploads-'));
  const config = loadConfig({ NODE_ENV: 'test', DB_PATH: ':memory:', UPLOAD_DIR: uploadDir, ADMIN_PASSWORD });
  const app = createApp({ db, config });
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
    db.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
    clock.reset();
  }

  return { db, config, base, api, ok, login, adminToken, close };
}

let seq = 0;
/** 直接在数据库里建用户 */
export function makeUser(db, overrides = {}) {
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
export function addCredit(db, userId, type, n = 1, { daysAgo = 40, eventId = null, source = 'review' } = {}) {
  for (let i = 0; i < n; i++) {
    db.insert('credit_events', {
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
export function makeIntent(db, userId, overrides = {}) {
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

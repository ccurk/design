// MySQL（mysql2）封装：建表、连接池、事务（用 AsyncLocalStorage 跟踪当前事务连接，支持嵌套 SAVEPOINT）。
// 从 SQLite 迁移而来：接口仍是 get/all/run/insert/update/tx，但全部改为 async（返回 Promise）。
//
// 与 SQLite schema 的差异：索引/主键/唯一用到的文本列改 VARCHAR；长文本/JSON 用 TEXT（MySQL8 括号默认值）；
// REAL→DOUBLE、INTEGER→INT、AUTOINCREMENT→AUTO_INCREMENT；不建外键（应用层维护完整性）；
// 索引写进建表语句；保留字列 key/value/read 用反引号。
import { AsyncLocalStorage } from 'node:async_hooks';
import mysql from 'mysql2/promise';
import { bjDate, weekdayName } from './time.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    openid VARCHAR(255) NOT NULL UNIQUE,
    phone VARCHAR(32),
    nickname VARCHAR(64) NOT NULL,
    avatar_url VARCHAR(512),
    cover_url VARCHAR(512),
    bio VARCHAR(512) NOT NULL DEFAULT '',
    gender VARCHAR(16) NOT NULL DEFAULT 'unknown',
    pace VARCHAR(16),
    interests TEXT NOT NULL DEFAULT ('[]'),
    phone_verified INT NOT NULL DEFAULT 0,
    id_verified INT NOT NULL DEFAULT 0,
    is_leader INT NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    restricted_until VARCHAR(40),
    restricted_reason VARCHAR(255),
    settings TEXT NOT NULL DEFAULT ('{}'),
    emergency_contact TEXT,
    onboarded INT NOT NULL DEFAULT 0,
    created_at VARCHAR(40) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token VARCHAR(255) PRIMARY KEY,
    user_id INT NOT NULL,
    created_at VARCHAR(40) NOT NULL,
    expires_at VARCHAR(40) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS admin_sessions (
    token VARCHAR(255) PRIMARY KEY,
    created_at VARCHAR(40) NOT NULL,
    expires_at VARCHAR(40) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS intents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    task VARCHAR(64) NOT NULL,
    category VARCHAR(32) NOT NULL,
    label VARCHAR(64),
    date_from VARCHAR(40) NOT NULL,
    date_to VARCHAR(40) NOT NULL,
    slot VARCHAR(16) NOT NULL,
    area VARCHAR(64) NOT NULL,
    areas TEXT,
    same_sex_only INT NOT NULL DEFAULT 0,
    size_min INT NOT NULL DEFAULT 3,
    size_max INT NOT NULL DEFAULT 5,
    relax_time INT NOT NULL DEFAULT 0,
    relax_size INT NOT NULL DEFAULT 0,
    time_from VARCHAR(16),
    time_to VARCHAR(16),
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    event_id INT,
    proposal_id INT,
    created_at VARCHAR(40) NOT NULL,
    updated_at VARCHAR(40),
    INDEX idx_intents_status (status),
    INDEX idx_intents_user (user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS proposals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task VARCHAR(64) NOT NULL,
    category VARCHAR(32) NOT NULL,
    date VARCHAR(40) NOT NULL,
    slot VARCHAR(16) NOT NULL,
    area VARCHAR(64) NOT NULL,
    title VARCHAR(255) NOT NULL,
    intent_ids TEXT NOT NULL DEFAULT ('[]'),
    user_ids TEXT NOT NULL DEFAULT ('[]'),
    score INT NOT NULL DEFAULT 0,
    reasons TEXT NOT NULL DEFAULT ('[]'),
    risks TEXT NOT NULL DEFAULT ('[]'),
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    event_id INT,
    created_at VARCHAR(40) NOT NULL,
    reviewed_at VARCHAR(40),
    review_note VARCHAR(255),
    INDEX idx_proposals_status (status)
  )`,
  `CREATE TABLE IF NOT EXISTS leader_applications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    real_name VARCHAR(64),
    specialties TEXT,
    emergency_name VARCHAR(64),
    emergency_phone VARCHAR(32),
    intro TEXT NOT NULL,
    images TEXT NOT NULL DEFAULT ('[]'),
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    note VARCHAR(255),
    created_at VARCHAR(40) NOT NULL,
    reviewed_at VARCHAR(40),
    INDEX idx_leader_apps (status, id)
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    category VARCHAR(32) NOT NULL,
    task VARCHAR(64),
    description VARCHAR(1000) NOT NULL DEFAULT '',
    start_at VARCHAR(40) NOT NULL,
    duration_min INT NOT NULL DEFAULT 120,
    place VARCHAR(255) NOT NULL DEFAULT '',
    meeting_point VARCHAR(255) NOT NULL DEFAULT '',
    capacity INT NOT NULL,
    min_size INT NOT NULL DEFAULT 3,
    fee_type VARCHAR(16) NOT NULL DEFAULT 'aa',
    fee_estimate DOUBLE,
    require_approval INT NOT NULL DEFAULT 0,
    same_sex_only INT NOT NULL DEFAULT 0,
    gender VARCHAR(16),
    source VARCHAR(16) NOT NULL,
    creator_id INT,
    status VARCHAR(24) NOT NULL,
    icebreaker_index INT NOT NULL DEFAULT 0,
    proposal_id INT,
    slot VARCHAR(16),
    area VARCHAR(64),
    moderation TEXT NOT NULL DEFAULT ('[]'),
    review_note VARCHAR(255),
    cancel_reason VARCHAR(255),
    formed_at VARCHAR(40),
    images TEXT NOT NULL DEFAULT ('[]'),
    location TEXT,
    exit_deadline VARCHAR(40),
    created_at VARCHAR(40) NOT NULL,
    INDEX idx_events_status (status, start_at)
  )`,
  `CREATE TABLE IF NOT EXISTS event_members (
    event_id INT NOT NULL,
    user_id INT NOT NULL,
    role VARCHAR(16) NOT NULL DEFAULT 'member',
    status VARCHAR(16) NOT NULL,
    attendance VARCHAR(16) NOT NULL DEFAULT 'pending',
    arrived_at VARCHAR(40),
    safe_at VARCHAR(40),
    muted INT NOT NULL DEFAULT 0,
    last_read_message_id INT NOT NULL DEFAULT 0,
    invited_at VARCHAR(40),
    applied_at VARCHAR(40),
    joined_at VARCHAR(40),
    left_at VARCHAR(40),
    invite_expired INT NOT NULL DEFAULT 0,
    invited_by INT,
    PRIMARY KEY (event_id, user_id),
    INDEX idx_members_user (user_id, status)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    event_id INT NOT NULL,
    user_id INT,
    kind VARCHAR(16) NOT NULL DEFAULT 'text',
    text TEXT NOT NULL,
    created_at VARCHAR(40) NOT NULL,
    INDEX idx_messages_event (event_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS aa_bills (
    event_id INT PRIMARY KEY,
    payer_id INT NOT NULL,
    amount DOUBLE NOT NULL,
    note VARCHAR(255),
    created_at VARCHAR(40) NOT NULL,
    updated_at VARCHAR(40) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS aa_transfers (
    event_id INT NOT NULL,
    from_user_id INT NOT NULL,
    to_user_id INT NOT NULL,
    status VARCHAR(16) NOT NULL,
    updated_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (event_id, from_user_id, to_user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS reviews (
    event_id INT NOT NULL,
    reviewer_id INT NOT NULL,
    target_id INT NOT NULL,
    attendance VARCHAR(16) NOT NULL,
    created_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (event_id, reviewer_id, target_id)
  )`,
  `CREATE TABLE IF NOT EXISTS review_feelings (
    event_id INT NOT NULL,
    reviewer_id INT NOT NULL,
    feelings TEXT NOT NULL DEFAULT ('[]'),
    created_at VARCHAR(40),
    PRIMARY KEY (event_id, reviewer_id)
  )`,
  `CREATE TABLE IF NOT EXISTS credit_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    event_id INT,
    type VARCHAR(24) NOT NULL,
    source VARCHAR(16) NOT NULL,
    note VARCHAR(255),
    revoked INT NOT NULL DEFAULT 0,
    created_at VARCHAR(40) NOT NULL,
    INDEX idx_credit_user (user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS appeals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    credit_event_id INT NOT NULL,
    text TEXT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    admin_note VARCHAR(255),
    created_at VARCHAR(40) NOT NULL,
    resolved_at VARCHAR(40)
  )`,
  `CREATE TABLE IF NOT EXISTS reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    reporter_id INT NOT NULL,
    target_type VARCHAR(16) NOT NULL,
    target_id INT NOT NULL,
    target_user_id INT,
    reason VARCHAR(255) NOT NULL,
    detail TEXT,
    images TEXT NOT NULL DEFAULT ('[]'),
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    action VARCHAR(24),
    admin_note VARCHAR(255),
    user_message VARCHAR(255),
    created_at VARCHAR(40) NOT NULL,
    resolved_at VARCHAR(40),
    INDEX idx_reports_status (status)
  )`,
  `CREATE TABLE IF NOT EXISTS blocks (
    user_id INT NOT NULL,
    blocked_id INT NOT NULL,
    created_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (user_id, blocked_id)
  )`,
  `CREATE TABLE IF NOT EXISTS mutes (
    user_id INT NOT NULL,
    muted_id INT NOT NULL,
    created_at VARCHAR(40),
    PRIMARY KEY (user_id, muted_id)
  )`,
  `CREATE TABLE IF NOT EXISTS posts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    text TEXT NOT NULL,
    images TEXT NOT NULL DEFAULT ('[]'),
    event_id INT,
    visibility VARCHAR(16) NOT NULL DEFAULT 'public',
    status VARCHAR(16) NOT NULL DEFAULT 'approved',
    moderation TEXT NOT NULL DEFAULT ('[]'),
    created_at VARCHAR(40) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS post_likes (
    post_id INT NOT NULL,
    user_id INT NOT NULL,
    created_at VARCHAR(40),
    PRIMARY KEY (post_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS comments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    post_id INT NOT NULL,
    user_id INT NOT NULL,
    reply_to_user_id INT,
    text TEXT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'approved',
    created_at VARCHAR(40) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS notices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    type VARCHAR(32) NOT NULL,
    title VARCHAR(255) NOT NULL,
    body TEXT NOT NULL DEFAULT (''),
    link VARCHAR(255),
    \`read\` INT NOT NULL DEFAULT 0,
    created_at VARCHAR(40) NOT NULL,
    INDEX idx_notices_user (user_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    \`key\` VARCHAR(191) PRIMARY KEY,
    \`value\` TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tags (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    \`key\` VARCHAR(191) NOT NULL UNIQUE,
    category VARCHAR(32) NOT NULL DEFAULT 'other',
    cover VARCHAR(255),
    hot INT NOT NULL DEFAULT 0,
    sort INT NOT NULL DEFAULT 0,
    created_at VARCHAR(40) NOT NULL,
    last_used_at VARCHAR(40)
  )`,
  `CREATE TABLE IF NOT EXISTS banners (
    id INT AUTO_INCREMENT PRIMARY KEY,
    image VARCHAR(512) NOT NULL,
    title VARCHAR(255) NOT NULL,
    subtitle VARCHAR(255),
    link VARCHAR(255),
    body TEXT,
    cta_label VARCHAR(64),
    cta_link VARCHAR(255),
    starts_at VARCHAR(40),
    ends_at VARCHAR(40),
    impressions INT NOT NULL DEFAULT 0,
    clicks INT NOT NULL DEFAULT 0,
    sort INT NOT NULL DEFAULT 0,
    enabled INT NOT NULL DEFAULT 1,
    created_at VARCHAR(40) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS job_marks (
    \`key\` VARCHAR(191) PRIMARY KEY,
    created_at VARCHAR(40) NOT NULL
  )`,
];

/** mysql2 不需要特别处理 boolean（会转 1/0），但 undefined 要转 null；统一处理 */
function bindValue(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function bindParams(params) {
  return params.map((p) => {
    if (p && typeof p === 'object' && !Array.isArray(p) && !(p instanceof Date) && !(p instanceof Uint8Array)) {
      const out = {};
      for (const [k, v] of Object.entries(p)) out[k] = bindValue(v);
      return out;
    }
    return bindValue(p);
  });
}

// 单个对象参数 = 命名占位符（:name）；否则是位置占位符（?）数组
function isNamed(x) {
  return x && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Date) && !(x instanceof Uint8Array);
}
function toValues(params) {
  const bound = bindParams(params);
  return bound.length === 1 && isNamed(bound[0]) ? bound[0] : bound;
}

/** 一次性修复历史「周undefined」标题（templateTitle 旧 bug 造成）；修过的下次不再命中 */
export async function repairBadTitles(db) {
  const rows = await db.all("SELECT id, title, start_at FROM events WHERE title LIKE '%周undefined%'");
  for (const e of rows) {
    const fixed = e.title.replaceAll('周undefined', weekdayName(bjDate(new Date(e.start_at))));
    await db.run('UPDATE events SET title = ? WHERE id = ?', fixed, e.id);
  }
}

// 从 CREATE TABLE 语句解析出列定义（给老库补列用）；只认顶层列，跳过 PRIMARY KEY / INDEX 等约束行
function parseTableSchema(sql) {
  const head = sql.match(/CREATE TABLE IF NOT EXISTS\s+`?(\w+)`?\s*\(([\s\S]*)\)\s*$/i);
  if (!head) return null;
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of head[2]) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  const skip = /^(PRIMARY\s+KEY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN\s+KEY|CHECK)\b/i;
  const columns = [];
  for (const raw of parts) {
    const def = raw.trim();
    const m = def.match(/^`?(\w+)`?\s/);
    if (!def || skip.test(def) || !m) continue;
    columns.push({ name: m[1], def });
  }
  return { table: head[1], columns };
}

// 老库升级：schema 里新增的列，如果已存在的表里缺了，就 ALTER TABLE 补上（保留老数据，已存在的不重复加）
async function ensureColumns(pool) {
  const [tables] = await pool.query('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()');
  const existing = new Set(tables.map((r) => r.t));
  for (const sql of SCHEMA) {
    const parsed = parseTableSchema(sql);
    if (!parsed || !existing.has(parsed.table)) continue; // 新表已由 CREATE TABLE 建好，无需补列
    const [cols] = await pool.query(
      'SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?',
      [parsed.table],
    );
    const have = new Set(cols.map((r) => String(r.c).toLowerCase()));
    for (const { name, def } of parsed.columns) {
      if (!have.has(name.toLowerCase())) await pool.query(`ALTER TABLE \`${parsed.table}\` ADD COLUMN ${def}`);
    }
  }
}

/** 如果目标数据库还不存在就建一个（本地/seed 用；生产的库由微信云托管预先建好）。 */
export async function ensureDatabase(conn) {
  const admin = await mysql.createConnection({ host: conn.host, port: conn.port, user: conn.user, password: conn.password });
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${conn.database}\` CHARACTER SET utf8mb4`);
  await admin.end();
}

const txStore = new AsyncLocalStorage();

/** 打开数据库（建连接池、建表、修历史标题）。conn: {host, port, user, password, database, connectionLimit?} */
export async function openDb(conn) {
  const pool = mysql.createPool({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    namedPlaceholders: true,
    connectionLimit: conn.connectionLimit || 10,
    charset: 'utf8mb4',
    multipleStatements: false,
    decimalNumbers: true, // SUM 等 DECIMAL 结果返回 JS number（否则是字符串，坑严格比较）
  });
  for (const sql of SCHEMA) await pool.query(sql);
  await ensureColumns(pool); // 老库升级时补上新加的列

  const store = () => txStore.getStore();
  const q = (sql, values) => (store() ? store().conn : pool).query(sql, values);

  const db = {
    pool,
    hooks: {}, // 由 app 注册，例如 notice → 微信订阅消息
    publicBaseUrl: '', // 由 app 设置（PUBLIC_BASE_URL），图片相对路径拼成绝对地址时用
    async get(sql, ...params) {
      const [rows] = await q(sql, toValues(params));
      return rows[0];
    },
    async all(sql, ...params) {
      const [rows] = await q(sql, toValues(params));
      return rows;
    },
    async run(sql, ...params) {
      const [r] = await q(sql, toValues(params));
      return { changes: r.affectedRows, lastId: r.insertId };
    },
    /** INSERT 的便捷写法：insert('users', {nickname: 'x'}) → 新 id（用位置占位符 ?） */
    async insert(table, row) {
      const keys = Object.keys(row);
      const sql = `INSERT INTO \`${table}\` (${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
      return (await db.run(sql, ...keys.map((k) => row[k]))).lastId;
    },
    /** UPDATE 的便捷写法：update('users', id, {nickname: 'y'})（用位置占位符 ?） */
    async update(table, id, patch, idColumn = 'id') {
      const keys = Object.keys(patch);
      if (!keys.length) return 0;
      const sql = `UPDATE \`${table}\` SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE \`${idColumn}\` = ?`;
      return (await db.run(sql, ...keys.map((k) => patch[k]), id)).changes;
    },
    async exec(sql) {
      await q(sql);
    },
    /** 事务；嵌套调用时用 SAVEPOINT。fn 可以是 async */
    async tx(fn) {
      const cur = store();
      if (cur) {
        const name = `sp_${++cur.depth}`;
        await cur.conn.query(`SAVEPOINT ${name}`);
        try {
          const result = await fn();
          await cur.conn.query(`RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (err) {
          await cur.conn.query(`ROLLBACK TO SAVEPOINT ${name}`);
          throw err;
        } finally {
          cur.depth--;
        }
      }
      const c = await pool.getConnection();
      try {
        return await txStore.run({ conn: c, depth: 0 }, async () => {
          await c.query('START TRANSACTION');
          try {
            const result = await fn();
            await c.query('COMMIT');
            return result;
          } catch (err) {
            await c.query('ROLLBACK');
            throw err;
          }
        });
      } finally {
        c.release();
      }
    },
    /** 清空所有业务表（seed / 测试前使用） */
    async reset() {
      const [rows] = await pool.query('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()');
      await pool.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const { t } of rows) await pool.query(`TRUNCATE TABLE \`${t}\``);
      await pool.query('SET FOREIGN_KEY_CHECKS = 1');
    },
    async close() {
      await pool.end();
    },
  };
  await repairBadTitles(db);
  return db;
}

/** 清空所有业务表（兼容旧的 resetDb(db) 调用） */
export async function resetDb(db) {
  await db.reset();
}

export const json = {
  parse(text, fallback) {
    if (text === null || text === undefined || text === '') return fallback;
    try {
      return JSON.parse(text);
    } catch {
      return fallback;
    }
  },
  str: (value) => JSON.stringify(value ?? null),
};

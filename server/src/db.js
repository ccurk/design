// SQLite（node:sqlite）封装：建表、预编译语句缓存、事务（支持嵌套）。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  openid TEXT NOT NULL UNIQUE,
  phone TEXT,
  nickname TEXT NOT NULL,
  avatar_url TEXT,
  cover_url TEXT,
  bio TEXT NOT NULL DEFAULT '',
  gender TEXT NOT NULL DEFAULT 'unknown',
  pace TEXT,
  interests TEXT NOT NULL DEFAULT '[]',
  phone_verified INTEGER NOT NULL DEFAULT 0,
  id_verified INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  restricted_until TEXT,
  restricted_reason TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  emergency_contact TEXT,
  onboarded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  task TEXT NOT NULL,
  category TEXT NOT NULL,
  label TEXT,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  slot TEXT NOT NULL,
  area TEXT NOT NULL,
  size_min INTEGER NOT NULL DEFAULT 3,
  size_max INTEGER NOT NULL DEFAULT 5,
  relax_time INTEGER NOT NULL DEFAULT 0,
  relax_size INTEGER NOT NULL DEFAULT 0,
  time_from TEXT,
  time_to TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  event_id INTEGER,
  proposal_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status);
CREATE INDEX IF NOT EXISTS idx_intents_user ON intents(user_id);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  category TEXT NOT NULL,
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  area TEXT NOT NULL,
  title TEXT NOT NULL,
  intent_ids TEXT NOT NULL DEFAULT '[]',
  user_ids TEXT NOT NULL DEFAULT '[]',
  score INTEGER NOT NULL DEFAULT 0,
  reasons TEXT NOT NULL DEFAULT '[]',
  risks TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  event_id INTEGER,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  review_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  task TEXT,
  description TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 120,
  place TEXT NOT NULL DEFAULT '',
  meeting_point TEXT NOT NULL DEFAULT '',
  capacity INTEGER NOT NULL,
  min_size INTEGER NOT NULL DEFAULT 3,
  fee_type TEXT NOT NULL DEFAULT 'aa',
  fee_estimate REAL,
  require_approval INTEGER NOT NULL DEFAULT 0,
  same_sex_only INTEGER NOT NULL DEFAULT 0,
  gender TEXT,
  source TEXT NOT NULL,
  creator_id INTEGER,
  status TEXT NOT NULL,
  icebreaker_index INTEGER NOT NULL DEFAULT 0,
  proposal_id INTEGER,
  slot TEXT,
  area TEXT,
  moderation TEXT NOT NULL DEFAULT '[]',
  review_note TEXT,
  cancel_reason TEXT,
  formed_at TEXT,
  images TEXT NOT NULL DEFAULT '[]',
  location TEXT,
  exit_deadline TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status, start_at);

CREATE TABLE IF NOT EXISTS event_members (
  event_id INTEGER NOT NULL REFERENCES events(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL,
  attendance TEXT NOT NULL DEFAULT 'pending',
  arrived_at TEXT,
  safe_at TEXT,
  muted INTEGER NOT NULL DEFAULT 0,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  invited_at TEXT,
  applied_at TEXT,
  joined_at TEXT,
  left_at TEXT,
  invite_expired INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON event_members(user_id, status);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  user_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'text',
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_event ON messages(event_id, id);

-- 每个局只有一笔 AA：一个成员把总花费一次性记下，其他人按人数平摊转给 TA（旧的 aa_items 不再使用）
CREATE TABLE IF NOT EXISTS aa_bills (
  event_id INTEGER PRIMARY KEY REFERENCES events(id),
  payer_id INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS aa_transfers (
  event_id INTEGER NOT NULL,
  from_user_id INTEGER NOT NULL,
  to_user_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, from_user_id, to_user_id)
);

CREATE TABLE IF NOT EXISTS reviews (
  event_id INTEGER NOT NULL,
  reviewer_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  attendance TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, reviewer_id, target_id)
);

CREATE TABLE IF NOT EXISTS review_feelings (
  event_id INTEGER NOT NULL,
  reviewer_id INTEGER NOT NULL,
  feelings TEXT NOT NULL DEFAULT '[]',
  created_at TEXT,
  PRIMARY KEY (event_id, reviewer_id)
);

CREATE TABLE IF NOT EXISTS credit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  event_id INTEGER,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_user ON credit_events(user_id);

CREATE TABLE IF NOT EXISTS appeals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  credit_event_id INTEGER NOT NULL REFERENCES credit_events(id),
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  admin_note TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  target_user_id INTEGER,
  reason TEXT NOT NULL,
  detail TEXT,
  images TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  action TEXT,
  admin_note TEXT,
  user_message TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);

CREATE TABLE IF NOT EXISTS blocks (
  user_id INTEGER NOT NULL,
  blocked_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS mutes (
  user_id INTEGER NOT NULL,
  muted_id INTEGER NOT NULL,
  created_at TEXT,
  PRIMARY KEY (user_id, muted_id)
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  images TEXT NOT NULL DEFAULT '[]',
  event_id INTEGER,
  visibility TEXT NOT NULL DEFAULT 'public',
  status TEXT NOT NULL DEFAULT 'approved',
  moderation TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS post_likes (
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TEXT,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  reply_to_user_id INTEGER,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notices_user ON notices(user_id, id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 标签：意向的「想做的事」和局的标签共用；key = 规范化后的名字（拉丁字母小写），撮合按 key 比较
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'other',
  cover TEXT,
  hot INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

-- 首页轮播图（后台维护）
CREATE TABLE IF NOT EXISTS banners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  link TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 定时任务去重（例如「只提醒一次」）
CREATE TABLE IF NOT EXISTS job_marks (
  key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
`;

/** 给已有数据库补新加的列（CREATE TABLE IF NOT EXISTS 不会改旧表） */
const COLUMN_MIGRATIONS = [
  ['users', 'restricted_reason', 'TEXT'],
  ['users', 'cover_url', 'TEXT'],
  ['event_members', 'invite_expired', 'INTEGER NOT NULL DEFAULT 0'],
  ['reports', 'user_message', 'TEXT'],
  // v0.3
  ['intents', 'time_from', 'TEXT'],
  ['intents', 'time_to', 'TEXT'],
  ['events', 'images', "TEXT NOT NULL DEFAULT '[]'"],
  ['events', 'location', 'TEXT'],
  ['events', 'exit_deadline', 'TEXT'],
];

function migrate(raw) {
  for (const [table, column, type] of COLUMN_MIGRATIONS) {
    const columns = raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!columns.includes(column)) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/** node:sqlite 不接受 boolean / undefined，统一转换 */
function bindValue(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function bindParams(params) {
  return params.map((p) => {
    if (p && typeof p === 'object' && !Array.isArray(p) && !(p instanceof Uint8Array)) {
      const out = {};
      for (const [k, v] of Object.entries(p)) out[k] = bindValue(v);
      return out;
    }
    return bindValue(p);
  });
}

export function openDb(dbPath = ':memory:') {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA foreign_keys = ON;');
  if (dbPath !== ':memory:') raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec(SCHEMA);
  migrate(raw);

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  let depth = 0;

  const db = {
    raw,
    path: dbPath,
    hooks: {}, // 由 app 注册，例如 notice → 微信订阅消息
    publicBaseUrl: '', // 由 app 设置（PUBLIC_BASE_URL），图片相对路径拼成绝对地址时用
    get: (sql, ...params) => stmt(sql).get(...bindParams(params)),
    all: (sql, ...params) => stmt(sql).all(...bindParams(params)),
    run(sql, ...params) {
      const r = stmt(sql).run(...bindParams(params));
      return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
    },
    /** INSERT 的便捷写法：insert('users', {nickname: 'x'}) → 新 id */
    insert(table, row) {
      const keys = Object.keys(row);
      const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => `:${k}`).join(', ')})`;
      return db.run(sql, row).lastId;
    },
    /** UPDATE 的便捷写法：update('users', id, {nickname: 'y'}) */
    update(table, id, patch, idColumn = 'id') {
      const keys = Object.keys(patch);
      if (!keys.length) return 0;
      const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = :${k}`).join(', ')} WHERE ${idColumn} = :__id`;
      return db.run(sql, { ...patch, __id: id }).changes;
    },
    exec: (sql) => raw.exec(sql),
    /** 同步事务；嵌套调用时用 SAVEPOINT */
    tx(fn) {
      if (depth === 0) {
        raw.exec('BEGIN IMMEDIATE');
        depth++;
        try {
          const result = fn();
          raw.exec('COMMIT');
          return result;
        } catch (err) {
          raw.exec('ROLLBACK');
          throw err;
        } finally {
          depth--;
        }
      }
      const name = `sp_${depth}`;
      raw.exec(`SAVEPOINT ${name}`);
      depth++;
      try {
        const result = fn();
        raw.exec(`RELEASE ${name}`);
        return result;
      } catch (err) {
        raw.exec(`ROLLBACK TO ${name}`);
        raw.exec(`RELEASE ${name}`);
        throw err;
      } finally {
        depth--;
      }
    },
    close: () => raw.close(),
  };
  return db;
}

/** 清空所有业务表（seed 前使用） */
export function resetDb(db) {
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  db.exec('PRAGMA foreign_keys = OFF;');
  for (const { name } of tables) db.exec(`DELETE FROM ${name};`);
  db.exec("DELETE FROM sqlite_sequence;");
  db.exec('PRAGMA foreign_keys = ON;');
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

// 后台设置（settings 表，value 为 JSON）。
import { json } from '../db.js';

const DEFAULTS = {
  autoConfirm: { enabled: false, threshold: 90 },
};

export function getSetting(db, key) {
  const row = db.get('SELECT value FROM settings WHERE key = ?', key);
  const value = json.parse(row?.value, null);
  const def = DEFAULTS[key];
  if (def && typeof def === 'object' && !Array.isArray(def)) return { ...def, ...(value || {}) };
  return value ?? def ?? null;
}

export function setSetting(db, key, value) {
  db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    json.str(value),
  );
  return getSetting(db, key);
}

export function allSettings(db) {
  return { autoConfirm: getSetting(db, 'autoConfirm') };
}

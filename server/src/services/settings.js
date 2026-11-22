// 后台设置（settings 表，value 为 JSON）。
import { json } from '../db.js';

const DEFAULTS = {
  autoConfirm: { enabled: false, threshold: 90 },
};

export async function getSetting(db, key) {
  const row = await db.get('SELECT `value` FROM settings WHERE `key` = ?', key);
  const value = json.parse(row?.value, null);
  const def = DEFAULTS[key];
  if (def && typeof def === 'object' && !Array.isArray(def)) return { ...def, ...(value || {}) };
  return value ?? def ?? null;
}

export async function setSetting(db, key, value) {
  await db.run(
    'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
    key,
    json.str(value),
  );
  return await getSetting(db, key);
}

export async function allSettings(db) {
  return { autoConfirm: await getSetting(db, 'autoConfirm') };
}

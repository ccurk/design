// 请求参数校验：失败时抛 VALIDATION（中文提示）。
import { invalid } from './errors.js';

export function str(value, label, { min = 0, max = 200, optional = false, trim = true } = {}) {
  if (value === undefined || value === null || (optional && value === '')) {
    if (optional) return null;
    throw invalid(`请填写${label}`);
  }
  if (typeof value !== 'string') throw invalid(`${label}格式不正确`);
  const v = trim ? value.trim() : value;
  if (v.length < min) throw invalid(min <= 1 ? `请填写${label}` : `${label}至少 ${min} 个字`);
  if (v.length > max) throw invalid(`${label}最多 ${max} 个字`);
  return v;
}

export function int(value, label, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    throw invalid(`请填写${label}`);
  }
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(n)) throw invalid(`${label}需要是整数`);
  if (n < min || n > max) throw invalid(`${label}需要在 ${min}–${max} 之间`);
  return n;
}

export function num(value, label, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    throw invalid(`请填写${label}`);
  }
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw invalid(`${label}需要是数字`);
  if (n < min || n > max) throw invalid(`${label}需要在 ${min}–${max} 之间`);
  return n;
}

export function bool(value, label, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw invalid(`请选择${label}`);
  }
  if (typeof value !== 'boolean') throw invalid(`${label}格式不正确`);
  return value;
}

export function oneOf(value, label, options, { optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    throw invalid(`请选择${label}`);
  }
  if (!options.includes(value)) throw invalid(`${label}不正确`);
  return value;
}

export function isoTime(value, label, { optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    throw invalid(`请填写${label}`);
  }
  const d = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(d.getTime())) throw invalid(`${label}格式不正确`);
  return d;
}

export function strArray(value, label, { maxItems = 20, maxLen = 20, optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw invalid(`请填写${label}`);
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw invalid(`${label}格式不正确`);
  const list = [...new Set(value.map((v) => v.trim()).filter(Boolean))];
  if (list.length > maxItems) throw invalid(`${label}最多 ${maxItems} 个`);
  if (list.some((v) => v.length > maxLen)) throw invalid(`${label}每项最多 ${maxLen} 个字`);
  return list;
}

/** 路由参数里的整数 id；不合法时当作不存在 */
export function idParam(value, notFoundError) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw notFoundError;
  return n;
}

// 图片地址：数据库里只存相对路径 /uploads/<文件>，接口返回时拼成绝对地址（PUBLIC_BASE_URL + 路径）。
// 客户端提交时绝对 / 相对都接受。路径是 /uploads/<文件> 的都算本站上传的图片
// （开发时手机和电脑访问后端用的域名常常不一样，所以不比较域名）；老数据里存的绝对地址同样处理。
import { invalid } from './errors.js';

const UPLOAD_PATH = /^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;

/** 本站上传图片的相对路径 /uploads/<文件>；不是本站上传的图片返回 null */
export function uploadPath(value) {
  if (typeof value !== 'string') return null;
  let v = value.trim();
  if (/^https?:\/\//i.test(v)) {
    try {
      v = new URL(v).pathname;
    } catch {
      return null;
    }
  }
  return UPLOAD_PATH.test(v) && !v.includes('..') ? v : null;
}

/** 返回给客户端的地址：本站图片拼成绝对地址，其他地址原样返回 */
export function absUrl(db, value) {
  if (!value) return null;
  const p = uploadPath(value);
  return p ? `${db?.publicBaseUrl || ''}${p}` : value;
}

export function absUrls(db, list) {
  return (Array.isArray(list) ? list : []).map((v) => absUrl(db, v)).filter(Boolean);
}

/** 局、动态的图片：0–max 张，只收本站上传的图片，返回相对路径（去重、保持顺序） */
export function parseImages(value, { max = 9, label = '图片' } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid(`${label}格式不正确`);
  if (value.length > max) throw invalid(`${label}最多 ${max} 张`);
  const out = [];
  for (const v of value) {
    const p = uploadPath(v);
    if (!p) throw invalid(`${label}地址不正确，请先上传`);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** 单张图片（轮播图）：必填，只收本站上传的图片 */
export function parseImage(value, label = '图片') {
  if (value === undefined || value === null || value === '') throw invalid(`请上传${label}`);
  const p = uploadPath(value);
  if (!p) throw invalid(`${label}地址不正确，请先上传`);
  return p;
}

/** 头像、举报截图：本站图片存相对路径，其他 http(s) 地址原样保留 */
export function storeUrl(value) {
  if (typeof value !== 'string') return value;
  return uploadPath(value) ?? value.trim();
}

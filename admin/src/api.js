// 调后台接口的唯一入口：前缀 /api、JSON 进出、带 Bearer token；失败时抛出 { code, message }。
// 任何接口返回 401（token 失效 / 过期）→ 清掉 token，回到登录页。
import { reactive } from './vue.js';
import { go, hrefOf, PAGES, route } from './router.js';

const TOKEN_KEY = 'dazi.admin.token';

function readToken() {
  try {
    return window.localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export const auth = reactive({ token: readToken() });

export function setToken(token) {
  auth.token = token;
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // 隐私模式等存不进去时，只在本页有效
  }
}

export function clearToken() {
  auth.token = '';
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 同上
  }
}

/** 接口错误：带 code（如 VALIDATION、CONFLICT）和中文 message */
export class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** 当前页面（登录后回到这里） */
function currentPlace() {
  return PAGES.includes(route.name) ? hrefOf(route.name, route.query).slice(2) : '';
}

/**
 * api('/admin/stats')
 * api('/admin/proposals/3/confirm', { method: 'POST', body: {...} })
 * api('/admin/users', { query: { q: '阿野' } })
 * api('/admin/upload', { method: 'POST', form: formData })   // multipart，不设 Content-Type，浏览器会带上 boundary
 */
export async function api(path, { method = 'GET', body, query, form } = {}) {
  let url = `/api${path}`;
  if (query) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''),
    ).toString();
    if (qs) url += `?${qs}`;
  }
  const headers = { Accept: 'application/json' };
  if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
  const sentToken = auth.token;
  if (sentToken) headers.Authorization = `Bearer ${sentToken}`;

  let res;
  try {
    res = await fetch(url, { method, headers, body: form || (body === undefined ? undefined : JSON.stringify(body)) });
  } catch {
    throw new ApiError('NETWORK', '连不上服务器，请检查网络后再试');
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (res.ok) return data;

  const err =
    data && data.error
      ? new ApiError(data.error.code, data.error.message || '操作没有成功，请重试', res.status)
      : new ApiError(`HTTP_${res.status}`, `服务器出错了（${res.status}），请稍后再试`, res.status);
  // 带着 token 还 401：登录过期了。登录接口本身的 401（密码不对）交给登录页显示
  if (res.status === 401 && sentToken) {
    if (auth.token === sentToken) clearToken();
    if (route.name !== 'login') {
      const next = currentPlace();
      go('login', next && next !== 'dashboard' ? { next } : {}, { replace: true });
    }
  }
  throw err;
}

/** 和服务端一样的上限（server/src/routes：只收 jpg / png / gif / webp，≤ 5MB） */
export const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
export const UPLOAD_MAX = 5 * 1024 * 1024;

/** 上传一张图片（后台 token）→ 图片地址。先在本地挡掉明显不行的文件，省一次请求 */
export async function uploadImage(file) {
  if (!file) throw new ApiError('VALIDATION', '先选一张图片');
  if (!UPLOAD_TYPES.includes(file.type)) throw new ApiError('VALIDATION', `「${file.name}」不是 jpg / png / gif / webp 图片`);
  if (file.size > UPLOAD_MAX) throw new ApiError('VALIDATION', `「${file.name}」超过 5MB 了，压缩一下再传`);
  const form = new FormData();
  form.append('file', file);
  const res = await api('/admin/upload', { method: 'POST', form });
  if (!res || !res.url) throw new ApiError('UPLOAD', '上传没有成功，请重试');
  return res.url;
}

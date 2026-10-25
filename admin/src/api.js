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
 */
export async function api(path, { method = 'GET', body, query } = {}) {
  let url = `/api${path}`;
  if (query) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''),
    ).toString();
    if (qs) url += `?${qs}`;
  }
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const sentToken = auth.token;
  if (sentToken) headers.Authorization = `Bearer ${sentToken}`;

  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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

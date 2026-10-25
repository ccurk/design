// 极简 hash 路由：#/dashboard、#/users?id=6 …… 地址栏的路径永远是 /admin/，相对路径的静态文件不会找错。
import { reactive } from './vue.js';

export const PAGES = ['dashboard', 'matching', 'moderation', 'events', 'users'];

export const route = reactive({ name: '', query: {} });

/** 生成 hash 链接；值为空的参数会被省略 */
export function hrefOf(name, query = {}) {
  const qs = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ).toString();
  return `#/${name}${qs ? `?${qs}` : ''}`;
}

function readHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const i = raw.indexOf('?');
  const path = i >= 0 ? raw.slice(0, i) : raw;
  const search = i >= 0 ? raw.slice(i + 1) : '';
  return { name: path.split('/')[0], query: Object.fromEntries(new URLSearchParams(search)) };
}

let guard = (r) => r;

/** guard(r) 返回要去的路由；带 redirect: true 时会替换地址栏（不留历史记录） */
export function setGuard(fn) {
  guard = fn;
}

function sync() {
  const next = guard(readHash());
  if (next.redirect) window.history.replaceState(window.history.state, '', hrefOf(next.name, next.query));
  route.name = next.name;
  route.query = next.query || {};
}

export function go(name, query = {}, { replace = false } = {}) {
  const href = hrefOf(name, query);
  if (replace) {
    window.history.replaceState(window.history.state, '', href);
    sync();
  } else if (window.location.hash === href) {
    sync();
  } else {
    window.location.hash = href; // 触发 hashchange → sync
  }
}

export function startRouter() {
  window.addEventListener('hashchange', sync);
  sync();
}

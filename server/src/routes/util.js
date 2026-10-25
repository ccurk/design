// 路由层的小工具。
import { notFound } from '../errors.js';
import { idParam } from '../validate.js';

/** 读取路由里的整数参数 */
export function pid(req, name = 'id') {
  return idParam(req.params[name], notFound('内容不存在'));
}

export function body(req) {
  return req.body && typeof req.body === 'object' ? req.body : {};
}

/** 分页参数：limit 1–50，cursor 为非负整数 */
export function page(req, defaultLimit = 20) {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || defaultLimit));
  const cursorNum = Number(req.query.cursor);
  const cursor = Number.isInteger(cursorNum) && cursorNum > 0 ? cursorNum : 0;
  return { limit, cursor };
}

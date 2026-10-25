// 统一错误：{ error: { code, message } }，message 为中文。
const STATUS = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  CONTENT_BLOCKED: 422,
  RESTRICTED: 403,
  INTERNAL: 500,
};

export class AppError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.status = STATUS[code] ?? 500;
    this.extra = extra;
  }
}

export const unauthorized = (msg = '请先登录') => new AppError('UNAUTHORIZED', msg);
export const forbidden = (msg = '没有权限') => new AppError('FORBIDDEN', msg);
export const notFound = (msg = '内容不存在') => new AppError('NOT_FOUND', msg);
export const invalid = (msg = '参数不正确') => new AppError('VALIDATION', msg);
export const conflict = (msg = '操作冲突，请刷新后再试') => new AppError('CONFLICT', msg);
export const blocked = (msg, reasons) => new AppError('CONTENT_BLOCKED', msg, { reasons });
export const restricted = (msg = '账号受限中，暂时不能报名或撮合') => new AppError('RESTRICTED', msg);
export const internal = (msg = '服务器开小差了，请稍后再试') => new AppError('INTERNAL', msg);

export function errorBody(err) {
  const body = { error: { code: err.code, message: err.message } };
  if (err.extra?.reasons) body.error.reasons = err.extra.reasons;
  return body;
}

// wx.request 的 Promise 封装：自动登录、带 Bearer token、401 时重新登录一次、失败时提示 error.message。
const config = require('../config');

// token 按登录方式分开存：改了 devLogin / devUserId 后会自动换身份重新登录
const TOKEN_KEY = 'dz_token_' + (config.devLogin ? 'dev' + (config.devUserId || '') : 'wx');
let token = '';
try {
  token = wx.getStorageSync(TOKEN_KEY) || '';
} catch (e) {
  token = '';
}
let loginTask = null;
let loginListener = null;

function setToken(value) {
  token = value || '';
  try {
    if (token) wx.setStorageSync(TOKEN_KEY, token);
    else wx.removeStorageSync(TOKEN_KEY);
  } catch (e) {
    // 存储失败不影响本次会话
  }
}

function getToken() {
  return token;
}

function makeError(code, message, status) {
  const err = new Error(message || '出了点问题，稍后再试');
  err.code = code || 'INTERNAL';
  err.status = status || 0;
  err.isApiError = true;
  return err;
}

function fromResponse(res) {
  const body = res && res.data;
  const e = body && body.error;
  if (e && e.message) return makeError(e.code, e.message, res.statusCode);
  if (res.statusCode === 404) return makeError('NOT_FOUND', '没有找到相关内容', 404);
  return makeError('INTERNAL', '服务开小差了，稍后再试', res.statusCode);
}

function toast(message) {
  if (!message) return;
  wx.showToast({ title: message, icon: 'none', duration: 2200 });
}

// 短提示用 toast；长的（比如时间重叠、过了最晚退出时间）用弹窗，免得被截断
const TITLES = { CONFLICT: '暂时不行', CONTENT_BLOCKED: '内容没通过审核', RESTRICTED: '账号受限中', VALIDATION: '再检查一下' };
function showError(err) {
  const message = (err && err.message) || '出了点问题，稍后再试';
  const code = err && err.code;
  if (message.length <= 24 && code !== 'CONFLICT') {
    toast(message);
    return;
  }
  let title = TITLES[code] || '提示';
  if (/重叠|已经有局/.test(message)) title = '时间冲突了';
  else if (/最晚退出/.test(message)) title = '不能退出了';
  else if (/标签/.test(message) && code === 'CONTENT_BLOCKED') title = '换个标签吧';
  wx.showModal({ title, content: message, showCancel: false, confirmText: '知道了', confirmColor: '#193543' });
}

// 开发模式下直接说清楚连的是哪个地址，方便排查「后端没启动 / 没关域名校验」
function networkMessage(err) {
  if (!config.devLogin) return '网络不太好，连不上服务器';
  const msg = (err && err.errMsg) || '';
  if (/domain|域名/i.test(msg)) return '请求被拦截：开发者工具「详情 → 本地设置」里勾选「不校验合法域名」';
  return '连不上后端 ' + config.baseURL + '，请确认它已经启动';
}

function send(method, path, data, withAuth) {
  return new Promise((resolve, reject) => {
    const header = { 'content-type': 'application/json' };
    if (withAuth && token) header.Authorization = 'Bearer ' + token;
    wx.request({
      url: config.baseURL + path,
      method,
      data: data === undefined ? {} : data,
      header,
      timeout: 15000,
      success: resolve,
      fail: (err) => reject(makeError('NETWORK', networkMessage(err), 0, err))
    });
  });
}

function wxCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => (res.code ? resolve(res.code) : reject(makeError('LOGIN', '微信登录失败'))),
      fail: () => reject(makeError('LOGIN', '微信登录失败'))
    });
  });
}

// 拿 token：开发模式走 /api/auth/dev-login，否则 wx.login → /api/auth/login
function login() {
  if (loginTask) return loginTask;
  const task = config.devLogin
    ? send('POST', '/api/auth/dev-login', config.devUserId ? { userId: config.devUserId } : {}, false)
    : wxCode().then((code) => send('POST', '/api/auth/login', { code }, false));
  loginTask = task.then(
    (res) => {
      loginTask = null;
      if (res.statusCode !== 200 || !res.data || !res.data.token) throw fromResponse(res);
      setToken(res.data.token);
      if (loginListener) loginListener(res.data);
      return res.data;
    },
    (err) => {
      loginTask = null;
      throw err;
    }
  );
  return loginTask;
}

function ensureLogin() {
  return token ? Promise.resolve() : login();
}

function onLogin(fn) {
  loginListener = fn;
}

/**
 * opts.silent：失败时不提示（轮询，或页面自己处理错误）
 */
function request(method, path, data, opts) {
  const options = opts || {};
  return ensureLogin()
    .then(() => send(method, path, data, true))
    .then((res) => {
      if (res.statusCode === 401 && !options.retried) {
        setToken('');
        return login().then(() => request(method, path, data, Object.assign({}, options, { retried: true, silent: true })));
      }
      if (res.statusCode >= 200 && res.statusCode < 300) return res.data;
      throw fromResponse(res);
    })
    .catch((err) => {
      const e = err && err.isApiError ? err : makeError('INTERNAL', '出了点问题，稍后再试');
      if (!options.silent && !e.toasted) {
        e.toasted = true;
        showError(e);
      }
      throw e;
    });
}

module.exports = {
  request,
  get: (path, data, opts) => request('GET', path, data, opts),
  post: (path, data, opts) => request('POST', path, data, opts),
  // wx.request 不支持 PATCH，部分更新也用 PUT
  put: (path, data, opts) => request('PUT', path, data, opts),
  del: (path, data, opts) => request('DELETE', path, data, opts),
  login,
  ensureLogin,
  onLogin,
  getToken,
  setToken,
  toast,
  showError,
  makeError
};

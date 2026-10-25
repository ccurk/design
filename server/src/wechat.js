// 微信小程序服务端接口：登录 code 换 openid、手机号快速验证、订阅消息（目前只打日志）。
// 没配 WX_APPID / WX_SECRET 时是开发模式：openid = dev_<code>，手机号随机生成。
import { AppError } from './errors.js';

const API = 'https://api.weixin.qq.com';

export function createWechat({ appId = '', secret = '', isProd = false, logger = console, fetchImpl = globalThis.fetch } = {}) {
  const configured = Boolean(appId && secret);
  let tokenCache = null; // { token, expiresAt }

  function devFallbackAllowed() {
    if (configured) return false;
    if (isProd) throw new AppError('INTERNAL', '服务端还没配置微信 AppID / Secret');
    return true;
  }

  async function call(url, init) {
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      logger.error('[wechat] 请求失败', err.message);
      throw new AppError('INTERNAL', '连接微信服务器失败，请稍后再试');
    }
    return res.json();
  }

  /** wx.login 的 code → { openid, unionid, sessionKey } */
  async function code2Session(code) {
    if (devFallbackAllowed()) return { openid: `dev_${code}`, unionid: null, sessionKey: null, dev: true };
    const qs = new URLSearchParams({ appid: appId, secret, js_code: code, grant_type: 'authorization_code' });
    const data = await call(`${API}/sns/jscode2session?${qs}`);
    if (data.errcode) {
      logger.warn('[wechat] jscode2session', data.errcode, data.errmsg);
      throw new AppError('UNAUTHORIZED', '微信登录失败，请重试');
    }
    return { openid: data.openid, unionid: data.unionid ?? null, sessionKey: data.session_key, dev: false };
  }

  /** 接口调用凭证，缓存到过期前 5 分钟 */
  async function getAccessToken(force = false) {
    if (!force && tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;
    const qs = new URLSearchParams({ grant_type: 'client_credential', appid: appId, secret });
    const data = await call(`${API}/cgi-bin/token?${qs}`);
    if (!data.access_token) {
      logger.error('[wechat] access_token', data.errcode, data.errmsg);
      throw new AppError('INTERNAL', '获取微信接口凭证失败');
    }
    tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 300) * 1000 };
    return tokenCache.token;
  }

  /** 手机号快速验证组件的 code → 手机号（不带区号） */
  async function getPhoneNumber(code) {
    if (devFallbackAllowed()) {
      const rand = String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
      return { phoneNumber: `138${rand}`, dev: true };
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await getAccessToken(attempt > 0);
      const data = await call(`${API}/wxa/business/getuserphonenumber?access_token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!data.errcode) return { phoneNumber: data.phone_info.purePhoneNumber, dev: false };
      if (![40001, 42001].includes(data.errcode)) {
        logger.warn('[wechat] getuserphonenumber', data.errcode, data.errmsg);
        throw new AppError('VALIDATION', '手机号验证失败，请重试');
      }
      tokenCache = null; // access_token 失效，刷新后重试一次
    }
    throw new AppError('INTERNAL', '手机号验证失败，请稍后再试');
  }

  /**
   * 订阅消息（占位）：正式接入时调用 /cgi-bin/message/subscribe/send，
   * 需要在小程序后台申请模板并由用户授权。目前只记日志。
   */
  async function sendSubscribeMessage({ openid, type, title, body, link } = {}) {
    logger.debug('[wechat] 订阅消息（未接入，仅记录）', { openid, type, title, body, link });
    return { ok: true, stub: true };
  }

  /** 内容安全（占位）：配置了微信后可接入 msgSecCheck，目前直接通过 */
  async function msgSecCheck() {
    return { ok: true, stub: true };
  }

  return { configured, code2Session, getPhoneNumber, getAccessToken, sendSubscribeMessage, msgSecCheck };
}

// 便捷导出：按当前环境变量创建的默认实例
let defaultInstance = null;
function instance() {
  defaultInstance ??= createWechat({
    appId: process.env.WX_APPID,
    secret: process.env.WX_SECRET,
    isProd: process.env.NODE_ENV === 'production',
  });
  return defaultInstance;
}
export const code2Session = (code) => instance().code2Session(code);
export const getPhoneNumber = (code) => instance().getPhoneNumber(code);
export const sendSubscribeMessage = (msg) => instance().sendSubscribeMessage(msg);

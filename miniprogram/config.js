// 运行配置。改完重新编译即可生效。
//
// 上线前只改这里：把 PROD 改成 true，并把 prodBaseURL 填成你的生产 HTTPS 域名。
// PROD = true 时会自动：接口走 HTTPS 生产域名 + 关闭开发自动登录（走真实 wx.login）。
const PROD = false; // ← 上线改成 true

const prodBaseURL = 'https://your-domain.com'; // ← 你的生产 HTTPS 域名（已 ICP 备案，且已加进小程序「服务器域名」白名单）
const devBaseURL = 'http://localhost:3000'; // 真机预览时改成电脑局域网 IP，如 http://192.168.1.8:3000

module.exports = {
  // 后端地址。上线必须是 HTTPS 合法域名，由上面的 PROD 开关决定。
  baseURL: PROD ? prodBaseURL : devBaseURL,

  // 开发模式：启动时调用 POST /api/auth/dev-login（默认登录演示账号「栗子」），手机号验证失败也允许继续。
  // PROD 下强制 false，走真实 wx.login → /api/auth/login（生产后端已禁用 dev-login）。
  devLogin: !PROD,

  // 开发模式下想换个演示账号登录时填用户 id（如 2），留空 = 默认账号
  devUserId: null,

  // 订阅消息模板 id（在小程序后台「订阅消息」里申请后填入）。留空时点「开启提醒」只提示已开启。
  subscribeTemplates: {
    match: '', // 撮合结果通知
    formed: '', // 成群通知（加入后人齐了提醒）
    reminder: '', // 活动开始提醒 / 轻确认出席
    report: '' // 举报处理结果
  }
};

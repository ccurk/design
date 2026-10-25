// 运行配置。改完重新编译即可生效。
module.exports = {
  // 后端地址。真机预览时改成电脑的局域网 IP（如 http://192.168.1.8:3000），上线必须是 HTTPS 合法域名。
  baseURL: 'http://localhost:3000',

  // 开发模式：启动时调用 POST /api/auth/dev-login（默认登录演示账号「栗子」），
  // 手机号验证失败也允许继续。上线前改成 false，改走 wx.login → /api/auth/login。
  devLogin: true,

  // 开发模式下想换个演示账号登录时填用户 id（如 2），留空 = 默认账号
  devUserId: null,

  // 订阅消息模板 id（在小程序后台「订阅消息」里申请后填入）。留空时点「开启提醒」只提示已开启。
  subscribeTemplates: {
    match: '', // 撮合结果通知
    reminder: '', // 活动开始提醒 / 轻确认出席
    report: '' // 举报处理结果
  }
};

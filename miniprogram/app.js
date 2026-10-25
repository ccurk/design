const session = require('./utils/session');
const nav = require('./utils/nav');

App({
  globalData: {
    me: null,
    dirty: {}
  },

  onLaunch(options) {
    // 拿 token（开发模式 dev-login，否则 wx.login），再读一次资料；没完成引导就去登录页
    session
      .loadMe(true)
      .then((me) => {
        const entry = '/' + ((options && options.path) || 'pages/home/home');
        if (me && !me.onboarded && nav.isTab(entry)) {
          wx.reLaunch({ url: '/pages/login/login' });
        }
      })
      .catch(() => {});
  }
});

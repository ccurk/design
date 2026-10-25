// 欢迎页：手机号快速验证 → 选兴趣
const api = require('../../utils/api');
const config = require('../../config');

Page({
  data: {
    agreed: false,
    busy: false
  },

  onShow() {
    // 引导页不显示「回首页」按钮，想先逛逛走「先随便看看」
    if (wx.hideHomeButton) wx.hideHomeButton();
  },

  toggleAgree() {
    this.setData({ agreed: !this.data.agreed });
  },

  needAgree() {
    wx.showToast({ title: '先勾选同意《社区公约》和《隐私说明》', icon: 'none' });
  },

  openRules(e) {
    wx.navigateTo({ url: '/pages/rules/rules?section=' + e.currentTarget.dataset.section });
  },

  browse() {
    wx.switchTab({ url: '/pages/square/square' });
  },

  onPhone(e) {
    if (this.data.busy) return;
    const code = e.detail && e.detail.code;
    if (!code) {
      // 用户拒绝、或没有手机号快速验证权限（测试号 / 个人主体）
      if (config.devLogin) {
        wx.showToast({ title: '开发模式：先跳过手机号验证', icon: 'none' });
        this.next();
      } else {
        wx.showToast({ title: '需要验证手机号才能继续', icon: 'none' });
      }
      return;
    }
    this.setData({ busy: true });
    api
      .verifyPhone(code)
      .then(() => this.next())
      .catch(() => {
        if (config.devLogin) this.next();
      })
      .then(() => this.setData({ busy: false }));
  },

  next() {
    wx.navigateTo({ url: '/pages/interests/interests' });
  }
});

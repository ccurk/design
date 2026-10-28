// 轮播广告落地页（平台内）：图 + 标题 + 正文 + 可选按钮；底部引导「商务合作」。
const api = require('../../utils/api');
const nav = require('../../utils/nav');

Page({
  data: { loading: true, error: '', ad: null },

  onLoad(query) {
    const id = Number(query.id);
    if (!id) {
      this.setData({ loading: false, error: '链接里缺少编号' });
      return;
    }
    api
      .bannerDetail(id, { silent: true })
      .then((ad) => this.setData({ loading: false, ad }))
      .catch((err) => this.setData({ loading: false, error: (err && err.message) || '看不到这个内容' }));
  },

  onCta() {
    const ad = this.data.ad;
    if (ad && ad.ctaLink) nav.openLink(ad.ctaLink);
  },

  goCoop() {
    wx.switchTab({ url: '/pages/me/me' });
  },
});

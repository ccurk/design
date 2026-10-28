// 我的：主页背景、资料、信用（含信用记录与申诉）、我的局、安全设置、公约、客服
const api = require('../../utils/api');
const format = require('../../utils/format');
const nav = require('../../utils/nav');
const native = require('../../utils/native');
const session = require('../../utils/session');
const upload = require('../../utils/upload');

const NEGATIVE = ['late', 'cancel_late', 'no_show'];
const APPEAL_STATE = { pending: '申诉中', approved: '申诉通过', rejected: '申诉未通过' };
const RECORD_PREVIEW = 8; // 信用记录默认只展开最近这么多，其余折进「查看全部」
// 商务合作联系方式——改成你自己的；不想留微信就把下面这行和弹窗里的「微信」删掉
const COOP_EMAIL = 'your-email@example.com';
const COOP_WECHAT = 'your-wechat-id';

Page({
  data: {
    me: null,
    error: '',
    creditText: '',
    records: [],
    visibleRecords: [],
    recordsMore: 0,
    showAllRecords: false,
    appealable: false,
    showRecords: false
  },

  onShow() {
    nav.setTab(this, 4);
    const app = getApp();
    if (app.globalData.openCredit) {
      app.globalData.openCredit = false;
      this.setData({ showRecords: true });
    }
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    const cached = session.cachedMe();
    if (cached && !this.data.me) this.render(cached);
    return Promise.all([
      session.loadMe(true).then((me) => this.render(me)),
      this.loadRecords()
    ]).catch((err) => {
      if (!this.data.me) this.setData({ error: err.message || '加载不出来，下拉试试' });
    });
  },

  render(me) {
    this.setData({
      me: Object.assign({ interests: [], credit: { rate: 100, eventsCount: 0, noShow: 0 } }, me),
      creditText: format.creditText(me.credit && me.credit.level),
      error: ''
    });
  },

  loadRecords() {
    return api
      .creditEvents()
      .then((res) => {
        const list = (res && res.items) || (Array.isArray(res) ? res : []);
        const records = list.map((r) => {
          let state = '';
          if (r.revoked) state = '已撤销';
          else if (r.appeal) state = APPEAL_STATE[r.appeal.status] || '已申诉';
          const canAppeal = !r.revoked && !r.appeal && NEGATIVE.indexOf(r.type) >= 0;
          return {
            id: r.id,
            typeLabel: r.typeLabel || r.type,
            eventTitle: r.eventTitle ? format.shortTitle(r.eventTitle) : '',
            note: r.note || '',
            date: format.md(r.createdAt),
            state,
            canAppeal
          };
        });
        // 可申诉的负面记录置顶，其余保持时间倒序；默认只展开最近 RECORD_PREVIEW 条
        const ordered = records.filter((r) => r.canAppeal).concat(records.filter((r) => !r.canAppeal));
        this.setData({ records: ordered, appealable: ordered.some((r) => r.canAppeal) }, () => this.applyRecordView());
      })
      .catch(() => {});
  },

  toggleRecords() {
    this.setData({ showRecords: !this.data.showRecords });
  },

  // 默认只显示最近 RECORD_PREVIEW 条，点「查看全部」才铺开，避免活跃用户一直下拉
  applyRecordView() {
    const { records, showAllRecords } = this.data;
    this.setData({
      visibleRecords: showAllRecords ? records : records.slice(0, RECORD_PREVIEW),
      recordsMore: Math.max(0, records.length - RECORD_PREVIEW)
    });
  },

  toggleAllRecords() {
    this.setData({ showAllRecords: !this.data.showAllRecords }, () => this.applyRecordView());
  },

  appeal(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    native.prompt({ title: '申诉这条记录', placeholderText: '说说当时的情况，比如提前在群里说过', confirmText: '提交' }).then((text) => {
      if (text === null) return;
      if (!text) {
        wx.showToast({ title: '写一句当时的情况吧', icon: 'none' });
        return;
      }
      api
        .appeal(id, text)
        .then(() => {
          wx.showToast({ title: '已提交，平台会尽快处理', icon: 'none' });
          this.loadRecords();
        })
        .catch(() => {});
    });
  },

  // 换主页背景：上传后直接保存；已经换过的可以恢复默认插画
  changeCover() {
    const me = this.data.me;
    if (!me || this.coverBusy) return;
    this.coverBusy = true;
    upload
      .pickCover(!!me.coverUrl)
      .then((res) => {
        if (!res) return null;
        return api.updateMe({ coverUrl: res.reset ? null : res.url }).then((next) => {
          session.setMe(next);
          this.render(next);
          wx.showToast({ title: res.reset ? '已恢复默认背景' : '背景换好了', icon: 'none' });
        });
      })
      .catch(() => {}) // 失败时 request 已经提示过
      .then(() => {
        this.coverBusy = false;
      });
  },

  edit() {
    wx.navigateTo({ url: '/pages/edit-profile/edit-profile' });
  },

  openMyEvents() {
    wx.navigateTo({ url: '/pages/my-events/my-events' });
  },

  openSafety() {
    wx.navigateTo({ url: '/pages/safety/safety' });
  },

  openRules() {
    wx.navigateTo({ url: '/pages/rules/rules' });
  },

  openLeader() {
    wx.navigateTo({ url: '/pages/leader-apply/leader-apply' });
  },

  // 商务合作 / 广告投放：留邮箱 + 微信，提示备注来意
  openCoop() {
    wx.showModal({
      title: '商务合作 · 广告投放',
      content: `邮箱：${COOP_EMAIL}\n微信：${COOP_WECHAT}\n\n想在首页投放广告或其它合作，邮件 / 微信联系，并备注来意（公司或品牌 + 想投放的内容）。`,
      confirmText: '复制邮箱',
      cancelText: '关闭',
      confirmColor: '#193543',
      success: (r) => {
        if (r.confirm) wx.setClipboardData({ data: COOP_EMAIL });
      },
    });
  },

  openCreditRules() {
    wx.navigateTo({ url: '/pages/rules/rules?section=credit' });
  }
});

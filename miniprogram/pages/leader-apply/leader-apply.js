// 申请成为官方带队：填带队介绍/经验 + 传资质图 → 提交，等后台审核。
const api = require('../../utils/api');

const STATUS_TEXT = {
  pending: { title: '审核中', desc: '资料已提交，平台会尽快审核，通过后你就是官方带队了。' },
  approved: { title: '已是官方带队', desc: '你已通过认证，可以带队组织官方局了。' },
  rejected: { title: '未通过', desc: '这次没通过，完善资料后可以重新提交。' },
};

Page({
  data: {
    loading: true,
    application: null, // 最近一条申请
    statusText: null,
    canApply: true,
    intro: '',
    images: [],
    uploading: false,
    submitting: false,
  },

  onLoad() {
    this.load();
  },

  load() {
    return api
      .leaderStatus({ silent: true })
      .then((res) => {
        const app = (res && res.application) || null;
        const isLeader = !!(res && res.isLeader);
        const status = isLeader ? 'approved' : app && app.status;
        this.setData({
          loading: false,
          application: app,
          statusText: status ? STATUS_TEXT[status] : null,
          canApply: !isLeader && (!app || app.status === 'rejected'),
        });
      })
      .catch(() => this.setData({ loading: false }));
  },

  onIntro(e) {
    this.setData({ intro: e.detail.value });
  },

  onImages(e) {
    this.setData({ images: e.detail.urls, uploading: e.detail.uploading });
  },

  submit() {
    if (this.data.submitting) return;
    const intro = this.data.intro.trim();
    if (intro.length < 10) {
      wx.showToast({ title: '多写一点带队介绍吧（至少 10 字）', icon: 'none' });
      return;
    }
    if (this.data.uploading) {
      wx.showToast({ title: '图片还在上传，稍等一下', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    api
      .applyLeader({ intro, images: this.data.images })
      .then(() => {
        wx.showToast({ title: '已提交，等平台审核', icon: 'none' });
        this.setData({ intro: '', images: [] });
        this.load();
      })
      .catch(() => {}) // request 已经弹过错误（如「先完成手机号认证」）
      .then(() => this.setData({ submitting: false }));
  },
});

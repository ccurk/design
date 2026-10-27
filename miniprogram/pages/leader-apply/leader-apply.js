// 申请成为官方带队（结构化认证）：真实姓名 + 擅长方向 + 带队经验 + 紧急联系人 + 证明材料 + 承诺 → 提交审核。
const api = require('../../utils/api');

// 与 server/src/constants.js 的 LEADER_SPECIALTIES 一致
const SPECIALTIES = ['徒步', '骑行', '登山', '摄影', '露营', '桌游', '咖啡', '美食', '读书', '拼车自驾', '其他'];

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
    specialtyList: SPECIALTIES,
    realName: '',
    specPicked: {},
    intro: '',
    emName: '',
    emPhone: '',
    images: [],
    agree: false,
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

  onRealName(e) {
    this.setData({ realName: e.detail.value });
  },

  onIntro(e) {
    this.setData({ intro: e.detail.value });
  },

  onEmName(e) {
    this.setData({ emName: e.detail.value });
  },

  onEmPhone(e) {
    this.setData({ emPhone: e.detail.value });
  },

  onImages(e) {
    this.setData({ images: e.detail.urls, uploading: e.detail.uploading });
  },

  toggleSpec(e) {
    const s = e.currentTarget.dataset.spec;
    this.setData({ specPicked: Object.assign({}, this.data.specPicked, { [s]: !this.data.specPicked[s] }) });
  },

  toggleAgree() {
    this.setData({ agree: !this.data.agree });
  },

  toast(title) {
    wx.showToast({ title, icon: 'none' });
  },

  submit() {
    if (this.data.submitting) return;
    const d = this.data;
    const realName = d.realName.trim();
    const intro = d.intro.trim();
    const emName = d.emName.trim();
    const emPhone = d.emPhone.trim();
    const specialties = d.specialtyList.filter((x) => d.specPicked[x]);
    if (realName.length < 2) return this.toast('填一下真实姓名');
    if (!specialties.length) return this.toast('选一个你擅长带的方向');
    if (intro.length < 10) return this.toast('多写一点带队介绍吧（至少 10 字）');
    if (emName.length < 2) return this.toast('填一下紧急联系人');
    if (!/^[0-9+\- ]{6,20}$/.test(emPhone)) return this.toast('填一个能打通的紧急联系人电话');
    if (!d.images.length) return this.toast('上传至少一张证明材料');
    if (d.uploading) return this.toast('图片还在上传，稍等一下');
    if (!d.agree) return this.toast('请先勾选「如实填写并对带队安全负责」');
    this.setData({ submitting: true });
    api
      .applyLeader({ realName, specialties, intro, emergencyName: emName, emergencyPhone: emPhone, images: d.images, agree: true })
      .then(() => {
        wx.showToast({ title: '已提交，等平台审核', icon: 'none' });
        this.setData({ realName: '', specPicked: {}, intro: '', emName: '', emPhone: '', images: [], agree: false });
        this.load();
      })
      .catch(() => {}) // request 已经弹过错误（如「先完成手机号认证」）
      .then(() => this.setData({ submitting: false }));
  },
});

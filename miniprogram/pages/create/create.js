// 发起一个局：类型、标题、时间（picker）、地点（chooseLocation / 文字兜底）、人数、费用、开关、说明
const api = require('../../utils/api');
const format = require('../../utils/format');
const native = require('../../utils/native');
const session = require('../../utils/session');

const TYPES = [
  { value: 'outdoor', label: '户外' },
  { value: 'food', label: '吃饭' },
  { value: 'coffee', label: '咖啡' },
  { value: 'game', label: '桌游' },
  { value: 'carpool', label: '拼车' },
  { value: 'other', label: '其他' }
];
const FEES = [
  { value: 'aa', label: 'AA' },
  { value: 'free', label: '免费' },
  { value: 'host', label: '我请客' }
];

Page({
  data: {
    types: TYPES,
    fees: FEES,
    category: 'outdoor',
    title: '',
    date: '',
    dateText: '',
    time: '',
    minDate: '',
    maxDate: '',
    place: '',
    capacity: 5,
    feeType: 'aa',
    feeEstimate: '',
    requireApproval: false,
    sameSexOnly: false,
    description: '',
    submitting: false,
    published: false,
    doneText: ''
  },

  onLoad() {
    this.setData({ minDate: format.dateStr(0), maxDate: format.dateStr(60) });
  },

  pickType(e) {
    this.setData({ category: e.currentTarget.dataset.value });
  },

  onTitle(e) {
    this.setData({ title: e.detail.value });
  },

  onDate(e) {
    const date = e.detail.value;
    this.setData({ date, dateText: format.dateLabel(date) });
  },

  onTime(e) {
    this.setData({ time: e.detail.value });
  },

  pickPlace() {
    native.pickPlace(this.data.place).then((p) => {
      if (p) this.setData({ place: p.name });
    });
  },

  dec() {
    if (this.data.capacity > 2) this.setData({ capacity: this.data.capacity - 1 });
  },

  inc() {
    if (this.data.capacity < 20) this.setData({ capacity: this.data.capacity + 1 });
  },

  pickFee(e) {
    this.setData({ feeType: e.currentTarget.dataset.value });
  },

  onFee(e) {
    this.setData({ feeEstimate: e.detail.value });
  },

  toggleApproval(e) {
    this.setData({ requireApproval: e.detail.value });
  },

  toggleSameSex(e) {
    const on = e.detail.value;
    if (!on) {
      this.setData({ sameSexOnly: false });
      return;
    }
    session
      .loadMe()
      .then((me) => {
        if (me.gender === 'female' || me.gender === 'male') {
          this.setData({ sameSexOnly: true });
          return;
        }
        native.confirm({ title: '先填一下性别', content: '同性局需要知道你的性别，只用于匹配，不会公开。', confirmText: '去填写', cancelText: '先不用' }).then((ok) => {
          if (ok) wx.navigateTo({ url: '/pages/edit-profile/edit-profile' });
        });
      })
      .catch(() => {});
  },

  onDesc(e) {
    this.setData({ description: e.detail.value });
  },

  publish() {
    if (this.data.submitting) return;
    const d = this.data;
    const title = d.title.trim();
    if (!title) return this.hint('先写个标题');
    if (!d.date || !d.time) return this.hint('选一下时间');
    const startAt = format.toISO(d.date, d.time);
    if (new Date(startAt).getTime() < Date.now() + 30 * 60 * 1000) return this.hint('开始时间要晚于现在半小时以上');
    if (!d.place) return this.hint('选一下集合地点');
    let feeEstimate;
    if (d.feeType === 'aa' && d.feeEstimate !== '') {
      feeEstimate = Math.round(Number(d.feeEstimate) * 100) / 100;
      if (!(feeEstimate >= 0)) return this.hint('每人费用填个数字就好');
    }
    const body = {
      title,
      category: d.category,
      startAt,
      place: d.place,
      capacity: d.capacity,
      feeType: d.feeType,
      requireApproval: d.requireApproval,
      sameSexOnly: d.sameSexOnly
    };
    if (feeEstimate !== undefined) body.feeEstimate = feeEstimate;
    if (d.description.trim()) body.description = d.description.trim();

    this.setData({ submitting: true });
    api
      .createEvent(body)
      .then((ev) => {
        this.eventId = ev.id;
        session.markDirty('square');
        this.setData({
          published: true,
          doneText:
            ev.status === 'pending_review'
              ? '审核通过后，大家就能在广场看到。满员会自动建群，并提醒你。'
              : '已经出现在广场上了。满员会自动建群，并提醒你。'
        });
        wx.setNavigationBarTitle({ title: '发布成功' });
      })
      .catch(() => {})
      .then(() => this.setData({ submitting: false }));
    return null;
  },

  hint(text) {
    wx.showToast({ title: text, icon: 'none' });
    return null;
  },

  openMine() {
    wx.redirectTo({ url: '/pages/my-events/my-events?tab=created' });
  },

  goSquare() {
    wx.switchTab({ url: '/pages/square/square' });
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' });
  }
});

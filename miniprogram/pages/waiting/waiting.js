// 撮合中：看进度、放宽条件、开提醒、取消意向。被邀请后自动跳到「撮合成功」。
const api = require('../../utils/api');
const format = require('../../utils/format');
const native = require('../../utils/native');

const NOTIFY_KEY = 'dz_notify_intent_';

Page({
  data: {
    loading: true,
    error: '',
    closed: false,
    closedTitle: '',
    closedDesc: '',
    intent: null,
    meta: '',
    seats: [],
    countText: '',
    needText: '',
    progress: 0,
    stage: 1,
    submitted: '',
    notify: false
  },

  onLoad(query) {
    this.id = Number(query.id);
    let notify = false;
    try {
      notify = !!wx.getStorageSync(NOTIFY_KEY + this.id);
    } catch (e) {
      notify = false;
    }
    this.setData({ notify });
    if (!this.id) {
      this.setData({ loading: false, error: '链接里缺少意向编号' });
      return;
    }
    this.load(true);
  },

  onShow() {
    if (this.loaded && !this.stopped) this.load(false);
    clearInterval(this.timer);
    // 每 15 秒看一眼有没有配到人
    if (!this.stopped) this.timer = setInterval(() => this.load(false), 15000);
  },

  onHide() {
    clearInterval(this.timer);
  },

  onUnload() {
    this.stop();
  },

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  },

  onPullDownRefresh() {
    this.load(true).then(() => wx.stopPullDownRefresh());
  },

  load(showError) {
    return api
      .intent(this.id, { silent: !showError })
      .then((it) => {
        this.loaded = true;
        if (it.status === 'invited' && it.eventId) {
          this.stop();
          wx.redirectTo({ url: '/pages/match/match?eventId=' + it.eventId });
          return;
        }
        if (it.status === 'matched' && it.eventId) {
          this.stop();
          wx.redirectTo({ url: '/pages/detail/detail?id=' + it.eventId });
          return;
        }
        if (it.status === 'cancelled' || it.status === 'expired') {
          this.stop();
          this.setData({
            loading: false,
            closed: true,
            closedTitle: it.status === 'expired' ? '这个意向过期了' : '这个意向已取消',
            closedDesc: '想做的事还在的话，回首页再说一次就好。'
          });
          return;
        }
        this.render(it);
      })
      .catch((err) => {
        if (showError) this.setData({ loading: false, error: err.message });
      });
  },

  render(it) {
    const count = (it.similarCount || 0) + 1;
    const need = Math.max(0, it.needMore || 0);
    const filled = Math.min(count, 5);
    const empty = Math.min(need, 6 - filled);
    const seats = [];
    for (let i = 0; i < filled; i++) seats.push({ key: 'f' + i, filled: true, alt: i % 2 === 1 });
    for (let j = 0; j < empty; j++) seats.push({ key: 'e' + j, filled: false });
    const meta = [it.slotLabel || format.SLOT[it.slot], format.sizeLabel(it.sizeMin, it.sizeMax, it.relaxSize), it.area ? it.area + '附近出发' : '']
      .filter(Boolean)
      .join(' · ');
    const proposed = it.status === 'proposed';
    this.setData({
      loading: false,
      error: '',
      intent: it,
      meta,
      seats,
      countText: '已有 ' + count + ' 人同意向',
      needText: proposed || need === 0 ? '人凑齐了，正在确认 · 成局前互相看不到是谁' : '还差 ' + need + ' 人就能成局 · 成局前互相看不到是谁',
      progress: proposed || need === 0 ? 100 : Math.round((count / (count + need)) * 100),
      stage: proposed || need === 0 ? 2 : 1,
      submitted: format.stamp(it.submittedAt || it.createdAt)
    });
  },

  toggleNotify() {
    if (this.data.notify) {
      this.setData({ notify: false });
      try {
        wx.removeStorageSync(NOTIFY_KEY + this.id);
      } catch (e) {
        // ignore
      }
      wx.showToast({ title: '已关闭提醒', icon: 'none' });
      return;
    }
    native.subscribe(['match']).then((ok) => {
      if (!ok) return;
      this.setData({ notify: true });
      try {
        wx.setStorageSync(NOTIFY_KEY + this.id, 1);
      } catch (e) {
        // ignore
      }
    });
  },

  toggleRelax(e) {
    const key = e.currentTarget.dataset.key;
    if (this.busy || !this.data.intent) return;
    this.busy = true;
    const value = !this.data.intent[key];
    this.setData({ ['intent.' + key]: value });
    api
      .updateIntent(this.id, { [key]: value })
      .then(() => {
        wx.showToast({ title: value ? '已放宽，成局会快一些' : '已恢复原来的条件', icon: 'none' });
        return this.load(false);
      })
      .catch(() => this.setData({ ['intent.' + key]: !value }))
      .then(() => {
        this.busy = false;
      });
  },

  goSquare() {
    wx.switchTab({ url: '/pages/square/square' });
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' });
  },

  cancel() {
    native
      .confirm({ title: '取消这个意向？', content: '取消后就不再为你撮合这件事了，不影响信用。', confirmText: '取消意向', cancelText: '再等等', confirmColor: '#B42318' })
      .then((ok) => {
        if (!ok) return;
        api
          .cancelIntent(this.id)
          .then(() => {
            this.stop();
            wx.showToast({ title: '已取消', icon: 'success' });
            setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 600);
          })
          .catch(() => {});
      });
  }
});

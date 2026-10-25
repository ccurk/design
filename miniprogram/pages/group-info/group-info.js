// 局信息：成员、AA 入口、免打扰、举报、退出（24 小时内退出提示临时鸽）
const api = require('../../utils/api');
const format = require('../../utils/format');
const native = require('../../utils/native');
const session = require('../../utils/session');

Page({
  data: {
    loading: true,
    error: '',
    event: null,
    when: '',
    members: [],
    aaText: '',
    muted: false,
    isHost: false,
    canLeave: true
  },

  onLoad(query) {
    this.id = Number(query.id);
    if (!this.id) {
      this.setData({ loading: false, error: '链接里缺少局的编号' });
      return;
    }
  },

  onShow() {
    if (this.id) this.load();
  },

  load() {
    return api
      .eventInfo(this.id)
      .then((res) => {
        const ev = res.event || {};
        const members = res.members || [];
        const me = members.filter((m) => m.isMe)[0];
        const isHost = !!(me && me.role === 'host' && ev.source === 'user');
        const aa = res.aa || {};
        let aaText = '还没记账';
        if (Number(aa.each) > 0) aaText = '每人 ¥' + format.money(aa.each) + (aa.openTransfers ? ' · ' + aa.openTransfers + ' 笔待转' : ' · 已结清');
        this.setData({
          loading: false,
          error: '',
          event: ev,
          when: [format.mdhm(ev.startAt), ev.place].filter(Boolean).join(' · '),
          members,
          aaText,
          muted: !!res.muted,
          isHost,
          canLeave: ev.phase !== 'ended' && ev.status !== 'cancelled'
        });
      })
      .catch((err) => this.setData({ loading: false, error: err.message }));
  },

  openDetail() {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + this.id });
  },

  openUser(e) {
    const { id, me } = e.currentTarget.dataset;
    if (!id || me) return;
    wx.navigateTo({ url: '/pages/user/user?id=' + id });
  },

  openAA() {
    wx.navigateTo({ url: '/pages/aa/aa?id=' + this.id });
  },

  toggleMute(e) {
    const muted = e.detail.value;
    this.setData({ muted });
    api
      .muteEvent(this.id, muted)
      .then(() => wx.showToast({ title: muted ? '已开启免打扰' : '已关闭免打扰', icon: 'none' }))
      .catch(() => this.setData({ muted: !muted }));
  },

  report() {
    wx.navigateTo({ url: '/pages/report/report?targetType=event&targetId=' + this.id });
  },

  leave() {
    const ev = this.data.event;
    if (this.data.isHost) {
      native
        .confirm({ title: '取消这个局？', content: '已加入的人会收到通知。尽量提前说，大家好另做安排。', confirmText: '取消这个局', cancelText: '再想想', confirmColor: '#B42318' })
        .then((ok) => {
          if (!ok) return;
          api
            .cancelEvent(this.id)
            .then(() => {
              session.markDirty('square');
              wx.showToast({ title: '已取消', icon: 'success' });
              setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 700);
            })
            .catch(() => {});
        });
      return;
    }
    const within = format.hoursUntil(ev.startAt) < 24;
    native
      .confirm({
        title: '确定退出这个局吗？',
        content: within
          ? '离开场不到 24 小时了，现在退出会记一次「临时鸽」。名额会让给候补的人。'
          : '现在退出不影响信用，名额会让给候补的人。开场前 24 小时内退出，会记一次「临时鸽」。',
        confirmText: '确定退出',
        cancelText: '再想想',
        confirmColor: '#B42318'
      })
      .then((ok) => {
        if (!ok) return;
        api
          .leave(this.id)
          .then((res) => {
            session.markDirty('square');
            wx.showToast({ title: res && res.penalty ? '已退出，记了一次临时鸽' : '已退出', icon: 'none' });
            setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 900);
          })
          .catch(() => {});
      });
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/inbox/inbox' }) });
  }
});

// 局信息：成员、AA 入口（一次声明的那笔）、免打扰、举报、退出（过了最晚退出时间变灰并写明原因）
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
    showLeave: true,
    leaveOff: false,
    leaveReason: ''
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
    return Promise.all([api.eventInfo(this.id, { silent: true }), api.aa(this.id, { silent: true }).catch(() => null)])
      .then(([res, aa]) => {
        const ev = res.event || {};
        const members = res.members || [];
        const me = members.filter((m) => m.isMe)[0];
        const isHost = !!(me && me.role === 'host' && ev.source === 'user');
        const live = ev.phase !== 'ended' && ev.status !== 'cancelled';
        this.setData({
          loading: false,
          error: '',
          event: ev,
          when: [format.mdhm(ev.startAt), ev.place].filter(Boolean).join(' · '),
          members,
          aaText: this.aaText(aa, res.aa),
          muted: !!res.muted,
          isHost,
          showLeave: live,
          leaveOff: !isHost && ev.canLeave === false,
          leaveReason: !isHost && ev.canLeave === false ? ev.leaveBlockedReason || '已过最晚退出时间，不能退出了' : ''
        });
      })
      .catch((err) => this.setData({ loading: false, error: err.message }));
  },

  // 「阿野 垫付 ¥150 · 2 笔待转」
  aaText(aa, fallback) {
    if (aa && aa.bill) {
      const b = aa.bill;
      const who = b.mine ? '我' : (b.payer && b.payer.nickname) || '';
      const open = (aa.transfers || []).filter((t) => t.status !== 'confirmed').length;
      return who + ' 垫付 ¥' + format.money(b.amount) + (open ? ' · ' + open + ' 笔待转' : ' · 已结清');
    }
    if (aa) return '还没人记';
    const f = fallback || {};
    if (Number(f.each) > 0) return '每人 ¥' + format.money(f.each) + (f.openTransfers ? ' · ' + f.openTransfers + ' 笔待转' : ' · 已结清');
    return '还没人记';
  },

  openDetail() {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + this.id });
  },

  // C 再约：带上这帮人和地点去发起一个新局
  reunion() {
    const ev = this.data.event;
    if (!ev) return;
    const ids = (this.data.members || []).filter((m) => !m.isMe && m.id).map((m) => m.id);
    const q = ['tag=' + encodeURIComponent(ev.tag || ev.task || ''), 'place=' + encodeURIComponent(ev.place || ''), ids.length ? 'invite=' + ids.join(',') : '']
      .filter(Boolean)
      .join('&');
    wx.navigateTo({ url: '/pages/create/create?' + q });
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
    if (!ev) return;
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
    if (this.data.leaveOff) {
      wx.showModal({ title: '不能退出了', content: this.data.leaveReason, showCancel: false, confirmText: '知道了', confirmColor: '#193543' });
      return;
    }
    const deadline = ev.exitDeadlineLabel || (ev.exitDeadline ? format.mdhm(ev.exitDeadline) : '');
    native
      .confirm({
        title: '确定退出这个局吗？',
        content: (deadline ? '最晚退出时间是 ' + deadline + '，过了就不能退了。' : '') + '退出后名额会让给别人。',
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

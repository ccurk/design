// 他人主页：信用、共同点、最近的局；举报、拉黑（不能私聊）
const api = require('../../utils/api');
const native = require('../../utils/native');
const session = require('../../utils/session');

function creditNote(c, hidden) {
  if (hidden) return '只看得到履约率。信用只看守不守约，不看话多不多。';
  const parts = [];
  if (c.cancelLate) parts.push('有 ' + c.cancelLate + ' 次临时取消');
  else parts.push('没有临时取消');
  if (c.noShow) parts.push('有 ' + c.noShow + ' 次放鸽子记录');
  else parts.push('没有放鸽子记录');
  if (c.late) parts.push('迟到过 ' + c.late + ' 次');
  let text = parts.join('，') + '。';
  if (c.level === 'restricted') text += '账号暂时受限中。';
  else if (c.level === 'fair') text += '信用一般。';
  return text;
}

Page({
  data: {
    loading: true,
    error: '',
    user: null,
    credit: {},
    creditNote: '',
    commonPoints: [],
    recent: [],
    hidden: false,
    blocked: false,
    isMe: false
  },

  onLoad(query) {
    this.id = Number(query.id);
    if (!this.id) {
      this.setData({ loading: false, error: '链接里缺少用户编号' });
      return;
    }
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    return Promise.all([api.user(this.id, { silent: true }), session.loadMe().catch(() => null)])
      .then(([res, me]) => {
        const user = res.user || {};
        const credit = res.credit || { rate: user.creditRate, level: user.creditLevel };
        if (credit.rate === undefined) credit.rate = user.creditRate;
        const hidden = !!res.profileHidden;
        const recent = (res.recentEvents || []).map((e) => ({
          id: e.id,
          title: e.title,
          cover: e.cover || '',
          coverKey: e.coverKey || '',
          category: e.category || '',
          sharedWithMe: !!e.sharedWithMe,
          link: !!e.sharedWithMe || !e.ended,
          sub: [e.dateLabel, e.sharedWithMe ? '和你同一个局' : e.ended ? '已结束' : ''].filter(Boolean).join(' · ')
        }));
        wx.setNavigationBarTitle({ title: (user.nickname || 'TA') + '的主页' });
        this.setData({
          loading: false,
          error: '',
          user: Object.assign({ interests: [] }, user),
          credit,
          creditNote: creditNote(credit, hidden),
          commonPoints: res.commonPoints || [],
          recent,
          hidden,
          blocked: !!res.blockedByMe,
          isMe: !!(me && me.id === user.id)
        });
      })
      .catch((err) => this.setData({ loading: false, error: err.message }));
  },

  openEvent(e) {
    const item = this.data.recent[e.currentTarget.dataset.index];
    if (item && item.link) wx.navigateTo({ url: '/pages/detail/detail?id=' + item.id });
  },

  report() {
    wx.navigateTo({ url: '/pages/report/report?targetType=user&targetId=' + this.id });
  },

  toggleBlock() {
    if (this.busy) return;
    if (this.data.blocked) {
      this.busy = true;
      api
        .unblock(this.id)
        .then(() => {
          this.setData({ blocked: false });
          wx.showToast({ title: '已移出黑名单', icon: 'none' });
        })
        .catch(() => {})
        .then(() => {
          this.busy = false;
        });
      return;
    }
    native
      .confirm({ title: '拉黑 TA？', content: '以后不会再撮合到一起，也看不到 TA 的动态。对方不会收到通知。', confirmText: '拉黑', confirmColor: '#B42318' })
      .then((ok) => {
        if (!ok) return;
        this.busy = true;
        api
          .block(this.id)
          .then(() => {
            this.setData({ blocked: true });
            session.markDirty('feed');
            wx.showToast({ title: '已拉黑', icon: 'none' });
          })
          .catch(() => {})
          .then(() => {
            this.busy = false;
          });
      });
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/square/square' }) });
  }
});

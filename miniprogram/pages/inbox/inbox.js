// 消息：需要你处理（轻确认出席 / 撮合成功 / 去评价）、局聊、通知
const api = require('../../utils/api');
const format = require('../../utils/format');
const nav = require('../../utils/nav');
const native = require('../../utils/native');

const NOTICE_ICON = {
  match: '/assets/icons/sparkle-primary.svg',
  matched: '/assets/icons/sparkle-primary.svg',
  report_result: '/assets/icons/shield-check-gray.svg',
  restricted: '/assets/icons/shield-check-gray.svg',
  appeal_result: '/assets/icons/shield-check-gray.svg',
  credit: '/assets/icons/shield-check-gray.svg'
};
const DEFAULT_ICON = '/assets/icons/bell-gray.svg';

function mapAction(a, i) {
  const base = Object.assign({ key: a.type + '-' + (a.eventId || i) }, a);
  if (a.type === 'match') base.sub = a.deadline ? '去看看是谁，' + format.mdhm(a.deadline) + ' 前确认' : '去看看是谁';
  else if (a.type === 'review') base.sub = '给同行的人一个评价 · 匿名';
  else base.sub = a.body || '去看看';
  return base;
}

Page({
  data: {
    loading: true,
    loaded: false,
    error: '',
    actions: [],
    chats: [],
    notices: []
  },

  onShow() {
    nav.setTab(this, 3);
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    this.setData({ loading: true });
    return api
      .inbox({ silent: this.data.loaded })
      .then((res) => {
        // 刚回答过的轻确认，5 分钟内保留结果（服务端已不再返回这条）
        const answered = {};
        this.data.actions.forEach((a) => {
          if (a.answer && Date.now() - a.answeredAt < 5 * 60 * 1000) answered[a.key] = a;
        });
        const actions = (res.actions || []).map(mapAction).map((a) => answered[a.key] || a);
        Object.keys(answered).forEach((k) => {
          if (!actions.some((a) => a.key === k)) actions.push(answered[k]);
        });
        const chats = (res.chats || []).map((c) => {
          const m = c.lastMessage;
          return Object.assign({}, c, {
            preview: m ? (m.nickname ? m.nickname + '：' : '') + m.text : '还没有人说话，打个招呼吧',
            time: m ? format.chatTime(m.createdAt) : '',
            unreadText: c.unread > 99 ? '99+' : String(c.unread || '')
          });
        });
        const notices = (res.notices || []).map((n) => Object.assign({}, n, {
          text: n.body ? n.title + '，' + n.body : n.title,
          time: format.stamp(n.createdAt),
          icon: NOTICE_ICON[n.type] || DEFAULT_ICON
        }));
        this.setData({ loading: false, loaded: true, error: '', actions, chats, notices });
      })
      .catch((err) => this.setData({ loading: false, error: err.message }));
  },

  attendYes(e) {
    const i = e.currentTarget.dataset.index;
    const a = this.data.actions[i];
    if (!a || this.busy) return;
    this.busy = true;
    api
      .attendance(a.eventId, true)
      .then(() =>
        this.setData({
          ['actions[' + i + '].answer']: 'yes',
          ['actions[' + i + '].answeredAt']: Date.now(),
          ['actions[' + i + '].dayWord']: format.dayWord(a.startAt)
        })
      )
      .catch(() => {})
      .then(() => {
        this.busy = false;
      });
  },

  attendNo(e) {
    const i = e.currentTarget.dataset.index;
    const a = this.data.actions[i];
    if (!a || this.busy) return;
    const within = format.hoursUntil(a.startAt) < 24;
    native
      .confirm({
        title: '去不了了？',
        content: within ? '离开场不到 24 小时了，现在说会记一次「临时鸽」。名额会让给候补的人。' : '提前说不算鸽，名额会让给候补的人。',
        confirmText: '去不了了',
        cancelText: '再想想',
        confirmColor: '#B42318'
      })
      .then((ok) => {
        if (!ok) return;
        this.busy = true;
        api
          .attendance(a.eventId, false)
          .then((res) => {
            const noText = res && res.penalty
              ? '已帮你退出，名额让给了候补。离开场不到 24 小时，记了一次临时鸽。'
              : '已帮你退出，名额让给了候补。提前说的，不算鸽。';
            this.setData({ ['actions[' + i + '].answer']: 'no', ['actions[' + i + '].answeredAt']: Date.now(), ['actions[' + i + '].noText']: noText });
          })
          .catch(() => {})
          .then(() => {
            this.busy = false;
          });
      });
  },

  openAction(e) {
    const a = this.data.actions[e.currentTarget.dataset.index];
    if (!a) return;
    if (a.type === 'match') wx.navigateTo({ url: '/pages/match/match?eventId=' + a.eventId });
    else if (a.type === 'review') wx.navigateTo({ url: '/pages/review/review?id=' + a.eventId });
    else if (a.eventId) wx.navigateTo({ url: '/pages/detail/detail?id=' + a.eventId });
  },

  openChat(e) {
    wx.navigateTo({ url: '/pages/group/group?id=' + e.currentTarget.dataset.id });
  },

  openNotice(e) {
    const i = e.currentTarget.dataset.index;
    const n = this.data.notices[i];
    if (!n) return;
    if (!n.read) {
      this.setData({ ['notices[' + i + '].read']: true });
      api.readNotice(n.id).catch(() => {});
    }
    if (n.link) nav.openLink(n.link);
  }
});

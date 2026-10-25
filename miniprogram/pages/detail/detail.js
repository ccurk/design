// 局详情：信息、同行的人、加入 / 申请 / 进群 / 去评价；发起人可处理报名、取消局；可分享
const api = require('../../utils/api');
const format = require('../../utils/format');
const native = require('../../utils/native');
const session = require('../../utils/session');

const SOURCE = { matched: '平台撮合局', platform: '平台局', user: '用户发起' };
const HOST_LINE = {
  matched: '由平台撮合 · 没有发起人，不用谁来张罗',
  platform: '平台组织 · 有工作人员跟进'
};

function computeCta(ev, isHost) {
  if (ev.status === 'cancelled') return { label: '已取消', disabled: true };
  if (ev.status === 'rejected') return { label: '没通过审核', disabled: true };
  if (ev.status === 'pending_review') return { label: '审核中', disabled: true };
  const member = ev.myStatus === 'joined';
  if (ev.phase === 'ended') {
    return member ? { label: '去评价', action: 'review' } : { label: '已结束', disabled: true };
  }
  if (member) return ev.chatOpen ? { label: '进入群聊', action: 'group' } : { label: isHost ? '等人加入' : '等大家确认', disabled: true };
  if (ev.myStatus === 'invited') return { label: '去确认', action: 'match' };
  if (ev.myStatus === 'applied') return { label: '等发起人同意', disabled: true };
  if (ev.isFull) return { label: '已满员', disabled: true };
  if (!ev.canJoin) return { label: '暂时不能加入', disabled: true };
  return { label: ev.requireApproval ? '申请加入' : '加入', action: 'join' };
}

Page({
  data: {
    loading: true,
    error: '',
    event: null,
    members: [],
    seats: [],
    canWait: false,
    applications: [],
    sourceLabel: '',
    categoryLabel: '',
    hostLine: '',
    dateFull: '',
    durationText: '',
    feeTitle: '',
    feeNote: '',
    slotText: '',
    fillPct: 0,
    cta: { label: '' },
    canCancel: false
  },

  onLoad(query) {
    this.id = Number(query.id);
    if (!this.id) {
      this.setData({ loading: false, error: '链接里缺少局的编号' });
      return;
    }
    if (wx.showShareMenu) wx.showShareMenu({ withShareTicket: false, menus: ['shareAppMessage'] });
    this.load();
  },

  onShow() {
    if (this.loaded) this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  onShareAppMessage() {
    const ev = this.data.event;
    return {
      title: ev ? ev.title + ' · 一起吗？' : '活动搭子 · 大理兴趣局',
      path: '/pages/detail/detail?id=' + this.id
    };
  },

  load() {
    return Promise.all([api.event(this.id), session.loadMe().catch(() => null)])
      .then(([ev, me]) => {
        this.loaded = true;
        const myId = me ? me.id : session.myId();
        const isHost = typeof ev.isHost === 'boolean' ? ev.isHost : !!(ev.host && ev.host.id === myId);
        const members = ev.members || [];
        const free = Math.max(0, (ev.capacity || 0) - (ev.memberCount || members.length));
        const seats = [];
        for (let i = 0; i < Math.min(free, 6); i++) seats.push('s' + i);
        const cta = computeCta(ev, isHost);
        let slotText = ev.isFull ? '已满员' : '还剩 ' + free + ' 个名额';
        if (ev.phase === 'ended') slotText = (ev.memberCount || members.length) + ' 人参加了';
        const estimate = ev.feeType === 'aa' && ev.feeEstimate ? 'AA 约 ¥' + format.money(ev.feeEstimate) + '/人' : '';
        this.setData({
          loading: false,
          error: '',
          event: ev,
          members,
          seats,
          canWait: cta.action === 'join',
          sourceLabel: SOURCE[ev.source] || '兴趣局',
          categoryLabel: format.CATEGORY[ev.category] || '其他',
          hostLine: HOST_LINE[ev.source] || '大家一起组的局',
          dateFull: format.fullDate(ev.startAt),
          durationText: format.duration(ev.durationMin),
          feeTitle: estimate || ev.feeLabel || '费用待定',
          feeNote: format.FEE_NOTE[ev.feeType] || '平台不经手钱',
          slotText,
          fillPct: ev.capacity ? Math.min(100, Math.round(((ev.memberCount || members.length) / ev.capacity) * 100)) : 0,
          cta,
          canCancel: isHost && ev.phase !== 'ended' && ['open', 'formed', 'pending_review'].indexOf(ev.status) >= 0
        });
        if (isHost && ev.requireApproval && ev.status === 'open') this.loadApplications();
        else if (this.data.applications.length) this.setData({ applications: [] });
      })
      .catch((err) => this.setData({ loading: false, error: err.message }));
  },

  loadApplications() {
    api
      .applications(this.id)
      .then((res) => {
        const list = (res && res.items) || (Array.isArray(res) ? res : []);
        this.setData({ applications: list.map((a) => a.user || a) });
      })
      .catch(() => {});
  },

  onCta() {
    const cta = this.data.cta;
    if (!cta || cta.disabled) return;
    if (cta.action === 'join') this.join();
    else if (cta.action === 'group') wx.navigateTo({ url: '/pages/group/group?id=' + this.id });
    else if (cta.action === 'match') wx.navigateTo({ url: '/pages/match/match?eventId=' + this.id });
    else if (cta.action === 'review') wx.navigateTo({ url: '/pages/review/review?id=' + this.id });
  },

  join() {
    if (this.busy) return;
    this.busy = true;
    // 顺手请求开始提醒的订阅（没配模板时静默）
    native.subscribe(['reminder'], { silent: true });
    api
      .join(this.id)
      .then((res) => {
        session.markDirty('square');
        if (res.myStatus === 'applied') {
          wx.showToast({ title: '已申请，等发起人同意', icon: 'none' });
          return this.load();
        }
        wx.showToast({ title: res.eventStatus === 'formed' ? '满员啦，群已建好' : '加入成功', icon: 'success' });
        return this.load().then(() => {
          if (this.data.event && this.data.event.chatOpen) {
            setTimeout(() => wx.navigateTo({ url: '/pages/group/group?id=' + this.id }), 700);
          }
        });
      })
      .catch(() => {})
      .then(() => {
        this.busy = false;
      });
  },

  approveApp(e) {
    api
      .approve(this.id, e.currentTarget.dataset.id)
      .then(() => {
        wx.showToast({ title: '已同意', icon: 'success' });
        this.load();
      })
      .catch(() => {});
  },

  rejectApp(e) {
    const userId = e.currentTarget.dataset.id;
    native.confirm({ title: '婉拒这个申请？', content: '不用解释原因，对方可以继续报名别的局。', confirmText: '婉拒' }).then((ok) => {
      if (!ok) return;
      api
        .reject(this.id, userId)
        .then(() => this.load())
        .catch(() => {});
    });
  },

  cancelEvent() {
    native
      .confirm({ title: '取消这个局？', content: '已加入的人会收到通知。发起人取消不影响信用，但尽量提前说。', confirmText: '取消这个局', cancelText: '再想想', confirmColor: '#B42318' })
      .then((ok) => {
        if (!ok) return;
        api
          .cancelEvent(this.id)
          .then(() => {
            session.markDirty('square');
            wx.showToast({ title: '已取消', icon: 'success' });
            this.load();
          })
          .catch(() => {});
      });
  },

  openUser(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/user/user?id=' + id });
  },

  report() {
    wx.navigateTo({ url: '/pages/report/report?targetType=event&targetId=' + this.id });
  },

  goSquare() {
    wx.switchTab({ url: '/pages/square/square' });
  }
});

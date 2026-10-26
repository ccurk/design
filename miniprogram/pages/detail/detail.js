// 局详情（docs/changes-v0.3.md C / I）：照片轮播（没有照片用标签插画）、时间地点费用、最晚退出时间、
// 同行的人；「加入」→ 确认弹窗（含免责声明）→ 结果（还差 N 人 / 满员进群）；
// 加入后没成群时底部显示进度和「邀请朋友」，成群后才能进群聊；过了最晚退出时间「退出这个局」变灰并写明原因。
const api = require('../../utils/api');
const format = require('../../utils/format');
const native = require('../../utils/native');
const request = require('../../utils/request');
const session = require('../../utils/session');

const SOURCE = { matched: '平台撮合局', platform: '平台局', user: '用户发起' };
const HOST_LINE = {
  matched: '由平台撮合 · 没有发起人，不用谁来张罗',
  platform: '平台组织 · 有工作人员跟进'
};

// 底部栏：mode = action（一个主按钮）| waiting（已加入未成群：进度 + 邀请）
function deadlinePassed(ev) {
  const t = ev.exitDeadline ? new Date(ev.exitDeadline).getTime() : 0;
  return !!t && t <= Date.now();
}

function computeBar(ev, isHost) {
  const remaining = typeof ev.remaining === 'number' ? ev.remaining : Math.max(0, (ev.capacity || 0) - (ev.memberCount || 0));
  if (ev.status === 'cancelled') return { mode: 'action', label: '已取消', disabled: true };
  if (ev.status === 'rejected') return { mode: 'action', label: '没通过审核', disabled: true };
  if (ev.status === 'pending_review') return { mode: 'action', label: '审核中', disabled: true };
  const member = ev.myStatus === 'joined';
  if (ev.phase === 'ended') return member ? { mode: 'action', label: '去评价', action: 'review' } : { mode: 'action', label: '已结束', disabled: true };
  if (member) {
    if (ev.chatOpen) return { mode: 'action', label: '进入群聊', action: 'group' };
    return { mode: 'waiting', remaining, isHost };
  }
  if (ev.myStatus === 'invited') return { mode: 'action', label: '去确认', action: 'match' };
  if (ev.myStatus === 'applied') return { mode: 'action', label: '等发起人同意', disabled: true };
  if (ev.isFull || ev.status === 'formed') return { mode: 'action', label: ev.isFull ? '已满员' : '已成群', disabled: true };
  if (deadlinePassed(ev)) return { mode: 'action', label: '已截止报名', disabled: true };
  if (!ev.canJoin) return { mode: 'action', label: '暂时不能加入', disabled: true };
  return { mode: 'action', label: ev.requireApproval ? '申请加入' : '加入', action: 'join' };
}

Page({
  data: {
    loading: true,
    error: '',
    event: null,
    images: [],
    imageIndex: 0,
    members: [],
    seats: [],
    canWait: false,
    applications: [],
    sourceLabel: '',
    hostLine: '',
    dateFull: '',
    durationText: '',
    feeTitle: '',
    feeNote: '',
    placeSub: '',
    hasMap: false,
    slotText: '',
    exitPassed: false,
    fillPct: 0,
    bar: { mode: 'action', label: '' },
    canCancel: false,
    leave: null,
    joinShow: false,
    joinInfo: {},
    joinBusy: false,
    joinResult: null
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
    if (this.loaded && !this.data.joinShow) this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  onShareAppMessage() {
    const ev = this.data.event;
    const share = {
      title: ev ? (ev.remaining > 0 ? '还差 ' + ev.remaining + ' 人：' : '') + ev.title : '活动搭子 · 大理兴趣局',
      path: '/pages/detail/detail?id=' + this.id
    };
    if (this.data.images.length) share.imageUrl = this.data.images[0];
    return share;
  },

  load() {
    return Promise.all([api.event(this.id, { silent: true }), session.loadMe().catch(() => null)])
      .then(([ev, me]) => {
        this.loaded = true;
        this.render(ev, me);
      })
      .catch((err) => {
        if (this.loaded) return;
        this.setData({ loading: false, error: (err && err.message) || '网络不太好' });
      });
  },

  retry() {
    this.setData({ loading: true, error: '' });
    this.load();
  },

  render(ev, me) {
    const myId = me ? me.id : session.myId();
    const isHost = typeof ev.isHost === 'boolean' ? ev.isHost : !!(ev.host && ev.host.id === myId);
    const members = ev.members || [];
    const count = ev.memberCount || members.length;
    const free = Math.max(0, (ev.capacity || 0) - count);
    const seats = [];
    for (let i = 0; i < Math.min(free, 6); i++) seats.push('s' + i);
    const bar = computeBar(ev, isHost);
    let slotText = ev.isFull ? '已满员' : '还剩 ' + free + ' 个名额';
    if (ev.status === 'formed' && !ev.isFull) slotText = '已成群 · ' + count + ' 人';
    else if (!ev.isFull && deadlinePassed(ev)) slotText = '已截止报名 · ' + count + ' 人';
    if (ev.phase === 'ended') slotText = count + ' 人参加了';
    const estimate = ev.feeType === 'aa' && ev.feeEstimate ? 'AA 约 ¥' + format.money(ev.feeEstimate) + '/人' : '';
    const loc = ev.location || null;
    const placeSub = [ev.meetingPoint, loc && loc.address && loc.address !== ev.place ? loc.address : ''].filter(Boolean).join(' · ');
    // 退出：成员（不是发起人）、还没开始、局还有效
    let leave = null;
    const active = ['open', 'formed'].indexOf(ev.status) >= 0 && ev.phase !== 'ended' && ev.phase !== 'ongoing';
    if (ev.myStatus === 'joined' && !isHost && active) {
      leave = ev.canLeave === false
        ? { label: '退出这个局', disabled: true, reason: ev.leaveBlockedReason || '已过最晚退出时间，不能退出了' }
        : { label: '退出这个局', disabled: false };
    } else if (ev.myStatus === 'applied' && active) {
      leave = { label: '撤回申请', disabled: false, withdraw: true };
    }
    this.setData({
      loading: false,
      error: '',
      event: ev,
      images: (ev.images || []).map(format.imageUrl).filter(Boolean),
      members,
      seats,
      canWait: bar.action === 'join',
      sourceLabel: SOURCE[ev.source] || '兴趣局',
      hostLine: HOST_LINE[ev.source] || '大家一起组的局',
      dateFull: format.fullDate(ev.startAt),
      durationText: format.duration(ev.durationMin),
      feeTitle: estimate || ev.feeLabel || '费用待定',
      feeNote: format.FEE_NOTE[ev.feeType] || '平台不经手钱',
      placeSub,
      hasMap: !!(loc && loc.latitude && loc.longitude),
      slotText,
      exitPassed: deadlinePassed(ev),
      fillPct: ev.capacity ? Math.min(100, Math.round((count / ev.capacity) * 100)) : 0,
      bar,
      leave,
      canCancel: isHost && ev.phase !== 'ended' && ['open', 'formed', 'pending_review'].indexOf(ev.status) >= 0
    });
    if (isHost && ev.requireApproval && ev.status === 'open') this.loadApplications();
    else if (this.data.applications.length) this.setData({ applications: [] });
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

  // ===== 照片 =====
  onSwiper(e) {
    this.setData({ imageIndex: e.detail.current });
  },

  previewImage(e) {
    const urls = this.data.images;
    wx.previewImage({ urls, current: urls[e.currentTarget.dataset.index] || urls[0] });
  },

  openMap() {
    const loc = this.data.event && this.data.event.location;
    if (!loc || !loc.latitude) return;
    wx.openLocation({
      latitude: Number(loc.latitude),
      longitude: Number(loc.longitude),
      name: loc.name || this.data.event.place,
      address: loc.address || '',
      scale: 16
    });
  },

  // ===== 底部按钮 =====
  onCta() {
    const bar = this.data.bar;
    if (!bar || bar.disabled) return;
    if (bar.action === 'join') this.openJoin();
    else if (bar.action === 'group') wx.navigateTo({ url: '/pages/group/group?id=' + this.id });
    else if (bar.action === 'match') wx.navigateTo({ url: '/pages/match/match?eventId=' + this.id });
    else if (bar.action === 'review') wx.navigateTo({ url: '/pages/review/review?id=' + this.id });
  },

  // 加入：先确认（时间、地点、费用、最晚退出时间 + 免责声明）
  openJoin() {
    const ev = this.data.event;
    this.setData({
      joinShow: true,
      joinResult: null,
      joinInfo: {
        title: ev.title,
        when: this.data.dateFull + (this.data.durationText ? ' · ' + this.data.durationText : ''),
        place: ev.place + (this.data.placeSub ? '（' + this.data.placeSub + '）' : ''),
        fee: this.data.feeTitle + ' · ' + this.data.feeNote,
        exit: ev.exitDeadlineLabel || (ev.exitDeadline ? format.mdhm(ev.exitDeadline) : '')
      }
    });
  },

  closeJoin() {
    const done = !!this.data.joinResult;
    this.setData({ joinShow: false });
    if (done) this.load();
  },

  confirmJoin() {
    if (this.data.joinBusy) return;
    this.setData({ joinBusy: true });
    api
      .join(this.id, { silent: true })
      .then((res) => {
        session.markDirty('square');
        this.setData({
          joinBusy: false,
          joinResult: {
            formed: !!res.formed || res.eventStatus === 'formed',
            remaining: typeof res.remaining === 'number' ? res.remaining : 0,
            myStatus: res.myStatus
          }
        });
        this.load();
      })
      .catch((err) => {
        this.setData({ joinBusy: false, joinShow: false });
        request.showError(err);
        this.load();
      });
  },

  joinChat() {
    this.setData({ joinShow: false });
    wx.navigateTo({ url: '/pages/group/group?id=' + this.id });
  },

  // ===== 退出 / 取消 =====
  leaveEvent() {
    const leave = this.data.leave;
    if (!leave) return;
    if (leave.disabled) {
      wx.showModal({ title: '不能退出了', content: leave.reason, showCancel: false, confirmText: '知道了', confirmColor: '#193543' });
      return;
    }
    const ev = this.data.event;
    const deadline = ev.exitDeadlineLabel || (ev.exitDeadline ? format.mdhm(ev.exitDeadline) : '');
    native
      .confirm({
        title: leave.withdraw ? '撤回报名申请？' : '退出这个局？',
        content: leave.withdraw ? '撤回后发起人就看不到你的申请了。' : (deadline ? '最晚退出时间是 ' + deadline + '，在这之前退出没关系。' : '') + '退出后名额会让给别人。',
        confirmText: leave.withdraw ? '撤回' : '退出',
        cancelText: '再想想',
        confirmColor: '#B42318'
      })
      .then((ok) => {
        if (!ok) return;
        api
          .leave(this.id)
          .then((res) => {
            session.markDirty('square');
            wx.showToast({ title: leave.withdraw ? '已撤回' : res && res.penalty ? '已退出，记一次临时取消' : '已退出', icon: 'none' });
            this.load();
          })
          .catch(() => this.load());
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

// 撮合成功：被邀请的人确认加入 / 换一批 / 看详情（docs/api.md 3.2 第 5 步）
const api = require('../../utils/api');
const format = require('../../utils/format');
const native = require('../../utils/native');
const request = require('../../utils/request');
const session = require('../../utils/session');

const KNOWN_TASKS = ['看日出', '爬山', '徒步', '骑行', '随便走走', '吃饭', '吃早餐', '早餐', '逛夜市', '夜市', '喝咖啡', '咖啡', '读书', '玩桌游', '桌游', '拼车'];
const VERB = { 早餐: '吃早餐', 夜市: '逛夜市', 咖啡: '喝咖啡', 桌游: '玩桌游' };

Page({
  data: {
    loading: true,
    error: '',
    event: null,
    others: [],
    commonPoints: [],
    myStatus: '',
    headline: '',
    lead: '',
    timeText: '',
    placeText: '',
    feeText: '',
    readyText: '',
    fullText: '',
    deadlineText: '',
    exitText: '',
    stateText: '',
    remaining: 0,
    fillPct: 0,
    joinShow: false,
    joinInfo: {},
    joinBusy: false,
    joinResult: null
  },

  onLoad(query) {
    this.eventId = Number(query.eventId || query.id);
    if (!this.eventId) {
      this.setData({ loading: false, error: '链接里缺少局的编号' });
      return;
    }
    this.load();
  },

  load() {
    return Promise.all([api.match(this.eventId, { silent: true }), session.loadMe().catch(() => null)])
      .then(([res, me]) => this.render(res, me))
      .catch((err) => this.setData({ loading: false, error: (err && err.message) || '网络不太好' }));
  },

  retry() {
    this.setData({ loading: true, error: '' });
    this.load();
  },

  render(res, me) {
    const ev = res.event || {};
    const myId = me ? me.id : session.myId();
    const others = (res.members || ev.members || []).filter((u) => !u.isMe && u.id !== myId);
    const myStatus = res.myStatus || ev.myStatus || '';
    const joined = res.joinedCount || 0;
    const left = Math.max(0, (ev.capacity || 0) - joined);
    const task = ev.task && KNOWN_TASKS.indexOf(ev.task) >= 0 ? VERB[ev.task] || ev.task : '';
    const headline = task && ev.startAt ? format.weekday(ev.startAt) + format.daypart(ev.startAt) + '，一起' + task : ev.title;

    let fullText;
    if (myStatus === 'joined') fullText = ev.chatOpen ? '人齐了，群已经建好' : '还差 ' + left + ' 人，人齐了自动建群';
    else if (left <= 1) fullText = '你加入即满员，自动建群';
    else fullText = '还有 ' + (left - 1) + ' 人在确认，满员自动建群';

    let stateText = '';
    if (ev.status === 'cancelled') stateText = '这次没凑齐，已帮你继续撮合。';
    else if (myStatus === 'declined') stateText = '你选了换一批，已帮你继续撮合，不影响信用。';
    else if (myStatus && myStatus !== 'invited' && myStatus !== 'joined') stateText = '这个撮合结果已经失效了。';

    const feeText = ev.feeLabel ? ev.feeLabel + (ev.feeType === 'aa' && /¥/.test(ev.feeLabel) ? '/人' : '') + ' · ' + (format.FEE_NOTE[ev.feeType] || '平台不经手钱') : '';

    this.setData({
      loading: false,
      error: '',
      event: ev,
      others,
      myStatus,
      commonPoints: res.commonPoints || [],
      headline,
      lead: (others.length || '几') + ' 个同样想去的人。不用自我介绍，到点出现就好。',
      timeText: [ev.dateLabel ? ev.dateLabel + ' 集合' : '', format.duration(ev.durationMin)].filter(Boolean).join(' · '),
      placeText: ev.meetingPoint ? ev.place + ' · ' + ev.meetingPoint : (ev.place || '') + '集合',
      feeText,
      readyText: joined + ' 人已就位',
      fullText,
      deadlineText: res.deadline && myStatus === 'invited' ? '请在 ' + format.mdhm(res.deadline) + ' 前确认，过时视为放弃（不扣分）' : '',
      exitText: ev.exitDeadlineLabel || (ev.exitDeadline ? format.mdhm(ev.exitDeadline) : ''),
      stateText,
      remaining: left,
      fillPct: ev.capacity ? Math.min(100, Math.round((joined / ev.capacity) * 100)) : 0
    });
  },

  // 「加入这个局」和局详情的「加入」走同一个确认弹窗
  accept() {
    const d = this.data;
    this.setData({
      joinShow: true,
      joinResult: null,
      joinInfo: { title: d.event.title, when: d.timeText, place: d.placeText, fee: d.feeText, exit: d.exitText }
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
      .acceptMatch(this.eventId, { silent: true })
      .then((res) => {
        this.setData({
          joinBusy: false,
          joinResult: {
            formed: !!res.formed || res.eventStatus === 'formed',
            remaining: typeof res.remaining === 'number' ? res.remaining : 0,
            myStatus: res.myStatus
          }
        });
      })
      .catch((err) => {
        this.setData({ joinBusy: false, joinShow: false });
        request.showError(err);
        this.load();
      });
  },

  joinChat() {
    this.setData({ joinShow: false });
    wx.redirectTo({ url: '/pages/group/group?id=' + this.eventId });
  },

  decline() {
    native
      .confirm({ title: '换一批？', content: '这次不去也不扣分，会继续帮你撮合同样的事。', confirmText: '换一批', cancelText: '再看看' })
      .then((ok) => {
        if (!ok) return;
        api
          .declineMatch(this.eventId)
          .then((res) => {
            if (res.intentId) wx.redirectTo({ url: '/pages/waiting/waiting?id=' + res.intentId });
            else wx.switchTab({ url: '/pages/home/home' });
          })
          .catch(() => {});
      });
  },

  openDetail() {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + this.eventId });
  },

  openGroup() {
    wx.navigateTo({ url: '/pages/group/group?id=' + this.eventId });
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' });
  }
});

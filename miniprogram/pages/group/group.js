// 成局群聊：页面可见时每 3 秒拉一次新消息；破冰话题；集合小任务「我到了」；AA / 照片 / 位置
const api = require('../../utils/api');
const format = require('../../utils/format');
const native = require('../../utils/native');

const POLL_MS = 3000;
const ICE_KEY = 'dz_ice_hidden_';

Page({
  data: {
    loading: true,
    closed: false,
    closedTitle: '',
    closedDesc: '',
    subtitle: '',
    task: { show: false },
    headSystem: null,
    list: [],
    icebreaker: null,
    hideIce: false,
    draft: '',
    focus: false,
    showPlus: false,
    intoView: '',
    composerStyle: ''
  },

  onLoad(query) {
    this.id = Number(query.id);
    this.lastId = 0;
    this.msgs = [];
    this.kb = 0;
    try {
      const hidden = wx.getStorageSync(ICE_KEY + this.id);
      this.hiddenIce = hidden === '' ? null : hidden;
    } catch (e) {
      this.hiddenIce = null;
    }
    if (!this.id) {
      this.setData({ loading: false, closed: true, closedTitle: '找不到这个群聊', closedDesc: '链接里缺少局的编号' });
      return;
    }
    this.load();
  },

  onShow() {
    if (!this.ready) return;
    this.refreshEvent();
    this.fetch(false);
    this.startPoll();
  },

  onHide() {
    this.stopPoll();
  },

  onUnload() {
    this.stopPoll();
  },

  load() {
    return api
      .event(this.id)
      .then((ev) => {
        this.applyEvent(ev);
        if (!ev.chatOpen) {
          const joined = ev.myStatus === 'joined';
          let closedTitle = '加入这个局后才能看到群聊';
          let closedDesc = '只在同一个局里聊天，防骚扰。';
          if (ev.status === 'cancelled') {
            closedTitle = '这个局已经取消了';
            closedDesc = '换个时间再约，或者去广场看看别的局。';
          } else if (joined && ev.source === 'matched') {
            closedTitle = '人齐了群聊会自动打开';
            closedDesc = '先等其他人确认，满员后会通知你。';
          } else if (joined) {
            closedTitle = '再有人加入，群聊就开了';
            closedDesc = '有人加入时会通知你。';
          }
          this.setData({ loading: false, closed: true, closedTitle, closedDesc });
          return null;
        }
        return this.fetch(true).then(() => {
          this.ready = true;
          this.setData({ loading: false });
          this.scrollBottom();
          this.startPoll();
        });
      })
      .catch((err) => this.setData({ loading: false, closed: true, closedTitle: '进不了这个群聊', closedDesc: err.message }));
  },

  refreshEvent() {
    api
      .event(this.id, { silent: true })
      .then((ev) => this.applyEvent(ev))
      .catch(() => {});
  },

  applyEvent(ev) {
    this.event = ev;
    wx.setNavigationBarTitle({ title: format.shortTitle(ev.title) + ' · ' + (ev.memberCount || 0) + ' 人' });
    this.setData({
      subtitle: [ev.dateLabel, ev.place].filter(Boolean).join(' · '),
      task: this.computeTask(ev)
    });
  },

  computeTask(ev) {
    if (!ev || ev.status === 'cancelled' || ev.myStatus !== 'joined') return { show: false };
    if (ev.phase === 'ended') {
      return this.safeDone
        ? { show: true, label: '局结束啦', text: '辛苦啦，给同行的人一个匿名评价吧', button: '去评价', action: 'review' }
        : { show: true, label: '局结束啦', text: '到家了吗？点一下报平安', button: '报平安', action: 'safe' };
    }
    const arrived = !!ev.myArrivedAt;
    return {
      show: true,
      label: '集合小任务',
      text: (ev.dateLabel || '') + ' 到' + (ev.place || '集合点') + '，点「我到了」',
      button: arrived ? '已到达' : '我到了',
      action: arrived ? '' : 'arrive',
      done: arrived
    };
  },

  // ---- 消息 ----
  fetch(initial) {
    if (this.fetching) return Promise.resolve();
    this.fetching = true;
    return api.messages(this.id, this.lastId || undefined, { silent: !initial }).then(
      (res) => {
        this.fetching = false;
        const ice = res && res.icebreaker;
        if (ice) {
          const cur = this.data.icebreaker;
          if (!cur || cur.index !== ice.index || cur.question !== ice.question) {
            this.setData({ icebreaker: ice, hideIce: this.hiddenIce !== null && Number(this.hiddenIce) === ice.index });
          }
        }
        this.append((res && res.items) || []);
      },
      (err) => {
        this.fetching = false;
        if (err && (err.status === 403 || err.status === 404)) {
          this.stopPoll();
          this.setData({ closed: true, closedTitle: '你已经不在这个群里了', closedDesc: err.message });
        }
        if (initial) throw err;
      }
    );
  },

  append(items) {
    const fresh = items.filter((m) => m && m.id > this.lastId).sort((a, b) => a.id - b.id);
    if (!fresh.length) return;
    fresh.forEach((m) => this.msgs.push(m));
    this.lastId = fresh[fresh.length - 1].id;
    let head = null;
    let list = this.msgs;
    if (this.msgs[0].kind === 'system') {
      head = this.msgs[0];
      list = this.msgs.slice(1);
    }
    this.setData({ headSystem: head, list }, () => this.scrollBottom());
  },

  startPoll() {
    this.stopPoll();
    this.timer = setInterval(() => this.fetch(false), POLL_MS);
  },

  stopPoll() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  scrollBottom() {
    this.setData({ intoView: '' }, () => this.setData({ intoView: 'bottom' }));
  },

  // ---- 输入 ----
  onInput(e) {
    this.setData({ draft: e.detail.value });
  },

  send() {
    const text = (this.data.draft || '').trim();
    if (!text || this.sending) return;
    this.sending = true;
    api
      .sendMessage(this.id, text)
      .then((msg) => {
        this.setData({ draft: '' });
        this.append([msg]);
      })
      .catch(() => {}) // CONTENT_BLOCKED 等错误由 request 统一 toast，草稿保留方便修改
      .then(() => {
        this.sending = false;
      });
  },

  onFocus(e) {
    this.setKeyboard((e.detail && e.detail.height) || 0);
    if (this.data.showPlus) this.setData({ showPlus: false });
  },

  onBlur() {
    this.setKeyboard(0);
    this.setData({ focus: false });
  },

  onKeyboard(e) {
    this.setKeyboard((e.detail && e.detail.height) || 0);
  },

  setKeyboard(height) {
    if (height === this.kb) return;
    this.kb = height;
    this.setData({ composerStyle: height ? 'padding-bottom: ' + (height + 10) + 'px;' : '' });
    if (height) this.scrollBottom();
  },

  togglePlus() {
    this.setData({ showPlus: !this.data.showPlus, focus: false });
    this.scrollBottom();
  },

  closePanels() {
    if (this.data.showPlus) this.setData({ showPlus: false });
  },

  // ---- 破冰 ----
  nextIce() {
    api
      .nextIcebreaker(this.id)
      .then((ice) => this.setData({ icebreaker: ice, hideIce: false }))
      .catch(() => {});
  },

  listen() {
    const ice = this.data.icebreaker;
    this.hiddenIce = ice ? ice.index : null;
    try {
      wx.setStorageSync(ICE_KEY + this.id, this.hiddenIce);
    } catch (e) {
      // ignore
    }
    this.setData({ hideIce: true });
    wx.showToast({ title: '好，先听听大家怎么说', icon: 'none' });
  },

  speak() {
    this.setData({ draft: '我来说一个：', focus: true, showPlus: false });
  },

  // ---- 集合小任务 ----
  onTask() {
    const t = this.data.task;
    if (!t || !t.action || this.taskBusy) return;
    if (t.action === 'review') {
      wx.navigateTo({ url: '/pages/review/review?id=' + this.id });
      return;
    }
    this.taskBusy = true;
    const call = t.action === 'arrive' ? api.arrive(this.id) : api.safe(this.id);
    call
      .then((res) => {
        if (t.action === 'arrive') {
          this.event.myArrivedAt = (res && res.arrivedAt) || new Date().toISOString();
          wx.showToast({ title: '收到，大家知道你到了', icon: 'none' });
        } else {
          this.safeDone = true;
          wx.showToast({ title: '收到，早点休息', icon: 'none' });
        }
        this.setData({ task: this.computeTask(this.event) });
        this.fetch(false);
      })
      .catch(() => {})
      .then(() => {
        this.taskBusy = false;
      });
  },

  // ---- 更多功能 ----
  openAA() {
    this.setData({ showPlus: false });
    wx.navigateTo({ url: '/pages/aa/aa?id=' + this.id });
  },

  sharePhoto() {
    this.setData({ showPlus: false });
    native
      .confirm({ title: '发照片', content: '照片会发到「动态」里，可以选「只给同局的人」看。', confirmText: '去发照片', cancelText: '算了' })
      .then((ok) => {
        if (ok) wx.navigateTo({ url: '/pages/compose/compose?eventId=' + this.id + '&visibility=event' });
      });
  },

  sendLocation() {
    this.setData({ showPlus: false });
    native.pickPlace().then((place) => {
      if (!place) return;
      const extra = place.address && place.address !== place.name ? '（' + place.address + '）' : '';
      api
        .sendMessage(this.id, '[位置] ' + place.name + extra)
        .then((msg) => this.append([msg]))
        .catch(() => {});
    });
  },

  onMsgLong(e) {
    const item = this.data.list[e.currentTarget.dataset.index];
    if (!item) return;
    const items = item.mine ? ['复制'] : ['复制', '举报这条消息'];
    native.actionSheet(items).then((i) => {
      if (i === 0) wx.setClipboardData({ data: item.text });
      if (i === 1) wx.navigateTo({ url: '/pages/report/report?targetType=message&targetId=' + item.id });
    });
  },

  openUser(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/user/user?id=' + id });
  },

  openInfo() {
    wx.navigateTo({ url: '/pages/group-info/group-info?id=' + this.id });
  },

  openDetail() {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + this.id });
  }
});

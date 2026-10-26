// 成局群聊（只在成群后开启）：页面可见时每 3 秒拉一次新消息；破冰话题；集合小任务「我到了」；
// 顶部 AA 卡片（一次声明的那笔：谁垫付、每人多少、我要转给谁）；照片 / 位置
const api = require('../../utils/api');
const format = require('../../utils/format');
const native = require('../../utils/native');

const POLL_MS = 3000;
// AA 卡片每 30 秒刷新一次（也会在有人记账的系统消息出现时刷新）
const AA_EVERY = 10;
const ICE_KEY = 'dz_ice_hidden_';

Page({
  data: {
    loading: true,
    closed: false,
    closedTitle: '',
    closedDesc: '',
    closedShare: false,
    closedProgress: null,
    aa: { show: false },
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
    this.loadAA();
    this.fetch(false);
    this.startPoll();
  },

  onShareAppMessage() {
    const ev = this.event;
    return {
      title: ev ? (ev.remaining > 0 ? '还差 ' + ev.remaining + ' 人：' : '') + ev.title : '活动搭子 · 大理兴趣局',
      path: '/pages/detail/detail?id=' + this.id
    };
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
          const remaining = typeof ev.remaining === 'number' ? ev.remaining : Math.max(0, (ev.capacity || 0) - (ev.memberCount || 0));
          let closedTitle = '加入这个局后才能看到群聊';
          let closedDesc = '只在同一个局里聊天，防骚扰。';
          let closedProgress = null;
          if (ev.status === 'cancelled') {
            closedTitle = '这个局已经取消了';
            closedDesc = '换个时间再约，或者去广场看看别的局。';
          } else if (joined) {
            // 群聊只在成群后开启（满员，或到最晚退出时间人数够了）
            closedTitle = '还差 ' + remaining + ' 人成群，群聊就开了';
            closedDesc = ev.source === 'matched' ? '等其他人确认，人齐了第一时间通知你。' : '人齐了第一时间通知你，群聊会自动建好。';
            closedProgress = { pct: ev.capacity ? Math.round(((ev.memberCount || 0) / ev.capacity) * 100) : 0, text: (ev.memberCount || 0) + '/' + ev.capacity + ' 人' };
          }
          this.setData({ loading: false, closed: true, closedTitle, closedDesc, closedProgress, closedShare: joined && ev.source !== 'matched' && ev.status === 'open' });
          return null;
        }
        this.loadAA();
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
    // 有人记了 / 改了 AA，顺手刷新顶部卡片
    if (this.ready && fresh.some((m) => /AA/.test(m.text || ''))) this.loadAA();
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
    this.ticks = 0;
    this.timer = setInterval(() => {
      this.fetch(false);
      this.ticks += 1;
      if (this.ticks % AA_EVERY === 0) this.loadAA();
    }, POLL_MS);
  },

  // ---- AA 卡片 ----
  loadAA() {
    return api
      .aa(this.id, { silent: true })
      .then((res) => this.setData({ aa: this.aaCard(res) }))
      .catch(() => {});
  },

  aaCard(res) {
    const b = res && res.bill;
    const ev = this.event || {};
    if (!b) {
      // 活动开始后才提醒「谁垫了钱」
      const show = !!(res && res.canDeclare && (ev.phase === 'ongoing' || ev.phase === 'ended'));
      return show ? { show: true, empty: true, title: '谁垫了钱？记一笔 AA', text: '一次记下总花费，大家按人数转给他', button: '记一笔' } : { show: false };
    }
    const payer = b.mine ? '我' : (b.payer && b.payer.nickname) || '';
    const each = format.money(res.each);
    const ts = res.transfers || [];
    const mine = ts.filter((t) => t.role === 'from')[0];
    const confirmed = ts.filter((t) => t.status === 'confirmed').length;
    let text = '每人 ¥' + each;
    let button = '';
    let done = false;
    if (mine && mine.status === 'pending') {
      text = '每人 ¥' + each + '，你转给' + payer;
      button = '去转账';
    } else if (mine && mine.status === 'paid') {
      text = '你已转 ¥' + each + '，等' + payer + '确认';
    } else if (mine && mine.status === 'confirmed') {
      text = '你已结清';
      done = true;
    } else if (b.mine) {
      done = ts.length > 0 && confirmed === ts.length;
      text = done ? '大家都转好了' : '每人 ¥' + each + ' · ' + confirmed + '/' + ts.length + ' 人已结清';
      if (ts.some((t) => t.status === 'paid')) button = '去确认';
    } else if (ts.length && confirmed === ts.length) {
      text = '每人 ¥' + each + ' · 已结清';
      done = true;
    }
    return {
      show: true,
      empty: false,
      title: 'AA · ' + payer + ' 垫付 ¥' + format.money(b.amount) + (b.note ? '（' + b.note + '）' : ''),
      text,
      button,
      done
    };
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

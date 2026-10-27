// 首页：轮播图 + 分类宫格（热门标签插画）→ 约搭子弹窗（日期 + 时间段 →「帮我选择 · …」），
// 正在为你撮合、大家最近在玩、还差人的局（docs/changes-v0.3.md B / E / H）。
const api = require('../../utils/api');
const format = require('../../utils/format');
const nav = require('../../utils/nav');
const session = require('../../utils/session');

const WHENS = [
  { value: 'today', label: '今天' },
  { value: 'tomorrow', label: '明天' },
  { value: 'weekend', label: '本周末' }
];
const BANNER_FALLBACK = ['sunrise', 'cycling', 'oldtown', 'lake'];
const GRID_MAX = 10;
const AREAS = ['古城', '才村', '下关', '喜洲', '双廊', '海东', '其他']; // 与 server/src/constants.js 的 AREAS 保持一致

function describe(intent, detail) {
  if (intent.status === 'invited') return { sub: '配到了，去看看是谁', pill: '撮合成功', pillClass: 'pill-accent' };
  if (intent.status === 'proposed') return { sub: '人凑齐了，正在确认', pill: '撮合中', pillClass: 'pill-accent' };
  let sub = '正在找同频的人';
  if (detail && typeof detail.similarCount === 'number') {
    const n = detail.similarCount + 1;
    sub = detail.needMore > 0 ? '已有 ' + n + ' 人同意向，还差 ' + detail.needMore + ' 人成局' : '已有 ' + n + ' 人同意向，马上成局';
  }
  return { sub, pill: '撮合中', pillClass: 'pill-stone' };
}

// 北京时间现在是几点（分钟）
function nowMinutes() {
  const p = format.bj(Date.now());
  return p.h * 60 + p.mi;
}

Page({
  data: {
    loading: true,
    error: '',
    banners: [],
    grid: [],
    tags: [],
    stats: null,
    proofUsers: [],
    highlights: [],
    featured: [],
    intents: [],

    // 约搭子弹窗
    matchShow: false,
    tagShow: false,
    tagCustom: false,
    dateShow: false,
    rangeShow: false,
    task: '',
    taskSrc: '/assets/covers/sunrise.svg',
    whens: WHENS,
    when: 'weekend',
    pickedDate: '',
    pickedDateLabel: '',
    slots: [],
    slot: 'allday',
    timeFrom: '',
    timeTo: '',
    rangeFrom: '14:00',
    rangeTo: '17:00',
    todayClosed: false,
    cta: '',
    areas: AREAS,
    areaPicked: { 古城: true },
    sameSexOnly: false,
    submitting: false
  },

  onLoad() {
    this.buildSlots();
    this.load();
  },

  // 有弹窗开着时隐藏底部导航（自定义 tabBar 在页面最上层，会挡住弹窗底部的按钮）
  syncTabBar() {
    const d = this.data;
    const open = d.matchShow || d.tagShow || d.dateShow || d.rangeShow;
    const tb = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tb && tb.data && tb.data.hidden !== open) tb.setData({ hidden: open });
  },

  sheets(patch, cb) {
    this.setData(patch, () => {
      this.syncTabBar();
      if (cb) cb();
    });
  },

  onShow() {
    nav.setTab(this, 0);
    this.syncTabBar();
    if (this.loadedOnce) {
      // load(true) 内部已经会刷新意向，别再额外触发一次
      if (Date.now() - this.loadedAt > 5 * 60 * 1000) this.load(true);
      else this.loadIntents();
    }
  },

  onPullDownRefresh() {
    this.load(true).then(() => wx.stopPullDownRefresh());
  },

  onShareAppMessage() {
    return { title: '在大理，找个搭子一起玩', path: '/pages/home/home' };
  },

  onShareTimeline() {
    return { title: '在大理，找个搭子一起玩' };
  },

  load(quiet) {
    if (!quiet && !this.loadedOnce) this.setData({ loading: true, error: '' });
    const intents = this.loadIntents();
    const home = api
      .home({ silent: true })
      .then((res) => {
        this.loadedOnce = true;
        this.loadedAt = Date.now();
        this.render(res || {});
      })
      .catch((err) => {
        if (this.loadedOnce) return;
        // 首页内容拿不到时，宫格用默认标签兜底，至少能发起撮合
        session.loadHotTags().then((tags) => this.setTags(tags));
        this.setData({ loading: false, error: (err && err.message) || '网络不太好' });
      });
    return Promise.all([home, intents]);
  },

  retry() {
    this.load();
  },

  render(res) {
    const banners = (res.banners || []).map((b, i) => ({
      id: b.id,
      image: format.imageUrl(b.image),
      fallback: format.coverSrc(BANNER_FALLBACK[i % BANNER_FALLBACK.length]),
      failed: !b.image,
      title: b.title || '',
      subtitle: b.subtitle || '',
      link: b.link || ''
    }));
    const highlights = (res.highlights || []).map((h) => ({
      postId: h.postId,
      image: format.imageUrl(h.image),
      text: h.text || '',
      user: h.user || {},
      eventTitle: format.shortTitle(h.eventTitle || '')
    }));
    const stats = res.stats && (res.stats.weekPeople || res.stats.weekFormed) ? res.stats : null;
    const seen = {};
    const proofUsers = highlights
      .map((h) => h.user)
      .filter((u) => u && u.id && !seen[u.id] && (seen[u.id] = true))
      .slice(0, 3);
    this.setTags(res.hotTags && res.hotTags.length ? res.hotTags : format.DEFAULT_TAGS);
    this.setData({
      loading: false,
      error: '',
      banners,
      highlights,
      featured: res.featuredEvents || [],
      stats,
      proofUsers
    });
  },

  setTags(tags) {
    const list = tags.map((t) => ({ name: t.name, category: t.category, cover: format.coverKey(t.cover, t.category) }));
    // 最多 10 格：标签放不下时留一格「更多」，最后一格固定「自己添加」
    const room = list.length > GRID_MAX - 1 ? GRID_MAX - 2 : GRID_MAX - 1;
    const grid = list.slice(0, room).map((t) => ({ kind: 'tag', name: t.name, src: format.coverSrc(t.cover) }));
    if (list.length > room) grid.push({ kind: 'more', name: '更多' });
    grid.push({ kind: 'custom', name: '自己添加' });
    const patch = { tags: list, grid };
    if (!this.data.task && list.length) {
      patch.task = list[0].name;
      patch.taskSrc = format.coverSrc(list[0].cover);
    }
    this.setData(patch, () => this.updateCta());
  },

  loadIntents() {
    return api
      .myIntents({ silent: true })
      .then((res) => {
        const items = (res && res.items) || [];
        // open 的意向再查一次详情，拿「已有几人 / 还差几人」
        return Promise.all(
          items.map((it) => (it.status === 'open' ? api.intent(it.id, { silent: true }).catch(() => null) : Promise.resolve(null)))
        ).then((details) => {
          const intents = items.map((it, i) =>
            Object.assign(
              { id: it.id, title: it.title, status: it.status, eventId: it.eventId, cover: format.tagCover(it.task, this.data.tags, it.category) },
              describe(it, details[i])
            )
          );
          this.setData({ intents });
        });
      })
      .catch(() => {});
  },

  // ===== 宫格 =====
  onGrid(e) {
    const item = this.data.grid[e.currentTarget.dataset.index];
    if (!item) return;
    if (item.kind === 'tag') {
      this.useTag(item.name);
      this.sheets({ matchShow: true });
    } else if (item.kind === 'more') {
      this.sheets({ matchShow: true, tagShow: true, tagCustom: false });
    } else {
      this.sheets({ matchShow: true, tagShow: true, tagCustom: true });
    }
  },

  useTag(name) {
    this.setData({ task: name, taskSrc: format.coverSrc(format.tagCover(name, this.data.tags)) }, () => this.updateCta());
  },

  openMatch() {
    this.sheets({ matchShow: true });
  },

  closeMatch() {
    this.sheets({ matchShow: false, tagShow: false, dateShow: false, rangeShow: false });
  },

  // ===== 标签 =====
  openTags() {
    this.sheets({ matchShow: true, tagShow: true, tagCustom: false });
  },

  closeTags() {
    this.sheets({ tagShow: false });
  },

  onTag(e) {
    this.useTag(e.detail.name);
    this.sheets({ tagShow: false });
  },

  // ===== 日期 =====
  pickWhen(e) {
    const value = e.currentTarget.dataset.value;
    if (value === 'today' && this.data.todayClosed) {
      wx.showToast({ title: '今天太晚了，选明天吧', icon: 'none' });
      return;
    }
    this.setData({ when: value, pickedDate: '', pickedDateLabel: '' }, () => this.buildSlots());
  },

  openDate() {
    this.sheets({ dateShow: true });
  },

  closeDate() {
    this.sheets({ dateShow: false });
  },

  onDate(e) {
    const { date } = e.detail;
    const when = date === format.dateStr(0) ? 'today' : date === format.dateStr(1) ? 'tomorrow' : date;
    const [, m, d] = date.split('-').map(Number);
    const isDate = when === date;
    this.sheets({ dateShow: false, when, pickedDate: isDate ? date : '', pickedDateLabel: isDate ? m + '月' + d + '日' : '' }, () => this.buildSlots());
  },

  // ===== 时间段 =====
  // 今天已经过去的时间段不能选（离结束不到 1 小时）
  buildSlots() {
    const now = nowMinutes();
    const todayClosed = format.toMinutes('23:00') - now < 60;
    // 今天太晚了就自动改到明天；各时间段是否可选要按最终选中的日期算，
    // 否则跳到明天后仍沿用今天的 off 标记，明天的档会被整排错误置灰
    let when = this.data.when;
    if (todayClosed && when === 'today') when = 'tomorrow';
    const today = when === 'today';
    const slots = format.TIME_SLOTS.map((s) => ({
      value: s.value,
      label: s.label,
      off: today && format.toMinutes(s.to) - Math.max(now, format.toMinutes(s.from)) < 60
    }));
    const patch = { slots, todayClosed };
    if (when !== this.data.when) patch.when = when;
    const cur = slots.filter((s) => s.value === this.data.slot)[0];
    if (cur && cur.off) patch.slot = (slots.filter((s) => !s.off)[0] || { value: 'allday' }).value;
    if (this.data.slot === 'custom' && today && format.toMinutes(this.data.timeTo) - now < 60) {
      patch.slot = 'allday';
      patch.timeFrom = '';
      patch.timeTo = '';
    }
    this.setData(patch, () => this.updateCta());
  },

  pickSlot(e) {
    const { value, off } = e.currentTarget.dataset;
    if (off) {
      wx.showToast({ title: '今天这个时间段已经过了', icon: 'none' });
      return;
    }
    this.setData({ slot: value, timeFrom: '', timeTo: '' }, () => this.updateCta());
  },

  openRange() {
    this.sheets({ rangeShow: true, rangeFrom: this.data.timeFrom || '14:00', rangeTo: this.data.timeTo || '17:00' });
  },

  closeRange() {
    this.sheets({ rangeShow: false });
  },

  onRange(e) {
    const { from, to } = e.detail;
    if (this.data.when === 'today' && format.toMinutes(to) - Math.max(nowMinutes(), format.toMinutes(from)) < 60) {
      wx.showToast({ title: '今天这段时间快过完了，换一个吧', icon: 'none' });
      return;
    }
    this.sheets({ rangeShow: false, slot: 'custom', timeFrom: from, timeTo: to }, () => this.updateCta());
  },

  // 片区多选：勾一个或多个能接受的片区，撮合时有交集就能配上
  toggleArea(e) {
    const area = e.currentTarget.dataset.area;
    this.setData({ areaPicked: Object.assign({}, this.data.areaPicked, { [area]: !this.data.areaPicked[area] }) });
  },

  toggleSameSex(e) {
    this.setData({ sameSexOnly: e.detail.value });
  },

  // 「帮我选择 · 本周末上午 · 看日出」
  updateCta() {
    const { when, pickedDateLabel, slot, timeFrom, timeTo, task } = this.data;
    const whenText = pickedDateLabel || (WHENS.filter((w) => w.value === when)[0] || {}).label || '';
    let timeText = '';
    if (slot === 'custom' && timeFrom) timeText = ' ' + timeFrom + '–' + timeTo;
    else if (slot !== 'allday') timeText = (format.TIME_SLOTS.filter((s) => s.value === slot)[0] || {}).label || '';
    this.setData({ cta: '帮我选择 · ' + whenText + timeText + (task ? ' · ' + task : '') });
  },

  submit() {
    if (this.data.submitting) return;
    const { task, when, slot, timeFrom, timeTo } = this.data;
    if (!task) {
      this.openTags();
      return;
    }
    const areas = this.data.areas.filter((a) => this.data.areaPicked[a]);
    if (!areas.length) {
      wx.showToast({ title: '选一个片区吧', icon: 'none' });
      return;
    }
    if (this.data.sameSexOnly) {
      const me = session.cachedMe();
      if (me && me.gender !== 'female' && me.gender !== 'male') {
        wx.showModal({
          title: '先填一下性别',
          content: '只约同性需要知道你的性别，只用于撮合，不会公开。',
          confirmText: '去填写',
          cancelText: '先不用',
          confirmColor: '#193543',
          success: (r) => r.confirm && wx.navigateTo({ url: '/pages/edit-profile/edit-profile' })
        });
        return;
      }
    }
    const body = { task, when, areas, sameSexOnly: this.data.sameSexOnly };
    if (slot === 'custom') {
      body.timeFrom = timeFrom;
      body.timeTo = timeTo;
    } else {
      body.slot = slot;
    }
    this.setData({ submitting: true });
    api
      .createIntent(body)
      .then((intent) => {
        this.sheets({ matchShow: false });
        wx.navigateTo({ url: '/pages/waiting/waiting?id=' + intent.id });
      })
      .catch(() => {})
      .then(() => this.setData({ submitting: false }));
  },

  // ===== 其他入口 =====
  openIntent(e) {
    const it = this.data.intents[e.currentTarget.dataset.index];
    if (!it) return;
    if (it.status === 'invited' && it.eventId) wx.navigateTo({ url: '/pages/match/match?eventId=' + it.eventId });
    else wx.navigateTo({ url: '/pages/waiting/waiting?id=' + it.id });
  },

  onBanner(e) {
    const b = this.data.banners[e.currentTarget.dataset.index];
    if (b && b.link) nav.openLink(b.link);
  },

  onBannerError(e) {
    const i = e.currentTarget.dataset.index;
    this.setData({ ['banners[' + i + '].failed']: true });
  },

  openHighlight(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/post/post?id=' + id });
  },

  openEvent(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
  },

  goSearch() {
    wx.navigateTo({ url: '/pages/search/search' });
  },

  goFeed() {
    wx.switchTab({ url: '/pages/feed/feed' });
  },

  goSquare() {
    wx.switchTab({ url: '/pages/square/square' });
  },

  // 带上首页选中的标签，发起页直接选好
  goCreate() {
    const task = this.data.task;
    wx.navigateTo({ url: '/pages/create/create' + (task ? '?tag=' + encodeURIComponent(task) : '') });
  }
});

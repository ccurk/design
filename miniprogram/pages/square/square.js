// 广场：顶部标签栏吸顶（全部 + 后台维护的热门标签，?tag= 筛选），切换时列表不跳动；
// 骨架屏、下拉刷新、触底加载、失败重试（docs/changes-v0.3.md A / I）
const api = require('../../utils/api');
const nav = require('../../utils/nav');
const session = require('../../utils/session');

const PAGE_SIZE = 10;

Page({
  data: {
    tags: [],
    tag: '',
    tagView: '',
    events: [],
    nextCursor: null,
    loading: true,
    switching: false,
    loadingMore: false,
    moreError: false,
    error: ''
  },

  onLoad() {
    session.loadHotTags().then((tags) => this.setData({ tags: tags.map((t) => t.name) }));
    this.refresh();
  },

  onShow() {
    nav.setTab(this, 1);
    if (session.takeDirty('square')) this.refresh(true);
  },

  onReady() {
    this.measure();
  },

  onPageScroll(e) {
    this.scrollTop = e.scrollTop;
  },

  onPullDownRefresh() {
    session.loadHotTags(true).then((tags) => this.setData({ tags: tags.map((t) => t.name) }));
    this.refresh(true).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadMore();
  },

  onShareAppMessage() {
    return { title: '大理这周的局，看到合适的直接加入', path: '/pages/square/square' };
  },

  // 记下标签栏吸顶时的滚动位置，切换标签后回到这里（列表从头看，标签栏不动）
  measure() {
    wx.createSelectorQuery()
      .select('#filters')
      .boundingClientRect()
      .selectViewport()
      .scrollOffset()
      .exec((res) => {
        if (res && res[0] && res[1]) this.stickyTop = res[0].top + res[1].scrollTop;
      });
  },

  // keep = 保留当前列表直到新数据回来（刷新 / 切换标签时不闪）
  refresh(keep) {
    const seq = (this.seq = (this.seq || 0) + 1);
    const hasList = this.data.events.length > 0;
    this.setData({ loading: !(keep && hasList), switching: !!(keep && hasList), error: '', moreError: false });
    return api
      .events({ tag: this.data.tag, limit: PAGE_SIZE }, { silent: !hasList })
      .then((res) => {
        if (seq !== this.seq) return;
        this.setData({ events: res.items || [], nextCursor: res.nextCursor || null, loading: false, switching: false });
      })
      .catch((err) => {
        if (seq !== this.seq) return;
        this.setData({ loading: false, switching: false, error: (err && err.message) || '网络不太好' });
      });
  },

  retry() {
    this.refresh();
  },

  loadMore() {
    if (!this.data.nextCursor || this.data.loadingMore || this.data.loading || this.data.switching) return;
    const seq = this.seq;
    this.setData({ loadingMore: true, moreError: false });
    api
      .events({ tag: this.data.tag, limit: PAGE_SIZE, cursor: this.data.nextCursor }, { silent: true })
      .then((res) => {
        if (seq !== this.seq) return;
        const seen = {};
        this.data.events.forEach((e) => (seen[e.id] = true));
        const more = (res.items || []).filter((e) => !seen[e.id]);
        this.setData({ events: this.data.events.concat(more), nextCursor: res.nextCursor || null });
      })
      .catch(() => this.setData({ moreError: true }))
      .then(() => this.setData({ loadingMore: false }));
  },

  pickTag(e) {
    const value = e.currentTarget.dataset.value;
    if (value === this.data.tag) return;
    this.setData({ tag: value, tagView: 't' + e.currentTarget.dataset.index });
    // 已经滚过标签栏时，回到标签栏吸顶的位置，新列表从第一条开始看
    if (this.stickyTop !== undefined && (this.scrollTop || 0) > this.stickyTop) {
      wx.pageScrollTo({ scrollTop: this.stickyTop, duration: 0 });
    }
    this.refresh(true);
  },

  goCreate() {
    const tag = this.data.tag;
    wx.navigateTo({ url: '/pages/create/create' + (tag ? '?tag=' + encodeURIComponent(tag) : '') });
  },

  goSearch() {
    wx.navigateTo({ url: '/pages/search/search' });
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' });
  }
});

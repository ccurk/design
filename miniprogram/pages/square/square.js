// 广场：顶部标签栏吸顶（全部 + 后台维护的热门标签，?tag= 筛选），切换时列表不跳动；
// 骨架屏、下拉刷新、触底加载、失败重试（docs/changes-v0.3.md A / I）
const api = require('../../utils/api');
const nav = require('../../utils/nav');
const session = require('../../utils/session');

const PAGE_SIZE = 10;
const AREAS = ['古城', '才村', '下关', '喜洲', '双廊', '海东', '其他']; // 与 server/src/constants.js 的 AREAS 一致
const SORTS = [
  { value: 'soon', label: '即将开始' },
  { value: 'new', label: '最新发布' },
  { value: 'filling', label: '快满了' }
];

Page({
  data: {
    tags: [],
    tag: '',
    tagView: '',
    official: false,
    area: '',
    areaLabel: '片区',
    sort: 'soon',
    sortLabel: '排序',
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

  onShareTimeline() {
    return { title: '大理这周的局，看到合适的直接加入' };
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
      .events(this.query(), { silent: !hasList })
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
      .events(this.query({ cursor: this.data.nextCursor }), { silent: true })
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

  // 拉列表的查询参数：标签 + 只看官方 + 片区 + 排序
  query(extra) {
    const q = { tag: this.data.tag, limit: PAGE_SIZE, sort: this.data.sort };
    if (this.data.official) q.source = 'official';
    if (this.data.area) q.area = this.data.area;
    return Object.assign(q, extra || {});
  },

  // 子筛选改了：若已滚过标签栏，先回到吸顶位置，再从头重拉
  applyFilter() {
    if (this.stickyTop !== undefined && (this.scrollTop || 0) > this.stickyTop) {
      wx.pageScrollTo({ scrollTop: this.stickyTop, duration: 0 });
    }
    this.refresh(true);
  },

  toggleOfficial() {
    this.setData({ official: !this.data.official }, () => this.applyFilter());
  },

  pickArea() {
    wx.showActionSheet({
      itemList: ['全部片区'].concat(AREAS),
      success: (r) => {
        const area = r.tapIndex === 0 ? '' : AREAS[r.tapIndex - 1];
        this.setData({ area, areaLabel: area || '片区' }, () => this.applyFilter());
      }
    });
  },

  pickSort() {
    wx.showActionSheet({
      itemList: SORTS.map((s) => s.label),
      success: (r) => {
        const s = SORTS[r.tapIndex];
        this.setData({ sort: s.value, sortLabel: s.value === 'soon' ? '排序' : s.label }, () => this.applyFilter());
      }
    });
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

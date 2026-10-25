// 广场：按分类看未开始的 open 局，下拉刷新、触底加载
const api = require('../../utils/api');
const nav = require('../../utils/nav');
const session = require('../../utils/session');

const CATS = [
  { value: '', label: '全部' },
  { value: 'outdoor', label: '户外' },
  { value: 'coffee', label: '咖啡' },
  { value: 'food', label: '吃饭' },
  { value: 'game', label: '桌游' },
  { value: 'carpool', label: '拼车' },
  { value: 'other', label: '其他' }
];
const PAGE_SIZE = 10;

Page({
  data: {
    cats: CATS,
    cat: '',
    events: [],
    nextCursor: null,
    loading: true,
    loadingMore: false,
    error: ''
  },

  onLoad() {
    this.refresh();
  },

  onShow() {
    nav.setTab(this, 1);
    if (session.takeDirty('square')) this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadMore();
  },

  refresh() {
    const seq = (this.seq = (this.seq || 0) + 1);
    this.setData({ loading: true, error: '' });
    return api
      .events({ category: this.data.cat, limit: PAGE_SIZE })
      .then((res) => {
        if (seq !== this.seq) return;
        this.setData({ events: res.items || [], nextCursor: res.nextCursor || null, loading: false });
      })
      .catch((err) => {
        if (seq === this.seq) this.setData({ loading: false, error: err.message });
      });
  },

  loadMore() {
    if (!this.data.nextCursor || this.data.loadingMore || this.data.loading) return;
    const seq = this.seq;
    this.setData({ loadingMore: true });
    api
      .events({ category: this.data.cat, limit: PAGE_SIZE, cursor: this.data.nextCursor })
      .then((res) => {
        if (seq !== this.seq) return;
        const seen = {};
        this.data.events.forEach((e) => (seen[e.id] = true));
        const more = (res.items || []).filter((e) => !seen[e.id]);
        this.setData({ events: this.data.events.concat(more), nextCursor: res.nextCursor || null });
      })
      .catch(() => {})
      .then(() => this.setData({ loadingMore: false }));
  },

  pickCat(e) {
    const value = e.currentTarget.dataset.value;
    if (value === this.data.cat) return;
    this.setData({ cat: value, events: [], nextCursor: null });
    this.refresh();
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/create/create' });
  },

  goSearch() {
    wx.navigateTo({ url: '/pages/search/search' });
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' });
  }
});

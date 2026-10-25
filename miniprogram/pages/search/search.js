// 搜索：热门词、最近搜过（本机）、结果列表；搜不到就引导回首页撮合
const api = require('../../utils/api');
const format = require('../../utils/format');

const RECENT_KEY = 'dz_recent_search';
const FALLBACK_HOT = ['看日出', '安静读书', '骑行', '桌游', '拼车去双廊', '早餐'];

Page({
  data: {
    q: '',
    term: '',
    hot: [],
    recent: [],
    results: [],
    searching: false,
    autoFocus: true
  },

  onLoad() {
    let recent = [];
    try {
      recent = wx.getStorageSync(RECENT_KEY) || [];
    } catch (e) {
      recent = [];
    }
    this.setData({ recent, hot: FALLBACK_HOT });
    api
      .hotTerms()
      .then((res) => {
        if (res && res.terms && res.terms.length) this.setData({ hot: res.terms });
      })
      .catch(() => {});
  },

  onUnload() {
    clearTimeout(this.timer);
  },

  onInput(e) {
    const q = e.detail.value;
    this.setData({ q });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.search(q), 350);
  },

  onConfirm(e) {
    clearTimeout(this.timer);
    this.search(e.detail.value, true);
  },

  pickTerm(e) {
    const term = e.currentTarget.dataset.term;
    this.setData({ q: term });
    this.search(term, true);
  },

  clear() {
    clearTimeout(this.timer);
    this.setData({ q: '', term: '', results: [] });
  },

  search(raw, remember) {
    const term = String(raw || '').trim();
    this.setData({ term });
    if (!term) {
      this.setData({ results: [] });
      return;
    }
    if (remember) this.remember(term);
    const seq = (this.seq = (this.seq || 0) + 1);
    this.setData({ searching: true });
    api
      .search(term)
      .then((res) => {
        if (seq !== this.seq) return;
        const results = (res.items || []).map((ev) => ({
          id: ev.id,
          title: ev.title,
          catLabel: format.CATEGORY[ev.category] || '其他',
          meta: [ev.dateLabel, ev.place].filter(Boolean).join(' · '),
          memberCount: ev.memberCount,
          capacity: ev.capacity
        }));
        this.setData({ results, searching: false });
      })
      .catch(() => {
        if (seq === this.seq) this.setData({ results: [], searching: false });
      });
  },

  remember(term) {
    const recent = [term].concat(this.data.recent.filter((t) => t !== term)).slice(0, 8);
    this.setData({ recent });
    try {
      wx.setStorageSync(RECENT_KEY, recent);
    } catch (e) {
      // ignore
    }
  },

  clearRecent() {
    this.setData({ recent: [] });
    try {
      wx.removeStorageSync(RECENT_KEY);
    } catch (e) {
      // ignore
    }
  },

  openEvent(e) {
    if (this.data.term) this.remember(this.data.term);
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' });
  }
});

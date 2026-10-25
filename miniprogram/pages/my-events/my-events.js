// 我的局：进行中（含撮合中的意向）/ 已结束（去评价）/ 我发起的
const api = require('../../utils/api');
const format = require('../../utils/format');

const TABS = [
  { value: 'ongoing', label: '进行中' },
  { value: 'ended', label: '已结束' },
  { value: 'created', label: '我发起的' }
];

function when(c) {
  return c.startAt ? format.mdhm(c.startAt) : c.dateLabel || '';
}

// 每张卡片：副标题、状态胶囊、点进去去哪
function mapCard(c, tab, i) {
  if (!c.id && c.intentId) {
    return {
      key: 'i' + c.intentId,
      isIntent: true,
      title: c.title,
      sub: [c.dateLabel, c.place ? c.place + '附近出发' : ''].filter(Boolean).join(' · ') || '正在找同频的人',
      pill: c.needMore > 0 ? '撮合中 · 还差 ' + c.needMore + ' 人' : '撮合中',
      pillClass: 'pill-pill',
      url: '/pages/waiting/waiting?id=' + c.intentId
    };
  }
  const card = {
    key: 'e' + (c.id || i),
    id: c.id,
    title: c.title,
    category: c.category,
    task: c.task,
    sub: [when(c), c.place].filter(Boolean).join(' · '),
    url: '/pages/detail/detail?id=' + c.id
  };
  const count = (c.memberCount || 0) + '/' + (c.capacity || 0);
  if (tab === 'ended' || c.phase === 'ended') {
    const toReview = c.needReview && !c.reviewed;
    card.sub = [c.dateLabel || when(c), toReview ? '待评价' : ''].filter(Boolean).join(' · ');
    card.reviewBtn = toReview && tab !== 'created';
    card.tag = c.reviewed ? '已评价' : tab === 'created' ? '已结束' : '';
    return card;
  }
  if (c.status === 'cancelled') {
    card.pill = '已取消';
    card.pillClass = 'pill-stone';
  } else if (c.status === 'rejected') {
    card.pill = '没通过审核';
    card.pillClass = 'pill-danger';
  } else if (c.status === 'pending_review') {
    card.pill = '审核中';
    card.pillClass = 'pill-pill';
  } else if (c.myStatus === 'invited') {
    card.pill = '撮合成功 · 去确认';
    card.pillClass = 'pill-accent';
    card.url = '/pages/match/match?eventId=' + c.id;
  } else if (c.myStatus === 'applied') {
    card.pill = '等发起人同意';
    card.pillClass = 'pill-pill';
  } else if (c.status === 'formed') {
    card.pill = '已成局 · ' + count + ' · 去群聊';
    card.pillClass = 'pill-accent';
    card.url = '/pages/group/group?id=' + c.id;
  } else if (c.myStatus === 'joined' && c.source !== 'matched' && c.memberCount >= 2) {
    // 用户局 / 平台局：有第二个人加入后群聊就开了
    card.pill = '等人中 · ' + count + ' · 去群聊';
    card.pillClass = 'pill-accent';
    card.url = '/pages/group/group?id=' + c.id;
  } else if (c.myStatus === 'joined' && c.source !== 'matched') {
    card.pill = '等人中 · ' + count;
    card.pillClass = 'pill-pill';
  } else if (c.myStatus === 'joined') {
    card.pill = '等大家确认 · ' + count;
    card.pillClass = 'pill-pill';
  } else {
    card.pill = '等人中 · ' + count;
    card.pillClass = 'pill-pill';
  }
  return card;
}

Page({
  data: {
    tabs: TABS,
    tab: 'ongoing',
    counts: { ongoing: '', ended: '', created: '' },
    lists: { ongoing: [], ended: [], created: [] },
    loading: true
  },

  onLoad(query) {
    if (TABS.some((t) => t.value === query.tab)) this.setData({ tab: query.tab });
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    const first = !this.loaded;
    return Promise.all(TABS.map((t) => api.myEvents(t.value, { silent: !first || t.value !== this.data.tab }).catch(() => null))).then((results) => {
      this.loaded = true;
      const lists = {};
      const counts = {};
      TABS.forEach((t, i) => {
        const items = (results[i] && results[i].items) || [];
        lists[t.value] = items.map((c, j) => mapCard(c, t.value, j));
        counts[t.value] = items.length;
      });
      this.setData({ lists, counts, loading: false });
    });
  },

  pickTab(e) {
    this.setData({ tab: e.currentTarget.dataset.value });
  },

  open(e) {
    const item = this.data.lists[this.data.tab][e.currentTarget.dataset.index];
    if (item && item.url) wx.navigateTo({ url: item.url });
  },

  review(e) {
    const item = this.data.lists[this.data.tab][e.currentTarget.dataset.index];
    if (item) wx.navigateTo({ url: '/pages/review/review?id=' + item.id });
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/create/create' });
  },

  goSquare() {
    wx.switchTab({ url: '/pages/square/square' });
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' });
  }
});

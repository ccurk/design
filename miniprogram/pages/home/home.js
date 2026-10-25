// 撮合首页：说出想做的事 + 什么时候 → 生成意向
const api = require('../../utils/api');
const nav = require('../../utils/nav');

const TASKS = ['吃饭', '咖啡', '爬山', '看日出', '拼车', '桌游', '骑行', '随便走走'];
const WHENS = [
  { value: 'today', label: '今天' },
  { value: 'tomorrow', label: '明天' },
  { value: 'weekend', label: '本周末' }
];

function describe(intent, detail) {
  if (intent.status === 'invited') {
    return { sub: '配到了，去看看是谁', pill: '撮合成功', pillClass: 'pill-accent' };
  }
  if (intent.status === 'proposed') {
    return { sub: '人凑齐了，正在确认', pill: '撮合中', pillClass: 'pill-accent' };
  }
  let sub = '正在找同频的人';
  if (detail && typeof detail.similarCount === 'number') {
    const n = detail.similarCount + 1;
    sub = detail.needMore > 0 ? '已有 ' + n + ' 人同意向，还差 ' + detail.needMore + ' 人成局' : '已有 ' + n + ' 人同意向，马上成局';
  }
  return { sub, pill: '撮合中', pillClass: 'pill-accent' };
}

Page({
  data: {
    tasks: TASKS,
    whens: WHENS,
    task: '看日出',
    when: 'weekend',
    whenLabel: '本周末',
    intents: [],
    submitting: false
  },

  onShow() {
    nav.setTab(this, 0);
    this.loadIntents();
  },

  onPullDownRefresh() {
    this.loadIntents().then(() => wx.stopPullDownRefresh());
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
          const intents = items.map((it, i) => Object.assign({ id: it.id, title: it.title, status: it.status, eventId: it.eventId }, describe(it, details[i])));
          this.setData({ intents });
        });
      })
      .catch(() => {});
  },

  pickTask(e) {
    this.setData({ task: e.currentTarget.dataset.value });
  },

  pickWhen(e) {
    const value = e.currentTarget.dataset.value;
    const found = WHENS.filter((w) => w.value === value)[0];
    this.setData({ when: value, whenLabel: found ? found.label : '' });
  },

  submit() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    api
      .createIntent({ task: this.data.task, when: this.data.when })
      .then((intent) => {
        wx.navigateTo({ url: '/pages/waiting/waiting?id=' + intent.id });
      })
      .catch(() => {})
      .then(() => this.setData({ submitting: false }));
  },

  openIntent(e) {
    const it = this.data.intents[e.currentTarget.dataset.index];
    if (!it) return;
    if (it.status === 'invited' && it.eventId) wx.navigateTo({ url: '/pages/match/match?eventId=' + it.eventId });
    else wx.navigateTo({ url: '/pages/waiting/waiting?id=' + it.id });
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/create/create' });
  }
});

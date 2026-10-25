// 选兴趣 + 社交节奏，保存后完成引导
const api = require('../../utils/api');
const session = require('../../utils/session');

const ALL = ['看日出', '爬山', '徒步', '骑行', '咖啡', '读书', '拍照', '吃饭', '夜市', '桌游', '电影', '瑜伽', '冥想', '画画', '拼车', '逛古镇', '听现场', '随便走走'];
const PACES = [
  { value: 'slow', label: '比较慢热，先听大家聊' },
  { value: 'warm', label: '熟了就话多' },
  { value: 'open', label: '随时都能聊' }
];

Page({
  data: {
    tags: ALL.map((label) => ({ label, on: false })),
    paces: PACES,
    pace: 'slow',
    count: 0,
    busy: false
  },

  onLoad() {
    session
      .loadMe()
      .then((me) => {
        const picked = me.interests || [];
        const extra = picked.filter((t) => ALL.indexOf(t) < 0);
        const tags = ALL.concat(extra).map((label) => ({ label, on: picked.indexOf(label) >= 0 }));
        this.setData({ tags, pace: me.pace || 'slow', count: picked.length });
      })
      .catch(() => {});
  },

  toggleTag(e) {
    const i = e.currentTarget.dataset.index;
    const key = 'tags[' + i + '].on';
    const on = !this.data.tags[i].on;
    this.setData({ [key]: on, count: this.data.count + (on ? 1 : -1) });
  },

  pickPace(e) {
    this.setData({ pace: e.currentTarget.dataset.value });
  },

  submit() {
    if (this.data.busy) return;
    const interests = this.data.tags.filter((t) => t.on).map((t) => t.label);
    if (!interests.length) {
      wx.showToast({ title: '至少选 1 个吧', icon: 'none' });
      return;
    }
    this.setData({ busy: true });
    api
      .updateMe({ interests, pace: this.data.pace, onboarded: true })
      .then((me) => {
        session.setMe(me);
        wx.switchTab({ url: '/pages/home/home' });
      })
      .catch(() => {})
      .then(() => this.setData({ busy: false }));
  }
});

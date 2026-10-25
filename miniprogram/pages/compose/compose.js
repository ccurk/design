// 发动态：文字 + 照片（最多 6 张）+ 关联局 + 可见范围
const api = require('../../utils/api');
const session = require('../../utils/session');
const upload = require('../../utils/upload');

Page({
  data: {
    text: '',
    images: [],
    events: [],
    eventId: null,
    visibility: 'public',
    submitting: false,
    done: false,
    pending: false
  },

  onLoad(query) {
    const eventId = Number(query.eventId) || null;
    this.setData({ eventId, visibility: eventId && query.visibility === 'event' ? 'event' : 'public' });
    this.loadEvents();
  },

  loadEvents() {
    const silent = { silent: true };
    Promise.all([api.myEvents('ongoing', silent).catch(() => null), api.myEvents('ended', silent).catch(() => null)]).then(([a, b]) => {
      const seen = {};
      const list = []
        .concat((a && a.items) || [], (b && b.items) || [])
        .filter((e) => e.id && e.myStatus === 'joined' && !seen[e.id] && (seen[e.id] = true))
        .map((e) => ({ id: e.id, title: e.title, sub: [e.dateLabel, e.memberCount ? e.memberCount + ' 人' : ''].filter(Boolean).join(' · ') }));
      this.setData({ events: list.slice(0, 8) });
    });
  },

  onText(e) {
    this.setData({ text: e.detail.value });
  },

  addImages() {
    const left = 6 - this.data.images.length;
    if (left <= 0) return;
    upload.pickAndUpload(left).then((list) => {
      if (list.length) this.setData({ images: this.data.images.concat(list).slice(0, 6) });
    });
  },

  removeImage(e) {
    const i = e.currentTarget.dataset.index;
    this.setData({ images: this.data.images.filter((_, j) => j !== i) });
  },

  pickEvent(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.eventId === id) {
      // 再点一下取消；「只给同局的人」没有局就不成立
      this.setData({ eventId: null, visibility: 'public' });
    } else {
      this.setData({ eventId: id });
    }
  },

  pickScope(e) {
    const value = e.currentTarget.dataset.value;
    if (value === 'event' && !this.data.eventId) {
      wx.showToast({ title: '先关联一个局，才能只给同局的人看', icon: 'none' });
      return;
    }
    this.setData({ visibility: value });
  },

  submit() {
    if (this.data.submitting) return;
    const text = this.data.text.trim();
    if (!text) {
      wx.showToast({ title: '写一句感受吧，照片可以配在后面', icon: 'none' });
      return;
    }
    const body = { text, images: this.data.images.map((i) => i.url), visibility: this.data.visibility };
    if (this.data.eventId) body.eventId = this.data.eventId;
    this.setData({ submitting: true });
    api
      .createPost(body)
      .then((post) => {
        session.markDirty('feed');
        this.setData({ done: true, pending: !post || post.status === 'pending' });
      })
      .catch(() => {})
      .then(() => this.setData({ submitting: false }));
  },

  goFeed() {
    wx.switchTab({ url: '/pages/feed/feed' });
  }
});

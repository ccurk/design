// 动态详情：图片左右滑（高度跟第一张图走，点开看大图）+ 正文 + 评论：回复、点赞、举报、删除自己的动态
const api = require('../../utils/api');
const native = require('../../utils/native');
const session = require('../../utils/session');
const { mapPost, mapComment } = require('../../utils/posts');

Page({
  data: {
    loading: true,
    error: '',
    post: null,
    current: 0,
    galleryH: 750,
    comments: [],
    draft: '',
    replyTo: null,
    focus: false,
    intoView: '',
    composerStyle: ''
  },

  onLoad(query) {
    this.id = Number(query.id);
    this.kb = 0;
    if (!this.id) {
      this.setData({ loading: false, error: '链接里缺少动态编号' });
      return;
    }
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    return api
      .post(this.id, { silent: true })
      .then((res) => {
        const comments = (res.comments || []).map(mapComment);
        this.setData({ loading: false, error: '', post: mapPost(Object.assign({}, res, { commentCount: comments.length })), comments });
      })
      .catch((err) => this.setData({ loading: false, error: err.message }));
  },

  retry() {
    this.setData({ loading: true, error: '' });
    this.load();
  },

  // 轮播高度按第一张图的比例（3:4 到 4:3 之间），避免大片留白
  onImgLoad(e) {
    if (Number(e.currentTarget.dataset.index) !== 0) return;
    const d = e.detail || {};
    if (!d.width || !d.height) return;
    const ratio = Math.max(0.75, Math.min(1.333, d.height / d.width));
    this.setData({ galleryH: Math.round(750 * ratio) });
  },

  onSwiper(e) {
    this.setData({ current: e.detail.current });
  },

  preview(e) {
    const urls = (this.data.post && this.data.post.images) || [];
    wx.previewImage({ urls, current: urls[e.currentTarget.dataset.index] || urls[0] });
  },

  openAuthor() {
    const a = this.data.post && this.data.post.author;
    if (a && a.id) wx.navigateTo({ url: '/pages/user/user?id=' + a.id });
  },

  openEvent() {
    const ev = this.data.post && this.data.post.event;
    if (ev && ev.id) wx.navigateTo({ url: '/pages/detail/detail?id=' + ev.id });
  },

  onShareAppMessage() {
    const p = this.data.post;
    const share = { title: p ? (p.text || '').slice(0, 24) || '大理的局 · 花絮' : '大理的局 · 花絮', path: '/pages/post/post?id=' + this.id };
    if (p && p.images.length) share.imageUrl = p.images[0];
    return share;
  },

  onShareTimeline() {
    const p = this.data.post;
    const share = { title: p ? (p.text || '').slice(0, 24) || '大理的局 · 花絮' : '大理的局 · 花絮', query: 'id=' + this.id };
    if (p && p.images.length) share.imageUrl = p.images[0];
    return share;
  },

  onLike() {
    const p = this.data.post;
    if (!p || this.liking) return;
    const liked = !p.liked;
    this.liking = true;
    this.setData({ 'post.liked': liked, 'post.likeCount': p.likeCount + (liked ? 1 : -1) });
    (liked ? api.like(p.id) : api.unlike(p.id))
      .then((res) => {
        if (res) this.setData({ 'post.liked': res.liked, 'post.likeCount': res.likeCount });
        session.markDirty('feed');
      })
      .catch(() => this.setData({ 'post.liked': p.liked, 'post.likeCount': p.likeCount }))
      .then(() => {
        this.liking = false;
      });
  },

  onMore() {
    const p = this.data.post;
    if (!p) return;
    if (p.mine) {
      native.actionSheet(['删除这条动态'], { itemColor: '#B42318' }).then((i) => {
        if (i !== 0) return;
        native.confirm({ title: '删除这条动态？', content: '删除后大家就看不到了。', confirmText: '删除', confirmColor: '#B42318' }).then((ok) => {
          if (!ok) return;
          api
            .deletePost(p.id)
            .then(() => {
              session.markDirty('feed');
              wx.showToast({ title: '已删除', icon: 'none' });
              setTimeout(() => this.goFeed(), 600);
            })
            .catch(() => {});
        });
      });
      return;
    }
    native.actionSheet(['举报这条动态']).then((i) => {
      if (i === 0) wx.navigateTo({ url: '/pages/report/report?targetType=post&targetId=' + p.id });
    });
  },

  reply(e) {
    const c = this.data.comments[e.currentTarget.dataset.index];
    if (!c || !c.author) return;
    this.setData({ replyTo: { id: c.author.id, nickname: c.author.nickname }, focus: true });
  },

  onCommentLong(e) {
    const c = this.data.comments[e.currentTarget.dataset.index];
    if (!c) return;
    const items = c.mine ? ['复制'] : ['回复', '复制', '举报这条评论'];
    native.actionSheet(items).then((i) => {
      const action = items[i];
      if (action === '回复') this.setData({ replyTo: { id: c.author.id, nickname: c.author.nickname }, focus: true });
      if (action === '复制') wx.setClipboardData({ data: c.text });
      if (action === '举报这条评论') wx.navigateTo({ url: '/pages/report/report?targetType=comment&targetId=' + c.id });
    });
  },

  onInput(e) {
    this.setData({ draft: e.detail.value });
  },

  send() {
    const text = (this.data.draft || '').trim();
    if (!text || this.sending) return;
    this.sending = true;
    const body = { text };
    if (this.data.replyTo) body.replyToUserId = this.data.replyTo.id;
    api
      .comment(this.id, body)
      .then((c) => {
        const comments = this.data.comments.concat([mapComment(c)]);
        this.setData({ comments, draft: '', replyTo: null, 'post.commentCount': comments.length });
        session.markDirty('feed');
        this.setData({ intoView: '' }, () => this.setData({ intoView: 'end' }));
      })
      .catch(() => {}) // 审核不通过（CONTENT_BLOCKED）由 request 统一 toast
      .then(() => {
        this.sending = false;
      });
  },

  onFocus(e) {
    this.setKeyboard((e.detail && e.detail.height) || 0);
  },

  onBlur() {
    this.setKeyboard(0);
    this.setData({ focus: false });
    // 没写东西就收起「回复某人」
    if (!this.data.draft) this.setData({ replyTo: null });
  },

  onKeyboard(e) {
    this.setKeyboard((e.detail && e.detail.height) || 0);
  },

  setKeyboard(height) {
    if (height === this.kb) return;
    this.kb = height;
    this.setData({ composerStyle: height ? 'padding-bottom: ' + (height + 10) + 'px;' : '' });
  },

  openUser(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/user/user?id=' + id });
  },

  goFeed() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/feed/feed' });
  }
});

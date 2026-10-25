// 动态：公共朋友圈。点赞、··· 举报 / 不看 TA / 删除自己的
const api = require('../../utils/api');
const nav = require('../../utils/nav');
const native = require('../../utils/native');
const session = require('../../utils/session');
const { mapPost } = require('../../utils/posts');

Page({
  data: {
    posts: [],
    nextCursor: null,
    loading: true,
    loadingMore: false,
    error: ''
  },

  onLoad() {
    this.refresh();
  },

  onShow() {
    nav.setTab(this, 2);
    if (session.takeDirty('feed')) this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (!this.data.nextCursor || this.data.loadingMore || this.data.loading) return;
    this.setData({ loadingMore: true });
    api
      .posts(this.data.nextCursor)
      .then((res) => {
        const seen = {};
        this.data.posts.forEach((p) => (seen[p.id] = true));
        const more = (res.items || []).filter((p) => !seen[p.id]).map(mapPost);
        this.setData({ posts: this.data.posts.concat(more), nextCursor: res.nextCursor || null });
      })
      .catch(() => {})
      .then(() => this.setData({ loadingMore: false }));
  },

  refresh() {
    this.setData({ loading: true, error: '' });
    return api
      .posts()
      .then((res) => this.setData({ posts: (res.items || []).map(mapPost), nextCursor: res.nextCursor || null, loading: false }))
      .catch((err) => this.setData({ loading: false, error: err.message }));
  },

  indexOf(id) {
    return this.data.posts.findIndex((p) => p.id === id);
  },

  onLike(e) {
    const i = this.indexOf(e.detail.id);
    if (i < 0 || this.liking) return;
    const p = this.data.posts[i];
    const liked = !p.liked;
    this.liking = true;
    this.setData({ ['posts[' + i + '].liked']: liked, ['posts[' + i + '].likeCount']: p.likeCount + (liked ? 1 : -1) });
    (liked ? api.like(p.id) : api.unlike(p.id))
      .then((res) => {
        const j = this.indexOf(p.id);
        if (j >= 0 && res) this.setData({ ['posts[' + j + '].liked']: res.liked, ['posts[' + j + '].likeCount']: res.likeCount });
      })
      .catch(() => {
        const j = this.indexOf(p.id);
        if (j >= 0) this.setData({ ['posts[' + j + '].liked']: p.liked, ['posts[' + j + '].likeCount']: p.likeCount });
      })
      .then(() => {
        this.liking = false;
      });
  },

  onMore(e) {
    const p = this.data.posts[this.indexOf(e.detail.id)];
    if (!p) return;
    if (p.mine) {
      native.actionSheet(['删除这条动态'], { itemColor: '#B42318' }).then((i) => {
        if (i === 0) this.remove(p);
      });
      return;
    }
    native.actionSheet(['举报这条动态', '不看 TA 的动态']).then((i) => {
      if (i === 0) wx.navigateTo({ url: '/pages/report/report?targetType=post&targetId=' + p.id });
      if (i === 1) this.muteAuthor(p);
    });
  },

  remove(p) {
    native.confirm({ title: '删除这条动态？', content: '删除后大家就看不到了。', confirmText: '删除', confirmColor: '#B42318' }).then((ok) => {
      if (!ok) return;
      api
        .deletePost(p.id)
        .then(() => {
          this.setData({ posts: this.data.posts.filter((x) => x.id !== p.id) });
          wx.showToast({ title: '已删除', icon: 'none' });
        })
        .catch(() => {});
    });
  },

  muteAuthor(p) {
    const authorId = p.author && p.author.id;
    if (!authorId) return;
    api
      .muteUser(authorId)
      .then(() => {
        this.setData({ posts: this.data.posts.filter((x) => !x.author || x.author.id !== authorId) });
        wx.showToast({ title: '好的，以后不再给你看 TA 的动态', icon: 'none' });
      })
      .catch(() => {});
  },

  onOpen(e) {
    wx.navigateTo({ url: '/pages/post/post?id=' + e.detail.id });
  },

  goCompose() {
    wx.navigateTo({ url: '/pages/compose/compose' });
  }
});

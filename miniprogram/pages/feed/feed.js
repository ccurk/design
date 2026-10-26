// 动态：双列瀑布流（第一张图作封面，没图的是文字卡片），点赞、长按 ··· 举报 / 不看 TA / 删除自己的；
// 骨架屏、下拉刷新、触底加载（docs/changes-v0.3.md F / I）
const api = require('../../utils/api');
const nav = require('../../utils/nav');
const native = require('../../utils/native');
const session = require('../../utils/session');
const { mapPost } = require('../../utils/posts');

// 卡片高度估算（以列宽为 1）：图片按 4:5 估，加载后用真实比例修正后续的分配
const BODY_WITH_IMAGE = 0.42;
const BODY_TEXT_ONLY = 0.26;

function estimate(p, ratio) {
  if (p.images.length) return (ratio || 1.25) + BODY_WITH_IMAGE;
  const lines = Math.min(6, Math.ceil((p.text || '').length / 10));
  return Math.max(0.84, 0.22 + lines * 0.15) + BODY_TEXT_ONLY;
}

Page({
  data: {
    left: [],
    right: [],
    empty: false,
    nextCursor: null,
    loading: true,
    loadingMore: false,
    moreError: false,
    error: ''
  },

  onLoad() {
    this.reset();
    this.refresh();
  },

  onShow() {
    nav.setTab(this, 2);
    if (session.takeDirty('feed')) this.refresh(true);
  },

  onPullDownRefresh() {
    this.refresh(true).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadMore();
  },

  onShareAppMessage() {
    return { title: '大理的局，结束后的花絮', path: '/pages/feed/feed' };
  },

  reset() {
    this.heights = [0, 0];
    this.where = {};
    this.counter = 0;
  },

  // 把新的一批分到较矮的那一列；已经放好的卡片不再挪动（不跳）
  place(posts, replace) {
    if (replace) this.reset();
    const left = replace ? [] : this.data.left.slice();
    const right = replace ? [] : this.data.right.slice();
    posts.forEach((p) => {
      if (this.where[p.id]) return;
      const col = this.heights[0] <= this.heights[1] ? 0 : 1;
      const list = col === 0 ? left : right;
      this.where[p.id] = { col, index: list.length, est: estimate(p), seq: this.counter++ };
      this.heights[col] += this.where[p.id].est;
      list.push(p);
    });
    this.setData({ left, right, empty: !left.length && !right.length });
  },

  refresh(keep) {
    const seq = (this.seq = (this.seq || 0) + 1);
    const has = this.data.left.length > 0;
    this.setData({ loading: !(keep && has), error: '', moreError: false });
    return api
      .posts(undefined, { silent: !has })
      .then((res) => {
        if (seq !== this.seq) return;
        this.place((res.items || []).map(mapPost), true);
        this.setData({ nextCursor: res.nextCursor || null, loading: false });
      })
      .catch((err) => {
        if (seq !== this.seq) return;
        this.setData({ loading: false, error: (err && err.message) || '网络不太好' });
      });
  },

  retry() {
    this.refresh();
  },

  loadMore() {
    if (!this.data.nextCursor || this.data.loadingMore || this.data.loading) return;
    const seq = this.seq;
    this.setData({ loadingMore: true, moreError: false });
    api
      .posts(this.data.nextCursor, { silent: true })
      .then((res) => {
        if (seq !== this.seq) return;
        this.place((res.items || []).map(mapPost), false);
        this.setData({ nextCursor: res.nextCursor || null });
      })
      .catch(() => this.setData({ moreError: true }))
      .then(() => this.setData({ loadingMore: false }));
  },

  // 封面图加载后拿到真实比例，修正这一列的估算高度
  onSize(e) {
    const { id, ratio } = e.detail;
    const w = this.where[id];
    if (!w || !ratio || w.sized) return;
    const p = this.find(id);
    if (!p) return;
    const est = estimate(p.post, ratio);
    this.heights[w.col] += est - w.est;
    w.est = est;
    w.sized = true;
  },

  find(id) {
    const w = this.where[id];
    if (!w) return null;
    const key = w.col === 0 ? 'left' : 'right';
    const post = this.data[key][w.index];
    return post && post.id === id ? { key, index: w.index, post } : null;
  },

  patch(id, fields) {
    const f = this.find(id);
    if (!f) return;
    const data = {};
    Object.keys(fields).forEach((k) => (data[f.key + '[' + f.index + '].' + k] = fields[k]));
    this.setData(data);
  },

  onLike(e) {
    const f = this.find(e.detail.id);
    if (!f || this.liking) return;
    const p = f.post;
    const liked = !p.liked;
    this.liking = true;
    this.patch(p.id, { liked, likeCount: p.likeCount + (liked ? 1 : -1) });
    (liked ? api.like(p.id) : api.unlike(p.id))
      .then((res) => {
        if (res) this.patch(p.id, { liked: res.liked, likeCount: res.likeCount });
      })
      .catch(() => this.patch(p.id, { liked: p.liked, likeCount: p.likeCount }))
      .then(() => {
        this.liking = false;
      });
  },

  onMore(e) {
    const f = this.find(e.detail.id);
    if (!f) return;
    const p = f.post;
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

  // 删除 / 不看之后整体重排一次（只在用户操作后发生）
  relayout(keep) {
    // 按原来的先后顺序合并两列，再重新分配
    const all = this.data.left
      .concat(this.data.right)
      .filter(keep)
      .sort((a, b) => this.where[a.id].seq - this.where[b.id].seq);
    this.place(all, true);
  },

  remove(p) {
    native.confirm({ title: '删除这条动态？', content: '删除后大家就看不到了。', confirmText: '删除', confirmColor: '#B42318' }).then((ok) => {
      if (!ok) return;
      api
        .deletePost(p.id)
        .then(() => {
          this.relayout((x) => x.id !== p.id);
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
        this.relayout((x) => !x.author || x.author.id !== authorId);
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

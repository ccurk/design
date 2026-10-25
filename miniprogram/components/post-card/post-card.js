// 动态卡片。事件：like / more / open（看详情）。作者、来源局在组件内直接跳转。
Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    post: { type: Object, value: {} },
    // 详情页：图片矮一点、正文不可点、不显示评论数
    detail: { type: Boolean, value: false }
  },
  methods: {
    openUser() {
      const a = this.data.post.author;
      if (a && a.id) wx.navigateTo({ url: '/pages/user/user?id=' + a.id });
    },
    openEvent() {
      const ev = this.data.post.event;
      if (ev && ev.id) wx.navigateTo({ url: '/pages/detail/detail?id=' + ev.id });
    },
    open() {
      if (!this.data.detail) this.triggerEvent('open', { id: this.data.post.id });
    },
    like() {
      this.triggerEvent('like', { id: this.data.post.id });
    },
    more() {
      this.triggerEvent('more', { id: this.data.post.id });
    },
    preview(e) {
      const urls = this.data.post.images || [];
      wx.previewImage({ urls, current: urls[e.currentTarget.dataset.index] });
    }
  }
});

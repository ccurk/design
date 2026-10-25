// 广场上的局卡片（EventCard）
Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    event: { type: Object, value: {} }
  },
  data: { preview: [], meta: '' },
  observers: {
    event(ev) {
      const e = ev || {};
      const meta = [e.dateLabel, e.place].filter(Boolean).join(' · ');
      this.setData({ preview: (e.membersPreview || []).slice(0, 3), meta });
    }
  },
  methods: {
    open() {
      const id = this.data.event && this.data.event.id;
      if (id) wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
    }
  }
});

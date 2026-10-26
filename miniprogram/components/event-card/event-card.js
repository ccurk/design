// 局卡片（EventCard）：封面优先用照片，没有就用标签插画；compact = 横滑小卡
Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    event: { type: Object, value: {} },
    compact: { type: Boolean, value: false }
  },
  data: { preview: [], meta: '', tag: '', statusText: '', statusClass: '' },
  observers: {
    event(ev) {
      const e = ev || {};
      const left = Math.max(0, (e.capacity || 0) - (e.memberCount || 0));
      let statusText = '';
      let statusClass = '';
      if (e.status === 'formed' || (e.capacity && left === 0)) {
        statusText = '已满员';
        statusClass = 'full';
      } else if (e.capacity && left <= 2) {
        statusText = '还差 ' + left + ' 人';
        statusClass = 'soon';
      }
      this.setData({
        preview: (e.membersPreview || []).slice(0, 3),
        meta: [e.dateLabel, e.place].filter(Boolean).join(' · '),
        tag: e.tag || e.task || '',
        statusText,
        statusClass
      });
    }
  },
  methods: {
    open() {
      const id = this.data.event && this.data.event.id;
      if (id) wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
    }
  }
});

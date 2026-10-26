// 自定义底部导航：选中项图标放在洱海蓝胶囊上
Component({
  data: {
    selected: 0,
    // 首页弹窗打开时隐藏，免得盖住弹窗的按钮
    hidden: false,
    list: [
      { url: '/pages/home/home', text: '撮合', icon: '/assets/icons/people-tab.svg', iconOn: '/assets/icons/people-ink.svg' },
      { url: '/pages/square/square', text: '广场', icon: '/assets/icons/compass-tab.svg', iconOn: '/assets/icons/compass-ink.svg' },
      { url: '/pages/feed/feed', text: '动态', icon: '/assets/icons/image-tab.svg', iconOn: '/assets/icons/image-ink.svg' },
      { url: '/pages/inbox/inbox', text: '消息', icon: '/assets/icons/chat-tab.svg', iconOn: '/assets/icons/chat-ink.svg' },
      { url: '/pages/me/me', text: '我的', icon: '/assets/icons/user-tab.svg', iconOn: '/assets/icons/user-ink.svg' }
    ]
  },
  methods: {
    switchTab(e) {
      const index = Number(e.currentTarget.dataset.index);
      if (index === this.data.selected) return;
      wx.switchTab({ url: this.data.list[index].url });
    }
  }
});

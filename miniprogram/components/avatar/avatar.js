// 头像：有 avatarUrl 显示图片，否则用 avatarText 画圆，颜色由 avatarColor 决定。
const format = require('../../utils/format');

const COLORS = {
  ink: ['#193543', '#FFFFFF'],
  stone: ['#E3E8EC', '#15171C'],
  accent: ['#7CCAE3', '#15171C'],
  slate: ['#2E4A5C', '#FFFFFF']
};

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    user: { type: Object, value: null },
    // 设计稿里的像素尺寸
    size: { type: Number, value: 40 },
    // 叠放时的白色描边
    ring: { type: Boolean, value: false }
  },
  data: { url: '', text: '', bg: '#E3E8EC', fg: '#15171C', px: 80, fs: 28, weight: 700 },
  observers: {
    'user, size': function (user, size) {
      const u = user || {};
      const c = COLORS[u.avatarColor] || COLORS.stone;
      const px = (size || 40) * 2;
      this.setData({
        url: format.imageUrl(u.avatarUrl),
        text: u.avatarText || (u.nickname ? String(u.nickname).slice(0, 1) : ''),
        bg: c[0],
        fg: c[1],
        px,
        fs: Math.round(px * (size >= 60 ? 0.39 : 0.37)),
        weight: size >= 60 ? 800 : 700
      });
    }
  },
  methods: {
    onError() {
      this.setData({ url: '' });
    }
  }
});

// 骨架屏：首次加载时占位，形状接近真实内容，避免加载完跳动
Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    // home | cards | list | feed | detail
    type: { type: String, value: 'list' },
    count: { type: Number, value: 3 }
  },
  data: { rows: [0, 1, 2] },
  observers: {
    count(n) {
      const rows = [];
      for (let i = 0; i < Math.max(1, n); i++) rows.push(i);
      this.setData({ rows });
    }
  }
});

// 选开始时间：日期 / 时 / 分（精确到分钟），我们自己的底部弹窗，不用系统选择器
const format = require('../../utils/format');

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    show: { type: Boolean, value: false },
    zIndex: { type: Number, value: 1100 },
    title: { type: String, value: '什么时候开始' },
    // ISO 时间；空 = 默认明天 09:00
    value: { type: String, value: '' },
    days: { type: Number, value: 60 },
    // 至少要晚于现在多少分钟
    minAhead: { type: Number, value: 30 }
  },
  data: {
    alive: false,
    dates: [],
    hours: format.range(0, 23),
    minutes: format.range(0, 59),
    pick: [1, 9, 0],
    summary: '',
    error: ''
  },
  observers: {
    show(v) {
      if (v) this.init();
      else this.timer = setTimeout(() => this.setData({ alive: false }), 300);
    }
  },
  lifetimes: {
    detached() {
      clearTimeout(this.timer);
    }
  },
  methods: {
    init() {
      clearTimeout(this.timer);
      const dates = format.dateOptions(this.data.days);
      let pick = [1, 9, 0];
      const p = this.data.value && format.bj(this.data.value);
      if (p) {
        const key = p.y + '-' + format.pad(p.m) + '-' + format.pad(p.d);
        const di = dates.findIndex((d) => d.date === key);
        if (di >= 0) pick = [di, p.h, p.mi];
      }
      this.setData({ alive: true, dates }, () => this.update(pick));
    },
    onChange(e) {
      this.update(e.detail.value);
    },
    current(pick) {
      const d = this.data.dates[pick[0]] || this.data.dates[0];
      const time = format.pad(pick[1]) + ':' + format.pad(pick[2]);
      return { date: d.date, time, iso: format.toISO(d.date, time), label: format.dateLabel(d.date) + ' ' + time };
    },
    update(pick) {
      const c = this.current(pick);
      const tooSoon = new Date(c.iso).getTime() < Date.now() + this.data.minAhead * 60000;
      this.setData({ pick, summary: c.label, error: tooSoon ? '开始时间要晚于现在 ' + this.data.minAhead + ' 分钟以上' : '' });
    },
    onConfirm() {
      if (this.data.error) return;
      this.triggerEvent('confirm', this.current(this.data.pick));
    },
    onClose() {
      this.triggerEvent('close');
    }
  }
});

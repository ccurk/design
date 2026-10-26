// 指定几点到几点（精确到分钟）：05:00 ≤ 开始 < 结束 ≤ 23:59，至少 60 分钟（docs/changes-v0.3.md B）
const format = require('../../utils/format');

const HOURS = format.range(5, 23);
const MINUTES = format.range(0, 59);

function toPick(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return [Math.max(0, h - 5), m];
}

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    show: { type: Boolean, value: false },
    zIndex: { type: Number, value: 1100 },
    title: { type: String, value: '指定时间段' },
    from: { type: String, value: '14:00' },
    to: { type: String, value: '17:00' }
  },
  data: { alive: false, hours: HOURS, minutes: MINUTES, sep: ['至'], pick: [9, 0, 0, 12, 0], fromText: '', toText: '', span: '', error: '' },
  observers: {
    show(v) {
      if (v) {
        clearTimeout(this.timer);
        const a = toPick(this.data.from || '14:00');
        const b = toPick(this.data.to || '17:00');
        this.setData({ alive: true }, () => this.update([a[0], a[1], 0, b[0], b[1]]));
      } else {
        this.timer = setTimeout(() => this.setData({ alive: false }), 300);
      }
    }
  },
  lifetimes: {
    detached() {
      clearTimeout(this.timer);
    }
  },
  methods: {
    onChange(e) {
      this.update(e.detail.value);
    },
    update(pick) {
      const from = HOURS[pick[0]] + ':' + MINUTES[pick[1]];
      const to = HOURS[pick[3]] + ':' + MINUTES[pick[4]];
      const span = format.toMinutes(to) - format.toMinutes(from);
      let error = '';
      if (span <= 0) error = '结束要晚于开始';
      else if (span < 60) error = '至少留 1 小时，才好约到人';
      this.setData({ pick, fromText: from, toText: to, span: span > 0 ? format.spanLabel(span) : '', error });
    },
    onConfirm() {
      if (this.data.error) return;
      const { fromText, toText } = this.data;
      this.triggerEvent('confirm', { from: fromText, to: toText, label: fromText + '–' + toText });
    },
    onClose() {
      this.triggerEvent('close');
    }
  }
});

// 选日期：月历样式，只能选今天起 days 天内（北京时间）
const format = require('../../utils/format');

const HEAD = ['一', '二', '三', '四', '五', '六', '日'];

function weekdayMon(date) {
  const [y, m, d] = date.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // 周一 = 0
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
}

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    show: { type: Boolean, value: false },
    title: { type: String, value: '选个日期' },
    value: { type: String, value: '' },
    days: { type: Number, value: 31 }
  },
  data: { head: HEAD, cells: [], selected: '', label: '', monthLabel: '' },
  observers: {
    show(v) {
      if (v) this.build();
    }
  },
  methods: {
    build() {
      const first = format.dateStr(0);
      const last = format.dateStr(this.data.days - 1);
      const start = addDays(first, -weekdayMon(first));
      const end = addDays(last, 6 - weekdayMon(last));
      const cells = [];
      for (let date = start; date <= end; date = addDays(date, 1)) {
        const [, m, d] = date.split('-').map(Number);
        cells.push({
          date,
          day: d === 1 ? m + '月' : String(d),
          monthStart: d === 1,
          today: date === first,
          disabled: date < first || date > last
        });
      }
      const selected = this.data.value && this.data.value >= first && this.data.value <= last ? this.data.value : '';
      const m1 = Number(first.split('-')[1]);
      const m2 = Number(last.split('-')[1]);
      this.setData({ cells, selected, label: selected ? format.dateLabel(selected) : '', monthLabel: m1 === m2 ? m1 + '月' : m1 + '月 – ' + m2 + '月' });
    },
    pick(e) {
      const { date, disabled } = e.currentTarget.dataset;
      if (disabled) return;
      this.setData({ selected: date, label: format.dateLabel(date) });
    },
    onConfirm() {
      if (!this.data.selected) return;
      this.triggerEvent('confirm', { date: this.data.selected, label: this.data.label });
    },
    onClose() {
      this.triggerEvent('close');
    }
  }
});

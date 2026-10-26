// AA 一次声明：总金额 + 包含什么（docs/changes-v0.3.md D）
const format = require('../../utils/format');

const QUICK = ['车费', '早餐', '午饭', '门票', '场地费', '饮料'];

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    show: { type: Boolean, value: false },
    // 修改时传入原来的
    amount: { type: Number, value: 0 },
    note: { type: String, value: '' },
    editing: { type: Boolean, value: false },
    memberCount: { type: Number, value: 0 },
    busy: { type: Boolean, value: false }
  },
  data: { quick: QUICK, amountText: '', noteText: '', each: '', error: '' },
  observers: {
    show(v) {
      if (!v) return;
      const amountText = this.data.amount ? format.money(this.data.amount) : '';
      this.setData({ amountText, noteText: this.data.note || '', error: '' }, () => this.preview());
    }
  },
  methods: {
    onAmount(e) {
      this.setData({ amountText: e.detail.value, error: '' }, () => this.preview());
    },
    onNote(e) {
      this.setData({ noteText: e.detail.value });
    },
    addQuick(e) {
      const word = e.currentTarget.dataset.word;
      const cur = this.data.noteText.trim();
      if (cur.split(/\s*\+\s*/).indexOf(word) >= 0) return;
      this.setData({ noteText: cur ? cur + ' + ' + word : word });
    },
    preview() {
      const n = this.data.memberCount;
      const amount = Number(this.data.amountText);
      this.setData({ each: amount > 0 && n > 0 ? format.money(Math.round((amount / n) * 100) / 100) : '' });
    },
    onConfirm() {
      if (this.data.busy) return;
      const amount = Math.round(Number(this.data.amountText) * 100) / 100;
      if (!(amount > 0)) {
        this.setData({ error: '先填一下总金额' });
        return;
      }
      if (amount > 100000) {
        this.setData({ error: '金额太大了，再检查一下' });
        return;
      }
      this.triggerEvent('confirm', { amount, note: this.data.noteText.trim() });
    },
    onClose() {
      if (!this.data.busy) this.triggerEvent('close');
    }
  }
});

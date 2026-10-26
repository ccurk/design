// 选标签：后台维护的热门标签 + 自己添加（1–8 个字，文字 / 数字 / 空格 / ·-_）
const format = require('../../utils/format');

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    show: { type: Boolean, value: false },
    title: { type: String, value: '想做什么' },
    // [{ name, category, cover }]
    tags: { type: Array, value: [] },
    value: { type: String, value: '' },
    // 打开就聚焦到「自己添加」
    custom: { type: Boolean, value: false },
    zIndex: { type: Number, value: 1100 }
  },
  data: { picked: '', input: '', error: '', focus: false, isCustom: false },
  observers: {
    show(v) {
      if (!v) {
        this.setData({ focus: false });
        return;
      }
      const picked = this.data.value || '';
      const isCustom = !!picked && !this.data.tags.some((t) => t.name === picked);
      this.setData({ picked, isCustom, input: isCustom ? picked : '', error: '', focus: false });
      if (this.data.custom) setTimeout(() => this.setData({ focus: true }), 320);
    }
  },
  methods: {
    pick(e) {
      this.setData({ picked: e.currentTarget.dataset.name, isCustom: false, error: '' });
    },
    onInput(e) {
      const input = e.detail.value;
      const r = format.normalizeTag(input);
      this.setData({ input, picked: r.error ? '' : r.name, isCustom: true, error: input ? r.error : '' });
    },
    onConfirm() {
      if (this.data.isCustom) {
        const r = format.normalizeTag(this.data.input);
        if (r.error) {
          this.setData({ error: r.error });
          return;
        }
        this.triggerEvent('confirm', { name: r.name, custom: true });
        return;
      }
      if (!this.data.picked) return;
      this.triggerEvent('confirm', { name: this.data.picked, custom: false });
    },
    onClose() {
      this.triggerEvent('close');
    }
  }
});

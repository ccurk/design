// 开关（受控）：点一下触发 change { value }，由页面决定是否更新 checked
Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    checked: { type: Boolean, value: false },
    disabled: { type: Boolean, value: false },
    label: { type: String, value: '' }
  },
  methods: {
    toggle() {
      if (this.data.disabled) return;
      this.triggerEvent('change', { value: !this.data.checked });
    }
  }
});

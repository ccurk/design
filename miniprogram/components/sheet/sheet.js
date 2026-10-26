// 底部弹窗（所有选择器、确认框的统一外壳）：圆角白底、标题 + 关闭、底部「取消 / 确定」。
// 用法：<dz-sheet show="{{x}}" title="…" bindclose="…" bindconfirm="…">内容</dz-sheet>
// actions="{{false}}" 时不显示默认按钮，可以用 slot="footer" 放自己的按钮。
Component({
  options: { styleIsolation: 'apply-shared', multipleSlots: true },
  properties: {
    show: { type: Boolean, value: false },
    title: { type: String, value: '' },
    confirmText: { type: String, value: '确定' },
    cancelText: { type: String, value: '取消' },
    actions: { type: Boolean, value: true },
    confirmDisabled: { type: Boolean, value: false },
    zIndex: { type: Number, value: 1000 },
    maskClose: { type: Boolean, value: true }
  },
  data: { rendered: false, visible: false },
  observers: {
    show(v) {
      if (v) this.open();
      else this.close();
    }
  },
  lifetimes: {
    detached() {
      clearTimeout(this.timer);
    }
  },
  methods: {
    open() {
      clearTimeout(this.timer);
      this.setData({ rendered: true }, () => {
        this.timer = setTimeout(() => this.setData({ visible: true }), 20);
      });
    },
    close() {
      clearTimeout(this.timer);
      if (!this.data.rendered) return;
      this.setData({ visible: false });
      this.timer = setTimeout(() => this.setData({ rendered: false }), 260);
    },
    onMask() {
      if (this.data.maskClose) this.triggerEvent('close');
    },
    onCancel() {
      this.triggerEvent('cancel');
      this.triggerEvent('close');
    },
    onConfirm() {
      if (!this.data.confirmDisabled) this.triggerEvent('confirm');
    },
    noop() {}
  }
});

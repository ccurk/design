// 空状态：一句标题 + 一句说明 + 可选按钮（slot）
Component({
  options: { styleIsolation: 'apply-shared', multipleSlots: false },
  properties: {
    title: { type: String, value: '' },
    desc: { type: String, value: '' },
    icon: { type: String, value: '' },
    compact: { type: Boolean, value: false }
  }
});

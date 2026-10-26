// 加入确认：局的时间、地点、费用、最晚退出时间 + 免责声明 →「同意并加入」→ 结果
// 页面在 bindconfirm 里调接口，成功后把 result 传回来：{ formed, remaining, myStatus }
const native = require('../../utils/native');

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    show: { type: Boolean, value: false },
    // { title, tag, when, place, fee, exit }
    info: { type: Object, value: {} },
    busy: { type: Boolean, value: false },
    result: { type: Object, value: null },
    confirmText: { type: String, value: '同意并加入' },
    // 没成群时显示「邀请朋友」（撮合局只有被配到的人能看，不显示）
    share: { type: Boolean, value: true }
  },
  methods: {
    onConfirm() {
      if (this.data.busy) return;
      // 订阅「人齐了」提醒必须在点击里同步发起；没配模板时静默跳过
      native.subscribe(['formed', 'reminder'], { silent: true });
      this.triggerEvent('confirm');
    },
    onClose() {
      if (this.data.busy) return;
      this.triggerEvent('close');
    },
    onChat() {
      this.triggerEvent('chat');
    },
    openRules() {
      wx.navigateTo({ url: '/pages/rules/rules?section=pact' });
    }
  }
});

// 举报：原因 + 说明 + 截图（最多 3 张）+ 可同时拉黑。targetType: user / event / post / comment / message
const api = require('../../utils/api');
const native = require('../../utils/native');
const session = require('../../utils/session');
const upload = require('../../utils/upload');

const REASONS = ['骚扰或不当言行', '色情低俗', '推销 / 拉人头', '涉及金钱交易', '放鸽子 / 恶意爽约', '冒充身份', '其他'];
const TYPES = ['user', 'event', 'post', 'comment', 'message'];

Page({
  data: {
    reasons: REASONS,
    reason: '',
    warn: false,
    detail: '',
    images: [],
    alsoBlock: false,
    showBlock: true,
    submitting: false,
    done: false
  },

  onLoad(query) {
    this.targetType = TYPES.indexOf(query.targetType) >= 0 ? query.targetType : 'user';
    this.targetId = Number(query.targetId);
    // 举报整个局时没有明确的「对方」，不显示拉黑选项
    this.setData({ showBlock: this.targetType !== 'event' });
  },

  pickReason(e) {
    this.setData({ reason: e.currentTarget.dataset.value, warn: false });
  },

  onDetail(e) {
    this.setData({ detail: e.detail.value });
  },

  addImage() {
    const left = 3 - this.data.images.length;
    if (left <= 0) return;
    upload.pickAndUpload(left).then((list) => {
      if (list.length) this.setData({ images: this.data.images.concat(list).slice(0, 3) });
    });
  },

  removeImage(e) {
    const i = e.currentTarget.dataset.index;
    this.setData({ images: this.data.images.filter((_, j) => j !== i) });
  },

  toggleBlock() {
    this.setData({ alsoBlock: !this.data.alsoBlock });
  },

  submit() {
    if (this.data.submitting) return;
    if (!this.data.reason) {
      this.setData({ warn: true });
      wx.showToast({ title: '先选一个原因', icon: 'none' });
      return;
    }
    if (!this.targetId) {
      wx.showToast({ title: '不知道要举报什么，返回重试一下', icon: 'none' });
      return;
    }
    // 处理结果用订阅消息通知（需要在点击里同步发起）
    native.subscribe(['report'], { silent: true });
    this.setData({ submitting: true });
    const body = {
      targetType: this.targetType,
      targetId: this.targetId,
      reason: this.data.reason,
      detail: this.data.detail.trim() || undefined,
      images: this.data.images.map((i) => i.url),
      alsoBlock: this.data.showBlock && this.data.alsoBlock
    };
    api
      .report(body)
      .then(() => {
        if (body.alsoBlock) session.markDirty('feed');
        this.setData({ done: true });
      })
      .catch(() => {})
      .then(() => this.setData({ submitting: false }));
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/home' }) });
  }
});

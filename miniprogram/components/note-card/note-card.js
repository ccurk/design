// 动态瀑布流卡片：第一张图作封面（widthFix），没图就是文字卡片。
// 事件：open / like / more（长按）/ size（封面加载后的高宽比，给瀑布流修正列高）
const TONES = ['tone-sky', 'tone-stone', 'tone-ink'];

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    post: { type: Object, value: {} }
  },
  data: { loaded: false, broken: false, tone: TONES[0] },
  observers: {
    'post.id': function (id) {
      this.setData({ tone: TONES[(Number(id) || 0) % TONES.length] });
    }
  },
  methods: {
    onLoad(e) {
      this.setData({ loaded: true });
      const d = (e && e.detail) || {};
      if (d.width && d.height) this.triggerEvent('size', { id: this.data.post.id, ratio: d.height / d.width });
    },
    onError() {
      this.setData({ loaded: true, broken: true });
    },
    open() {
      this.triggerEvent('open', { id: this.data.post.id });
    },
    like() {
      this.triggerEvent('like', { id: this.data.post.id });
    },
    more() {
      this.triggerEvent('more', { id: this.data.post.id });
    }
  }
});

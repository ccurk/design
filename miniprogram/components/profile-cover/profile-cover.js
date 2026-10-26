// 个人主页顶部的背景图：铺到状态栏下面（页面 json 里 navigationStyle: custom），往上滑过背景后出现带标题的顶栏。
// 背景：自己上传的照片优先，没有就用 coverKey 对应的插画（docs/api.md「Me」）。
// editable：显示「更换背景」，点背景也算，触发 change；back：左上角返回按钮（他人主页）。
const format = require('../../utils/format');

// 深色插画：状态栏用白字
const DARK_KEYS = ['boardgame'];

// 状态栏、胶囊按钮的位置，算出顶栏和背景的高度（px）
function layout() {
  let win = {};
  try {
    win = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {};
  } catch (e) {
    win = {};
  }
  const statusH = win.statusBarHeight || 20;
  const width = win.windowWidth || 375;
  let rect = null;
  try {
    rect = wx.getMenuButtonBoundingClientRect();
  } catch (e) {
    rect = null;
  }
  if (!rect || !rect.height) rect = { top: statusH + 4, height: 32, width: 87, right: width - 7 };
  const gap = Math.max(rect.top - statusH, 4);
  const capSide = Math.max(width - (rect.right || width - 7), 7);
  return {
    statusH,
    capTop: rect.top,
    capH: rect.height,
    capSide,
    // 标题两边让出胶囊按钮的宽度，保证居中又不压住胶囊
    titleInset: capSide + (rect.width || 87) + 8,
    navH: rect.top + rect.height + gap,
    coverH: Math.round((width * 450) / 750) + statusH
  };
}

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    image: { type: String, value: '' },
    coverKey: { type: String, value: '' },
    // 顶栏出现后显示的标题
    title: { type: String, value: '' },
    editable: { type: Boolean, value: false },
    back: { type: Boolean, value: false }
  },
  data: { statusH: 20, capTop: 24, capH: 32, capSide: 7, titleInset: 102, navH: 60, coverH: 245, src: '', isPhoto: false, dark: false, solid: false },
  observers: {
    'image, coverKey': function () {
      this.compute(false);
    }
  },
  lifetimes: {
    attached() {
      this.shown = true;
      this.setData(layout());
      this.compute(false);
      // 背景底边滑到顶栏下面 → 顶栏变实
      this.io = this.createIntersectionObserver();
      this.io.relativeToViewport({ top: -this.data.navH }).observe('.pc-sentinel', (res) => this.setSolid(!(res.intersectionRatio > 0)));
    },
    detached() {
      if (this.io) this.io.disconnect();
    }
  },
  pageLifetimes: {
    show() {
      this.shown = true;
      this.front = '';
      this.paint();
    },
    hide() {
      this.shown = false;
    }
  },
  methods: {
    compute(failed) {
      const photo = failed ? '' : format.imageUrl(this.data.image || '');
      const key = format.COVER_KEYS.indexOf(this.data.coverKey) >= 0 ? this.data.coverKey : '';
      this.setData({
        src: photo || (key ? format.coverSrc(key) : ''),
        isPhoto: !!photo,
        dark: !!photo || DARK_KEYS.indexOf(key) >= 0
      });
      this.paint();
    },
    setSolid(solid) {
      if (solid === this.data.solid) return;
      this.setData({ solid });
      this.paint();
    },
    // 状态栏和胶囊按钮：顶栏出现或浅色背景用黑字，照片 / 深色插画用白字
    paint() {
      if (!this.shown) return;
      const front = this.data.solid || !this.data.dark ? '#000000' : '#ffffff';
      if (front === this.front) return;
      this.front = front;
      wx.setNavigationBarColor({ frontColor: front, backgroundColor: '#F1F4F6', fail() {} });
    },
    onImgError() {
      // 照片打不开就退回插画
      if (this.data.isPhoto) this.compute(true);
    },
    onTapCover() {
      if (this.data.editable) {
        this.triggerEvent('change');
        return;
      }
      if (this.data.isPhoto) wx.previewImage({ urls: [this.data.src], current: this.data.src });
    },
    onChange() {
      this.triggerEvent('change');
    },
    goBack() {
      wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/home' }) });
    }
  }
});

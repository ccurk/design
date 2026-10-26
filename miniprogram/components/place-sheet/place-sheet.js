// 选地点：输入框 + 大理常用地点 +「在地图上选」+ 明显的「确定」（docs/changes-v0.3.md I）
const SPOTS = ['古城南门', '古城北门', '人民路', '才村码头', '喜洲古镇', '双廊', '苍山索道'];

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    show: { type: Boolean, value: false },
    title: { type: String, value: '在哪儿集合' },
    value: { type: String, value: '' },
    // { name, address, latitude, longitude } | null
    location: { type: Object, value: null }
  },
  data: { spots: SPOTS, name: '', loc: null, focus: false },
  observers: {
    show(v) {
      if (v) this.setData({ name: this.data.value || '', loc: this.data.location || null });
    }
  },
  methods: {
    onInput(e) {
      this.setData({ name: e.detail.value });
    },
    pickSpot(e) {
      // 常用地点没有坐标，只带名字
      this.setData({ name: e.currentTarget.dataset.name, loc: null });
    },
    openMap() {
      const loc = this.data.loc;
      const opts = {
        success: (res) => {
          const name = res.name || res.address;
          if (!name) return;
          this.setData({ name, loc: { name, address: res.address || '', latitude: res.latitude, longitude: res.longitude } });
        },
        fail: (err) => {
          if (err && err.errMsg && err.errMsg.indexOf('cancel') >= 0) return;
          wx.showToast({ title: '没能打开地图，直接写地点也可以', icon: 'none' });
        }
      };
      if (loc && loc.latitude) Object.assign(opts, { latitude: loc.latitude, longitude: loc.longitude });
      wx.chooseLocation(opts);
    },
    clearLoc() {
      this.setData({ loc: null });
    },
    onConfirm() {
      const name = (this.data.name || '').trim();
      if (!name) return;
      const loc = this.data.loc ? Object.assign({}, this.data.loc, { name }) : null;
      this.triggerEvent('confirm', { name, location: loc });
    },
    onClose() {
      this.triggerEvent('close');
    }
  }
});

// 选图上传：每张显示上传进度，失败可重试，可删、可点开看大图。
// 事件 change：{ urls: 已上传的地址, uploading: 是否还有在传的 }
const upload = require('../../utils/upload');

let seq = 0;

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    max: { type: Number, value: 9 },
    // 每格大小（rpx）
    size: { type: Number, value: 196 },
    addText: { type: String, value: '' },
    // 第一张标「封面」
    cover: { type: Boolean, value: false }
  },
  data: { items: [] },
  methods: {
    emit() {
      const items = this.data.items;
      this.triggerEvent('change', {
        urls: items.filter((i) => i.status === 'done').map((i) => i.url),
        uploading: items.some((i) => i.status === 'uploading')
      });
    },
    index(key) {
      return this.data.items.findIndex((i) => i.key === key);
    },
    patch(key, fields) {
      const i = this.index(key);
      if (i < 0) return;
      const data = {};
      Object.keys(fields).forEach((k) => {
        data['items[' + i + '].' + k] = fields[k];
      });
      this.setData(data);
    },
    add() {
      const left = this.data.max - this.data.items.length;
      if (left <= 0) {
        wx.showToast({ title: '最多 ' + this.data.max + ' 张', icon: 'none' });
        return;
      }
      upload.choose(left).then((paths) => {
        if (!paths.length) return;
        const fresh = paths.slice(0, left).map((path) => ({ key: 'u' + ++seq, path, url: '', progress: 0, status: 'uploading' }));
        this.setData({ items: this.data.items.concat(fresh) }, () => {
          this.emit();
          fresh.forEach((it) => this.send(it.key, it.path));
        });
      });
    },
    send(key, path) {
      this.patch(key, { status: 'uploading', progress: 0 });
      upload
        .uploadOne(path, (p) => this.patch(key, { progress: p }))
        .then((url) => {
          this.patch(key, { url, status: 'done', progress: 100 });
          this.emit();
        })
        .catch((err) => {
          this.patch(key, { status: 'error' });
          this.emit();
          wx.showToast({ title: (err && err.message) || '有一张图片没传上去', icon: 'none' });
        });
    },
    retry(e) {
      const it = this.data.items[this.index(e.currentTarget.dataset.key)];
      if (it) this.send(it.key, it.path);
    },
    remove(e) {
      const key = e.currentTarget.dataset.key;
      this.setData({ items: this.data.items.filter((i) => i.key !== key) }, () => this.emit());
    },
    preview(e) {
      const items = this.data.items;
      const it = items[this.index(e.currentTarget.dataset.key)];
      if (!it) return;
      wx.previewImage({ urls: items.map((i) => i.path), current: it.path });
    }
  }
});

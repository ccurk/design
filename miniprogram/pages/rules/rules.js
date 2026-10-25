// 社区公约与规则（静态）。?section=pact|credit|privacy 打开后滚到对应段落
const SECTIONS = ['pact', 'credit', 'privacy'];

Page({
  onLoad(query) {
    this.section = SECTIONS.indexOf(query.section) >= 0 ? query.section : '';
  },

  onReady() {
    if (this.section && this.section !== 'pact') this.scrollTo(this.section);
  },

  jump(e) {
    this.scrollTo(e.currentTarget.dataset.id);
  },

  scrollTo(id) {
    wx.pageScrollTo({ selector: '#' + id, offsetTop: -12, duration: 250 });
  }
});

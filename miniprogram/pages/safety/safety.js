// 安全设置：同性局、报平安、主页可见、紧急联系人、黑名单、一键 110
const api = require('../../utils/api');
const native = require('../../utils/native');
const session = require('../../utils/session');

function mapContact(c) {
  if (!c || !c.name) return null;
  return { name: c.name, phoneMasked: c.phoneMasked || c.phone || '', initial: String(c.name).slice(0, 1) };
}

Page({
  data: {
    loading: true,
    error: '',
    sameSexOnly: false,
    checkInReminder: true,
    profileOpen: true,
    contact: null,
    editing: false,
    draftName: '',
    draftPhone: '',
    blocked: [],
    showBlocked: false
  },

  onLoad() {
    this.load();
  },

  load() {
    this.setData({ loading: true, error: '' });
    return api
      .safety({ silent: true })
      .then((res) => this.render(res))
      .catch((err) => this.setData({ loading: false, error: err.message }));
  },

  render(res) {
    if (!res) return;
    this.setData({
      loading: false,
      sameSexOnly: !!res.sameSexOnly,
      checkInReminder: res.checkInReminder !== false,
      profileOpen: res.profileOpen !== false,
      contact: mapContact(res.emergencyContact),
      blocked: res.blocked || this.data.blocked
    });
  },

  toggle(e) {
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value;
    if (key === 'sameSexOnly' && value) {
      const me = session.cachedMe();
      if (me && me.gender !== 'female' && me.gender !== 'male') {
        native.confirm({ title: '先填一下性别', content: '同性局需要知道你的性别，只用于匹配，不会公开。', confirmText: '去填写', cancelText: '先不用' }).then((ok) => {
          if (ok) wx.navigateTo({ url: '/pages/edit-profile/edit-profile' });
        });
        return;
      }
    }
    this.setData({ [key]: value });
    api
      .updateSafety({ [key]: value })
      .then((res) => {
        if (res && typeof res === 'object' && key in res) this.render(res);
      })
      .catch(() => this.setData({ [key]: !value }));
  },

  toggleForm() {
    this.setData({ editing: !this.data.editing, draftName: this.data.contact ? this.data.contact.name : '', draftPhone: '' });
  },

  onName(e) {
    this.setData({ draftName: e.detail.value });
  },

  onPhone(e) {
    this.setData({ draftPhone: e.detail.value });
  },

  saveContact() {
    const name = this.data.draftName.trim();
    const phone = this.data.draftPhone.trim();
    if (!name) {
      wx.showToast({ title: '写个称呼，比如：妈妈', icon: 'none' });
      return;
    }
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      wx.showToast({ title: '手机号填 11 位数字', icon: 'none' });
      return;
    }
    api
      .updateSafety({ emergencyContact: { name, phone } })
      .then((res) => {
        this.setData({ editing: false });
        if (res && res.emergencyContact) this.render(res);
        else this.setData({ contact: mapContact({ name, phoneMasked: phone.slice(0, 3) + ' **** ' + phone.slice(-4) }) });
        wx.showToast({ title: '已保存', icon: 'success' });
      })
      .catch(() => {});
  },

  removeContact() {
    native.confirm({ title: '不设紧急联系人了？', content: '报平安没回复时就没人可以联系了。', confirmText: '移除', confirmColor: '#B42318' }).then((ok) => {
      if (!ok) return;
      api
        .updateSafety({ emergencyContact: null })
        .then(() => this.setData({ contact: null, editing: false }))
        .catch(() => {});
    });
  },

  toggleBlocked() {
    this.setData({ showBlocked: !this.data.showBlocked });
  },

  unblock(e) {
    const u = this.data.blocked[e.currentTarget.dataset.index];
    if (!u) return;
    api
      .unblock(u.id)
      .then(() => {
        this.setData({ blocked: this.data.blocked.filter((x) => x.id !== u.id) });
        session.markDirty('feed');
        wx.showToast({ title: '已移出黑名单', icon: 'none' });
      })
      .catch(() => {});
  },

  call110() {
    wx.makePhoneCall({ phoneNumber: '110', fail: () => {} });
  }
});

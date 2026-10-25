// AA 记账：记一笔（我垫付）、谁该转给谁、我已转账 / 确认收到。平台不经手钱。
const api = require('../../utils/api');
const format = require('../../utils/format');
const native = require('../../utils/native');

const STATUS = {
  pending: { text: '待转', cls: 'pill-accent' },
  paid: { text: '等对方确认', cls: 'pill-accent' },
  confirmed: { text: '已结清', cls: 'pill-stone' }
};

Page({
  data: {
    loading: true,
    error: '',
    title: '',
    total: '0',
    each: '0',
    memberCount: 0,
    items: [],
    transfers: [],
    adding: false,
    saving: false,
    name: '',
    amount: ''
  },

  onLoad(query) {
    this.id = Number(query.id);
    if (!this.id) {
      this.setData({ loading: false, error: '链接里缺少局的编号' });
      return;
    }
    api
      .event(this.id, { silent: true })
      .then((ev) => this.setData({ title: format.shortTitle(ev.title) }))
      .catch(() => {});
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    return api
      .aa(this.id)
      .then((res) => this.render(res))
      .catch((err) => this.setData({ loading: false, error: err.message }));
  },

  render(res) {
    const name = (u, role) => (role ? '我' : (u && u.nickname) || '');
    const items = (res.items || []).map((it) => ({
      id: it.id,
      name: it.name,
      mine: !!it.mine,
      payerText: (it.mine ? '我' : (it.payer && it.payer.nickname) || '') + '垫付' + (it.mine ? ' · 点一下可删除' : ''),
      amountText: format.money(it.amount)
    }));
    const transfers = (res.transfers || []).map((t, i) => {
      let action = '';
      if (t.role === 'from' && t.status === 'pending') action = 'pay';
      if (t.role === 'to' && t.status === 'paid') action = 'confirm';
      const st = STATUS[t.status] || STATUS.pending;
      let statusText = st.text;
      if (t.status === 'paid' && t.role !== 'from') statusText = '待确认';
      return {
        key: (t.from && t.from.id) + '-' + (t.to && t.to.id) + '-' + i,
        fromId: t.from && t.from.id,
        toId: t.to && t.to.id,
        fromName: name(t.from, t.role === 'from'),
        toName: name(t.to, t.role === 'to'),
        amountText: format.money(t.amount),
        action,
        statusText,
        pillClass: st.cls
      };
    });
    this.setData({
      loading: false,
      error: '',
      items,
      transfers,
      total: format.money(res.total),
      each: format.money(res.each),
      memberCount: res.memberCount || 0
    });
  },

  startAdd() {
    this.setData({ adding: true, name: '', amount: '' });
  },

  cancelAdd() {
    this.setData({ adding: false });
  },

  onName(e) {
    this.setData({ name: e.detail.value });
  },

  onAmount(e) {
    this.setData({ amount: e.detail.value });
  },

  save() {
    if (this.data.saving) return;
    const amount = Math.round(Number(this.data.amount) * 100) / 100;
    if (!amount || amount <= 0) {
      wx.showToast({ title: '金额要大于 0', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    api
      .addAA(this.id, { name: (this.data.name || '').trim() || '其他花费', amount })
      .then((res) => {
        this.setData({ adding: false });
        if (res && res.items) this.render(res);
        else this.load();
      })
      .catch(() => {})
      .then(() => this.setData({ saving: false }));
  },

  onItem(e) {
    const item = this.data.items[e.currentTarget.dataset.index];
    if (!item || !item.mine) return;
    native.actionSheet(['删除这笔'], { itemColor: '#B42318' }).then((i) => {
      if (i !== 0) return;
      api
        .deleteAA(this.id, item.id)
        .then((res) => {
          if (res && res.items) this.render(res);
          else this.load();
        })
        .catch(() => {});
    });
  },

  pay(e) {
    const t = this.data.transfers[e.currentTarget.dataset.index];
    if (!t) return;
    native.confirm({ title: '已经转给 ' + t.toName + ' 了吗？', content: '在微信里转完 ¥' + t.amountText + ' 再点确认，对方收到后会清账。', confirmText: '已转账' }).then((ok) => {
      if (!ok) return;
      api
        .aaPaid(this.id, t.toId)
        .then((res) => this.render(res))
        .catch(() => {});
    });
  },

  confirmPaid(e) {
    const t = this.data.transfers[e.currentTarget.dataset.index];
    if (!t) return;
    api
      .aaConfirm(this.id, t.fromId)
      .then((res) => {
        wx.showToast({ title: '已确认收到', icon: 'success' });
        this.render(res);
      })
      .catch(() => {});
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/inbox/inbox' }) });
  }
});

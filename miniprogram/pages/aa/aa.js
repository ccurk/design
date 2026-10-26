// AA：每个局只有一笔，由垫钱的人一次记下总花费，其他人按人数平摊转给他（docs/changes-v0.3.md D）。
// 记了就锁定；有人点「我已转账」之前，记账人还能改或撤回。平台不经手钱。
const api = require('../../utils/api');
const format = require('../../utils/format');
const native = require('../../utils/native');

const STATUS = {
  pending: { text: '待转', cls: 'pill-accent' },
  paid: { text: '等确认', cls: 'pill-accent' },
  confirmed: { text: '已结清', cls: 'pill-stone' }
};

Page({
  data: {
    loading: true,
    error: '',
    title: '',
    bill: null,
    total: '0',
    each: '0',
    memberCount: 0,
    transfers: [],
    canDeclare: false,
    settled: false,
    myTodo: '',
    sheet: false,
    editing: false,
    busy: false
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
      .aa(this.id, { silent: true })
      .then((res) => this.render(res))
      .catch((err) => this.setData({ loading: false, error: (err && err.message) || '网络不太好' }));
  },

  retry() {
    this.setData({ loading: true, error: '' });
    this.load();
  },

  render(res) {
    const b = res.bill;
    const bill = b
      ? {
          payer: b.payer,
          payerName: b.mine ? '我' : (b.payer && b.payer.nickname) || '',
          amount: Number(b.amount) || 0,
          amountText: format.money(b.amount),
          note: b.note || '',
          time: format.stamp(b.createdAt),
          mine: !!b.mine,
          editable: !!b.editable
        }
      : null;
    let myTodo = '';
    const transfers = (res.transfers || []).map((t, i) => {
      let action = '';
      if (t.role === 'from' && t.status === 'pending') action = 'pay';
      if (t.role === 'to' && t.status === 'paid') action = 'confirm';
      if (t.role === 'from' && t.status === 'pending') myTodo = '你需要转 ¥' + format.money(t.amount) + ' 给 ' + ((t.to && t.to.nickname) || '记账的人');
      const st = STATUS[t.status] || STATUS.pending;
      let statusText = st.text;
      if (t.status === 'paid' && t.role === 'from') statusText = '等对方确认';
      return {
        key: (t.from && t.from.id) + '-' + (t.to && t.to.id) + '-' + i,
        from: t.from,
        fromId: t.from && t.from.id,
        toId: t.to && t.to.id,
        fromName: t.role === 'from' ? '我' : (t.from && t.from.nickname) || '',
        toName: t.role === 'to' ? '我' : (t.to && t.to.nickname) || '',
        amountText: format.money(t.amount),
        action,
        statusText,
        pillClass: st.cls,
        done: t.status === 'confirmed'
      };
    });
    this.setData({
      loading: false,
      error: '',
      bill,
      transfers,
      total: format.money(res.total),
      each: format.money(res.each),
      memberCount: res.memberCount || 0,
      canDeclare: !!res.canDeclare,
      settled: !!bill && transfers.length > 0 && transfers.every((t) => t.done),
      myTodo
    });
  },

  // 接口返回了新的 AA 视图就直接用，否则重新拉一次
  apply(res) {
    if (res && Object.prototype.hasOwnProperty.call(res, 'transfers')) this.render(res);
    else return this.load();
  },

  openDeclare() {
    if (!this.data.canDeclare) return;
    this.setData({ sheet: true, editing: false });
  },

  openEdit() {
    if (!this.data.bill || !this.data.bill.editable) return;
    this.setData({ sheet: true, editing: true });
  },

  closeSheet() {
    this.setData({ sheet: false });
  },

  onSheetConfirm(e) {
    if (this.data.busy) return;
    const data = { amount: e.detail.amount, note: e.detail.note };
    const editing = this.data.editing;
    this.setData({ busy: true });
    (editing ? api.updateAA(this.id, data) : api.declareAA(this.id, data))
      .then((res) => {
        this.setData({ sheet: false });
        wx.showToast({ title: editing ? '已修改' : '记好了，已通知大家', icon: 'success' });
        return this.apply(res);
      })
      .catch(() => this.load())
      .then(() => this.setData({ busy: false }));
  },

  manage() {
    native.actionSheet(['修改金额或说明', '撤回这笔 AA']).then((i) => {
      if (i === 0) this.openEdit();
      if (i === 1) this.withdraw();
    });
  },

  withdraw() {
    native
      .confirm({ title: '撤回这笔 AA？', content: '撤回后大家不用再转给你，之后可以重新记一笔。', confirmText: '撤回', confirmColor: '#B42318' })
      .then((ok) => {
        if (!ok) return;
        api
          .withdrawAA(this.id)
          .then((res) => {
            wx.showToast({ title: '已撤回', icon: 'success' });
            return this.apply(res);
          })
          .catch(() => this.load());
      });
  },

  pay(e) {
    const t = this.data.transfers[e.currentTarget.dataset.index];
    if (!t) return;
    native.confirm({ title: '已经转给 ' + t.toName + ' 了吗？', content: '在微信里转完 ¥' + t.amountText + ' 再点确认，对方收到后就清账。', confirmText: '已转账' }).then((ok) => {
      if (!ok) return;
      api
        .aaPaid(this.id, t.toId)
        .then((res) => this.apply(res))
        .catch(() => this.load());
    });
  },

  confirmPaid(e) {
    const t = this.data.transfers[e.currentTarget.dataset.index];
    if (!t) return;
    api
      .aaConfirm(this.id, t.fromId)
      .then((res) => {
        wx.showToast({ title: '已确认收到', icon: 'success' });
        return this.apply(res);
      })
      .catch(() => this.load());
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/inbox/inbox' }) });
  }
});

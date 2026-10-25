// 互评：每个人 准时 / 迟到 / 没来（默认准时）+ 整体感受，匿名
const api = require('../../utils/api');
const native = require('../../utils/native');

const OPTIONS = [
  { value: 'on_time', label: '准时', cls: 'on-time' },
  { value: 'late', label: '迟到', cls: 'on-late' },
  { value: 'no_show', label: '没来', cls: 'on-no' }
];
const FEELINGS = ['很放松', '不尴尬', '下次还来', '节奏刚好'];

Page({
  data: {
    loading: true,
    error: '',
    event: null,
    eventSub: '',
    people: [],
    options: OPTIONS,
    feels: FEELINGS.map((label) => ({ label, on: false })),
    submitting: false,
    done: false,
    doneText: ''
  },

  onLoad(query) {
    this.id = Number(query.id);
    if (!this.id) {
      this.setData({ loading: false, error: '链接里缺少局的编号' });
      return;
    }
    api
      .review(this.id)
      .then((res) => {
        const ev = res.event || {};
        if (res.canSubmit === false && !res.submitted) {
          this.setData({
            loading: false,
            error: ev.phase === 'ended' ? '评价已经截止了（局结束后 7 天内可以评价）。' : '局结束后才能评价，到时候会提醒你。'
          });
          return;
        }
        this.setData({
          loading: false,
          event: ev,
          eventSub: [ev.dateLabel, ev.place, ev.memberCount ? ev.memberCount + ' 人' : ''].filter(Boolean).join(' · '),
          people: (res.people || []).map((u) => Object.assign({}, u, { att: 'on_time' })),
          done: !!res.submitted,
          doneText: res.submitted ? '你已经评价过这个局了。大家的信用会按多数人的评价更新。' : ''
        });
      })
      .catch((err) => this.setData({ loading: false, error: err.message }));
  },

  pickAtt(e) {
    const { pi, value } = e.currentTarget.dataset;
    this.setData({ ['people[' + pi + '].att']: value });
  },

  toggleFeel(e) {
    const i = e.currentTarget.dataset.index;
    this.setData({ ['feels[' + i + '].on']: !this.data.feels[i].on });
  },

  submit() {
    if (this.data.submitting) return;
    const absent = this.data.people.filter((p) => p.att === 'no_show').map((p) => p.nickname);
    const go = () => this.send();
    if (!absent.length) {
      go();
      return;
    }
    native
      .confirm({
        title: '确认 ' + absent.join('、') + ' 没来？',
        content: '会按多数人的评价记一次「放鸽子」。只在 TA 真的没来、也没提前说的时候选。',
        confirmText: '确认提交',
        cancelText: '再看看'
      })
      .then((ok) => {
        if (ok) go();
      });
  },

  send() {
    const attendance = {};
    this.data.people.forEach((p) => {
      attendance[String(p.id)] = p.att;
    });
    const feelings = this.data.feels.filter((f) => f.on).map((f) => f.label);
    this.setData({ submitting: true });
    api
      .submitReview(this.id, { attendance, feelings })
      .then(() => this.setData({ done: true, doneText: '大家的信用已经更新，你的履约记录也 +1 局。' }))
      .catch(() => {})
      .then(() => this.setData({ submitting: false }));
  },

  backToMine() {
    const pages = getCurrentPages();
    const prev = pages[pages.length - 2];
    if (prev && prev.route === 'pages/my-events/my-events') wx.navigateBack();
    else wx.redirectTo({ url: '/pages/my-events/my-events?tab=ended' });
  }
});

// 发起一个局（docs/changes-v0.3.md A / C / I）：标签（热门 + 自己添加）、标题、开始时间（精确到分钟）、
// 集合地点（常用地点 / 地图）、最晚退出时间、人数、谁可以报名（女 / 男 / 不限）、费用、介绍 + 最多 9 张照片。
// 时间、地点、标签、性别、退出时间都用自己的底部弹窗。
const api = require('../../utils/api');
const format = require('../../utils/format');
const session = require('../../utils/session');

const FEES = [
  { value: 'aa', label: 'AA' },
  { value: 'free', label: '免费' },
  { value: 'host', label: '我请客' }
];
const PHRASES = ['慢热友好', '新手友好', '不用尬聊', '不喝酒', '自带装备'];
const EXIT_HOURS = [2, 6, 12, 24, 48];
const DEFAULT_EXIT = 24;
// 退出时间至少要比现在晚这么多（填表也要花时间）
const EXIT_MARGIN = 10 * 60 * 1000;

function genderLimitOf(g) {
  if (g.female && g.male) return 'any';
  return g.female ? 'female' : 'male';
}

Page({
  data: {
    fees: FEES,
    phrases: PHRASES,
    hotTags: [],
    tag: '',
    customTag: '',
    tagShow: false,
    title: '',
    titleHint: '',
    startAt: '',
    startText: '',
    timeShow: false,
    place: '',
    location: null,
    placeShow: false,
    exitHours: DEFAULT_EXIT,
    exitOptions: [],
    exitText: '',
    exitShow: false,
    exitPick: DEFAULT_EXIT,
    capacity: 5,
    myGender: '',
    genderText: '不限',
    genders: { female: true, male: true },
    genderPick: { female: true, male: true },
    genderShow: false,
    feeType: 'aa',
    feeEstimate: '',
    requireApproval: false,
    description: '',
    images: [],
    uploading: false,
    submitting: false,
    published: false,
    doneText: ''
  },

  onLoad(query) {
    session.loadHotTags().then((tags) => {
      const patch = { hotTags: tags };
      // 从首页 / 广场带了标签过来
      const want = query && query.tag ? decodeURIComponent(query.tag) : '';
      if (want) {
        patch.tag = want;
        if (!tags.some((t) => t.name === want)) patch.customTag = want;
      }
      this.setData(patch, () => this.suggestTitle());
    });
    session
      .loadMe()
      .then((me) => this.setData({ myGender: me && (me.gender === 'female' || me.gender === 'male') ? me.gender : '' }))
      .catch(() => {});
  },

  onShow() {
    // 从「编辑资料」回来时，性别可能刚填上
    if (this.wentProfile) {
      this.wentProfile = false;
      session
        .loadMe(true)
        .then((me) => this.setData({ myGender: me && (me.gender === 'female' || me.gender === 'male') ? me.gender : '' }))
        .catch(() => {});
    }
  },

  // ===== 标签 =====
  pickTag(e) {
    this.setData({ tag: e.currentTarget.dataset.name }, () => this.suggestTitle());
  },

  openTagSheet() {
    this.setData({ tagShow: true });
  },

  closeTagSheet() {
    this.setData({ tagShow: false });
  },

  onTagSheet(e) {
    const { name } = e.detail;
    const isHot = this.data.hotTags.some((t) => t.name === name);
    this.setData({ tag: name, customTag: isHot ? this.data.customTag : name, tagShow: false }, () => this.suggestTitle());
  },

  // ===== 标题 =====
  onTitle(e) {
    this.setData({ title: e.detail.value });
  },

  // 「周六清晨 · 看日出」
  suggestTitle() {
    const { tag, startAt } = this.data;
    let hint = '';
    if (tag && startAt) hint = format.dayWord(startAt) + format.daypart(startAt) + ' · ' + tag;
    else if (tag) hint = '一起' + tag;
    this.setData({ titleHint: hint });
  },

  useHint() {
    if (this.data.titleHint) this.setData({ title: this.data.titleHint });
  },

  // ===== 时间 =====
  openTime() {
    this.setData({ timeShow: true });
  },

  closeTime() {
    this.setData({ timeShow: false });
  },

  onTime(e) {
    this.setData({ startAt: e.detail.iso, startText: e.detail.label, timeShow: false }, () => {
      this.buildExit();
      this.suggestTitle();
    });
  },

  // ===== 地点 =====
  openPlace() {
    this.setData({ placeShow: true });
  },

  closePlace() {
    this.setData({ placeShow: false });
  },

  onPlace(e) {
    this.setData({ place: e.detail.name, location: e.detail.location || null, placeShow: false });
  },

  // ===== 最晚退出时间：开始前 2 / 6 / 12 / 24 / 48 小时，已经过去的不能选 =====
  buildExit(keep) {
    const start = new Date(this.data.startAt).getTime();
    if (!start) return;
    const now = Date.now();
    const exitOptions = EXIT_HOURS.map((h) => {
      const t = start - h * 3600000;
      return { hours: h, label: '开始前 ' + h + ' 小时', time: format.mdhm(new Date(t).toISOString()), off: t <= now + EXIT_MARGIN };
    });
    let hours = keep || this.data.exitHours;
    const cur = exitOptions.filter((o) => o.hours === hours)[0];
    if (!cur || cur.off) {
      // 默认 24 小时；来不及就取还来得及的最长一档；都来不及就交给服务端（发布后 30 分钟）
      const ok = exitOptions.filter((o) => !o.off && o.hours <= DEFAULT_EXIT);
      hours = ok.length ? ok[ok.length - 1].hours : 0;
    }
    this.setData({ exitOptions, exitHours: hours, exitText: this.exitLabel(hours, exitOptions) });
  },

  exitLabel(hours, options) {
    if (!hours) return '发布后 30 分钟内可以退出';
    const o = (options || this.data.exitOptions).filter((x) => x.hours === hours)[0];
    return o ? o.label + '（' + o.time + '）' : '';
  },

  openExit() {
    if (!this.data.startAt) {
      wx.showToast({ title: '先选开始时间', icon: 'none' });
      return;
    }
    this.buildExit();
    this.setData({ exitShow: true, exitPick: this.data.exitHours });
  },

  closeExit() {
    this.setData({ exitShow: false });
  },

  pickExit(e) {
    const { hours, off } = e.currentTarget.dataset;
    if (off) {
      wx.showToast({ title: '这个时间已经过了', icon: 'none' });
      return;
    }
    this.setData({ exitPick: hours });
  },

  confirmExit() {
    const hours = this.data.exitPick;
    this.setData({ exitShow: false, exitHours: hours, exitText: this.exitLabel(hours) });
  },

  // ===== 人数 =====
  dec() {
    if (this.data.capacity > 2) this.setData({ capacity: this.data.capacity - 1 });
  },

  inc() {
    if (this.data.capacity < 20) this.setData({ capacity: this.data.capacity + 1 });
  },

  // ===== 谁可以报名：女 / 男 多选，都选 = 不限；发起人自己必须在内 =====
  openGender() {
    this.setData({ genderShow: true, genderPick: Object.assign({}, this.data.genders) });
  },

  closeGender() {
    this.setData({ genderShow: false });
  },

  toggleGender(e) {
    const g = e.currentTarget.dataset.g;
    const me = this.data.myGender;
    const pick = Object.assign({}, this.data.genderPick);
    if (g === 'any') {
      this.setData({ genderPick: { female: true, male: true } });
      return;
    }
    if (!me) {
      wx.showToast({ title: '先在资料里选性别，才能限制', icon: 'none' });
      return;
    }
    if (g === me) {
      wx.showToast({ title: '发起人自己也要能参加', icon: 'none' });
      return;
    }
    pick[g] = !pick[g];
    this.setData({ genderPick: pick });
  },

  confirmGender() {
    const g = this.data.genderPick;
    const limit = genderLimitOf(g);
    this.setData({ genderShow: false, genders: g, genderText: format.GENDER_LIMIT[limit] });
  },

  goProfile() {
    this.wentProfile = true;
    this.setData({ genderShow: false });
    wx.navigateTo({ url: '/pages/edit-profile/edit-profile' });
  },

  // ===== 费用、开关 =====
  pickFee(e) {
    this.setData({ feeType: e.currentTarget.dataset.value });
  },

  onFee(e) {
    this.setData({ feeEstimate: e.detail.value });
  },

  toggleApproval(e) {
    this.setData({ requireApproval: e.detail.value });
  },

  // ===== 介绍 + 照片 =====
  onDesc(e) {
    this.setData({ description: e.detail.value });
  },

  addPhrase(e) {
    const word = e.currentTarget.dataset.word;
    const cur = this.data.description;
    if (cur.indexOf(word) >= 0) return;
    const next = cur.trim() ? cur.replace(/[，,。\s]*$/, '') + '，' + word : word;
    if (next.length > 300) {
      wx.showToast({ title: '介绍最多 300 字', icon: 'none' });
      return;
    }
    this.setData({ description: next });
  },

  onImages(e) {
    this.setData({ images: e.detail.urls, uploading: e.detail.uploading });
  },

  // ===== 发布 =====
  publish() {
    if (this.data.submitting) return;
    const d = this.data;
    const title = d.title.trim();
    if (!d.tag) return this.hint('选一个标签');
    if (!title) return this.hint('先写个标题');
    if (!d.startAt) return this.hint('选一下开始时间');
    if (new Date(d.startAt).getTime() < Date.now() + 30 * 60 * 1000) return this.hint('开始时间要晚于现在半小时以上');
    if (!d.place) return this.hint('选一下集合地点');
    if (d.uploading) return this.hint('照片还在上传，稍等一下');
    let feeEstimate;
    if (d.feeType === 'aa' && d.feeEstimate !== '') {
      feeEstimate = Math.round(Number(d.feeEstimate) * 100) / 100;
      if (!(feeEstimate >= 0)) return this.hint('每人费用填个数字就好');
    }
    // 退出时间可能在填表时过期，发布前再算一次
    this.buildExit(d.exitHours);
    const exitHours = this.data.exitHours;
    const body = {
      title,
      tag: d.tag,
      startAt: d.startAt,
      place: d.place,
      capacity: d.capacity,
      feeType: d.feeType,
      requireApproval: d.requireApproval,
      genderLimit: genderLimitOf(d.genders),
      images: d.images
    };
    if (d.location) body.location = d.location;
    if (exitHours) body.exitDeadline = new Date(new Date(d.startAt).getTime() - exitHours * 3600000).toISOString();
    if (feeEstimate !== undefined) body.feeEstimate = feeEstimate;
    if (d.description.trim()) body.description = d.description.trim();

    this.setData({ submitting: true });
    api
      .createEvent(body)
      .then((ev) => {
        this.eventId = ev.id;
        session.markDirty('square');
        this.setData({
          published: true,
          doneText:
            ev.status === 'pending_review'
              ? '审核通过后，大家就能在广场看到。人齐了会自动建群，并通知你。'
              : '已经出现在广场上了。人齐了会自动建群，并通知你。'
        });
        wx.setNavigationBarTitle({ title: '发布成功' });
      })
      .catch(() => {})
      .then(() => this.setData({ submitting: false }));
    return null;
  },

  hint(text) {
    wx.showToast({ title: text, icon: 'none' });
    return null;
  },

  openEvent() {
    if (this.eventId) wx.redirectTo({ url: '/pages/detail/detail?id=' + this.eventId });
    else this.openMine();
  },

  openMine() {
    wx.redirectTo({ url: '/pages/my-events/my-events?tab=created' });
  },

  goSquare() {
    wx.switchTab({ url: '/pages/square/square' });
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' });
  },

  onShareAppMessage() {
    if (this.eventId) return { title: this.data.title, path: '/pages/detail/detail?id=' + this.eventId };
    return { title: '在大理，找个搭子一起玩', path: '/pages/home/home' };
  }
});

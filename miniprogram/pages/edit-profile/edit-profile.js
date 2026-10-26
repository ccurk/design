// 编辑资料：头像、主页背景（选图上传）、昵称、简介、兴趣、社交节奏、性别。昵称 / 简介会过内容审核。
const api = require('../../utils/api');
const format = require('../../utils/format');
const session = require('../../utils/session');
const upload = require('../../utils/upload');

const TAGS = ['看日出', '爬山', '骑行', '咖啡', '读书', '拍照', '吃饭', '桌游', '电影', '瑜伽', '拼车', '随便走走'];
const MAX_PICK = 12; // 服务端上限
const PACES = [
  { value: 'slow', label: '比较慢热' },
  { value: 'warm', label: '熟了就话多' },
  { value: 'open', label: '随时都能聊' }
];
const GENDERS = [
  { value: 'female', label: '女' },
  { value: 'male', label: '男' },
  { value: 'unknown', label: '不填' }
];

Page({
  data: {
    loading: true,
    preview: null,
    avatarUrl: null,
    coverUrl: null,
    coverChanged: false,
    coverSrc: '',
    coverNote: '',
    nickname: '',
    bio: '',
    tags: [],
    paces: PACES,
    pace: 'slow',
    genders: GENDERS,
    gender: 'unknown',
    saving: false
  },

  onLoad() {
    session.loadHotTags().then((tags) => {
      this.hotTags = tags;
      this.refreshCover();
    });
    session
      .loadMe(true)
      .then((me) => {
        const picked = me.interests || [];
        const extra = picked.filter((t) => TAGS.indexOf(t) < 0);
        // 服务端按已保存的第一个兴趣算好的插画，第一个兴趣没变时直接用
        this.savedFirst = picked[0] || '';
        this.savedKey = me.coverKey || '';
        this.setData({
          loading: false,
          preview: me,
          avatarUrl: me.avatarUrl || null,
          coverUrl: me.coverUrl || null,
          nickname: me.nickname || '',
          bio: me.bio || '',
          tags: TAGS.concat(extra).map((label) => ({ label, on: picked.indexOf(label) >= 0 })),
          pace: me.pace || 'slow',
          gender: me.gender || 'unknown'
        });
        this.refreshCover();
      })
      .catch(() => {
        this.setData({ loading: false, preview: {}, tags: TAGS.map((label) => ({ label, on: false })) });
        this.refreshCover();
      });
  },

  // 背景预览：上传的照片；没有就是第一个兴趣对应的插画（和服务端同一个规则，没选兴趣是洱海）
  refreshCover() {
    if (this.data.coverUrl) {
      this.setData({ coverSrc: format.imageUrl(this.data.coverUrl), coverNote: '用的是你上传的照片' });
      return;
    }
    const first = (this.data.tags.filter((t) => t.on)[0] || {}).label || '';
    let key = 'lake';
    if (first) key = first === this.savedFirst && this.savedKey ? this.savedKey : format.tagCover(first, this.hotTags, 'outdoor');
    this.setData({
      coverSrc: format.coverSrc(key),
      coverNote: first ? '默认用第一个兴趣「' + first + '」的插画' : '默认是洱海插画，选了兴趣会换成对应的'
    });
  },

  changeCover() {
    upload.pickCover(!!this.data.coverUrl).then((res) => {
      if (!res) return;
      this.setData({ coverUrl: res.reset ? null : res.url, coverChanged: true });
      this.refreshCover();
    });
  },

  changeAvatar() {
    upload.pickAndUpload(1).then((list) => {
      if (!list.length) return;
      const url = list[0].url;
      this.setData({ avatarUrl: url, preview: Object.assign({}, this.data.preview, { avatarUrl: url }) });
    });
  },

  onNickname(e) {
    this.setData({ nickname: e.detail.value });
  },

  onBio(e) {
    this.setData({ bio: e.detail.value });
  },

  toggleTag(e) {
    const i = e.currentTarget.dataset.index;
    const on = !this.data.tags[i].on;
    if (on && this.data.tags.filter((t) => t.on).length >= MAX_PICK) {
      wx.showToast({ title: '最多选 ' + MAX_PICK + ' 个', icon: 'none' });
      return;
    }
    this.setData({ ['tags[' + i + '].on']: on });
    this.refreshCover();
  },

  pickPace(e) {
    this.setData({ pace: e.currentTarget.dataset.value });
  },

  pickGender(e) {
    this.setData({ gender: e.currentTarget.dataset.value });
  },

  save() {
    if (this.data.saving) return;
    const nickname = this.data.nickname.trim();
    if (!nickname) {
      wx.showToast({ title: '昵称不能空着', icon: 'none' });
      return;
    }
    const body = {
      nickname,
      bio: this.data.bio.trim(),
      gender: this.data.gender,
      pace: this.data.pace,
      interests: this.data.tags.filter((t) => t.on).map((t) => t.label)
    };
    if (this.data.avatarUrl) body.avatarUrl = this.data.avatarUrl;
    if (this.data.coverChanged) body.coverUrl = this.data.coverUrl;
    this.setData({ saving: true });
    api
      .updateMe(body)
      .then((me) => {
        session.setMe(me);
        wx.showToast({ title: '已保存', icon: 'success' });
        setTimeout(() => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/me/me' }) }), 600);
      })
      .catch(() => {}) // 审核不通过时 toast 服务端的提示
      .then(() => this.setData({ saving: false }));
  }
});

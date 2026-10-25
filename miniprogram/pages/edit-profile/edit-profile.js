// 编辑资料：头像（选图上传）、昵称、简介、兴趣、社交节奏、性别。昵称 / 简介会过内容审核。
const api = require('../../utils/api');
const session = require('../../utils/session');
const upload = require('../../utils/upload');

const TAGS = ['看日出', '爬山', '骑行', '咖啡', '读书', '拍照', '吃饭', '桌游', '电影', '瑜伽', '拼车', '随便走走'];
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
    session
      .loadMe(true)
      .then((me) => {
        const picked = me.interests || [];
        const extra = picked.filter((t) => TAGS.indexOf(t) < 0);
        this.setData({
          loading: false,
          preview: me,
          avatarUrl: me.avatarUrl || null,
          nickname: me.nickname || '',
          bio: me.bio || '',
          tags: TAGS.concat(extra).map((label) => ({ label, on: picked.indexOf(label) >= 0 })),
          pace: me.pace || 'slow',
          gender: me.gender || 'unknown'
        });
      })
      .catch(() => this.setData({ loading: false, preview: {}, tags: TAGS.map((label) => ({ label, on: false })) }));
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
    this.setData({ ['tags[' + i + '].on']: !this.data.tags[i].on });
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

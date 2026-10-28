// 所有接口集中在这里，路径与 docs/api.md、docs/changes-v0.3.md 对应（tools/check.js 会核对）。
const { get, post, put, del } = require('./request');

const q = (params) => {
  const out = {};
  Object.keys(params || {}).forEach((k) => {
    if (params[k] !== undefined && params[k] !== null && params[k] !== '') out[k] = params[k];
  });
  return out;
};

module.exports = {
  // 4.1 登录与资料
  verifyPhone: (code) => post('/api/auth/phone', { code }),
  me: (opts) => get('/api/me', {}, opts),
  updateMe: (data) => put('/api/me', data),
  safety: (opts) => get('/api/me/safety', {}, opts),
  updateSafety: (data) => put('/api/me/safety', data),
  creditEvents: () => get('/api/me/credit-events'),
  appeal: (id, text) => post(`/api/credit-events/${id}/appeal`, { text }),
  leaderStatus: (opts) => get('/api/leader-application', {}, opts),
  applyLeader: (data) => post('/api/leader-application', data),

  // 4.2 他人主页、拉黑、不看
  user: (id, opts) => get(`/api/users/${id}`, {}, opts),
  block: (userId) => post(`/api/blocks/${userId}`),
  unblock: (userId) => del(`/api/blocks/${userId}`),
  muteUser: (userId) => post(`/api/mutes/${userId}`),

  // v0.3 首页与标签
  home: (opts) => get('/api/home', {}, opts),
  hotTags: (opts) => get('/api/tags/hot', {}, opts),
  bannerDetail: (id, opts) => get(`/api/banners/${id}`, {}, opts), // 轮播广告落地页
  bannerClick: (id) => post(`/api/banners/${id}/click`), // 记一次点击

  // 4.3 撮合意向与撮合结果。createIntent：{task, when, slot} 或 {task, when, timeFrom, timeTo}
  createIntent: (data, opts) => post('/api/intents', data, opts),
  myIntents: (opts) => get('/api/intents/mine', {}, opts),
  intent: (id, opts) => get(`/api/intents/${id}`, {}, opts),
  updateIntent: (id, data) => put(`/api/intents/${id}`, data),
  cancelIntent: (id) => del(`/api/intents/${id}`),
  match: (eventId, opts) => get(`/api/matches/${eventId}`, {}, opts),
  acceptMatch: (eventId, opts) => post(`/api/matches/${eventId}/accept`, {}, opts),
  declineMatch: (eventId) => post(`/api/matches/${eventId}/decline`),

  // 4.4 局
  events: (params, opts) => get('/api/events', q(params), opts),
  eventRanking: (opts) => get('/api/events/ranking', {}, opts), // 本周人气榜
  event: (id, opts) => get(`/api/events/${id}`, {}, opts),
  createEvent: (data, opts) => post('/api/events', data, opts),
  join: (id, body, opts) => post(`/api/events/${id}/join`, body || {}, opts),
  leave: (id) => post(`/api/events/${id}/leave`),
  cancelEvent: (id) => post(`/api/events/${id}/cancel`),
  applications: (id) => get(`/api/events/${id}/applications`, {}, { silent: true }),
  approve: (id, userId) => post(`/api/events/${id}/applications/${userId}/approve`),
  reject: (id, userId) => post(`/api/events/${id}/applications/${userId}/reject`),
  attendance: (id, going) => post(`/api/events/${id}/attendance`, { going }),
  arrive: (id) => post(`/api/events/${id}/arrive`),
  safe: (id) => post(`/api/events/${id}/safe`),
  myEvents: (tab, opts) => get('/api/events/mine', { tab }, opts),
  search: (keyword) => get('/api/search', { q: keyword }),
  hotTerms: () => get('/api/search/hot', {}, { silent: true }),

  // 4.5 群聊、局信息、AA
  messages: (id, after, opts) => get(`/api/events/${id}/messages`, after ? { after } : {}, opts),
  sendMessage: (id, text) => post(`/api/events/${id}/messages`, { text }),
  nextIcebreaker: (id) => post(`/api/events/${id}/icebreaker/next`),
  eventInfo: (id, opts) => get(`/api/events/${id}/info`, {}, opts),
  muteEvent: (id, muted) => put(`/api/events/${id}/mute`, { muted }),
  // v0.3 AA：每个局只有一笔，由垫钱的人一次声明
  aa: (id, opts) => get(`/api/events/${id}/aa`, {}, opts),
  declareAA: (id, data) => post(`/api/events/${id}/aa`, data),
  updateAA: (id, data) => put(`/api/events/${id}/aa`, data),
  withdrawAA: (id) => del(`/api/events/${id}/aa`),
  aaPaid: (id, toUserId) => post(`/api/events/${id}/aa/paid`, { toUserId }),
  aaConfirm: (id, fromUserId) => post(`/api/events/${id}/aa/confirm`, { fromUserId }),

  // 4.6 互评
  review: (id, opts) => get(`/api/events/${id}/review`, {}, opts),
  submitReview: (id, data) => post(`/api/events/${id}/reviews`, data),

  // 4.7 动态
  posts: (cursor, opts) => get('/api/posts', q({ cursor }), opts),
  post: (id, opts) => get(`/api/posts/${id}`, {}, opts),
  createPost: (data) => post('/api/posts', data),
  deletePost: (id) => del(`/api/posts/${id}`),
  like: (id) => post(`/api/posts/${id}/like`),
  unlike: (id) => del(`/api/posts/${id}/like`),
  comment: (id, data) => post(`/api/posts/${id}/comments`, data),

  // 4.8 举报、消息中心（上传见 utils/upload.js）
  report: (data) => post('/api/reports', data),
  inbox: (opts) => get('/api/inbox', {}, opts),
  readNotice: (id) => post(`/api/notices/${id}/read`, {}, { silent: true })
};

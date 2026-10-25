// 所有接口集中在这里，路径与 docs/api.md 一一对应（tools/check.js 会核对）。
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
  safety: () => get('/api/me/safety'),
  updateSafety: (data) => put('/api/me/safety', data),
  creditEvents: () => get('/api/me/credit-events'),
  appeal: (id, text) => post(`/api/credit-events/${id}/appeal`, { text }),

  // 4.2 他人主页、拉黑、不看
  user: (id) => get(`/api/users/${id}`),
  block: (userId) => post(`/api/blocks/${userId}`),
  unblock: (userId) => del(`/api/blocks/${userId}`),
  muteUser: (userId) => post(`/api/mutes/${userId}`),

  // 4.3 撮合意向与撮合结果
  createIntent: (data) => post('/api/intents', data),
  myIntents: (opts) => get('/api/intents/mine', {}, opts),
  intent: (id, opts) => get(`/api/intents/${id}`, {}, opts),
  updateIntent: (id, data) => put(`/api/intents/${id}`, data),
  cancelIntent: (id) => del(`/api/intents/${id}`),
  match: (eventId) => get(`/api/matches/${eventId}`),
  acceptMatch: (eventId) => post(`/api/matches/${eventId}/accept`),
  declineMatch: (eventId) => post(`/api/matches/${eventId}/decline`),

  // 4.4 局
  events: (params) => get('/api/events', q(params)),
  event: (id, opts) => get(`/api/events/${id}`, {}, opts),
  createEvent: (data) => post('/api/events', data),
  join: (id) => post(`/api/events/${id}/join`),
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
  eventInfo: (id) => get(`/api/events/${id}/info`),
  muteEvent: (id, muted) => put(`/api/events/${id}/mute`, { muted }),
  aa: (id) => get(`/api/events/${id}/aa`),
  addAA: (id, data) => post(`/api/events/${id}/aa/items`, data),
  deleteAA: (id, itemId) => del(`/api/events/${id}/aa/items/${itemId}`),
  aaPaid: (id, toUserId) => post(`/api/events/${id}/aa/paid`, { toUserId }),
  aaConfirm: (id, fromUserId) => post(`/api/events/${id}/aa/confirm`, { fromUserId }),

  // 4.6 互评
  review: (id) => get(`/api/events/${id}/review`),
  submitReview: (id, data) => post(`/api/events/${id}/reviews`, data),

  // 4.7 动态
  posts: (cursor) => get('/api/posts', q({ cursor })),
  post: (id) => get(`/api/posts/${id}`),
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

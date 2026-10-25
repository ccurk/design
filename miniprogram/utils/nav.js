// 页面跳转：tab 页自动用 switchTab，页面栈满了退回 redirectTo。
const TABS = ['/pages/home/home', '/pages/square/square', '/pages/feed/feed', '/pages/inbox/inbox', '/pages/me/me'];

function isTab(url) {
  return TABS.indexOf(String(url).split('?')[0]) >= 0;
}

function go(url) {
  if (!url) return;
  if (isTab(url)) {
    wx.switchTab({ url: url.split('?')[0] });
    return;
  }
  wx.navigateTo({
    url,
    fail: () => wx.redirectTo({ url })
  });
}

// 返回上一页；没有上一页（比如从分享卡片进来）就回到指定 tab
function back(fallback) {
  if (getCurrentPages().length > 1) wx.navigateBack();
  else wx.switchTab({ url: fallback || '/pages/home/home' });
}

// WXML 里 data-url="..." 的通用点击处理
function onTap(e) {
  const url = e.currentTarget.dataset.url;
  go(url);
}

// 通知里的 link（见 server/src/services/notices.js）：match:<eventId>、event:<eventId>、chat:<eventId>、
// review:<eventId>、post:<postId>、credit；也兼容 /pages/... 路径
function openLink(link) {
  if (!link) return false;
  const s = String(link).trim();
  if (s.indexOf('/pages/') === 0) {
    go(s);
    return true;
  }
  // 「我的信用记录」在「我的」页里展开
  if (s === 'credit') {
    getApp().globalData.openCredit = true;
    wx.switchTab({ url: '/pages/me/me' });
    return true;
  }
  const m = s.match(/^\/?([a-z-]+)[:/](\d+)/i);
  if (!m) return false;
  const id = m[2];
  const map = {
    match: '/pages/match/match?eventId=' + id,
    matches: '/pages/match/match?eventId=' + id,
    event: '/pages/detail/detail?id=' + id,
    events: '/pages/detail/detail?id=' + id,
    group: '/pages/group/group?id=' + id,
    chat: '/pages/group/group?id=' + id,
    review: '/pages/review/review?id=' + id,
    intent: '/pages/waiting/waiting?id=' + id,
    intents: '/pages/waiting/waiting?id=' + id,
    post: '/pages/post/post?id=' + id,
    posts: '/pages/post/post?id=' + id,
    user: '/pages/user/user?id=' + id,
    users: '/pages/user/user?id=' + id
  };
  const url = map[m[1].toLowerCase()];
  if (!url) return false;
  go(url);
  return true;
}

// 自定义 tabBar 选中态
function setTab(page, index) {
  if (typeof page.getTabBar === 'function' && page.getTabBar()) {
    page.getTabBar().setData({ selected: index });
  }
}

module.exports = { TABS, isTab, go, back, onTap, openLink, setTab };

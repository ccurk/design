// 当前登录用户（Me）的缓存。
const api = require('./api');
const format = require('./format');
const request = require('./request');

let mePromise = null;

function app() {
  return getApp() || { globalData: {} };
}

function setMe(me) {
  if (!me) return;
  app().globalData.me = me;
  mePromise = Promise.resolve(me);
}

function loadMe(force) {
  if (force || !mePromise) {
    mePromise = api.me().then(
      (me) => {
        app().globalData.me = me;
        return me;
      },
      (err) => {
        mePromise = null;
        throw err;
      }
    );
  }
  return mePromise;
}

function cachedMe() {
  return app().globalData.me || null;
}

function myId() {
  const me = cachedMe();
  return me ? me.id : null;
}

// 登录接口返回的 user 直接作为缓存
request.onLogin((data) => {
  if (data && data.user) setMe(data.user);
});

// 热门标签（后台维护），10 分钟内复用
let tagsPromise = null;
let tagsAt = 0;
function loadHotTags(force) {
  if (force || !tagsPromise || Date.now() - tagsAt > 10 * 60 * 1000) {
    tagsAt = Date.now();
    tagsPromise = api.hotTags({ silent: true }).then(
      (res) => (res && res.items && res.items.length ? res.items : format.DEFAULT_TAGS),
      () => {
        tagsPromise = null;
        return format.DEFAULT_TAGS;
      }
    );
  }
  return tagsPromise;
}

// 标记某个列表需要刷新（例如发了动态后回到动态页）
function markDirty(key) {
  const g = app().globalData;
  g.dirty = g.dirty || {};
  g.dirty[key] = true;
}

function takeDirty(key) {
  const g = app().globalData;
  if (g.dirty && g.dirty[key]) {
    g.dirty[key] = false;
    return true;
  }
  return false;
}

module.exports = { loadMe, setMe, cachedMe, myId, markDirty, takeDirty, loadHotTags };

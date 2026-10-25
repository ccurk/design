// 原生能力的小封装：订阅消息、选位置（带文字兜底）、确认框、输入框。
const config = require('../config');

// 订阅消息。必须在点击回调里同步调用。没配模板 id 时只提示「已开启」。
function subscribe(keys, opts) {
  const options = opts || {};
  const ids = (keys || []).map((k) => config.subscribeTemplates[k]).filter(Boolean);
  return new Promise((resolve) => {
    if (!ids.length) {
      if (!options.silent) wx.showToast({ title: '已开启', icon: 'success' });
      resolve(true);
      return;
    }
    wx.requestSubscribeMessage({
      tmplIds: ids,
      success: (res) => {
        const ok = ids.some((id) => res[id] === 'accept');
        if (!options.silent) wx.showToast({ title: ok ? '已开启' : '没有开启提醒', icon: ok ? 'success' : 'none' });
        resolve(ok);
      },
      fail: () => {
        if (!options.silent) wx.showToast({ title: '没能开启提醒', icon: 'none' });
        resolve(false);
      }
    });
  });
}

function confirm(options) {
  return new Promise((resolve) => {
    wx.showModal(
      Object.assign(
        {
          confirmColor: '#193543',
          cancelColor: '#5B5F68',
          success: (res) => resolve(!!res.confirm),
          fail: () => resolve(false)
        },
        options
      )
    );
  });
}

// 带输入框的弹窗；返回输入的文字，取消返回 null
function prompt(options) {
  return new Promise((resolve) => {
    wx.showModal(
      Object.assign(
        {
          editable: true,
          confirmColor: '#193543',
          cancelColor: '#5B5F68',
          success: (res) => resolve(res.confirm ? String(res.content || '').trim() : null),
          fail: () => resolve(null)
        },
        options
      )
    );
  });
}

// 选位置：优先 wx.chooseLocation，打不开时退回文字输入。返回 { name, address } 或 null
function pickPlace(current) {
  return new Promise((resolve) => {
    wx.chooseLocation({
      success: (res) => {
        const name = res.name || res.address;
        resolve(name ? { name, address: res.address || '' } : null);
      },
      fail: (err) => {
        if (err && err.errMsg && err.errMsg.indexOf('cancel') >= 0) {
          resolve(null);
          return;
        }
        prompt({ title: '写下地点', placeholderText: '比如：大理古城南门', content: current || '' }).then((text) =>
          resolve(text ? { name: text, address: '' } : null)
        );
      }
    });
  });
}

function actionSheet(itemList, opts) {
  return new Promise((resolve) => {
    wx.showActionSheet(
      Object.assign(
        {
          itemList,
          itemColor: '#15171C',
          success: (res) => resolve(res.tapIndex),
          fail: () => resolve(-1)
        },
        opts || {}
      )
    );
  });
}

module.exports = { subscribe, confirm, prompt, pickPlace, actionSheet };

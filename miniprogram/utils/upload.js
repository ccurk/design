// 选图 + 上传到 /api/upload（multipart，字段名 file，≤ 5MB）。返回服务端 url 列表。
const config = require('../config');
const request = require('./request');

function uploadOne(filePath, retried) {
  return request.ensureLogin().then(
    () =>
      new Promise((resolve, reject) => {
        wx.uploadFile({
          url: config.baseURL + '/api/upload',
          filePath,
          name: 'file',
          header: { Authorization: 'Bearer ' + request.getToken() },
          success: (res) => {
            let body = null;
            try {
              body = JSON.parse(res.data);
            } catch (e) {
              body = null;
            }
            if (res.statusCode === 401 && !retried) {
              request.setToken('');
              request.login().then(() => uploadOne(filePath, true)).then(resolve, reject);
              return;
            }
            if (res.statusCode === 200 && body && body.url) resolve(body.url);
            else reject(request.makeError((body && body.error && body.error.code) || 'UPLOAD', (body && body.error && body.error.message) || '图片上传失败'));
          },
          fail: () => reject(request.makeError('NETWORK', '图片上传失败，检查一下网络'))
        });
      })
  );
}

function choose(count) {
  return new Promise((resolve) => {
    wx.chooseMedia({
      count: Math.max(1, count),
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => resolve((res.tempFiles || []).map((f) => f.tempFilePath)),
      fail: (err) => {
        if (err && err.errMsg && err.errMsg.indexOf('cancel') < 0) {
          wx.showToast({ title: '没能打开相册', icon: 'none' });
        }
        resolve([]);
      }
    });
  });
}

// 选 count 张图并逐张上传；返回 [{ path: 本地临时路径, url: 服务端地址 }]
function pickAndUpload(count) {
  return choose(count).then((paths) => {
    if (!paths.length) return [];
    wx.showLoading({ title: '上传中', mask: true });
    const results = [];
    let chain = Promise.resolve();
    paths.forEach((p) => {
      chain = chain.then(() => uploadOne(p).then((url) => results.push({ path: p, url })));
    });
    return chain.then(
      () => {
        wx.hideLoading();
        return results;
      },
      (err) => {
        wx.hideLoading();
        wx.showToast({ title: err.message || '图片上传失败', icon: 'none' });
        return results;
      }
    );
  });
}

module.exports = { pickAndUpload, uploadOne };

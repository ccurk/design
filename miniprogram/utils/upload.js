// 选图 + 上传到 /api/upload（multipart，字段名 file，≤ 5MB）。返回服务端 url 列表。
const config = require('../config');
const request = require('./request');

// onProgress(0–100) 可选
function uploadOne(filePath, onProgress, retried) {
  return request.ensureLogin().then(
    () =>
      new Promise((resolve, reject) => {
        const task = wx.uploadFile({
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
              request.login().then(() => uploadOne(filePath, onProgress, true)).then(resolve, reject);
              return;
            }
            if (res.statusCode === 200 && body && body.url) resolve(body.url);
            else reject(request.makeError((body && body.error && body.error.code) || 'UPLOAD', (body && body.error && body.error.message) || '图片上传失败'));
          },
          fail: () => reject(request.makeError('NETWORK', '图片上传失败，检查一下网络'))
        });
        if (onProgress && task && task.onProgressUpdate) task.onProgressUpdate((p) => onProgress(p.progress));
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

// 主页背景：已经有自己的背景时先问「从相册选择 / 恢复默认背景」。
// 返回 { url }（已上传）、{ reset: true }（恢复默认）或 null（取消 / 上传失败，失败已提示）
function pickCover(hasCustom) {
  const ask = hasCustom
    ? new Promise((resolve) =>
        wx.showActionSheet({
          itemList: ['从相册选择', '恢复默认背景'],
          success: (res) => resolve(res.tapIndex === 1 ? 'reset' : 'pick'),
          fail: () => resolve(null)
        })
      )
    : Promise.resolve('pick');
  return ask.then((choice) => {
    if (choice === 'reset') return { reset: true };
    if (choice !== 'pick') return null;
    return pickAndUpload(1).then((list) => (list.length ? { url: list[0].url } : null));
  });
}

module.exports = { pickAndUpload, pickCover, uploadOne, choose };

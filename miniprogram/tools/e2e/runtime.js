// 端到端检查用的小程序运行时 mock：wx.*、Page()、Component()、App()、getApp()。
// 页面 / 组件代码原样加载，网络请求真的发到后端（BASE）。只用于开发时自测，不会打进小程序包（tools/ 在 packOptions.ignore 里）。
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MP = path.join(__dirname, '..', '..');
const BASE = process.env.BASE || 'http://localhost:3500';
// 选图时返回的本地图片：可以用 E2E_IMAGE 指定一张，默认生成 1×1 的 PNG
const TEST_PNG = process.env.E2E_IMAGE || path.join(os.tmpdir(), 'dz-e2e-1x1.png');
if (!fs.existsSync(TEST_PNG)) {
  fs.writeFileSync(TEST_PNG, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5a40000000049454e44ae426082', 'hex'));
}

const storage = {};
const log = { toasts: [], navs: [], modals: [], titles: [], requests: [], bodies: [], subs: [], scrolls: [], navColors: [] };
const ctl = { modal: true, sheet: 0, prompt: '提前一天在群里说过了', location: 'fail' };
let inflight = 0;

function qs(data) {
  return Object.keys(data || {})
    .filter((k) => data[k] !== undefined)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(data[k]))
    .join('&');
}

function doRequest(opts) {
  return new Promise((resolve, reject) => {
    const method = (opts.method || 'GET').toUpperCase();
    let url = opts.url;
    let body = null;
    if (method === 'GET' || method === 'DELETE') {
      const q = qs(opts.data);
      if (q && method === 'GET') url += (url.includes('?') ? '&' : '?') + q;
      if (method === 'DELETE' && opts.data && Object.keys(opts.data).length) body = JSON.stringify(opts.data);
    } else body = JSON.stringify(opts.data || {});
    const u = new URL(url);
    const headers = Object.assign({}, opts.header || {});
    if (body) headers['content-length'] = Buffer.byteLength(body);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let data = buf;
        try {
          data = JSON.parse(buf);
        } catch (e) {
          /* keep string */
        }
        log.requests.push(method + ' ' + u.pathname + (u.search || '') + ' ' + res.statusCode);
        log.bodies.push({ method, path: u.pathname, search: u.search, body: body ? JSON.parse(body) : null, status: res.statusCode, data });
        resolve({ statusCode: res.statusCode, data, header: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function doUpload(opts) {
  return new Promise((resolve, reject) => {
    const boundary = '----dz' + Date.now();
    const file = fs.readFileSync(opts.filePath);
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${opts.name}"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, file, tail]);
    const u = new URL(opts.url);
    const headers = Object.assign({}, opts.header || {}, { 'content-type': 'multipart/form-data; boundary=' + boundary, 'content-length': body.length });
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        log.requests.push('UPLOAD ' + u.pathname + ' ' + res.statusCode);
        resolve({ statusCode: res.statusCode, data: buf });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const later = (fn) => setTimeout(fn, 0);
const nav = (kind) => (o) => {
  log.navs.push(kind + ' ' + (o.url || ''));
  if (o.success) later(() => o.success({}));
};

global.wx = {
  request(o) {
    inflight++;
    doRequest(o).then(
      (res) => {
        inflight--;
        o.success && o.success(res);
      },
      (err) => {
        inflight--;
        o.fail && o.fail({ errMsg: 'request:fail ' + err.message });
      }
    );
  },
  uploadFile(o) {
    inflight++;
    const progressFns = [];
    later(() => progressFns.forEach((fn) => fn({ progress: 40 })));
    doUpload(o).then(
      (res) => {
        inflight--;
        o.success && o.success(res);
      },
      (err) => {
        inflight--;
        o.fail && o.fail({ errMsg: 'uploadFile:fail ' + err.message });
      }
    );
    return { onProgressUpdate: (fn) => progressFns.push(fn), abort() {} };
  },
  login: (o) => later(() => o.success({ code: 'harness' + (ctl.loginSuffix || '') })),
  getStorageSync: (k) => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => {
    storage[k] = v;
  },
  removeStorageSync: (k) => {
    delete storage[k];
  },
  showToast: (o) => log.toasts.push(o.title),
  showModal: (o) => {
    log.modals.push(o.title + (o.content ? ' | ' + o.content : ''));
    later(() => o.success && o.success({ confirm: ctl.modal, cancel: !ctl.modal, content: ctl.prompt }));
  },
  showActionSheet: (o) => {
    log.modals.push('sheet: ' + o.itemList.join('/'));
    later(() => (ctl.sheet < 0 ? o.fail && o.fail({}) : o.success && o.success({ tapIndex: ctl.sheet })));
  },
  showLoading() {},
  hideLoading() {},
  navigateTo: nav('navigateTo'),
  redirectTo: nav('redirectTo'),
  switchTab: nav('switchTab'),
  reLaunch: nav('reLaunch'),
  navigateBack: nav('navigateBack'),
  setNavigationBarTitle: (o) => log.titles.push(o.title),
  setNavigationBarColor: (o) => log.navColors.push(o.frontColor),
  // iPhone 13 的状态栏和胶囊按钮
  getWindowInfo: () => ({ statusBarHeight: 47, windowWidth: 390, windowHeight: 844, pixelRatio: 3 }),
  getMenuButtonBoundingClientRect: () => ({ top: 51, height: 32, width: 87, left: 296, right: 383, bottom: 83 }),
  stopPullDownRefresh() {},
  hideHomeButton() {},
  showShareMenu() {},
  requestSubscribeMessage: (o) => {
    log.subs.push(o.tmplIds.join(','));
    later(() => o.success({}));
  },
  openLocation: (o) => log.navs.push('openLocation ' + (o.name || '') + ' ' + o.latitude + ',' + o.longitude),
  createSelectorQuery: () => {
    const q = {
      select: () => q,
      selectViewport: () => q,
      boundingClientRect: () => q,
      scrollOffset: () => q,
      exec: (cb) => later(() => cb && cb([{ top: 180, height: 60 }, { scrollTop: 0 }]))
    };
    return q;
  },
  chooseLocation: (o) =>
    later(() => (ctl.location === 'fail' ? o.fail({ errMsg: 'chooseLocation:fail auth deny' }) : o.success({ name: '大理古城南门', address: '大理市复兴路南端', latitude: 25.6899, longitude: 100.1622 }))),
  chooseMedia: (o) => later(() => o.success({ tempFiles: [{ tempFilePath: TEST_PNG }] })),
  makePhoneCall: (o) => log.navs.push('call ' + o.phoneNumber),
  setClipboardData() {},
  previewImage: (o) => log.navs.push('previewImage ' + (o.urls || []).length + ' ' + (o.current || '')),
  pageScrollTo: (o) => log.scrolls.push(o.scrollTop)
};

const appInstance = { globalData: { me: null, dirty: {} } };
global.getApp = () => appInstance;
const stack = [];
global.getCurrentPages = () => stack;
global.App = (def) => Object.assign(appInstance, def);
let lastDef = null;
global.Page = (def) => {
  lastDef = def;
};
global.Component = (def) => {
  lastDef = def;
};

const config = require(MP + '/config.js');
config.baseURL = BASE;

function setPath(obj, p, v) {
  const parts = p.replace(/\[(\d+)\]/g, '.$1').split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] === undefined || o[parts[i]] === null) o[parts[i]] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function loadPage(route) {
  const file = MP + '/' + route + '.js';
  delete require.cache[require.resolve(file)];
  require(file);
  const def = lastDef;
  const page = {};
  Object.keys(def).forEach((k) => {
    if (k !== 'data') page[k] = def[k];
  });
  page.data = JSON.parse(JSON.stringify(def.data || {}));
  page.route = route;
  page.setData = function (obj, cb) {
    Object.keys(obj).forEach((k) => setPath(this.data, k, obj[k]));
    if (cb) cb.call(this);
  };
  page.getTabBar = () => ({ setData() {} });
  return page;
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

// 组件实例：属性默认值 + data，setData 时触发 observers（够测组件逻辑用）
function loadComponent(name, props) {
  const file = MP + '/components/' + name + '/' + name + '.js';
  delete require.cache[require.resolve(file)];
  require(file);
  const def = lastDef;
  const inst = { data: {}, events: [], is: name };
  const P = def.properties || {};
  Object.keys(P).forEach((k) => {
    const spec = P[k];
    const t = spec && spec.type ? spec.type : spec;
    inst.data[k] = spec && spec.value !== undefined ? clone(spec.value) : t === Boolean ? false : t === Number ? 0 : t === Array ? [] : t === Object ? null : '';
  });
  Object.assign(inst.data, clone(def.data || {}));
  Object.assign(inst, def.methods || {});
  const obs = def.observers || {};
  inst.setData = function (obj, cb) {
    const keys = Object.keys(obj);
    keys.forEach((k) => setPath(this.data, k, obj[k]));
    Object.keys(obs).forEach((key) => {
      const fields = key.split(',').map((x) => x.trim());
      if (fields.some((f) => keys.some((k) => k === f || k.indexOf(f + '.') === 0 || k.indexOf(f + '[') === 0 || f.indexOf(k + '.') === 0))) {
        obs[key].apply(this, fields.map((f) => f.split('.').reduce((o, p) => (o == null ? o : o[p]), this.data)));
      }
    });
    if (cb) cb.call(this);
  };
  inst.triggerEvent = (n, detail) => inst.events.push({ name: n, detail: clone(detail) });
  // IntersectionObserver：记下回调，测试里用 inst._io({ intersectionRatio }) 模拟滚动
  inst.createIntersectionObserver = () => {
    const io = { relativeToViewport: (m) => ((inst._ioMargins = m), io), observe: (sel, cb) => ((inst._io = cb), io), disconnect() {} };
    return io;
  };
  if (props) inst.setData(props);
  if (def.lifetimes && def.lifetimes.attached) def.lifetimes.attached.call(inst);
  return inst;
}

async function idle(extra) {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 15));
    if (inflight === 0) {
      await new Promise((r) => setTimeout(r, 30));
      if (inflight === 0) break;
    }
  }
  if (extra) await new Promise((r) => setTimeout(r, extra));
}

function ev(dataset, detail) {
  return { currentTarget: { dataset: dataset || {} }, detail: detail || {} };
}

module.exports = { MP, BASE, log, ctl, storage, loadPage, loadComponent, idle, ev, appInstance, stack, config, doRequest, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

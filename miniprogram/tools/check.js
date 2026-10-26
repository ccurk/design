#!/usr/bin/env node
/**
 * 小程序静态检查（纯 node，无依赖）。用法：node tools/check.js
 *
 *  1. 所有 .json 能解析
 *  2. app.json 里的页面、custom-tab-bar、用到的自定义组件都有 .js/.json/.wxml/.wxss
 *  3. 每个 .js 过 node --check
 *  4. WXML 标签配对
 *  5. wx.navigateTo/redirectTo/reLaunch/switchTab 的 url、<navigator url>、data-url、所有 '/pages/...' 字面量
 *     都指向真实页面；tab 页只能用 switchTab（或 reLaunch）
 *  6. WXML / JS / JSON / WXSS 里引用的 /assets/... 文件都存在
 *  7. 调用的接口路径（和方法）都在 docs/api.md 或 docs/changes-v0.3.md 里；v0.3 删除的接口（如 /aa/items）不能再用
 *  8. WXML 里 bind/catch 的事件处理函数在对应 .js 里有定义
 *  9. 用到的 dz-* 组件都已注册；wx:for 都带 wx:key
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.resolve(ROOT, '..', 'docs', 'api.md');
// 新一轮改动约定：后端合并进 api.md 之前，这里的接口也算数
const CHANGE_DOCS = ['changes-v0.3.md'].map((f) => path.resolve(ROOT, '..', 'docs', f)).filter((f) => fs.existsSync(f));
const SKIP_DIRS = new Set(['node_modules', 'miniprogram_npm', '.git']);

const errors = [];
const warnings = [];
const rel = (f) => path.relative(ROOT, f) || '.';
const fail = (file, msg) => errors.push(`${rel(file)}: ${msg}`);
const warn = (file, msg) => warnings.push(`${rel(file)}: ${msg}`);
const read = (f) => fs.readFileSync(f, 'utf8');

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, out);
    } else out.push(full);
  }
  return out;
}

const files = walk(ROOT, []);
const byExt = (ext) => files.filter((f) => f.endsWith(ext));
// tools/ 是本地脚本，不参与小程序打包，只做语法检查
const appFiles = (ext) => byExt(ext).filter((f) => !rel(f).startsWith('tools' + path.sep));

// ---------- 1. JSON ----------
const json = {};
for (const f of byExt('.json')) {
  try {
    json[f] = JSON.parse(read(f));
  } catch (e) {
    fail(f, 'JSON 解析失败：' + e.message);
  }
}

// ---------- 2. 页面与组件文件齐全 ----------
const appJsonPath = path.join(ROOT, 'app.json');
const app = json[appJsonPath];
if (!app) {
  console.error('app.json 缺失或无法解析');
  process.exit(1);
}
const pages = app.pages || [];
const pageSet = new Set(pages.map((p) => '/' + p));
const tabPages = ((app.tabBar && app.tabBar.list) || []).map((t) => '/' + t.pagePath);
const tabSet = new Set(tabPages);
for (const t of tabPages) if (!pageSet.has(t)) fail(appJsonPath, `tabBar 页面 ${t} 不在 pages 里`);
for (const f of ['app.js', 'app.json', 'app.wxss', 'project.config.json', 'sitemap.json']) {
  if (!fs.existsSync(path.join(ROOT, f))) fail(path.join(ROOT, f), '文件缺失');
}
const project = json[path.join(ROOT, 'project.config.json')];
if (project && (!project.setting || project.setting.urlCheck !== false)) fail(path.join(ROOT, 'project.config.json'), 'setting.urlCheck 应为 false');

const EXTS = ['.js', '.json', '.wxml', '.wxss'];
function checkUnit(base, label) {
  for (const ext of EXTS) if (!fs.existsSync(base + ext)) fail(base + ext, `${label}缺少 ${ext} 文件`);
}
pages.forEach((p) => checkUnit(path.join(ROOT, p), '页面'));
if (app.tabBar && app.tabBar.custom) {
  checkUnit(path.join(ROOT, 'custom-tab-bar', 'index'), '自定义 tabBar ');
}

// 组件：app.json + 各页面 / 组件 json 的 usingComponents
const registered = {}; // json 文件 -> { tag: 组件路径 }
const componentBases = new Set();
for (const [file, data] of Object.entries(json)) {
  if (!data || typeof data !== 'object' || !data.usingComponents) continue;
  registered[file] = data.usingComponents;
  for (const [tag, p] of Object.entries(data.usingComponents)) {
    if (p.startsWith('plugin://')) continue;
    const base = p.startsWith('/') ? path.join(ROOT, p) : path.resolve(path.dirname(file), p);
    componentBases.add(base);
    if (!/^[a-z][a-z0-9-]*$/.test(tag)) fail(file, `组件标签名 ${tag} 不合法`);
  }
}
for (const base of componentBases) {
  checkUnit(base, '组件');
  const cj = json[base + '.json'];
  if (cj && cj.component !== true) fail(base + '.json', '组件 json 需要 "component": true');
}

// ---------- 3. node --check ----------
for (const f of byExt('.js')) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    const msg = String(e.stderr || e.message).split('\n').filter(Boolean).slice(0, 4).join(' | ');
    fail(f, 'node --check 失败：' + msg);
  }
}

// ---------- 4. WXML 标签配对 ----------
const TAG_RE = /<(\/?)([a-zA-Z][\w\-.:]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/g;
const wxmlTags = {}; // file -> [{name, attrs}]
for (const f of appFiles('.wxml')) {
  // 去掉注释和 {{ }} 表达式（表达式里可能有 < >）
  const src = read(f)
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\{\{[\s\S]*?\}\}/g, (m) => m.replace(/[^\n]/g, 'x'));
  const stack = [];
  const tags = [];
  let consumed = '';
  let last = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(src))) {
    consumed += src.slice(last, m.index);
    last = TAG_RE.lastIndex;
    const [, closing, name, attrs, selfClose] = m;
    const line = src.slice(0, m.index).split('\n').length;
    if (closing) {
      const top = stack.pop();
      if (!top) fail(f, `第 ${line} 行：多余的 </${name}>`);
      else if (top.name !== name) fail(f, `第 ${line} 行：</${name}> 与第 ${top.line} 行的 <${top.name}> 不匹配`);
    } else {
      tags.push({ name, attrs, line });
      if (!selfClose) stack.push({ name, line });
    }
  }
  consumed += src.slice(last);
  if (/<\/?[a-zA-Z]/.test(consumed)) {
    const line = src.slice(0, src.indexOf(consumed.match(/<\/?[a-zA-Z][^\n]*/)[0])).split('\n').length;
    fail(f, `第 ${line} 行附近：有无法解析的标签`);
  }
  for (const open of stack) fail(f, `第 ${open.line} 行：<${open.name}> 没有闭合`);
  wxmlTags[f] = tags;
}

// ---------- 5. 跳转地址 ----------
function pagePath(url) {
  return String(url).split('?')[0].split('${')[0];
}
function checkNav(file, method, url) {
  const p = pagePath(url);
  if (!p || p.endsWith('/') || !p.startsWith('/pages/')) {
    warn(file, `${method} 的 url 不是固定页面路径：${url}`);
    return;
  }
  if (!pageSet.has(p)) return fail(file, `${method} 指向不存在的页面 ${p}`);
  if (method === 'switchTab' && !tabSet.has(p)) fail(file, `switchTab 只能跳 tab 页，${p} 不是 tab 页`);
  if ((method === 'navigateTo' || method === 'redirectTo') && tabSet.has(p)) fail(file, `${method} 不能跳 tab 页 ${p}，请用 switchTab`);
}
let navCount = 0;
for (const f of appFiles('.js')) {
  const src = read(f);
  const re = /wx\.(navigateTo|redirectTo|reLaunch|switchTab)\(\s*\{\s*url\s*:\s*(['"`])([^'"`]*)\2/g;
  let m;
  while ((m = re.exec(src))) {
    navCount++;
    checkNav(f, m[1], m[3]);
  }
  // 其余 '/pages/...' 字面量（地址表、tabBar 列表、nav.go 参数等）
  const lit = /(['"`])(\/pages\/[^'"`?$]*)/g;
  while ((m = lit.exec(src))) {
    const p = m[2];
    if (p.endsWith('/')) continue; // 前缀判断，如 s.indexOf('/pages/')
    if (!pageSet.has(p)) fail(f, `引用了不存在的页面 ${p}`);
  }
}
for (const [f, tags] of Object.entries(wxmlTags)) {
  for (const t of tags) {
    const attr = (name) => {
      const mm = t.attrs.match(new RegExp('\\s' + name + '\\s*=\\s*"([^"]*)"'));
      return mm ? mm[1] : null;
    };
    if (t.name === 'navigator') {
      const url = attr('url');
      if (url !== null) {
        navCount++;
        const type = attr('open-type') || 'navigate';
        const method = { navigate: 'navigateTo', redirect: 'redirectTo', switchTab: 'switchTab', reLaunch: 'reLaunch' }[type] || 'navigateTo';
        checkNav(f, method, url);
      }
    }
    const dataUrl = attr('data-url');
    if (dataUrl !== null) {
      navCount++;
      const p = pagePath(dataUrl);
      if (!pageSet.has(p)) fail(f, `data-url 指向不存在的页面 ${p}`);
    }
  }
}

// ---------- 6. /assets 引用 ----------
let assetCount = 0;
for (const f of [...appFiles('.wxml'), ...appFiles('.js'), ...appFiles('.json'), ...appFiles('.wxss')]) {
  const src = read(f);
  const re = /\/assets\/[\w\-./]*/g;
  let m;
  while ((m = re.exec(src))) {
    const ref = m[0].replace(/[.]+$/, '');
    assetCount++;
    if (ref.endsWith('/')) {
      warn(f, `动态拼接的资源路径无法检查：${ref}`);
      continue;
    }
    const full = path.join(ROOT, ref);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) fail(f, `资源不存在：${ref}`);
  }
}

// ---------- 7. 接口路径 ----------
const norm = (p) => p.split('?')[0].replace(/\$\{[^}]*\}/g, ':p').replace(/:\w+/g, ':p').replace(/\/+$/, '');
const docRoutes = new Set();
const docPaths = new Set();
const removed = []; // 约定里写明删除的接口（路径片段）
function parseRoutes(segment) {
  const tokens = [...segment.matchAll(/`([^`]+)`/g)].map((x) => x[1].trim());
  let prev = null;
  for (const tok of tokens) {
    const full = tok.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/\S+)/);
    if (full) {
      prev = { method: full[1], path: norm(full[2]) };
    } else if (prev && /^\/[\w:-]+$/.test(tok)) {
      // 「`POST /api/x/:id/approve` · `/reject`」这种简写：替换最后一段
      prev = { method: prev.method, path: prev.path.replace(/\/[^/]+$/, '') + norm(tok) };
    } else continue;
    docRoutes.add(prev.method + ' ' + prev.path);
    docPaths.add(prev.path);
  }
}
if (!fs.existsSync(DOCS)) {
  fail(DOCS, '找不到 docs/api.md，无法核对接口');
} else {
  for (const line of read(DOCS).split('\n')) {
    if (line.startsWith('|')) parseRoutes(line.split('|')[1] || '');
  }
}
for (const file of CHANGE_DOCS) {
  for (const line of read(file).split('\n')) {
    // 表格取第一列，列表 / 段落取整行
    parseRoutes(line.startsWith('|') ? line.split('|')[1] || '' : line);
    if (/接口删除|不再使用/.test(line)) {
      for (const x of line.matchAll(/`(\/[\w/:-]+)`/g)) removed.push(norm(x[1]));
    }
  }
}
const isRemoved = (p) => removed.some((r) => p.endsWith(r) || p.includes(r + '/'));
const METHOD = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', del: 'DELETE' };
let apiCount = 0;
for (const f of appFiles('.js')) {
  const src = read(f);
  let m;
  // get('/api/...') / post(`/api/...${id}`) 等
  const call = /\b(get|post|put|patch|del)\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
  const seen = new Set();
  while ((m = call.exec(src))) {
    const lit = m[2].slice(1, -1);
    if (!lit.startsWith('/api/')) continue;
    const route = METHOD[m[1]] + ' ' + norm(lit);
    seen.add(m.index + m[0].indexOf(m[2]));
    apiCount++;
    if (m[1] === 'patch') fail(f, `wx.request 不支持 PATCH，请改用 PUT：${route}`);
    if (isRemoved(norm(lit))) fail(f, `接口已在新约定里删除：${route}`);
    else if (!docRoutes.has(route)) fail(f, `接口不在 docs/api.md / 改动约定里：${route}`);
  }
  // send('POST', '/api/...')
  const send = /\bsend\(\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*'(\/api\/[^']*)'/g;
  while ((m = send.exec(src))) {
    seen.add(m.index + m[0].indexOf("'" + m[2]));
    apiCount++;
    const route = m[1] + ' ' + norm(m[2]);
    if (m[1] === 'PATCH') fail(f, `wx.request 不支持 PATCH，请改用 PUT：${route}`);
    if (!docRoutes.has(route)) fail(f, `接口不在 docs/api.md / 改动约定里：${route}`);
  }
  // 其余 /api 字面量（如上传地址）只核对路径
  const any = /(['"`])(\/api\/[^'"`]*)\1/g;
  while ((m = any.exec(src))) {
    if (seen.has(m.index)) continue;
    apiCount++;
    const p = norm(m[2]);
    if (isRemoved(p)) fail(f, `接口已在新约定里删除：${p}`);
    else if (!docPaths.has(p)) fail(f, `接口路径不在 docs/api.md / 改动约定里：${p}`);
  }
}

// 页面 / 组件里调用的 api.xxx() 都要在 utils/api.js 里定义
const apiFile = path.join(ROOT, 'utils', 'api.js');
if (fs.existsSync(apiFile)) {
  const apiNames = new Set([...read(apiFile).matchAll(/^\s{2}(\w+):\s*\(/gm)].map((x) => x[1]));
  for (const f of appFiles('.js')) {
    if (f === apiFile) continue;
    for (const x of read(f).matchAll(/\bapi\s*\.(\w+)\s*\(/g)) {
      if (!apiNames.has(x[1])) fail(f, `调用了 utils/api.js 里没有的接口函数 api.${x[1]}()`);
    }
  }
}

// ---------- 8. 事件处理函数 ----------
let handlerCount = 0;
for (const [f, tags] of Object.entries(wxmlTags)) {
  const jsFile = f.replace(/\.wxml$/, '.js');
  if (!fs.existsSync(jsFile)) continue;
  const js = read(jsFile);
  for (const t of tags) {
    const re = /\s(?:bind|catch|capture-bind|capture-catch|mut-bind):?([a-z]+)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(t.attrs))) {
      const name = m[2].trim();
      if (!name || name.includes('{{')) continue;
      handlerCount++;
      if (!new RegExp('(^|[^\\w.])' + name + '\\s*(\\(|:)').test(js)) fail(f, `第 ${t.line} 行：${m[1]} 处理函数 ${name} 在 ${rel(jsFile)} 里没有定义`);
    }
  }
}

// ---------- 9. 组件注册与 wx:key ----------
const globalTags = Object.keys(app.usingComponents || {});
for (const [f, tags] of Object.entries(wxmlTags)) {
  const local = Object.keys((json[f.replace(/\.wxml$/, '.json')] || {}).usingComponents || {});
  for (const t of tags) {
    if (t.name.startsWith('dz-') && !globalTags.includes(t.name) && !local.includes(t.name)) {
      fail(f, `第 ${t.line} 行：组件 <${t.name}> 没有注册`);
    }
    if (/\swx:for\s*=/.test(t.attrs) && !/\swx:key\s*=/.test(t.attrs)) warn(f, `第 ${t.line} 行：wx:for 没有 wx:key`);
  }
}

// ---------- 结果 ----------
const summary = [
  `${Object.keys(json).length} 个 json`,
  `${pages.length} 个页面`,
  `${componentBases.size} 个组件`,
  `${byExt('.js').length} 个 js`,
  `${Object.keys(wxmlTags).length} 个 wxml`,
  `${navCount} 处跳转`,
  `${assetCount} 处资源引用`,
  `${apiCount} 处接口调用（文档里 ${docRoutes.size} 个接口${CHANGE_DOCS.length ? '，含改动约定' : ''}）`,
  `${handlerCount} 个事件绑定`
].join('，');
console.log('检查范围：' + summary);
if (warnings.length) {
  console.log(`\n提醒 ${warnings.length} 条：`);
  warnings.forEach((w) => console.log('  - ' + w));
}
if (errors.length) {
  console.log(`\n错误 ${errors.length} 条：`);
  errors.forEach((e) => console.log('  ✗ ' + e));
  process.exit(1);
}
console.log('\n✓ 全部通过');

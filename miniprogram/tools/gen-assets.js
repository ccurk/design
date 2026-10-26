#!/usr/bin/env node
/**
 * 生成 assets/icons/*.svg 与 assets/covers/*.svg。
 * - 图标：小程序 <image> 里的 SVG 不支持 currentColor，所以每种颜色单独输出一个文件；线条路径取自 design/app/*.dc.html。
 * - 封面插画：从 design/illustrations/<key>.svg 复制（docs/changes-v0.3.md H）。
 * 用法：node tools/gen-assets.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const C = {
  ink: '#15171C',
  gray: '#5B5F68',
  muted: '#858C94',
  tab: '#6B6F78',
  body: '#3D4048',
  primary: '#193543',
  accent: '#7CCAE3',
  white: '#FFFFFF',
  danger: '#B42318'
};

// 24×24 线性图标：sw = stroke-width，colors = 需要输出的颜色
const ICONS = {
  'chevron-right': { sw: 2, body: '<path d="M9.5 5.5L16 12l-6.5 6.5"/>', colors: ['muted', 'ink', 'white'] },
  pin: { sw: 2, body: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>', colors: ['gray', 'ink'] },
  clock: { sw: 2, body: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', colors: ['gray', 'ink'] },
  wallet: { sw: 1.9, body: '<rect x="3.5" y="6" width="17" height="12.5" rx="2.5"/><path d="M3.5 10h17"/><path d="M15.5 14.5h2"/>', colors: ['gray', 'ink'] },
  people: { sw: 1.9, body: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.1 2.8-5 5.5-5s4.9 1.9 5.5 5"/><circle cx="17" cy="9" r="2.6"/><path d="M15.8 14.2c2.3.2 4 1.9 4.6 4.8"/>', colors: ['ink', 'tab', 'primary', 'accent', 'gray'] },
  compass: { sw: 1.8, body: '<circle cx="12" cy="12" r="8.5"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>', colors: ['ink', 'tab', 'primary'] },
  image: { sw: 1.8, body: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 16l-4.5-4.5-7.5 8"/>', colors: ['ink', 'tab', 'primary'] },
  chat: { sw: 1.8, body: '<path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-4.5 3.5z"/>', colors: ['ink', 'tab', 'primary'] },
  user: { sw: 1.9, body: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c.9-3.8 3.9-6 7.5-6s6.6 2.2 7.5 6"/>', colors: ['ink', 'tab', 'white', 'gray'] },
  sparkle: { sw: 2, body: '<path d="M12 3.5l1.9 5 5 1.9-5 1.9-1.9 5-1.9-5-5-1.9 5-1.9z"/>', colors: ['primary', 'white'] },
  'shield-check': { sw: 2, body: '<path d="M12 3.5l7 2.8v5.4c0 4.2-2.9 7.4-7 8.8-4.1-1.4-7-4.6-7-8.8V6.3z"/><path d="M9 12l2 2 4-4"/>', colors: ['primary', 'gray', 'body'] },
  shield: { sw: 1.8, body: '<path d="M12 3.5l7 2.8v5.4c0 4.2-2.9 7.4-7 8.8-4.1-1.4-7-4.6-7-8.8V6.3z"/>', colors: ['ink'] },
  phone: { sw: 2, body: '<path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2 2A16.5 16.5 0 0 1 4.5 5.5a2 2 0 0 1 2-2z"/>', colors: ['white', 'danger'] },
  bell: { sw: 1.8, body: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>', colors: ['primary', 'ink', 'gray'] },
  refresh: { sw: 2, body: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>', colors: ['ink', 'body', 'white'] },
  check: { sw: 2.4, body: '<path d="M5 12.5l4.2 4.2L19 7"/>', colors: ['ink', 'white', 'primary'] },
  plus: { sw: 2, body: '<path d="M12 5v14M5 12h14"/>', colors: ['white', 'gray', 'ink', 'primary'] },
  minus: { sw: 2.2, body: '<path d="M5 12h14"/>', colors: ['ink'] },
  search: { sw: 2, body: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>', colors: ['ink', 'gray'] },
  close: { sw: 2, body: '<path d="M6 6l12 12M18 6L6 18"/>', colors: ['gray'] },
  'x-bold': { sw: 3, body: '<path d="M6 6l12 12M18 6L6 18"/>', colors: ['ink'] },
  flag: { sw: 2, body: '<path d="M5.5 21V4.5"/><path d="M5.5 5h11l-2 4 2 4h-11"/>', colors: ['gray', 'ink'] },
  exit: { sw: 2, body: '<path d="M14 4.5h4.5v15H14"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h9"/>', colors: ['danger'] },
  ban: { sw: 2, body: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>', colors: ['danger', 'body', 'ink'] },
  send: { sw: 2, body: '<path d="M21 3.5L10.5 14"/><path d="M21 3.5l-6.5 17-4-6.5-6.5-4z"/>', colors: ['white'] },
  more: { fill: true, body: '<circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/>', colors: ['gray'] },
  heart: { sw: 1.8, body: '<path d="M12 19.5s-7-4.3-7-9.4A3.9 3.9 0 0 1 12 7.6a3.9 3.9 0 0 1 7 2.5c0 5.1-7 9.4-7 9.4z"/>', colors: ['ink', 'gray'] },
  'heart-fill': { sw: 1.8, filled: true, body: '<path d="M12 19.5s-7-4.3-7-9.4A3.9 3.9 0 0 1 12 7.6a3.9 3.9 0 0 1 7 2.5c0 5.1-7 9.4-7 9.4z"/>', colors: ['ink', 'danger'] },
  star: { sw: 2, body: '<path d="M12 4l2.4 5 5.4.6-4 3.7 1.1 5.3L12 15.9 7.1 18.6l1.1-5.3-4-3.7 5.4-.6z"/>', colors: ['accent'] },
  doc: { sw: 1.8, body: '<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M9 8.5h6M9 12h6M9 15.5h3.5"/>', colors: ['ink'] },
  headset: { sw: 1.8, body: '<path d="M4.5 14v-2a7.5 7.5 0 0 1 15 0v2"/><rect x="3.5" y="13" width="4" height="6" rx="1.5"/><rect x="16.5" y="13" width="4" height="6" rx="1.5"/><path d="M18.5 19c0 1.5-1.5 2.5-4 2.5"/>', colors: ['ink'] },
  // v0.3
  calendar: { sw: 1.9, body: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>', colors: ['gray', 'ink'] },
  hash: { sw: 1.9, body: '<path d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16"/>', colors: ['gray', 'ink'] },
  grid: { sw: 1.8, body: '<rect x="4" y="4" width="6.5" height="6.5" rx="2"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="2"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="2"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="2"/>', colors: ['ink'] },
  share: { sw: 1.9, body: '<path d="M12 15V4M8 8l4-4 4 4"/><path d="M5 12v6.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V12"/>', colors: ['ink', 'white'] },
  edit: { sw: 1.9, body: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>', colors: ['ink'] },
  trash: { sw: 1.9, body: '<path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13"/>', colors: ['danger'] },
  lock: { sw: 1.9, body: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>', colors: ['gray'] },
  alert: { sw: 1.9, body: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.5v.01"/>', colors: ['gray', 'danger'] },
  map: { sw: 1.9, body: '<path d="M9 4.5L3.5 6.5v13L9 17.5l6 2 5.5-2v-13L15 6.5z"/><path d="M9 4.5v13M15 6.5v13"/>', colors: ['primary'] },
  hourglass: { sw: 1.9, body: '<path d="M7 3.5h10M7 20.5h10"/><path d="M8 3.5c0 4 8 5 8 8.5s-8 4.5-8 8.5M16 3.5c0 4-8 5-8 8.5s8 4.5 8 8.5"/>', colors: ['gray'] }
};

// 封面插画：固定配色（底色由容器提供）
const ACC = C.accent;
const INK = C.ink;
const dot = (cx, cy, r, color) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" stroke="none"/>`;
const COVERS = {
  // 登录页大图：太阳、山、洱海波纹、星星
  hero: {
    w: 358, h: 250, sw: 2, color: ACC,
    body: '<circle cx="250" cy="86" r="26"/><path d="M0 182L70 114l46 32 70-74 66 80 40-26 66 50"/>' +
      '<path d="M24 206c18 0 18-6 36-6s18 6 36 6 18-6 36-6 18 6 36 6 18-6 36-6 18 6 36 6 18-6 36-6 18 6 36 6"/>' +
      '<path d="M60 228c14 0 14-5 28-5s14 5 28 5 14-5 28-5 14 5 28 5 14-5 28-5 14 5 28 5 14-5 28-5"/>' +
      dot(56, 50, 1.8, ACC) + dot(132, 34, 1.8, ACC) + dot(316, 44, 1.8, ACC)
  },
  // 广场卡片（户外）
  'mountains-card': {
    w: 338, h: 124, sw: 2, color: ACC,
    body: '<circle cx="236" cy="46" r="14"/><path d="M0 122L66 66l42 28 60-58 58 64 36-22 76 42"/>' +
      dot(44, 26, 1.5, ACC) + dot(110, 18, 1.5, ACC) + dot(300, 30, 1.5, ACC)
  },
  // 撮合成功卡片
  'mountains-match': {
    w: 326, h: 112, sw: 2, color: ACC,
    body: '<circle cx="222" cy="44" r="16"/><path d="M0 110L64 56l40 26 56-52 54 58 36-22 76 44"/>' +
      dot(48, 24, 1.5, ACC) + dot(104, 16, 1.5, ACC) + dot(292, 26, 1.5, ACC)
  },
  // 局详情顶部（贴底对齐）
  'mountains-wide': {
    w: 390, h: 170, sw: 2, color: ACC,
    body: '<circle cx="270" cy="70" r="22"/><path d="M0 166L80 90l48 32 72-74 70 78 44-28 76 58"/>' +
      dot(60, 40, 1.6, ACC) + dot(150, 24, 1.6, ACC) + dot(344, 34, 1.6, ACC)
  },
  // 小方块里的山（贴底）
  'mountains-tile': {
    w: 56, h: 38, sw: 2, color: ACC,
    body: '<circle cx="39" cy="13" r="5"/><path d="M0 37l13-13 9 6 11-13 10 13 13 6"/>'
  },
  bowl: {
    w: 96, h: 64, sw: 2.2, color: INK,
    body: '<path d="M18 30h60"/><path d="M22 30a26 24 0 0 0 52 0"/><path d="M38 58h20"/><path d="M40 20c0-4 3-4 3-8"/><path d="M52 20c0-4 3-4 3-8"/>'
  },
  cup: {
    w: 96, h: 64, sw: 2.2, color: INK,
    body: '<path d="M30 26h32v14a14 14 0 0 1-14 14h-4a14 14 0 0 1-14-14z"/><path d="M62 30h4a7 7 0 0 1 0 14h-4"/><path d="M24 60h48"/><path d="M40 8c0 4-3 4-3 8"/><path d="M50 8c0 4-3 4-3 8"/>'
  },
  dice: {
    w: 96, h: 64, sw: 2.2, color: ACC,
    body: '<rect x="16" y="14" width="32" height="32" rx="7"/>' + dot(25, 23, 2.4, ACC) + dot(32, 30, 2.4, ACC) + dot(39, 37, 2.4, ACC) +
      '<rect x="54" y="24" width="28" height="28" rx="6"/>' + dot(62, 32, 2.4, ACC) + dot(74, 32, 2.4, ACC) + dot(62, 44, 2.4, ACC) + dot(74, 44, 2.4, ACC)
  },
  car: {
    w: 96, h: 64, sw: 2.2, color: INK,
    body: '<path d="M14 44v-9l9-15h50l9 15v9z"/><path d="M22 35h52"/><path d="M48 20v15"/>' +
      '<circle cx="29" cy="46" r="6" fill="#DDE4E9"/><circle cx="67" cy="46" r="6" fill="#DDE4E9"/>'
  },
  'bowl-tile': { w: 96, h: 64, sw: 5, color: INK, body: '<path d="M18 30h60"/><path d="M22 30a26 24 0 0 0 52 0"/>' },
  'car-tile': {
    w: 96, h: 64, sw: 4.6, color: INK,
    body: '<path d="M14 44v-9l9-15h50l9 15v9z"/><path d="M22 35h52"/><circle cx="29" cy="46" r="6" fill="#DDE4E9"/><circle cx="67" cy="46" r="6" fill="#DDE4E9"/>'
  },
  'cup-tile': {
    w: 24, h: 24, sw: 1.8, color: INK,
    body: '<path d="M5 8h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z"/><path d="M16 9h1.5a2 2 0 0 1 0 4H16"/><path d="M4 20h14"/>'
  },
  'dice-tile': {
    w: 24, h: 24, sw: 1.8, color: ACC,
    body: '<rect x="4" y="4" width="16" height="16" rx="4"/>' + dot(9, 9, 1.2, ACC) + dot(15, 15, 1.2, ACC) + dot(12, 12, 1.2, ACC)
  },
  waves: {
    w: 24, h: 24, sw: 1.8, color: ACC,
    body: '<path d="M3 9c2 0 2-1.5 4.5-1.5S9.5 9 12 9s2.5-1.5 4.5-1.5S19 9 21 9"/>' +
      '<path d="M3 14c2 0 2-1.5 4.5-1.5S9.5 14 12 14s2.5-1.5 4.5-1.5S19 14 21 14"/>' +
      '<path d="M3 19c2 0 2-1.5 4.5-1.5S9.5 19 12 19s2.5-1.5 4.5-1.5S19 19 21 19"/>'
  },
  'hill-tile': { w: 24, h: 24, sw: 1.8, color: ACC, body: '<path d="M3 19l6-8 4 5 3-3.5L21 19z"/><circle cx="16.5" cy="6.5" r="2"/>' },
  'sparkle-tile': { w: 24, h: 24, sw: 1.8, color: INK, body: '<path d="M12 3.5l1.9 5 5 1.9-5 1.9-1.9 5-1.9-5-5-1.9 5-1.9z"/>' }
};

function svg(w, h, attrs, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ${attrs}>${body}</svg>\n`;
}

function write(rel, content) {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function clean(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return;
  for (const f of fs.readdirSync(abs)) if (f.endsWith('.svg')) fs.unlinkSync(path.join(abs, f));
}

clean('assets/icons');
clean('assets/covers');

// 封面插画：design/illustrations/<key>.svg（v0.3 H）
const ILLUSTRATIONS = ['sunrise', 'mountain', 'cycling', 'lake', 'coffee', 'reading', 'food', 'boardgame', 'carpool', 'oldtown'];
const ILL_DIR = path.join(ROOT, '..', 'design', 'illustrations');
const missing = [];

let count = 0;
for (const [name, def] of Object.entries(ICONS)) {
  for (const key of def.colors) {
    const color = C[key];
    if (!color) throw new Error(`unknown color ${key} for ${name}`);
    let attrs;
    if (def.fill) attrs = `fill="${color}"`;
    else attrs = `fill="${def.filled ? color : 'none'}" stroke="${color}" stroke-width="${def.sw}" stroke-linecap="round" stroke-linejoin="round"`;
    write(`assets/icons/${name}-${key}.svg`, svg(24, 24, attrs, def.body));
    count++;
  }
}

for (const [name, def] of Object.entries(COVERS)) {
  const attrs = `fill="none" stroke="${def.color}" stroke-width="${def.sw}" stroke-linecap="round" stroke-linejoin="round"`;
  write(`assets/covers/${name}.svg`, svg(def.w, def.h, attrs, def.body));
  count++;
}

for (const key of ILLUSTRATIONS) {
  const src = path.join(ILL_DIR, key + '.svg');
  if (!fs.existsSync(src)) {
    missing.push(key);
    continue;
  }
  write(`assets/covers/${key}.svg`, fs.readFileSync(src, 'utf8'));
  count++;
}
if (missing.length) console.warn('缺少插画（design/illustrations）：' + missing.join(', '));

console.log(`generated ${count} svg files`);

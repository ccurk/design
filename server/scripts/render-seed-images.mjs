// 把 design/illustrations/*.svg 渲染成 1200×800 的图片，放进 server/seed-assets/（提交到仓库，seed 时复制进上传目录）。
// 用法：node scripts/render-seed-images.mjs [key ...]   不传 key 就渲染全部
// 需要 Playwright + Chromium（不在 package.json 里，开发机全局装一份即可）。
// 用 createRequire 走 CommonJS 的解析规则，这样全局安装（NODE_PATH）的 playwright 也能找到。
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.resolve(SERVER_DIR, '..', 'design', 'illustrations');
const OUT_DIR = path.join(SERVER_DIR, 'seed-assets');
const WIDTH = 1200;
const HEIGHT = 800;
const MAX_BYTES = 300 * 1024; // PNG 超过 300 KB 就改存 JPEG（quality 82）

const wanted = process.argv.slice(2);
const keys = fs
  .readdirSync(SRC_DIR)
  .filter((f) => f.endsWith('.svg'))
  .map((f) => f.slice(0, -4))
  .filter((k) => !wanted.length || wanted.includes(k))
  .sort();
if (!keys.length) {
  console.error(`没有找到要渲染的 SVG（${SRC_DIR}）`);
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  for (const key of keys) {
    const svg = fs.readFileSync(path.join(SRC_DIR, `${key}.svg`));
    const src = `data:image/svg+xml;base64,${svg.toString('base64')}`;
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:#fff"><img id="art" src="${src}" width="${WIDTH}" height="${HEIGHT}" style="display:block"></body></html>`,
    );
    await page.waitForFunction(() => {
      const img = document.getElementById('art');
      return img.complete && img.naturalWidth > 0;
    });
    const clip = { x: 0, y: 0, width: WIDTH, height: HEIGHT };
    let buffer = await page.screenshot({ type: 'png', clip });
    let ext = 'png';
    if (buffer.length > MAX_BYTES) {
      buffer = await page.screenshot({ type: 'jpeg', quality: 82, clip });
      ext = 'jpg';
    }
    // 同一个 key 只保留一种格式
    for (const old of ['png', 'jpg']) {
      const file = path.join(OUT_DIR, `${key}.${old}`);
      if (old !== ext && fs.existsSync(file)) fs.rmSync(file);
    }
    fs.writeFileSync(path.join(OUT_DIR, `${key}.${ext}`), buffer);
    console.log(`  ${key}.${ext}  ${(buffer.length / 1024).toFixed(1)} KB`);
  }
} finally {
  await browser.close();
}
console.log(`已渲染 ${keys.length} 张到 ${path.relative(process.cwd(), OUT_DIR) || OUT_DIR}`);

// 把整个网站打包成单个自包含 HTML：所有 JS 模块 + CSS 内联，零外部依赖。
// 方案：每个模块编码为 base64 data URL，用 importmap 把裸说明符映射到它们，
// 浏览器原生构建模块图（支持相对 import / dynamic import / 循环）。
import { readFileSync, writeFileSync, readdirSync } from 'fs';

const DIR = new URL('./', import.meta.url);
const read = p => readFileSync(new URL(p, DIR), 'utf8');

// 1) 读取并内联 CSS
const css = ['css/main.css', 'css/themes.css', 'css/effects.css']
  .map(f => `/* ===== ${f} ===== */\n` + read(f)).join('\n\n');

// 2) 读取所有 JS 模块
const jsFiles = readdirSync(new URL('./js/', DIR)).filter(f => f.endsWith('.js'));
const modules = {};
for (const f of jsFiles) modules[f.replace(/\.js$/, '')] = read('js/' + f);

// 3) 把相对说明符 './xxx.js' 改成裸说明符 'xxx'（供 importmap 解析）
const RELSPEC = /(['"])\.\/([\w][\w.-]*)\.js\1/g;
for (const name in modules) {
  modules[name] = modules[name].replace(RELSPEC, (_, q, base) => q + base + q);
}

// 4) 每个模块编码为 base64 data URL（charset=utf-8 保证中文正确）
const toDataUrl = src =>
  'data:text/javascript;charset=utf-8;base64,' + Buffer.from(src, 'utf8').toString('base64');
const imports = {};
for (const name in modules) imports[name] = toDataUrl(modules[name]);

const importmap = JSON.stringify({ imports }, null, 0);

// 5) 组装 HTML（基于 index.html 的 body 结构）
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<meta name="description" content="《九百九十九》—— 一段下沉至 999 层的心理恐怖叙事。" />
<meta name="theme-color" content="#050507" />
<title>九百九十九 · 999</title>
<style>
${css}
</style>
<script type="importmap">
${importmap}
</script>
</head>
<body>
<div id="boot" aria-hidden="false">
  <div id="boot-inner">
    <div id="boot-count">999</div>
    <div id="boot-line">正在下沉…</div>
  </div>
</div>
<main id="game" role="application" aria-label="九百九十九"></main>
<noscript>
  <div style="color:#caa;background:#050507;font-family:serif;padding:3rem;text-align:center;">
    这段经历需要 JavaScript。请在支持的浏览器中开启它，然后继续下沉。
  </div>
</noscript>
<script type="module">import 'main';</script>
</body>
</html>
`;

const out = new URL('./999.html', DIR);
writeFileSync(out, html, 'utf8');
const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
console.log('已生成 999.html，大小 ' + kb + ' KB，内联模块 ' + Object.keys(modules).length + ' 个');
console.log('模块清单:', Object.keys(modules).join(', '));

/**
 * 浏览器 ES module 需要显式的 .js 扩展名，而 TypeScript 的 `bundler`
 * 解析模式输出的是无扩展名的相对导入。构建后统一补上。
 *
 * 用法：node tools/fix-esm-imports.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public', 'js');
let patched = 0;

function rewrite(file) {
  let src = fs.readFileSync(file, 'utf8');
  const before = src;
  // import ... from './x'   |   export ... from './x'   |   import './x'
  src = src.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.\.?\/[^'"]+)\2/g, (m, head, quote, spec) => {
    if (/\.(js|mjs|json|css)$/.test(spec)) return m;
    return `${head}${quote}${spec}.js${quote}`;
  });
  if (src !== before) {
    fs.writeFileSync(file, src, 'utf8');
    patched += 1;
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith('.js')) rewrite(full);
  }
}

if (!fs.existsSync(ROOT)) {
  console.error(`[fix-esm] 目录不存在：${ROOT}，请先编译客户端`);
  process.exit(1);
}
walk(ROOT);
console.log(`[fix-esm] 已修正 ${patched} 个文件的模块导入路径`);

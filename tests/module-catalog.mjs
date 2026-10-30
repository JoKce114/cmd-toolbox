// 模块清单的离线校验：不需要 Electron 或 GUI。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

// catalog 是纯 TS 常量，这里用正则读源码，避免引入打包链路
const source = readFileSync(resolve(root, 'src/modules/catalog.ts'), 'utf8');

console.log('1. 清单里的模块定义完整');
const ids = [...source.matchAll(/^\s+id: '([^']+)'/gm)].map((m) => m[1]);
assert(ids.length === 3, `有 3 个模块，实际 ${ids.length}`);
assert(new Set(ids).size === 3, 'id 互不重复');
assert(!ids.includes('format'), '格式化模块已移除');

console.log('2. 每个模块的 kind 合法');
const kinds = [...source.matchAll(/^\s+kind: '([^']+)'/gm)].map((m) => m[1]);
for (const kind of kinds) {
  assert(['minify', 'diagnostics'].includes(kind), `kind ${kind} 合法`);
}

console.log('3. 每个模块都声明了语言');
const langs = [...source.matchAll(/^\s+languages: \[([^\]]+)\]/gm)];
assert(langs.length === 3, `3 个模块都声明了 languages，实际 ${langs.length}`);
for (const match of langs) {
  assert(match[1].trim().length > 0, 'languages 非空');
}

console.log('4. 默认不启用诊断模块');
const defaults = source.match(/DEFAULT_ENABLED_MODULES[^=]*=\s*\[([^\]]*)\]/);
assert(Boolean(defaults), '找到 DEFAULT_ENABLED_MODULES');
assert(!/diag-js/.test(defaults[1]), '默认不启用 JS 诊断');
assert(/diag-php/.test(defaults[1]), '默认启用 PHP 诊断');
assert(/minify/.test(defaults[1]), '默认启用压缩');

console.log(`\n全部通过（${passed} 项）`);

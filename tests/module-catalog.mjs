// 模块清单的离线校验：不需要 Electron 或 GUI。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

// catalog 是纯 TS 常量：静态形状用正则读源码，函数行为用类型剥离在子进程里导入真实模块，
// 都不需要打包链路。
const source = readFileSync(resolve(root, 'src/modules/catalog.ts'), 'utf8');

console.log('1. 清单里的模块定义完整');
const ids = [...source.matchAll(/^\s+id: '([^']+)'/gm)].map((m) => m[1]);
assert(ids.length === 4, `有 4 个模块，实际 ${ids.length}`);
assert(new Set(ids).size === 4, 'id 互不重复');
assert(!ids.includes('format'), '格式化模块已移除');
// 压缩没有开关：保存时总是自动执行，文件树右键也能生成
assert(!ids.includes('minify'), '压缩不作为可开关的模块');

console.log('2. 每个模块的 kind 合法');
const kinds = [...source.matchAll(/^\s+kind: '([^']+)'/gm)].map((m) => m[1]);
for (const kind of kinds) {
  assert(kind === 'diagnostics' || kind === 'reference', `kind ${kind} 合法`);
}
assert(kinds.filter((kind) => kind === 'diagnostics').length === 2, '有 2 个诊断模块');
assert(kinds.filter((kind) => kind === 'reference').length === 2, '有 2 个跳转模块');

console.log('3. 每个模块都声明了语言');
const langs = [...source.matchAll(/^\s+languages: \[([^\]]+)\]/gm)];
assert(langs.length === 4, `4 个模块都声明了 languages，实际 ${langs.length}`);
for (const match of langs) {
  assert(match[1].trim().length > 0, 'languages 非空');
}

console.log('4. 默认模块');
const defaults = source.match(/DEFAULT_ENABLED_MODULES[^=]*=\s*\[([^\]]*)\]/);
assert(Boolean(defaults), '找到 DEFAULT_ENABLED_MODULES');
assert(!/diag-js/.test(defaults[1]), '默认不启用 JS 诊断');
assert(/diag-php/.test(defaults[1]), '默认启用 PHP 诊断');
assert(/ref-php/.test(defaults[1]), 'ref-php 默认开启');
assert(/ref-js/.test(defaults[1]), 'ref-js 默认开启');

// 直接 import .ts 需要 Node >= 22.7（22.6 起有 --experimental-strip-types，
// 但 22.7 才默认按 ESM 语法检测）。低版本不能静默跳过，要明确说明原因。
function supportsTypeStripping() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 7);
}

function runCatalogCase() {
  if (!supportsTypeStripping()) {
    throw new Error(`Node ${process.versions.node} 不支持 --experimental-strip-types，需要 >= 22.7`);
  }
  const url = new URL('../src/modules/catalog.ts', import.meta.url).href;
  const script = `
    const catalog = await import(${JSON.stringify(url)});
    const ids = (list) => list.map((m) => m.id);
    const legacy = catalog.mergeDefaultModules(
      ['diag-php'],
      catalog.LEGACY_DEFAULT_ENABLED_MODULES,
    );
    const legacyDisabled = catalog.mergeDefaultModules(
      [],
      catalog.LEGACY_DEFAULT_ENABLED_MODULES,
    );
    const manualOff = catalog.mergeDefaultModules(
      ['diag-php'],
      ['diag-php', 'ref-php', 'ref-js'],
    );
    console.log(JSON.stringify({
      refPhp: ids(catalog.modulesFor('reference', 'php')),
      refJsx: ids(catalog.modulesFor('reference', 'jsx')),
      refTs: ids(catalog.modulesFor('reference', 'ts')),
      diagPhp: ids(catalog.modulesFor('diagnostics', 'php')),
      legacy,
      legacyDisabled,
      manualOff,
    }));
  `;
  const output = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
    { encoding: 'utf8' },
  );
  return JSON.parse(output.trim().split('\n').pop());
}

const catalog = runCatalogCase();

console.log('5. 按 kind + 语言匹配');
assert(
  catalog.refPhp.includes('ref-php') && !catalog.refPhp.includes('ref-js'),
  'PHP 只匹配到 ref-php',
);
assert(catalog.refJsx.includes('ref-js'), 'JSX 能匹配到 ref-js');
assert(catalog.refTs.length === 0, 'TS 暂不匹配跳转模块');
assert(
  catalog.diagPhp.includes('diag-php') && !catalog.diagPhp.includes('ref-php'),
  '诊断与跳转两组互不串门',
);

console.log('6. 老用户的默认模块迁移');
assert(catalog.legacy.enabledModules.includes('ref-php'), '老用户升级后获得 ref-php');
assert(catalog.legacy.enabledModules.includes('ref-js'), '老用户升级后获得 ref-js');
assert(
  catalog.legacy.seenDefaultModules.includes('ref-php'),
  '合并后记录 ref-php 已见过',
);
assert(
  !catalog.legacyDisabled.enabledModules.includes('diag-php'),
  '老用户手动关掉的 diag-php 不会被重新打开',
);
assert(
  catalog.legacyDisabled.enabledModules.includes('ref-php'),
  '手动关掉 diag-php 的老用户仍获得新增的 ref-php',
);
assert(
  !catalog.manualOff.enabledModules.includes('ref-php'),
  '用户手动关掉 ref-php 后保存，下次加载不会重新打开',
);
assert(
  catalog.manualOff.seenDefaultModules.includes('ref-php'),
  '手动关掉的 ref-php 仍记为已见过',
);

console.log(`\n全部通过（${passed} 项）`);

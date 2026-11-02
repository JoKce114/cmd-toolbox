import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const symbols = require('../desktop/symbols.js');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error('断言失败：' + message);
  passed += 1;
  console.log('  ok  ' + message);
}

const NL = '\n';

console.log('1. PHP 声明提取');
const phpSource = [
  '<?php',
  'namespace App\\Helps;',
  '',
  '/**',
  ' * 类说明',
  ' */',
  'class HelpsVisualV2 {',
  '  /**',
  '   * 去读输出对应的h标签html',
  '   *',
  '   * @param string $Name',
  '   * @param array $options',
  '   * @return string',
  '   */',
  '  public static function echoListHTags($Name, $options = []) {',
  '    return $Name;',
  '  }',
  '',
  '  private function hidden() {}',
  '}',
  '',
  '/**',
  ' * 全局函数说明',
  ' */',
  'function plainFunc($a) {}',
  '',
  '// function commentedOut() {}',
  'const SAMPLE = "function insideString() {}";',
].join(NL);

const phpDecls = symbols.parsePhpSymbols(phpSource);
const cls = phpDecls.find((d) => d.kind === 'class' && d.name === 'HelpsVisualV2');
assert(Boolean(cls), '识别出类 HelpsVisualV2');
assert(cls.namespace === 'App\\Helps', `类带命名空间，实际 ${cls.namespace}`);
assert(cls.doc === '类说明', `类 docblock 已清理，实际 ${JSON.stringify(cls.doc)}`);
assert(cls.line === 7, `类声明行号，实际 ${cls.line}`);

const method = phpDecls.find((d) => d.kind === 'method' && d.name === 'echoListHTags');
assert(Boolean(method), '识别出方法 echoListHTags');
assert(method.owner === 'HelpsVisualV2', `方法带所属类，实际 ${method.owner}`);
assert(method.signature === 'public static function echoListHTags($Name, $options = [])', `签名完整，实际 ${method.signature}`);
assert(method.doc.includes('@param string $Name'), '方法 docblock 含 @param');
assert(method.doc.includes('@return string'), '方法 docblock 含 @return');
assert(!method.doc.includes('/**'), 'docblock 不含注释定界符');
assert(method.line === 15, `方法声明行号，实际 ${method.line}`);

const fn = phpDecls.find((d) => d.kind === 'function' && d.name === 'plainFunc');
assert(Boolean(fn), '识别出全局函数 plainFunc');
assert(fn.owner === '', '全局函数没有所属类');
assert(fn.namespace === 'App\\Helps', '全局函数带命名空间');
assert(fn.doc === '全局函数说明', '全局函数 docblock 正确');

assert(!phpDecls.some((d) => d.name === 'commentedOut'), '注释掉的函数不算声明');
assert(!phpDecls.some((d) => d.name === 'insideString'), '字符串里的同名不算声明');

console.log('\n2. 注释类型校验');
const commentSource = [
  '<?php',
  '// 普通行注释',
  'class LooseComment {',
  '  /**',
  '   * 方法说明',
  '   */',
  '  public function withDoc() {}',
  '',
  '  // 方法前的普通注释',
  '  public function withLineComment() {}',
  '',
  '  /* 块注释 */',
  '  public function withBlockComment() {}',
  '}',
].join(NL);

const commentDecls = symbols.parsePhpSymbols(commentSource);
const looseClass = commentDecls.find((d) => d.kind === 'class' && d.name === 'LooseComment');
assert(Boolean(looseClass), '识别出类 LooseComment');
assert(looseClass.doc === '', `// 行注释不当 docblock，实际 ${JSON.stringify(looseClass.doc)}`);

const withDoc = commentDecls.find((d) => d.kind === 'method' && d.name === 'withDoc');
assert(withDoc.doc === '方法说明', `正常 docblock 仍然生效，实际 ${JSON.stringify(withDoc.doc)}`);

const withLine = commentDecls.find((d) => d.kind === 'method' && d.name === 'withLineComment');
assert(withLine.doc === '', `// 方法注释不当 docblock，实际 ${JSON.stringify(withLine.doc)}`);

const withBlock = commentDecls.find((d) => d.kind === 'method' && d.name === 'withBlockComment');
assert(withBlock.doc === '', `/* */ 块注释不当 docblock，实际 ${JSON.stringify(withBlock.doc)}`);

assert(symbols.cleanDoc('/**/') === '', `空 docblock 不残留定界符，实际 ${JSON.stringify(symbols.cleanDoc('/**/'))}`);

console.log('\n3. interface / trait 签名');
const kindsSource = [
  '<?php',
  'interface Fooable {',
  '  public function foo();',
  '}',
  'trait BarTrait {',
  '  public function bar() {}',
  '}',
  'class Baz {}',
].join(NL);

const kindDecls = symbols.parsePhpSymbols(kindsSource);
const iface = kindDecls.find((d) => d.kind === 'class' && d.name === 'Fooable');
assert(Boolean(iface), '识别出 interface Fooable');
assert(iface.signature === 'interface Fooable', `interface 签名反映真实种类，实际 ${iface.signature}`);

const trait = kindDecls.find((d) => d.kind === 'class' && d.name === 'BarTrait');
assert(Boolean(trait), '识别出 trait BarTrait');
assert(trait.signature === 'trait BarTrait', `trait 签名反映真实种类，实际 ${trait.signature}`);

const plainClass = kindDecls.find((d) => d.kind === 'class' && d.name === 'Baz');
assert(plainClass.signature === 'class Baz', `普通 class 签名保持不变，实际 ${plainClass.signature}`);

console.log('\n4. 函数体内的嵌套声明');
const nestedSource = [
  '<?php',
  'function outerFn($a) {',
  '  function innerFn($b) {}',
  '  $closure = function ($c) {};',
  '  return $a;',
  '}',
  'function afterFn() {}',
].join(NL);

const nestedDecls = symbols.parsePhpSymbols(nestedSource);
const outerFns = nestedDecls.filter((d) => d.kind === 'function').map((d) => d.name).sort();
assert(
  JSON.stringify(outerFns) === JSON.stringify(['afterFn', 'outerFn']),
  `只收集外层函数，实际 ${outerFns.join(', ')}`,
);
assert(!nestedDecls.some((d) => d.name === 'innerFn'), '函数体内的具名函数不被收集');
assert(!nestedDecls.some((d) => d.kind === 'function' && d.name === ''), '闭包（匿名函数）不被收集');

console.log('2. JS 声明提取');
const jsSource = [
  '/**',
  ' * 全局函数说明',
  ' */',
  'function plainFn(a, b) {',
  '  return a + b;',
  '}',
  '',
  '/** 类说明 */',
  'class Widget {',
  '  render() {}',
  '}',
  '',
  'const arrowFn = (x) => x * 2;',
  'let notAFunction = 1;',
  '// function commentedJs() {}',
  'const text = "function insideJsString() {}";',
].join(NL);

const jsDecls = symbols.parseJsSymbols(jsSource, 'js');
const jsFn = jsDecls.find((d) => d.name === 'plainFn');
assert(Boolean(jsFn), '识别出函数声明 plainFn');
assert(jsFn.signature === 'function plainFn(a, b)', `JS 签名到 { 为止，实际 ${jsFn.signature}`);
assert(jsFn.doc === '全局函数说明', 'JS docblock 正确');
assert(jsFn.line === 4, `JS 函数行号，实际 ${jsFn.line}`);

const jsClass = jsDecls.find((d) => d.name === 'Widget');
assert(Boolean(jsClass) && jsClass.kind === 'class', '识别出类 Widget');
assert(jsClass.doc === '类说明', '单行 docblock 也能提取');

const jsArrow = jsDecls.find((d) => d.name === 'arrowFn');
assert(Boolean(jsArrow), '识别出箭头函数赋值的变量');
assert(jsArrow.signature.includes('arrowFn'), `箭头函数签名含变量名，实际 ${jsArrow.signature}`);

assert(!jsDecls.some((d) => d.name === 'notAFunction'), '普通变量不算函数声明');
assert(!jsDecls.some((d) => d.name === 'commentedJs'), '注释掉的 JS 函数不算声明');
assert(!jsDecls.some((d) => d.name === 'insideJsString'), '字符串里的同名不算声明');

const jsxDecls = symbols.parseJsSymbols('export function App() {\n  return <div />;\n}\n', 'jsx');
assert(jsxDecls.some((d) => d.name === 'App'), 'JSX 文件能正常解析');

console.log('\n5. JS 局部声明泄漏');
const leakSource = [
  'const arr = [1];',
  'arr.map(() => {',
  '  function callbackLocal() {}',
  '});',
  'export default function () {',
  '  function defaultLocal() {}',
  '}',
  'const iife = (function () {',
  '  function iifeLocal() {}',
  '  return 1;',
  '})();',
].join(NL);

const leakDecls = symbols.parseJsSymbols(leakSource, 'js');
assert(!leakDecls.some((d) => d.name === 'callbackLocal'), '回调函数体里的函数不被收集');
assert(!leakDecls.some((d) => d.name === 'defaultLocal'), 'export default 匿名函数体里的函数不被收集');
assert(!leakDecls.some((d) => d.name === 'iifeLocal'), 'IIFE 函数体里的函数不被收集');

console.log('\n6. 函数表达式与解构参数签名');
const signatureSource = [
  'const fnExpr = function (a, b) {',
  '  return a + b;',
  '};',
  'function App({ title }) {',
  '  return title;',
  '}',
  'function withDefault(a = {}) {',
  '  return a;',
  '}',
].join(NL);

const signatureDecls = symbols.parseJsSymbols(signatureSource, 'js');
const fnExpr = signatureDecls.find((d) => d.name === 'fnExpr');
assert(fnExpr.signature === 'fnExpr = function (a, b)', `函数表达式签名到右括号为止，实际 ${fnExpr.signature}`);

const appFn = signatureDecls.find((d) => d.name === 'App');
assert(appFn.signature === 'function App({ title })', `解构参数签名完整，实际 ${appFn.signature}`);

const withDefault = signatureDecls.find((d) => d.name === 'withDefault');
assert(withDefault.signature === 'function withDefault(a = {})', `默认值里的花括号不截断签名，实际 ${withDefault.signature}`);

console.log('\n7. export 前缀与 const 前的 JSDoc');
const docSource = [
  '/** 导出函数说明 */',
  'export function exportedFn(a) {',
  '  return a;',
  '}',
  '',
  '/** 默认导出说明 */',
  'export default function defaultFn() {}',
  '',
  '/** 导出类说明 */',
  'export class ExportedClass {}',
  '',
  '/** 箭头说明 */',
  'const documentedArrow = (x) => x;',
  '',
  '/** 常量函数说明 */',
  'export const documentedConst = function () {};',
].join(NL);

const docDecls = symbols.parseJsSymbols(docSource, 'js');
const exportedFn = docDecls.find((d) => d.name === 'exportedFn');
assert(exportedFn.doc === '导出函数说明', `export function 的 JSDoc，实际 ${JSON.stringify(exportedFn.doc)}`);

const defaultFn = docDecls.find((d) => d.name === 'defaultFn');
assert(defaultFn.doc === '默认导出说明', `export default function 的 JSDoc，实际 ${JSON.stringify(defaultFn.doc)}`);

const exportedClass = docDecls.find((d) => d.name === 'ExportedClass');
assert(exportedClass.doc === '导出类说明', `export class 的 JSDoc，实际 ${JSON.stringify(exportedClass.doc)}`);

const documentedArrow = docDecls.find((d) => d.name === 'documentedArrow');
assert(documentedArrow.doc === '箭头说明', `const 赋值上方的 JSDoc，实际 ${JSON.stringify(documentedArrow.doc)}`);

const documentedConst = docDecls.find((d) => d.name === 'documentedConst');
assert(documentedConst.doc === '常量函数说明', `export const 上方的 JSDoc，实际 ${JSON.stringify(documentedConst.doc)}`);

console.log('\n8. JSDoc 不误挂');
const strayDocSource = [
  'const first = 1; /** 尾注释 */',
  'function afterTrailing() {}',
  '',
  '/** 文件头 */',
  '',
  '',
  'function farFromHeader() {}',
  '',
  '/** 隔代码 */ console.log("x");',
  'function afterCode() {}',
].join(NL);

const strayDecls = symbols.parseJsSymbols(strayDocSource, 'js');
const afterTrailing = strayDecls.find((d) => d.name === 'afterTrailing');
assert(afterTrailing.doc === '', `上一行语句末尾的尾注释不挂给下一个声明，实际 ${JSON.stringify(afterTrailing.doc)}`);

const farFromHeader = strayDecls.find((d) => d.name === 'farFromHeader');
assert(farFromHeader.doc === '', `隔空行的文件头注释不挂给远处声明，实际 ${JSON.stringify(farFromHeader.doc)}`);

const afterCode = strayDecls.find((d) => d.name === 'afterCode');
assert(afterCode.doc === '', `中间隔着代码的注释不挂给声明，实际 ${JSON.stringify(afterCode.doc)}`);

console.log('\n9. CommonJS 解析');
const cjsSource = [
  'function cjsFn() {',
  '  return 1;',
  '}',
  'with ({ a: 1 }) {',
  '  console.log(a);',
  '}',
  'return;',
].join(NL);

const cjsDecls = symbols.parseJsSymbols(cjsSource, 'cjs');
assert(cjsDecls.some((d) => d.name === 'cjsFn'), 'cjs 能解析 with 和顶层 return');
assert(symbols.parseJsSymbols(cjsSource, 'js').length === 0, '同一份 CJS 按 module 解析确实会失败');

console.log('\n10. 项目查询');
const projectDir = mkdtempSync(join(tmpdir(), 'cmdtb-symbols-'));
mkdirSync(join(projectDir, 'app'), { recursive: true });
mkdirSync(join(projectDir, 'vendor'), { recursive: true });

writeFileSync(
  join(projectDir, 'app', 'current.php'),
  ['<?php', 'namespace App;', 'class Here {', '  public function shared() {}', '}'].join(NL),
  'utf8',
);
writeFileSync(
  join(projectDir, 'app', 'other.php'),
  ['<?php', 'namespace App;', 'class Other {', '  public function shared() {}', '}'].join(NL),
  'utf8',
);
writeFileSync(
  join(projectDir, 'app', 'deep.php'),
  ['<?php', 'namespace App;', 'class Deep {', '  public function shared() {}', '}'].join(NL),
  'utf8',
);
writeFileSync(
  join(projectDir, 'vendor', 'lib.php'),
  ['<?php', 'class Vendor {', '  public function shared() {}', '}'].join(NL),
  'utf8',
);
// public static 修饰 + 大小写混合的声明名：预筛正则必须能命中
writeFileSync(
  join(projectDir, 'app', 'mixed.php'),
  ['<?php', 'namespace App;', 'class Mixed {', '  public static function MixedCase() {}', '}'].join(NL),
  'utf8',
);

try {
  symbols.resetCache();
  const found = await symbols.lookup(projectDir, 'shared', { currentPath: 'app/current.php' });
  assert(found.ok === true, '查询成功');
  assert(found.matches.length === 3, `vendor 被跳过，实际 ${found.matches.length} 条`);
  assert(
    found.matches.every((m) => !m.relPath.startsWith('vendor/')),
    '结果里没有 vendor 下的声明',
  );
  assert(
    found.matches[0].relPath === 'app/current.php',
    `当前文件排第一，实际 ${found.matches[0].relPath}`,
  );
  assert(found.matches[0].line === 4, `行号是 1 起始的声明行，实际 ${found.matches[0].line}`);

  // 上一轮查询里 mixed.php 因预筛未命中被扫过，这里不能因此漏掉
  const mixedHit = await symbols.lookup(projectDir, 'MixedCase', {});
  assert(
    mixedHit.matches.length === 1 && mixedHit.matches[0].relPath === 'app/mixed.php',
    `public static / 大小写混合的声明能被命中，实际 ${mixedHit.matches.length} 条`,
  );

  symbols.resetCache();
  const byReceiver = await symbols.lookup(projectDir, 'shared', {
    currentPath: 'app/other.php',
    receiver: 'Deep',
  });
  assert(
    byReceiver.matches[0].relPath === 'app/other.php',
    '当前文件仍然优先于接收者匹配',
  );

  symbols.resetCache();
  const noCurrent = await symbols.lookup(projectDir, 'shared', { receiver: 'Deep' });
  assert(noCurrent.matches[0].relPath === 'app/deep.php', '接收者同名类优先');

  symbols.resetCache();
  const missing = await symbols.lookup(projectDir, 'nothingHere', {});
  assert(missing.ok === true && missing.matches.length === 0, '查不到时返回空列表而不是报错');

  const tooShort = await symbols.lookup(projectDir, 'a', {});
  assert(tooShort.matches.length === 0, '查询名少于 2 字符直接返回空');

  // 文件改动后 mtime 变化，缓存必须失效
  symbols.resetCache();
  await symbols.lookup(projectDir, 'renamedLater', {});
  writeFileSync(
    join(projectDir, 'app', 'other.php'),
    ['<?php', 'namespace App;', 'class Other {', '  public function renamedLater() {}', '}'].join(NL),
    'utf8',
  );
  const afterEdit = await symbols.lookup(projectDir, 'renamedLater', {});
  assert(afterEdit.matches.length === 1, '文件改动后缓存失效，能查到新声明');
} finally {
  rmSync(projectDir, { recursive: true, force: true });
}

console.log('\n11. 项目隔离与缓存');
const dirA = mkdtempSync(join(tmpdir(), 'cmdtb-symbols-a-'));
const dirB = mkdtempSync(join(tmpdir(), 'cmdtb-symbols-b-'));
const sameTime = new Date(1700000000000);
try {
  writeFileSync(join(dirA, 'a.php'), ['<?php', 'function alphaOnly() {}'].join(NL), 'utf8');
  writeFileSync(join(dirB, 'a.php'), ['<?php', 'function betaOnly() {}'].join(NL), 'utf8');
  // 两个不同项目下的同名相对路径，强制相同 mtime：缓存只按 relPath 作 key 时会串味
  utimesSync(join(dirA, 'a.php'), sameTime, sameTime);
  utimesSync(join(dirB, 'a.php'), sameTime, sameTime);

  symbols.resetCache();
  const aHit = await symbols.lookup(dirA, 'alphaOnly', {});
  assert(aHit.matches.length === 1, '项目 A 能查到自己的声明');
  const bHit = await symbols.lookup(dirB, 'betaOnly', {});
  assert(bHit.matches.length === 1, `不同项目的同名相对路径不串味，实际 ${bHit.matches.length} 条`);
  assert(bHit.matches[0].name === 'betaOnly', '项目 B 拿到的是 B 的声明');

  // 预筛没命中不能把「没解析」当成「没有声明」缓存起来
  writeFileSync(join(dirA, 'b.php'), ['<?php', 'function alphaOnly() {}'].join(NL), 'utf8');
  symbols.resetCache();
  const prefilterMiss = await symbols.lookup(dirA, 'notPresent', {});
  assert(prefilterMiss.matches.length === 0, '预筛未命中时返回空');
  const afterMiss = await symbols.lookup(dirA, 'alphaOnly', {});
  assert(afterMiss.matches.length === 2, `同文件换名字再查不能漏，实际 ${afterMiss.matches.length} 条`);
} finally {
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
}

console.log('\n12. 扫描上限');
const limitDir = mkdtempSync(join(tmpdir(), 'cmdtb-symbols-limit-'));
try {
  writeFileSync(
    join(limitDir, 'huge.php'),
    '<?php function hugeFn() {}\n' + 'x'.repeat(1024 * 1024 + 10),
    'utf8',
  );
  writeFileSync(join(limitDir, 'small.php'), '<?php function smallFn() {}', 'utf8');

  symbols.resetCache();
  const huge = await symbols.lookup(limitDir, 'hugeFn', {});
  assert(huge.matches.length === 0, '单文件超过 1MB 不解析');
  const small = await symbols.lookup(limitDir, 'smallFn', {});
  assert(small.matches.length === 1, '同目录下的小文件仍然能查到');

  const manyDir = join(limitDir, 'many');
  mkdirSync(manyDir, { recursive: true });
  for (let i = 0; i < 4001; i += 1) {
    writeFileSync(join(manyDir, `f${String(i).padStart(4, '0')}.php`), '', 'utf8');
  }

  symbols.resetCache();
  const capped = await symbols.lookup(limitDir, 'zzz', {});
  assert(capped.truncated === true, '超过 4000 个文件时标记 truncated');
  assert(capped.scanned === 4000, `最多扫描 4000 个文件，实际 ${capped.scanned}`);
} finally {
  rmSync(limitDir, { recursive: true, force: true });
}

console.log(`\n全部通过：${passed} 项`);

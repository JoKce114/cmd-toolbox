import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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

// 当前文件故意叫 zzz.php：字典序里它排最后，不实现「当前文件优先」就会选 aaa.php。
writeFileSync(
  join(projectDir, 'app', 'aaa.php'),
  ['<?php', 'namespace App;', 'class Aaa {', '  public function shared() {}', '}'].join(NL),
  'utf8',
);
writeFileSync(
  join(projectDir, 'app', 'bbb.php'),
  ['<?php', 'namespace App;', 'class Bbb {', '  public function shared() {}', '}'].join(NL),
  'utf8',
);
writeFileSync(
  join(projectDir, 'app', 'zzz.php'),
  ['<?php', 'namespace App;', 'class Deep {', '  public function shared() {}', '}'].join(NL),
  'utf8',
);
writeFileSync(
  join(projectDir, 'vendor', 'lib.php'),
  ['<?php', 'class Vendor {', '  public function shared() {}', '}'].join(NL),
  'utf8',
);
// public static 修饰 + 大小写混合的声明名
writeFileSync(
  join(projectDir, 'app', 'mixed.php'),
  ['<?php', 'namespace App;', 'class Mixed {', '  public static function MixedCase() {}', '}'].join(NL),
  'utf8',
);
// 箭头函数赋值：声明里没有 function 关键字，预筛必须按名字本身命中
writeFileSync(join(projectDir, 'app', 'arrow.js'), 'const arrowTarget = () => 1;\n', 'utf8');
// PHP 引用返回：function 与名字之间有 &
writeFileSync(join(projectDir, 'app', 'ref.php'), ['<?php', 'function &refTarget() {}'].join(NL), 'utf8');
// mtime 失效用例的独立文件
writeFileSync(join(projectDir, 'app', 'edited.php'), ['<?php', 'function editBefore() {}'].join(NL), 'utf8');

try {
  symbols.resetCache();
  const found = await symbols.lookup(projectDir, 'shared', { currentPath: 'app/zzz.php' });
  assert(found.ok === true, '查询成功');
  assert(found.matches.length === 3, `vendor 被跳过，实际 ${found.matches.length} 条`);
  assert(
    found.matches.every((m) => !m.relPath.startsWith('vendor/')),
    '结果里没有 vendor 下的声明',
  );
  assert(
    found.matches[0].relPath === 'app/zzz.php',
    `当前文件排第一（字典序最后也能胜出），实际 ${found.matches[0].relPath}`,
  );
  assert(found.matches[0].line === 4, `行号是 1 起始的声明行，实际 ${found.matches[0].line}`);

  // 上一轮查询里 mixed.php 因预筛未命中被扫过，这里不能因此漏掉
  const mixedHit = await symbols.lookup(projectDir, 'MixedCase', {});
  assert(
    mixedHit.matches.length === 1 && mixedHit.matches[0].relPath === 'app/mixed.php',
    `public static / 大小写混合的声明能被命中，实际 ${mixedHit.matches.length} 条`,
  );

  // 大小写不同的查询名：PHP 函数名不敏感，返回的仍是声明里的原始写法
  symbols.resetCache();
  const caseHit = await symbols.lookup(projectDir, 'MIXEDCASE', {});
  assert(
    caseHit.matches.length === 1 && caseHit.matches[0].name === 'MixedCase',
    `大小写不同的查询名能找到定义，实际 ${caseHit.matches.length} 条 / ${caseHit.matches[0] && caseHit.matches[0].name}`,
  );

  // 箭头函数赋值的声明没有 function 关键字，预筛不能漏
  const arrowHit = await symbols.lookup(projectDir, 'arrowTarget', {});
  assert(
    arrowHit.matches.length === 1 && arrowHit.matches[0].relPath === 'app/arrow.js',
    `箭头函数赋值能被查到，实际 ${arrowHit.matches.length} 条`,
  );

  // PHP `function &x()` 的引用返回
  const refHit = await symbols.lookup(projectDir, 'refTarget', {});
  assert(
    refHit.matches.length === 1 && refHit.matches[0].relPath === 'app/ref.php',
    `function &x() 能被查到，实际 ${refHit.matches.length} 条`,
  );

  // 当前文件优先于接收者：不排序会选 aaa.php，接收者优先会选 zzz.php，只有当前文件优先得到 bbb.php
  symbols.resetCache();
  const currentBeatsReceiver = await symbols.lookup(projectDir, 'shared', {
    currentPath: 'app/bbb.php',
    receiver: 'Deep',
  });
  assert(
    currentBeatsReceiver.matches[0].relPath === 'app/bbb.php',
    `当前文件优先于接收者匹配，实际 ${currentBeatsReceiver.matches[0].relPath}`,
  );

  // 接收者优先：Deep 在字典序最后的 zzz.php，不实现该规则会选 aaa.php
  symbols.resetCache();
  const noCurrent = await symbols.lookup(projectDir, 'shared', { receiver: 'Deep' });
  assert(
    noCurrent.matches[0].relPath === 'app/zzz.php',
    `接收者同名类优先，实际 ${noCurrent.matches[0].relPath}`,
  );

  // currentPath 可能是绝对路径或反斜杠形式，必须归一化后才能命中「当前文件优先」
  symbols.resetCache();
  const absCurrent = await symbols.lookup(projectDir, 'shared', {
    currentPath: join(projectDir, 'app', 'zzz.php'),
  });
  assert(absCurrent.matches[0].relPath === 'app/zzz.php', `绝对路径 currentPath 已归一化，实际 ${absCurrent.matches[0].relPath}`);

  symbols.resetCache();
  const slashCurrent = await symbols.lookup(projectDir, 'shared', { currentPath: 'app\\zzz.php' });
  assert(slashCurrent.matches[0].relPath === 'app/zzz.php', `反斜杠 currentPath 已归一化，实际 ${slashCurrent.matches[0].relPath}`);

  symbols.resetCache();
  const nonStringCurrent = await symbols.lookup(projectDir, 'shared', { currentPath: 123 });
  assert(
    nonStringCurrent.matches[0].relPath === 'app/aaa.php',
    `非字符串 currentPath 当作空，实际 ${nonStringCurrent.matches[0].relPath}`,
  );

  symbols.resetCache();
  const missing = await symbols.lookup(projectDir, 'nothingHere', {});
  assert(missing.ok === true && missing.matches.length === 0, '查不到时返回空列表而不是报错');

  const tooShort = await symbols.lookup(projectDir, 'a', {});
  assert(tooShort.matches.length === 0, '查询名少于 2 字符直接返回空');

  // 非法 name 不能被 String() 转成 "[object Object]" 之类的长字符串，
  // 否则会白白触发一次全项目扫描。scanned 为 0 才能证明没有遍历项目。
  const badNameCases = [
    ['对象', { foo: 'bar' }],
    ['数字', 123],
    ['纯空格', '   '],
  ];
  for (const [label, badName] of badNameCases) {
    let result = null;
    let error = null;
    try {
      result = await symbols.lookup(projectDir, badName, {});
    } catch (err) {
      error = err;
    }
    assert(!error, `${label} name 不抛异常，实际 ${error && error.message}`);
    assert(result && result.ok === true, `${label} name 返回成功形状`);
    assert(result && result.matches.length === 0, `${label} name 返回空 matches`);
    assert(result && result.scanned === 0, `${label} name 不扫描项目，实际 ${result && result.scanned}`);
  }

  // 关键字、$ 变量名和超长名字会命中几乎所有文件，必须在遍历之前拒绝。
  // scanned 为 0 证明连目录都没读。
  const rejectedNames = [
    ['$i', '$ 开头的变量名'],
    ['return', '关键字 return'],
    ['function', '关键字 function'],
    ['CLASS', '关键字判定不区分大小写'],
    ['a'.repeat(101), '超过 100 字符的名字'],
  ];
  for (const [badTarget, label] of rejectedNames) {
    const result = await symbols.lookup(projectDir, badTarget, {});
    assert(result && result.ok === true, `${label} 返回成功形状`);
    assert(result && result.matches.length === 0, `${label} 返回空 matches`);
    assert(result && result.scanned === 0, `${label} 不扫描项目，实际 ${result && result.scanned}`);
  }

  // 边界值：恰好 100 字符的合法名字不能被误伤
  const boundaryName = await symbols.lookup(projectDir, 'a'.repeat(100), {});
  assert(boundaryName.ok === true && boundaryName.scanned > 0, `100 字符的名字仍执行查询，实际 ${boundaryName.scanned}`);

  // 先查询一个存在且会被解析的名字（确保写入缓存），再改内容与 mtime：
  // 缓存不失效的话，旧名字仍会命中旧声明。
  symbols.resetCache();
  const beforeEdit = await symbols.lookup(projectDir, 'editBefore', {});
  assert(beforeEdit.matches.length === 1, `改动前能查到旧声明（并写入缓存），实际 ${beforeEdit.matches.length} 条`);
  writeFileSync(
    join(projectDir, 'app', 'edited.php'),
    ['<?php', 'function editAfter() {}'].join(NL),
    'utf8',
  );
  const bumped = new Date(Date.now() + 5000);
  utimesSync(join(projectDir, 'app', 'edited.php'), bumped, bumped);
  const afterEdit = await symbols.lookup(projectDir, 'editBefore', {});
  assert(afterEdit.matches.length === 0, `mtime 变化后旧缓存失效，实际 ${afterEdit.matches.length} 条`);
  const afterEditNew = await symbols.lookup(projectDir, 'editAfter', {});
  assert(afterEditNew.matches.length === 1, `mtime 变化后能查到新声明，实际 ${afterEditNew.matches.length} 条`);
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

console.log('\n13. 排序规则');
const orderDir = mkdtempSync(join(tmpdir(), 'cmdtb-symbols-order-'));
try {
  // 命名空间优先：当前文件在 Wanted，bbb 在 Wanted，aaa 在 Other。
  // 不实现命名空间规则时字典序会先选 aaa。
  mkdirSync(join(orderDir, 'ns'), { recursive: true });
  writeFileSync(
    join(orderDir, 'ns', 'aaa.php'),
    ['<?php', 'namespace Other;', 'function nsTarget() {}'].join(NL),
    'utf8',
  );
  writeFileSync(
    join(orderDir, 'ns', 'bbb.php'),
    ['<?php', 'namespace Wanted;', 'function nsTarget() {}'].join(NL),
    'utf8',
  );
  writeFileSync(
    join(orderDir, 'ns', 'zzz.php'),
    ['<?php', 'namespace Wanted;', 'class Context {}'].join(NL),
    'utf8',
  );

  symbols.resetCache();
  const byNamespace = await symbols.lookup(orderDir, 'nsTarget', { currentPath: 'ns/zzz.php' });
  assert(
    byNamespace.matches.length === 2 && byNamespace.matches[0].relPath === 'ns/bbb.php',
    `同命名空间优先（不实现会选 aaa），实际 ${byNamespace.matches.map((m) => m.relPath).join(', ')}`,
  );

  // 路径深度优先：浅的在前。字典序会把更深的 a/b/deep.php 排到最前。
  mkdirSync(join(orderDir, 'depth', 'a', 'b'), { recursive: true });
  writeFileSync(join(orderDir, 'depth', 'shallow.php'), ['<?php', 'function depthTarget() {}'].join(NL), 'utf8');
  writeFileSync(join(orderDir, 'depth', 'a', 'mid.php'), ['<?php', 'function depthTarget() {}'].join(NL), 'utf8');
  writeFileSync(join(orderDir, 'depth', 'a', 'b', 'deep.php'), ['<?php', 'function depthTarget() {}'].join(NL), 'utf8');

  symbols.resetCache();
  const byDepth = await symbols.lookup(orderDir, 'depthTarget', {});
  assert(
    JSON.stringify(byDepth.matches.map((m) => m.relPath)) ===
      JSON.stringify(['depth/shallow.php', 'depth/a/mid.php', 'depth/a/b/deep.php']),
    `路径浅的优先，实际 ${byDepth.matches.map((m) => m.relPath).join(', ')}`,
  );

  // 字典序与深度直接测排序函数：NTFS 的 readdir 本身就返回字母序，
  // 靠临时目录的写入顺序构造「反字典序」并不可靠，用例会恒真。
  // 现在传入构造好的 match 对象，去掉 localeCompare 或深度规则都会立刻失败。
  const shallowMatch = { relPath: 'a.php', owner: '', namespace: '' };
  const deepMatch = { relPath: 'dir/b.php', owner: '', namespace: '' };
  assert(
    symbols.compareMatches(shallowMatch, deepMatch, {}) < 0,
    '纯函数：浅路径排在深路径前',
  );
  assert(
    symbols.compareMatches(deepMatch, shallowMatch, {}) > 0,
    '纯函数：反向输入时深路径排在浅路径后',
  );
  assert(
    symbols.compareMatches({ relPath: 'zeta.php' }, { relPath: 'alpha.php' }, {}) > 0,
    '纯函数：同深度按字典序，倒序输入仍是 alpha 在前',
  );
} finally {
  rmSync(orderDir, { recursive: true, force: true });
}

console.log('\n14. currentPath 越界防护');
const escapeParent = mkdtempSync(join(tmpdir(), 'cmdtb-symbols-escape-'));
const escapeDir = join(escapeParent, 'project');
const outsideDir = join(escapeParent, 'outside');
try {
  mkdirSync(escapeDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  // 项目外文件带 Secret 命名空间。若 namespaceOf 读了它，查询会把 bbb.php 排到最前。
  writeFileSync(
    join(outsideDir, 'outside.php'),
    ['<?php', 'namespace Secret;', 'class Fake {}'].join(NL),
    'utf8',
  );
  writeFileSync(
    join(escapeDir, 'aaa.php'),
    ['<?php', 'namespace Other;', 'function leakTarget() {}'].join(NL),
    'utf8',
  );
  writeFileSync(
    join(escapeDir, 'bbb.php'),
    ['<?php', 'namespace Secret;', 'function leakTarget() {}'].join(NL),
    'utf8',
  );

  const byDotDot = await symbols.lookup(escapeDir, 'leakTarget', { currentPath: '../outside/outside.php' });
  assert(
    byDotDot.matches[0].relPath === 'aaa.php',
    `../ 越界不提供命名空间，实际 ${byDotDot.matches[0].relPath}`,
  );

  // 指向项目外的符号链接同样不能读。本机普通账户没有创建文件符号链接的权限（EPERM），
  // 退到目录联接（junction），它走同一条 realpath 校验。
  let linkCurrent = '';
  try {
    symlinkSync(join(outsideDir, 'outside.php'), join(escapeDir, 'link.php'), 'file');
    linkCurrent = 'link.php';
  } catch {
    symlinkSync(outsideDir, join(escapeDir, 'link'), 'junction');
    linkCurrent = 'link/outside.php';
  }
  const byLink = await symbols.lookup(escapeDir, 'leakTarget', { currentPath: linkCurrent });
  assert(
    byLink.matches[0].relPath === 'aaa.php',
    `符号链接指向项目外时不提供命名空间（${linkCurrent}），实际 ${byLink.matches[0].relPath}`,
  );
} finally {
  rmSync(escapeParent, { recursive: true, force: true });
}

console.log('\n15. 大小写规则按语言区分');
const caseDir = mkdtempSync(join(tmpdir(), 'cmdtb-symbols-case-'));
try {
  // JS 里 Foo 与 foo 是两个不同的标识符
  writeFileSync(
    join(caseDir, 'names.js'),
    ['function Foo() {}', 'function foo() {}'].join(NL),
    'utf8',
  );

  symbols.resetCache();
  const jsLower = await symbols.lookup(caseDir, 'foo', {});
  assert(
    jsLower.matches.length === 1 &&
      jsLower.matches[0].name === 'foo' &&
      jsLower.matches[0].relPath === 'names.js',
    `JS 区分大小写：查 foo 只命中 foo，实际 ${jsLower.matches.map((m) => `${m.name}@${m.relPath}`).join(', ')}`,
  );

  // PHP 里的 Foo 对大小写不敏感，同一个查询应同时命中它和 JS 的 foo
  writeFileSync(join(caseDir, 'legacy.php'), ['<?php', 'function Foo() {}'].join(NL), 'utf8');

  symbols.resetCache();
  const withPhp = await symbols.lookup(caseDir, 'foo', {});
  const hitJsLower = withPhp.matches.some((m) => m.relPath === 'names.js' && m.name === 'foo');
  const hitJsUpper = withPhp.matches.some((m) => m.relPath === 'names.js' && m.name === 'Foo');
  const hitPhpUpper = withPhp.matches.some((m) => m.relPath === 'legacy.php' && m.name === 'Foo');
  assert(hitJsLower, 'PHP 存在时 JS 的 foo 仍被命中');
  assert(!hitJsUpper, 'PHP 存在时 JS 的 Foo 仍不被 foo 命中');
  assert(hitPhpUpper, 'PHP 大小写不敏感：查 foo 命中 PHP 的 Foo');
} finally {
  rmSync(caseDir, { recursive: true, force: true });
}

console.log('\n16. 解析文件数上限');
const parseLimitDir = mkdtempSync(join(tmpdir(), 'cmdtb-symbols-parse-limit-'));
try {
  // 350 个文件都含同一个声明：不设解析上限时会全部交给 php-parser。
  for (let i = 0; i < 350; i += 1) {
    writeFileSync(
      join(parseLimitDir, `f${String(i).padStart(3, '0')}.php`),
      ['<?php', 'function capTarget() {}'].join(NL),
      'utf8',
    );
  }

  symbols.resetCache();
  const capped = await symbols.lookup(parseLimitDir, 'capTarget', {});
  assert(capped.truncated === true, '实际解析文件数超过上限时标记 truncated');
  assert(capped.matches.length < 350, `解析数被上限截住，实际 ${capped.matches.length}`);
  assert(capped.scanned === 350, `scanned 仍报告收集到的文件数，实际 ${capped.scanned}`);
} finally {
  rmSync(parseLimitDir, { recursive: true, force: true });
}

console.log('\n17. 调用点不能占用解析预算');
const callSiteDir = mkdtempSync(join(tmpdir(), 'cmdtb-symbols-callsite-'));
try {
  // 200 个文件只有调用、没有声明；真正的声明放在字典序最后。
  // 预筛若把调用当命中，解析预算会被调用点耗光，声明永远轮不到。
  for (let i = 0; i < 200; i += 1) {
    writeFileSync(
      join(callSiteDir, `a${String(i).padStart(3, '0')}.php`),
      ['<?php', '$x = HelpFile::getBaseName($y);'].join(NL),
      'utf8',
    );
  }
  writeFileSync(
    join(callSiteDir, 'zzdecl.php'),
    ['<?php', 'class HelpFile {', '  public static function getBaseName($p) { return $p; }', '}'].join(NL),
    'utf8',
  );

  symbols.resetCache();
  const found = await symbols.lookup(callSiteDir, 'getBaseName', {});
  assert(found.truncated === false, `调用点不该触发截断，实际 truncated=${found.truncated}`);
  assert(found.matches.length === 1, `只收集到真实声明，实际 ${found.matches.length} 条`);
  assert(
    found.matches[0].relPath === 'zzdecl.php',
    `找到字典序末尾的声明，实际 ${found.matches[0].relPath}`,
  );
  assert(found.matches[0].owner === 'HelpFile', '声明带所属类');
} finally {
  rmSync(callSiteDir, { recursive: true, force: true });
}

console.log('\n18. PHP 变量只搜当前文件');
const varDir = mkdtempSync(join(tmpdir(), 'cmdtb-symbols-var-'));
try {
  writeFileSync(
    join(varDir, 'here.php'),
    [
      '<?php',
      '$extName = HelpsFile::getExtName($amazonImage);',
      'if ($extName == "jpg") { echo $extName; }',
      '$extName = strtolower($extName);',
    ].join(NL),
    'utf8',
  );
  // 另一个文件也有同名变量，但变量不跨文件搜索
  writeFileSync(join(varDir, 'elsewhere.php'), ['<?php', '$extName = "x";'].join(NL), 'utf8');
  writeFileSync(join(varDir, 'other.php'), ['<?php', '$unrelated = 1;'].join(NL), 'utf8');

  symbols.resetCache();
  const vars = await symbols.lookup(varDir, '$extName', { currentPath: 'here.php' });
  assert(vars.matches.length === 2, `只收集两处赋值，实际 ${vars.matches.length}`);
  assert(
    vars.matches.every((m) => m.relPath === 'here.php'),
    '命中项全部来自当前文件',
  );
  assert(
    vars.matches.every((m) => m.kind === 'variable'),
    'kind 标记为 variable',
  );
  assert(vars.matches[0].line === 2, `第一次赋值在第 2 行，实际 ${vars.matches[0].line}`);
  assert(
    vars.matches[0].signature === '$extName = HelpsFile::getExtName($amazonImage);',
    `签名取整行原文，实际 ${vars.matches[0].signature}`,
  );
  assert(
    !vars.matches.some((m) => m.line === 3),
    '== 比较不算赋值',
  );

  symbols.resetCache();
  const notHere = await symbols.lookup(varDir, '$extName', { currentPath: 'other.php' });
  assert(notHere.matches.length === 0, '当前文件没有该变量时不跨文件查找');

  symbols.resetCache();
  const noFile = await symbols.lookup(varDir, '$extName', {});
  assert(noFile.matches.length === 0, '没有当前文件信息时返回空');
} finally {
  rmSync(varDir, { recursive: true, force: true });
}

console.log(`\n全部通过：${passed} 项`);

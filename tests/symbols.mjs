import { createRequire } from 'node:module';

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

console.log(`\n全部通过：${passed} 项`);

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

console.log(`\n全部通过：${passed} 项`);

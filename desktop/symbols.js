// 扫描时跳过的目录：依赖和产物目录里同名声明太多，还会把扫描拖慢
// （Task 3 扫描项目时使用，本文件目前未引用）
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'dist', 'release', 'release-build']);

let phpEngine = null;

function loadPhpEngine() {
  if (phpEngine) return phpEngine;
  const { Engine } = require('php-parser');
  phpEngine = new Engine({
    parser: { extractDoc: true, suppressErrors: true },
    ast: { withPositions: true },
  });
  return phpEngine;
}

// php-parser 给的 value 是带 /** 和 */ 的原文，这里只留正文，
// 并去掉每行开头的「 * 」，卡片里可以直接按行渲染
function cleanDoc(raw) {
  const text = String(raw || '')
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '');
  // /**/ 这类空注释的起止定界符共用中间那颗星，去掉开头后只剩 /，直接清空
  if (/^[*/]*$/.test(text)) return '';
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*?\s?/, '').trimEnd())
    .join('\n')
    .trim();
}

// 从节点源码里截出声明头：遇到 { 或 => 就停，压平空白。
// 比用 AST 重新拼参数更忠实（能保留默认值和类型写法的原样）。
// php-parser 的偏移在 loc.start.offset，acorn 则直接给 start/end，两种都认。
function sourceSignature(text, node, stops) {
  const locStart = node && node.loc && node.loc.start && node.loc.start.offset;
  const locEnd = node && node.loc && node.loc.end && node.loc.end.offset;
  const start = typeof locStart === 'number' ? locStart : node && node.start;
  const end = typeof locEnd === 'number' ? locEnd : node && node.end;
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return '';
  let slice = text.slice(start, end);
  let cut = slice.length;
  for (const stop of stops) {
    const index = slice.indexOf(stop);
    if (index >= 0 && index < cut) cut = index;
  }
  return slice
    .slice(0, cut)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;$/, '');
}

function docOf(node) {
  const list = Array.isArray(node && node.leadingComments) ? node.leadingComments : [];
  const last = list.filter((item) => item && typeof item.value === 'string').pop();
  // 只有紧贴在声明前的 /** */ 才算 docblock；//、#、/* */ 都不是
  if (!last || !last.value.trimStart().startsWith('/**')) return '';
  return cleanDoc(last.value);
}

function lineOf(node) {
  const line = node && node.loc && node.loc.start && node.loc.start.line;
  return typeof line === 'number' && line > 0 ? line : 1;
}

// 只收集声明本身；绝不递归进函数/方法体，避免闭包和局部定义混进来
function walkPhp(node, text, namespace, owner, out) {
  if (!node || typeof node !== 'object' || !node.kind) return;

  // php-parser 的根节点是 program，本身不是声明，只负责往下走
  if (node.kind === 'program') {
    for (const child of node.children || []) walkPhp(child, text, namespace, owner, out);
    return;
  }

  if (node.kind === 'namespace') {
    const next = node.name ? String(node.name) : namespace;
    for (const child of node.children || []) walkPhp(child, text, next, owner, out);
    return;
  }

  if (node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait') {
    const name = node.name && node.name.name ? String(node.name.name) : '';
    if (name) {
      out.push({
        kind: 'class',
        name,
        owner: '',
        namespace,
        line: lineOf(node),
        signature: `${node.kind} ${name}`,
        doc: docOf(node),
      });
    }
    for (const member of node.body || []) walkPhp(member, text, namespace, name, out);
    return;
  }

  if (node.kind === 'method') {
    const name = node.name && node.name.name ? String(node.name.name) : '';
    if (name) {
      out.push({
        kind: 'method',
        name,
        owner,
        namespace,
        line: lineOf(node),
        signature: sourceSignature(text, node, ['{', ';']),
        doc: docOf(node),
      });
    }
    return;
  }

  if (node.kind === 'function') {
    const name = node.name && node.name.name ? String(node.name.name) : '';
    if (name) {
      out.push({
        kind: 'function',
        name,
        owner: '',
        namespace,
        line: lineOf(node),
        signature: sourceSignature(text, node, ['{', ';']),
        doc: docOf(node),
      });
    }
  }
}

function parsePhpSymbols(text) {
  if (!String(text || '').includes('<?php')) return [];
  const engine = loadPhpEngine();
  let ast;
  try {
    ast = engine.parseCode(text, 'input.php');
  } catch {
    return [];
  }
  const out = [];
  try {
    walkPhp(ast, text, '', '', out);
  } catch {
    return [];
  }
  return out;
}

// JSDoc 只有紧贴声明时才认：从声明起点往前跳过空白，必须正好接在 */ 上
function jsDocBefore(text, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(text[cursor])) cursor -= 1;
  if (cursor < 1 || text[cursor] !== '/' || text[cursor - 1] !== '*') return '';
  const closing = cursor + 1;
  const opening = text.lastIndexOf('/**', closing);
  if (opening < 0) return '';
  return cleanDoc(text.slice(opening, closing));
}

function walkJs(node, text, out) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;

  if (node.type === 'FunctionDeclaration' && node.id && node.id.name) {
    out.push({
      kind: 'function',
      name: node.id.name,
      owner: '',
      namespace: '',
      line: node.loc ? node.loc.start.line : 1,
      signature: sourceSignature(text, node, ['{']),
      doc: jsDocBefore(text, node.start),
    });
    return;
  }

  if (node.type === 'ClassDeclaration' && node.id && node.id.name) {
    out.push({
      kind: 'class',
      name: node.id.name,
      owner: '',
      namespace: '',
      line: node.loc ? node.loc.start.line : 1,
      signature: `class ${node.id.name}`,
      doc: jsDocBefore(text, node.start),
    });
    return;
  }

  if (node.type === 'VariableDeclarator' && node.id && node.id.name && node.init) {
    const init = node.init;
    if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
      out.push({
        kind: 'function',
        name: node.id.name,
        owner: '',
        namespace: '',
        line: node.loc ? node.loc.start.line : 1,
        signature: sourceSignature(text, node, ['=>']),
        doc: jsDocBefore(text, node.start),
      });
      return;
    }
  }

  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) walkJs(item, text, out);
    } else if (value && typeof value === 'object') {
      walkJs(value, text, out);
    }
  }
}

function parseJsSymbols(text, lang) {
  const source = String(text || '');
  if (!source.trim()) return [];
  let parser;
  try {
    const acorn = require('acorn');
    if (lang === 'jsx') {
      const jsx = require('acorn-jsx');
      const plugin = typeof jsx === 'function' ? jsx : jsx.default;
      parser = acorn.Parser.extend(plugin());
    } else {
      parser = acorn.Parser;
    }
  } catch {
    return [];
  }

  let ast;
  try {
    ast = parser.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
      allowHashBang: true,
    });
  } catch {
    return [];
  }

  const out = [];
  try {
    walkJs(ast, source, out);
  } catch {
    return [];
  }
  return out;
}

module.exports = { parsePhpSymbols, parseJsSymbols, cleanDoc };

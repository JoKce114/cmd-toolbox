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

// acorn 的声明节点起点经常落在 export/default/const 之后，回溯时把这些前缀也跳过
const JS_PREFIX_KEYWORDS = new Set(['export', 'default', 'async', 'const', 'let', 'var', 'declare']);

// JSDoc 只有紧贴声明时才认：从声明起点往前只允许空白和声明前缀关键字，
// 且注释必须独占一行（排除上一行语句末尾的 /** */ 尾注释），中间最多隔一个换行
// （排除隔空行认领文件头注释）。
function jsDocBefore(text, index) {
  let cursor = index;
  for (;;) {
    while (cursor > 0 && /\s/.test(text[cursor - 1])) cursor -= 1;
    if (cursor >= 2 && text[cursor - 1] === '/' && text[cursor - 2] === '*') {
      const closing = cursor;
      const opening = text.lastIndexOf('/**', closing);
      if (opening < 0) return '';
      const lineStart = text.lastIndexOf('\n', opening - 1) + 1;
      if (text.slice(lineStart, opening).trim() !== '') return '';
      if ((text.slice(closing, index).match(/\n/g) || []).length > 1) return '';
      return cleanDoc(text.slice(opening, closing));
    }
    const wordEnd = cursor;
    while (cursor > 0 && /[A-Za-z_$]/.test(text[cursor - 1])) cursor -= 1;
    if (cursor === wordEnd) return '';
    if (!JS_PREFIX_KEYWORDS.has(text.slice(cursor, wordEnd))) return '';
  }
}

// JS 声明签名：按参数列表的右括号截断，而不是按第一个 {（解构参数和默认值里的 { 都在括号内）。
// 箭头函数没有参数括号时退回到 =>；arrowBodyStart 用来避开函数体里嵌套的 =>。
function jsSignature(text, start, end, arrowBodyStart) {
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return '';
  const slice = text.slice(start, end);
  const normalize = (value) => value.replace(/\s+/g, ' ').trim().replace(/;$/, '');

  if (typeof arrowBodyStart === 'number') {
    const arrowIndex = slice.lastIndexOf('=>', arrowBodyStart - start);
    if (arrowIndex >= 0) return normalize(slice.slice(0, arrowIndex));
  }

  const open = slice.indexOf('(');
  if (open < 0) return normalize(slice);

  let depth = 0;
  let quote = '';
  for (let i = open; i < slice.length; i += 1) {
    const char = slice[i];
    if (quote) {
      if (char === '\\') {
        i += 1;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return normalize(slice.slice(0, i + 1));
    }
  }
  return normalize(slice);
}

function walkJs(node, text, out) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;

  // 函数和类节点一律不递归：无论是否被收集，函数体/类体里都是局部声明和闭包，
  // 不是调用方想跳转的目标。匿名函数和 IIFE 也靠这里挡住。
  if (node.type === 'FunctionDeclaration') {
    if (node.id && node.id.name) {
      out.push({
        kind: 'function',
        name: node.id.name,
        owner: '',
        namespace: '',
        line: node.loc ? node.loc.start.line : 1,
        signature: jsSignature(text, node.start, node.end),
        doc: jsDocBefore(text, node.start),
      });
    }
    return;
  }

  if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') return;

  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
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
    }
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
        signature: jsSignature(
          text,
          node.start,
          node.end,
          init.type === 'ArrowFunctionExpression' && init.body ? init.body.start : undefined,
        ),
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
    // .cjs 是 CommonJS：with 和顶层 return（Node 会包进函数里）都是合法的脚本语法，
    // 按 module 解析会整文件报错并返回空。
    const cjs = lang === 'cjs';
    ast = parser.parse(source, {
      ecmaVersion: 'latest',
      sourceType: cjs ? 'script' : 'module',
      allowReturnOutsideFunction: cjs,
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

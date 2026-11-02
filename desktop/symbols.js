// 扫描时跳过的目录：依赖和产物目录里同名声明太多，还会把扫描拖慢
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'dist', 'release', 'release-build']);

const fsp = require('fs/promises');
const path = require('path');
const { resolveWithin } = require('./path-guard');

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

// ---------------------------------------------------------------------------
// 项目符号索引
//
// 早期实现是「每次点击遍历项目、按预算截断」，在真实项目上不成立：
// develop-6.0 有 79600 个目录项、4499 个 PHP 文件，任何预算都会漏掉
// 后半部分的文件，表现为「明明有定义却提示找不到」。
//
// 现在改为持久化索引：首次打开项目时全量扫描一次（实测 5540 个文件约 420ms，
// 索引 JSON 约 1.5MB），之后每次查询只读索引（毫秒级），不再有截断。
// 索引只存「名字 → 文件:行」，签名和 docblock 在命中后解析那 1-3 个文件，
// 所以准确性不受影响。
// ---------------------------------------------------------------------------

const crypto = require('crypto');

const MAX_NAME_LENGTH = 100;
// 关键字不可能对应声明，命中面却几乎覆盖全项目。PHP 关键字不区分大小写，
// 所以统一按小写比较；列表取 PHP/JS 的常见集合，不必穷举。
const RESERVED_NAMES = new Set([
  'return', 'function', 'class', 'const', 'let', 'var', 'if', 'else', 'for', 'while',
  'echo', 'new', 'static', 'public', 'private', 'protected', 'use', 'namespace',
  'true', 'false', 'null', 'undefined', 'this', 'self', 'parent',
  'interface', 'trait', 'extends', 'implements', 'abstract', 'final', 'switch', 'case',
  'break', 'continue', 'do', 'try', 'catch', 'finally', 'throw', 'instanceof', 'typeof',
  'delete', 'in', 'export', 'import', 'default', 'super', 'void', 'with', 'enum',
]);
const MAX_FILE_BYTES = 1024 * 1024;
const PHP_EXT = new Set(['.php']);
const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx']);

const INDEX_VERSION = 1;
// 没有文件监听，只能定期重建。重建在后台跑，期间继续用旧索引。
const INDEX_TTL = 10 * 60 * 1000;

let indexDir = '';

// 主进程在 whenReady 里指定索引目录；单测不配置时只用内存索引
function configure(options = {}) {
  indexDir = typeof options.indexDir === 'string' ? options.indexDir : '';
}

// root → { index, building }。index 是最后一次成功构建的结果。
const indexMem = new Map();

// 供测试清空内存索引，下次查询会重新建
function resetCache() {
  indexMem.clear();
}

// 项目里的文件被应用自己写过（保存、压缩产物、git 切分支）时调用：
// 丢掉内存索引，下一次查询同步重建。只丢内存不删磁盘文件，
// 重建失败时还能退化到旧数据。
function invalidate(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath) return;
  indexMem.delete(path.resolve(projectPath));
}

function emptyResult() {
  return { ok: true, matches: [], truncated: false, scanned: 0 };
}

function isValidName(name) {
  if (name.length > MAX_NAME_LENGTH) return false;
  if (name.startsWith('$')) return false;
  return !RESERVED_NAMES.has(name.toLowerCase());
}

function shouldSkipDir(name) {
  return SKIP_DIRS.has(name) || name.startsWith('release-build');
}

function indexPathFor(root) {
  if (!indexDir) return '';
  const hash = crypto
    .createHash('sha1')
    .update(path.resolve(root).toLowerCase())
    .digest('hex')
    .slice(0, 16);
  return path.join(indexDir, `${hash}.json`);
}

// 逐行提取声明。刻意不用 AST：全量索引要扫几千个文件，
// php-parser 平均 22ms/文件，全量要一分多钟；这里只需要名字和行号，
// 精确的签名和 docblock 等命中后再由 AST 补。
function scanFileSymbols(text, isPhp) {
  const out = [];
  let owner = '';
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // 不能用 ^ 锚行首：PHP 文件第一行常是 `<?php function foo()`，
    // 名字前面还有 `<?php ` 前缀。用「非标识符字符」作左边界。
    const cls =
      /(?:^|[^\w$])(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+([A-Za-z_]\w*)/.exec(line);
    if (cls) {
      owner = cls[1];
      out.push({ name: cls[1], line: index + 1, kind: 'class', owner: '' });
      continue;
    }
    const fn =
      /(?:^|[^\w$])(?:(?:public|private|protected|static|async|export|default|abstract|final)\s+)*function\s+&?\s*([A-Za-z_]\w*)/.exec(
        line,
      );
    if (fn) {
      out.push({ name: fn[1], line: index + 1, kind: owner ? 'method' : 'function', owner });
      continue;
    }
    if (isPhp) continue;
    const assigned =
      /(?:^|[^\w$])(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (assigned) out.push({ name: assigned[1], line: index + 1, kind: 'function', owner: '' });
  }
  return out;
}

async function collectSourceFiles(root) {
  const files = [];
  async function walk(relDir) {
    let entries;
    try {
      entries = await fsp.readdir(path.join(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        await walk(relPath);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (PHP_EXT.has(ext) || JS_EXT.has(ext)) files.push(relPath);
    }
  }
  await walk('');
  return files;
}

async function buildIndex(root) {
  const files = await collectSourceFiles(root);
  const symbols = Object.create(null);
  const fileMap = Object.create(null);

  for (const relPath of files) {
    let stat;
    let text;
    try {
      stat = await fsp.stat(path.join(root, relPath));
      if (stat.size > MAX_FILE_BYTES) continue;
      text = await fsp.readFile(path.join(root, relPath), 'utf8');
    } catch {
      continue;
    }
    fileMap[relPath] = stat.mtimeMs;

    const isPhp = PHP_EXT.has(path.extname(relPath).toLowerCase());
    for (const symbol of scanFileSymbols(text, isPhp)) {
      // key 用小写：PHP 标识符不区分大小写，查 getbasename 也要能命中
      // getBaseName。条目里保留原始写法，返回给界面时用。
      const key = symbol.name.toLowerCase();
      const list = symbols[key] || (symbols[key] = []);
      list.push([relPath, symbol.line, symbol.kind, symbol.owner, symbol.name]);
    }
  }

  return { version: INDEX_VERSION, root, builtAt: Date.now(), files: fileMap, symbols };
}

async function loadIndexFromDisk(file) {
  if (!file) return null;
  try {
    const data = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (!data || data.version !== INDEX_VERSION || typeof data.symbols !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

async function persistIndex(file, index) {
  if (!file) return;
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify(index), 'utf8');
  } catch {
    // 写不进去只是下次还要重建，不影响本次查询
  }
}

async function ensureIndex(root) {
  const cached = indexMem.get(root);
  if (cached && cached.index) return cached.index;
  if (cached && cached.building) return cached.building;

  const entry = cached || {};
  indexMem.set(root, entry);

  entry.building = (async () => {
    const file = indexPathFor(root);
    const fromDisk = await loadIndexFromDisk(file);
    if (fromDisk && path.resolve(fromDisk.root).toLowerCase() === root.toLowerCase()) {
      entry.index = fromDisk;
      return fromDisk;
    }
    const built = await buildIndex(root);
    entry.index = built;
    await persistIndex(file, built);
    return built;
  })();

  try {
    return await entry.building;
  } finally {
    entry.building = null;
  }
}

// 索引过期时后台重建，重建期间继续用旧索引
function refreshIfStale(root, index) {
  if (!index || Date.now() - index.builtAt < INDEX_TTL) return;
  const entry = indexMem.get(root);
  if (!entry || entry.building) return;
  entry.building = (async () => {
    const built = await buildIndex(root);
    entry.index = built;
    await persistIndex(indexPathFor(root), built);
    return built;
  })();
  entry.building.finally(() => {
    entry.building = null;
  });
}

// 打开项目时调用：把索引建好，用户第一次 Ctrl+点击就已经是快的
async function warmIndex(projectPath) {
  const root = path.resolve(projectPath);
  const index = await ensureIndex(root);
  refreshIfStale(root, index);
  return { ok: true, files: Object.keys(index.files).length };
}

function normalizeCurrentPath(root, value) {
  if (typeof value !== 'string' || !value) return '';
  let rel = value;
  try {
    if (path.isAbsolute(rel)) rel = path.relative(root, rel);
  } catch {
    return '';
  }
  rel = rel.split(path.sep).join('/');
  if (!rel || rel === '.' || rel.startsWith('../') || rel === '..') return '';
  // currentPath 来自渲染进程，除了词法越界还要挡符号链接逃逸：
  // 项目内一个指向项目外的链接，读它等于读到项目外的文件。
  try {
    resolveWithin(root, rel);
  } catch {
    return '';
  }
  return rel;
}

// PHP 标识符不区分大小写，JS 标识符区分。
// 判断依据是声明所在文件的扩展名：同一个查询名在两种语言里的语义不同。
function nameMatches(declName, relPath, target, targetLower) {
  if (PHP_EXT.has(path.extname(relPath).toLowerCase())) {
    return declName.toLowerCase() === targetLower;
  }
  return declName === target;
}

function depthOf(relPath) {
  return relPath.split('/').length;
}

function compareMatches(a, b, context) {
  const aCurrent = a.relPath === context.currentPath ? 0 : 1;
  const bCurrent = b.relPath === context.currentPath ? 0 : 1;
  if (aCurrent !== bCurrent) return aCurrent - bCurrent;

  if (context.receiver) {
    const aOwner = a.owner && a.owner.toLowerCase() === context.receiver.toLowerCase() ? 0 : 1;
    const bOwner = b.owner && b.owner.toLowerCase() === context.receiver.toLowerCase() ? 0 : 1;
    if (aOwner !== bOwner) return aOwner - bOwner;
  }

  if (context.namespace) {
    const aNs = a.namespace === context.namespace ? 0 : 1;
    const bNs = b.namespace === context.namespace ? 0 : 1;
    if (aNs !== bNs) return aNs - bNs;
  }

  const depth = depthOf(a.relPath) - depthOf(b.relPath);
  if (depth !== 0) return depth;
  return a.relPath.localeCompare(b.relPath);
}

// 当前文件所属的命名空间，用于「同命名空间优先」
async function namespaceOf(root, relPath) {
  if (!relPath || !PHP_EXT.has(path.extname(relPath).toLowerCase())) return '';
  let text;
  try {
    text = await fsp.readFile(path.join(root, relPath), 'utf8');
  } catch {
    return '';
  }
  const hit = parsePhpSymbols(text).find((item) => item.namespace);
  return hit ? hit.namespace : '';
}

// self:: / static:: / $this-> 的接收者不是类名，要换成光标所在的类
async function enclosingClassName(root, currentPath, line) {
  if (!currentPath || !line) return '';
  let text;
  try {
    text = await fsp.readFile(path.join(root, currentPath), 'utf8');
  } catch {
    return '';
  }
  const lines = text.split(/\r?\n/);
  const limit = Math.min(line, lines.length);
  let owner = '';
  for (let index = 0; index < limit; index += 1) {
    const match = /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+([A-Za-z_]\w*)/.exec(
      lines[index],
    );
    if (match) owner = match[1];
  }
  return owner;
}

// 索引只给了位置，签名和 docblock 要读那几个文件由 AST 补。
// 命中的通常只有 1-3 个文件，成本可以忽略。
async function resolveCandidates(root, candidates, target) {
  const targetLower = target.toLowerCase();
  const byFile = new Set();
  for (const [relPath] of candidates) byFile.add(relPath);

  const matches = [];
  for (const relPath of byFile) {
    let text;
    try {
      text = await fsp.readFile(path.join(root, relPath), 'utf8');
    } catch {
      continue;
    }
    const ext = path.extname(relPath).toLowerCase();
    const decls = PHP_EXT.has(ext)
      ? parsePhpSymbols(text)
      : parseJsSymbols(text, ext.slice(1));
    for (const decl of decls) {
      if (!nameMatches(decl.name, relPath, target, targetLower)) continue;
      matches.push({ ...decl, relPath });
    }
  }
  return matches;
}

// PHP 局部变量与函数参数只搜当前文件：找赋值点和 `function foo($name, ...)` 的
// 参数声明。变量没有 docblock，卡片上能提供的信息就是它出现的那一行。
// 光标所在函数的行范围（1 起，闭区间）。找不到、或光标不在该函数体内时返回 null，
// 表示光标在顶层代码里，此时变量按整个文件找。
// 用括号配对定边界：缩进在 PHP/JS 混排的模板里不可靠。
function enclosingScope(lines, cursorLine) {
  const limit = Math.min(Math.max(Number(cursorLine) || 0, 1), lines.length);

  // 从光标行往前找最近的函数声明
  let fnLine = -1;
  for (let index = limit - 1; index >= 0; index -= 1) {
    if (/\bfunction\b/.test(lines[index])) {
      fnLine = index;
      break;
    }
  }
  if (fnLine < 0) return null;

  // 从声明行开始配对花括号，找到函数体结束行
  let depth = 0;
  let started = false;
  for (let index = fnLine; index < lines.length; index += 1) {
    for (const ch of lines[index]) {
      if (ch === '{') {
        depth += 1;
        started = true;
      } else if (ch === '}') {
        depth -= 1;
      }
    }
    if (started && depth <= 0) {
      const scope = { start: fnLine + 1, end: index + 1 };
      // 光标在函数体之后（例如两个方法之间的空白）就不算在作用域里
      if (limit < scope.start || limit > scope.end) return null;
      return scope;
    }
  }
  const scope = { start: fnLine + 1, end: lines.length };
  if (limit < scope.start) return null;
  return scope;
}

// PHP 局部变量与函数参数只搜光标所在方法：同名变量在别的方法里出现时，
// 不该被当成「定义」跳过去。找不到所在方法（顶层代码）时退回整个文件。
async function lookupLocalVariable(root, currentPath, name, cursorLine) {
  if (!currentPath) return emptyResult();
  if (!PHP_EXT.has(path.extname(currentPath).toLowerCase())) return emptyResult();

  let text;
  try {
    text = await fsp.readFile(path.join(root, currentPath), 'utf8');
  } catch {
    return emptyResult();
  }

  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `=` 后面紧跟 `=` 或 `>` 时是比较/箭头，不是赋值
  const assign = new RegExp(`${escaped}\\s*=(?!=|>)`);
  const param = new RegExp(`(?:^|[(,])\\s*${escaped}\\s*[,)=]`);

  const lines = text.split(/\r?\n/);
  const scope = enclosingScope(lines, cursorLine);
  const from = scope ? scope.start - 1 : 0;
  const to = scope ? scope.end : lines.length;

  const params = [];
  const assignments = [];
  for (let index = from; index < to; index += 1) {
    const line = lines[index];
    const isAssign = assign.test(line);
    // 参数只在函数签名行里认，避免把 `foo($categoryId)` 这类调用当成声明
    const isParam = !isAssign && /\bfunction\b/.test(line) && param.test(line);
    if (!isAssign && !isParam) continue;

    const match = {
      relPath: currentPath,
      line: index + 1,
      kind: 'variable',
      name,
      owner: '',
      namespace: '',
      signature: line.trim(),
      doc: '',
    };
    if (isParam) params.push(match);
    else assignments.push(match);
  }

  // 参数才是变量的声明；赋值只是后续修改。渲染侧会直接跳到第一条，
  // 所以顺序必须让参数排在前面。
  return { ok: true, matches: [...params, ...assignments], truncated: false, scanned: 1 };
}

async function lookup(projectPath, name, options = {}) {
  // name 可能来自外部输入。非字符串经 String() 会变成 "[object Object]"，
  // 这里一律视为无效查询。
  if (typeof name !== 'string') return emptyResult();

  const target = name.trim();
  if (target.length < 2) return emptyResult();

  const root = path.resolve(projectPath);
  const currentPath = normalizeCurrentPath(root, options.currentPath);

  // PHP 变量（`$name`）：只在当前文件、当前方法里有意义
  if (target.startsWith('$')) {
    return lookupLocalVariable(root, currentPath, target, Number(options.line) || 0);
  }

  if (!isValidName(target)) return emptyResult();

  const index = await ensureIndex(root);
  refreshIfStale(root, index);

  const candidates = index.symbols[target.toLowerCase()] || [];

  let receiver = String(options.receiver || '');
  if (/^(\$this|self|static)$/i.test(receiver)) {
    receiver = await enclosingClassName(root, currentPath, Number(options.line) || 0);
  }

  const context = {
    currentPath,
    receiver,
    namespace: await namespaceOf(root, currentPath),
  };

  const matches = await resolveCandidates(root, candidates, target);
  matches.sort((a, b) => compareMatches(a, b, context));

  return {
    ok: true,
    matches,
    truncated: false,
    scanned: Object.keys(index.files).length,
  };
}

module.exports = {
  parsePhpSymbols,
  parseJsSymbols,
  cleanDoc,
  lookup,
  configure,
  warmIndex,
  resetCache,
  invalidate,
  compareMatches,
};

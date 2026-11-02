# 编辑器符号跳转与简介 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在编辑器里 Ctrl+点击函数/类名，弹出简介卡片（签名 + docblock），可再跳转到定义所在文件与行。

**Architecture:** 解析放在主进程新增的 `desktop/symbols.js`：遍历项目文件 → 文本预筛 → 只对命中文件跑 `php-parser` / `acorn` → 按规则排序后经 IPC 返回。渲染侧在 `CodeMirrorHost` 里拦截 Ctrl+点击，用 CodeMirror 的 tooltip 承载 React 卡片。

**Tech Stack:** Electron 主进程（CommonJS）、CodeMirror 6（`@codemirror/view` 的 `showTooltip` / `domEventHandlers`）、`php-parser` 3.7、`acorn` + `acorn-jsx`、React 19。

## Global Constraints

- 解析器必须在主进程运行，因此 `php-parser`、`acorn`、`acorn-jsx` 从 `devDependencies` 移到 `dependencies`。
- 扫描时跳过 `vendor`、`node_modules`、`.git`、`dist`、`release`、`release-build` 与符号链接。
- 单文件上限 1MB；最多扫描 4000 个文件；查询名少于 2 字符直接返回空。
- 不做常驻索引、不在启动时扫描；缓存只记录被实际解析过的文件与其 mtime。
- 唯一的触发方式是 Ctrl+点击（含 Cmd+点击），不做 F12、不拦截普通悬停。
- 模块关闭时 Ctrl+点击不拦截，保持 CodeMirror 原生多光标行为。
- 测试里所有界面文案断言用中文原文；改文案前先 grep `tests/`。
- 提交信息不写任何 AI 署名。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `desktop/symbols.js` | 新建。PHP/JS 声明提取、文件遍历与预筛、查询、排序、mtime 缓存 |
| `desktop/main.js` | 注册 `symbols:lookup` IPC |
| `desktop/preload.js` | 暴露 `api.symbols.lookup` |
| `src/global.d.ts` | IPC 类型声明 |
| `src/modules/catalog.ts` | `ModuleKind` 扩展为 `reference`，新增 `ref-php` / `ref-js` |
| `src/components/SettingsModal.tsx` | 模块页签按 kind 分组 |
| `src/symbolLookup.ts` | 新建。取词、识别接收者、调用主进程、结果归一化 |
| `src/components/SymbolCard.tsx` | 新建。简介卡片 React 组件 |
| `src/components/CodeMirrorHost.tsx` | Ctrl+点击拦截、手型光标、tooltip 承载卡片 |
| `src/components/EditorPane.tsx` | 计算 `referenceModule`、处理跳转与定位 |
| `src/useEditorFiles.ts` | 无改动（跳转复用 `open`） |
| `src/styles.css` | 卡片样式 |
| `tests/symbols.mjs` | 新建离线测试 |
| `tests/editor-goto-def.mjs` | 新建 UI 测试 |

---

## Task 1: PHP 声明提取

**Files:**
- Create: `desktop/symbols.js`
- Test: `tests/symbols.mjs`

**Interfaces:**
- Produces: `parsePhpSymbols(text) => SymbolDecl[]`，`cleanDoc(raw) => string`
- `SymbolDecl = { kind: 'function'|'method'|'class', name: string, owner: string, namespace: string, line: number, signature: string, doc: string }`

- [ ] **Step 1: 写失败的测试**

创建 `tests/symbols.mjs`：

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/symbols.mjs`
Expected: FAIL —— `Cannot find module '../desktop/symbols.js'`

- [ ] **Step 3: 创建 `desktop/symbols.js`**

```js
const path = require('path');

// 扫描时跳过的目录：依赖和产物目录里同名声明太多，还会把扫描拖慢
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
  return String(raw || '')
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*?\s?/, '').trimEnd())
    .join('\n')
    .trim();
}

// 从节点源码里截出声明头：遇到 { 或 => 就停，压平空白。
// 比用 AST 重新拼参数更忠实（能保留默认值和类型写法的原样）。
function sourceSignature(text, node, stops) {
  const start = node && node.loc && node.loc.start && node.loc.start.offset;
  const end = node && node.loc && node.loc.end && node.loc.end.offset;
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
  return last ? cleanDoc(last.value) : '';
}

function lineOf(node) {
  const line = node && node.loc && node.loc.start && node.loc.start.line;
  return typeof line === 'number' && line > 0 ? line : 1;
}

// 只收集声明本身；绝不递归进函数/方法体，避免闭包和局部定义混进来
function walkPhp(node, text, namespace, owner, out) {
  if (!node || typeof node !== 'object' || !node.kind) return;

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
        signature: `class ${name}`,
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

module.exports = { parsePhpSymbols, cleanDoc };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/symbols.mjs`
Expected: PASS，输出 `全部通过：17 项`（数量以实际断言数为准，只要求无 FAIL）

- [ ] **Step 5: 提交**

```bash
git add desktop/symbols.js tests/symbols.mjs
git commit -m "$(cat <<'EOF'
feat(symbols): 主进程提取 PHP 类、方法与函数的声明和 docblock
EOF
)"
```

---

## Task 2: JS 声明提取

**Files:**
- Modify: `desktop/symbols.js`
- Test: `tests/symbols.mjs`

**Interfaces:**
- Produces: `parseJsSymbols(text, lang) => SymbolDecl[]`；`lang` 取值 `js`/`mjs`/`cjs`/`jsx`

- [ ] **Step 1: 追加失败的测试**

在 `tests/symbols.mjs` 的 `全部通过` 之前插入：

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/symbols.mjs`
Expected: FAIL —— `symbols.parseJsSymbols is not a function`

- [ ] **Step 3: 实现**

在 `desktop/symbols.js` 的 `parsePhpSymbols` 之后加入：

```js
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
```

同时把导出行改成：

```js
module.exports = { parsePhpSymbols, parseJsSymbols, cleanDoc };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/symbols.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add desktop/symbols.js tests/symbols.mjs
git commit -m "$(cat <<'EOF'
feat(symbols): 主进程提取 JS 函数、类与箭头函数声明
EOF
)"
```

---

## Task 3: 文件遍历、预筛、排序与查询

**Files:**
- Modify: `desktop/symbols.js`
- Test: `tests/symbols.mjs`

**Interfaces:**
- Produces: `lookup(projectPath, name, options) => Promise<{ ok: true, matches: SymbolMatch[], truncated: boolean, scanned: number }>`，`resetCache()`
- `options = { currentPath?: string, receiver?: string }`
- `SymbolMatch = SymbolDecl & { relPath: string }`，结果按规则排序后返回

- [ ] **Step 1: 追加失败的测试**

在 `tests/symbols.mjs` 顶部补充导入：

```js
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

在文件末尾（`全部通过` 之前）插入：

```js
console.log('3. 项目查询');
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/symbols.mjs`
Expected: FAIL —— `symbols.lookup is not a function`

- [ ] **Step 3: 实现**

在 `desktop/symbols.js` 顶部补充依赖：

```js
const fsp = require('fs/promises');
const path = require('path');
```

在 `parseJsSymbols` 之后加入：

```js
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 1024 * 1024;
const PHP_EXT = new Set(['.php']);
const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx']);

// relPath → { mtime, decls }。只装被实际解析过的文件，不是项目级索引
const declCache = new Map();

function resetCache() {
  declCache.clear();
}

function shouldSkipDir(name) {
  return SKIP_DIRS.has(name) || name.startsWith('release-build');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function collectFiles(root) {
  const files = [];
  let truncated = false;

  async function walk(relDir) {
    if (truncated) return;
    let entries;
    try {
      entries = await fsp.readdir(path.join(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.isSymbolicLink()) continue;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        await walk(relPath);
        continue;
      }
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (PHP_EXT.has(ext) || JS_EXT.has(ext)) files.push(relPath);
    }
  }

  await walk('');
  return { files, truncated };
}

// 文本预筛：只有真的出现 "function name" / "class name" 的文件才值得解析。
// 不预筛直接全量解析，千文件项目要二十秒。
function prefilter(text, name) {
  const escaped = escapeRegExp(name);
  return new RegExp(`\\b(?:function|class)\\s+${escaped}\\b`, 'i').test(text);
}

async function declsFor(root, relPath, name) {
  let stat;
  try {
    stat = await fsp.stat(path.join(root, relPath));
  } catch {
    return [];
  }
  if (stat.size > MAX_FILE_BYTES) return [];

  const cached = declCache.get(relPath);
  if (cached && cached.mtime === stat.mtimeMs) return cached.decls;

  let text;
  try {
    text = await fsp.readFile(path.join(root, relPath), 'utf8');
  } catch {
    return [];
  }
  if (!prefilter(text, name)) {
    declCache.set(relPath, { mtime: stat.mtimeMs, decls: [] });
    return [];
  }

  const ext = path.extname(relPath).toLowerCase();
  const decls = PHP_EXT.has(ext)
    ? parsePhpSymbols(text)
    : parseJsSymbols(text, ext.slice(1));
  declCache.set(relPath, { mtime: stat.mtimeMs, decls });
  return decls;
}

function depthOf(relPath) {
  return relPath.split('/').length;
}

function compareMatches(a, b, context) {
  const aCurrent = a.relPath === context.currentPath ? 0 : 1;
  const bCurrent = b.relPath === context.currentPath ? 0 : 1;
  if (aCurrent !== bCurrent) return aCurrent - bCurrent;

  if (context.receiver) {
    const aOwner = a.owner && a.owner === context.receiver ? 0 : 1;
    const bOwner = b.owner && b.owner === context.receiver ? 0 : 1;
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

// 当前文件的命名空间：用于「同命名空间优先」。
// 只解析当前文件，拿不到就当作没有命名空间。
async function namespaceOf(root, relPath) {
  if (!relPath) return '';
  const decls = await declsFor(root, relPath, '__namespace_probe__');
  const hit = decls.find((item) => item.namespace);
  return hit ? hit.namespace : '';
}

async function lookup(projectPath, name, options = {}) {
  const target = String(name || '').trim();
  if (target.length < 2) {
    return { ok: true, matches: [], truncated: false, scanned: 0 };
  }

  const root = path.resolve(projectPath);
  const { files, truncated } = await collectFiles(root);
  const currentPath = typeof options.currentPath === 'string' ? options.currentPath : '';
  const context = {
    currentPath,
    receiver: String(options.receiver || ''),
    namespace: await namespaceOf(root, currentPath),
  };

  const matches = [];
  for (const relPath of files) {
    const decls = await declsFor(root, relPath, target);
    for (const decl of decls) {
      if (decl.name !== target) continue;
      matches.push({ ...decl, relPath });
    }
  }

  matches.sort((a, b) => compareMatches(a, b, context));
  return { ok: true, matches, truncated, scanned: files.length };
}

module.exports = { parsePhpSymbols, parseJsSymbols, cleanDoc, lookup, resetCache };
```

`namespaceOf` 里调 `declsFor` 会先做预筛，而 `__namespace_probe__` 几乎不可能出现在文件里，导致返回空。改成直接读当前文件解析：

```js
async function namespaceOf(root, relPath) {
  if (!relPath) return '';
  let text;
  try {
    text = await fsp.readFile(path.join(root, relPath), 'utf8');
  } catch {
    return '';
  }
  if (!PHP_EXT.has(path.extname(relPath).toLowerCase())) return '';
  const hit = parsePhpSymbols(text).find((item) => item.namespace);
  return hit ? hit.namespace : '';
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/symbols.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add desktop/symbols.js tests/symbols.mjs
git commit -m "$(cat <<'EOF'
feat(symbols): 按项目查询同名声明，预筛后只解析命中文件

跳过依赖目录与符号链接，单文件超过 1MB 不读，最多扫 4000 个文件。
结果按当前文件、接收者类、同命名空间、路径深度排序，缓存按 mtime 失效。
EOF
)"
```

---

## Task 4: 主进程接线与依赖迁移

**Files:**
- Modify: `desktop/main.js`
- Modify: `desktop/preload.js`
- Modify: `src/global.d.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `window.api.symbols.lookup(projectPath, name, options)`

- [ ] **Step 1: 注册 IPC**

在 `desktop/main.js` 顶部引入区（`const updates = require('./updates');` 之后）加入：

```js
const symbols = require('./symbols');
```

在 `ipcMain.handle('updates:check', ...)` 之后加入：

```js
  ipcMain.handle('symbols:lookup', (_event, projectPath, name, options) =>
    symbols.lookup(projectPath, name, options),
  );
```

- [ ] **Step 2: preload 暴露**

在 `desktop/preload.js` 的 `panes` 块之后加入：

```js
  symbols: {
    lookup: (projectPath, name, options) =>
      invoke('symbols:lookup', projectPath, name, options),
  },
```

- [ ] **Step 3: 类型声明**

在 `src/global.d.ts` 的 `browser` 块之后加入：

```ts
      symbols: {
        lookup: (
          projectPath: string,
          name: string,
          options?: { currentPath?: string; receiver?: string },
        ) => Promise<{
          ok: boolean;
          matches: SymbolMatch[];
          truncated: boolean;
          scanned: number;
        }>;
      };
```

并在该文件顶部类型导入处补上 `SymbolMatch`（定义放在 `src/types.ts`，见Task 6）。

- [ ] **Step 4: 依赖迁移**

编辑 `package.json`：把 `acorn`、`acorn-jsx`、`php-parser` 从 `devDependencies` 移到 `dependencies`。

Run:
```bash
npm install --package-lock-only
node -p "const p=require('./package.json'); [p.dependencies, Object.keys(p.devDependencies)].map(console.log)"
```
Expected: 三个包出现在 `dependencies`，不再出现在 `devDependencies`

- [ ] **Step 5: 验证主进程能加载**

Run:
```bash
node -e "const s=require('./desktop/symbols.js'); console.log(typeof s.lookup, typeof s.parsePhpSymbols)"
```
Expected: `function function`

- [ ] **Step 6: 提交**

```bash
git add desktop/main.js desktop/preload.js src/global.d.ts package.json package-lock.json
git commit -m "$(cat <<'EOF'
feat(symbols): 暴露 symbols:lookup IPC，解析器移入运行时依赖

解析在主进程跑，php-parser / acorn / acorn-jsx 必须放进 dependencies，
否则打包后启动会 Cannot find module。
EOF
)"
```

---

## Task 5: 模块目录与设置分组

**Files:**
- Modify: `src/modules/catalog.ts`
- Modify: `src/components/SettingsModal.tsx`
- Test: `tests/module-catalog.mjs`

**Interfaces:**
- Produces: `ModuleKind = 'diagnostics' | 'reference'`；模块 `ref-php`、`ref-js`

- [ ] **Step 1: 写失败的测试**

在 `tests/module-catalog.mjs` 末尾追加：

```js
console.log('模块分组');
const reference = catalog.EDITOR_MODULES.filter((m) => m.kind === 'reference');
assert(reference.map((m) => m.id).sort().join(',') === 'ref-js,ref-php', '有两个跳转模块');
assert(
  catalog.modulesFor('reference', 'php').some((m) => m.id === 'ref-php'),
  'PHP 能匹配到 ref-php',
);
assert(
  catalog.modulesFor('reference', 'jsx').some((m) => m.id === 'ref-js'),
  'JSX 能匹配到 ref-js',
);
assert(catalog.DEFAULT_ENABLED_MODULES.includes('ref-php'), 'ref-php 默认开启');
assert(catalog.DEFAULT_ENABLED_MODULES.includes('ref-js'), 'ref-js 默认开启');
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/module-catalog.mjs`
Expected: FAIL —— 找不到 `reference` 模块

- [ ] **Step 3: 实现目录**

编辑 `src/modules/catalog.ts`：

```ts
export type ModuleKind = 'diagnostics' | 'reference';
```

在 `EDITOR_MODULES` 数组末尾追加：

```ts
  {
    id: 'ref-php',
    name: 'PHP 跳转与简介',
    description: '按住 Ctrl 点击函数或类名，查看说明并跳到定义',
    kind: 'reference',
    languages: ['php'],
  },
  {
    id: 'ref-js',
    name: 'JS 跳转与简介',
    description: '按住 Ctrl 点击函数或类名，查看说明并跳到定义。TS / TSX 暂不支持',
    kind: 'reference',
    languages: ['js', 'mjs', 'cjs', 'jsx'],
  },
```

并把默认值改成：

```ts
export const DEFAULT_ENABLED_MODULES = ['diag-php', 'ref-php', 'ref-js'];
```

- [ ] **Step 4: 设置面板按 kind 分组**

把 `src/components/SettingsModal.tsx` 的模块页签内容（当前 `EDITOR_MODULES.map(...)` 那段）替换为：

```tsx
            {[
              { kind: 'diagnostics' as const, title: '语法检查' },
              { kind: 'reference' as const, title: '跳转与简介' },
            ].map((group) => {
              const items = EDITOR_MODULES.filter((item) => item.kind === group.kind);
              if (!items.length) return null;
              return (
                <div key={group.kind}>
                  <p className="settings-group-title">{group.title}</p>
                  {items.map((item) => (
                    <div className="settings-item" key={item.id}>
                      <div className="settings-item-text">
                        <span className="settings-item-label">{item.name}</span>
                        <span className="settings-item-desc">{item.description}</span>
                      </div>
                      <Toggle
                        checked={modules.includes(item.id)}
                        onChange={(next) => toggleModule(item.id, next)}
                      />
                    </div>
                  ))}
                </div>
              );
            })}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node tests/module-catalog.mjs`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/modules/catalog.ts src/components/SettingsModal.tsx tests/module-catalog.mjs
git commit -m "$(cat <<'EOF'
feat(modules): 模块分「语法检查」与「跳转与简介」两组

新增 ref-php / ref-js，默认开启；设置面板按 kind 分组显示。
EOF
)"
```

---

## Task 6: 渲染侧取词与卡片组件

**Files:**
- Modify: `src/types.ts`
- Create: `src/symbolLookup.ts`
- Create: `src/components/SymbolCard.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Produces:
  - `SymbolMatch`（`src/types.ts`）
  - `wordAndReceiverAt(state, pos) => { name, receiver, from, to } | null`
  - `SymbolCard` 组件，props `{ card, onJump, onClose }`

- [ ] **Step 1: 加类型**

在 `src/types.ts` 末尾追加：

```ts
export type SymbolMatch = {
  relPath: string;
  line: number;
  kind: 'function' | 'method' | 'class';
  name: string;
  owner: string;
  namespace: string;
  signature: string;
  doc: string;
};

export type SymbolLookupResult = {
  ok: boolean;
  matches: SymbolMatch[];
  truncated: boolean;
  scanned: number;
};
```

- [ ] **Step 2: 写取词实现**

创建 `src/symbolLookup.ts`：

```ts
import type { EditorState } from '@codemirror/state';
import type { SymbolLookupResult, SymbolMatch } from './types';

const WORD_CHAR = /[\w$]/;

// 光标可能落在词中间，也可能刚点在词尾：向右补一次，向左退一步再匹配
export function wordAndReceiverAt(
  state: EditorState,
  pos: number,
): { name: string; receiver: string; from: number; to: number } | null {
  const line = state.doc.lineAt(pos);
  const text = line.text;
  const column = pos - line.from;

  let start = column;
  let end = column;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start -= 1;
  while (end < text.length && WORD_CHAR.test(text[end])) end += 1;
  if (start === end) return null;

  const name = text.slice(start, end);
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;

  // Foo::bar() / $obj->bar()：取名字前面那段标识符当「接收者」
  const before = text.slice(0, start);
  const match = /([A-Za-z_][\w]*)\s*(?:::|->)\s*$/.exec(before);
  const receiver = match ? match[1] : '';

  return { name, receiver, from: line.from + start, to: line.from + end };
}

export async function lookupSymbol(
  projectPath: string,
  name: string,
  options: { currentPath?: string; receiver?: string },
): Promise<SymbolLookupResult> {
  const bridge = window.api?.symbols;
  if (!bridge) return { ok: false, matches: [], truncated: false, scanned: 0 };
  try {
    return await bridge.lookup(projectPath, name, options);
  } catch {
    return { ok: false, matches: [], truncated: false, scanned: 0 };
  }
}

export function describeLocation(match: SymbolMatch): string {
  const file = match.relPath.split('/').pop() || match.relPath;
  const owner = match.owner ? `${match.owner}::` : '';
  return `${owner}${match.name} · ${file}:${match.line}`;
}
```

`WORD_CHAR` 只认 ASCII 标识符字符：PHP 和 JS 的标识符都不含 CJK，不需要扩到非 ASCII 范围。

- [ ] **Step 3: 写卡片组件**

创建 `src/components/SymbolCard.tsx`：

```tsx
import { CornerDownRight, X } from 'lucide-react';
import { describeLocation } from '../symbolLookup';
import type { SymbolMatch } from '../types';

export type SymbolCardState = {
  name: string;
  loading: boolean;
  truncated: boolean;
  matches: SymbolMatch[];
};

type SymbolCardProps = {
  card: SymbolCardState;
  onJump: (match: SymbolMatch) => void;
  onClose: () => void;
};

export function SymbolCard({ card, onJump, onClose }: SymbolCardProps) {
  const single = card.matches.length === 1 ? card.matches[0] : null;

  return (
    <div className="symbol-card">
      <div className="symbol-card-head">
        <span className="symbol-card-name">{card.name}</span>
        <button type="button" className="symbol-card-close" title="关闭" onClick={onClose}>
          <X size={12} />
        </button>
      </div>

      {card.loading ? <p className="symbol-card-empty">正在查找定义…</p> : null}

      {!card.loading && card.matches.length === 0 ? (
        <p className="symbol-card-empty">没有找到「{card.name}」的定义</p>
      ) : null}

      {single ? (
        <div className="symbol-card-single">
          {single.namespace || single.owner ? (
            <p className="symbol-card-where">
              {[single.namespace, single.owner].filter(Boolean).join('\\')}
            </p>
          ) : null}
          <pre className="symbol-card-signature">{single.signature}</pre>
          {single.doc ? <pre className="symbol-card-doc">{single.doc}</pre> : null}
          <button type="button" className="symbol-card-jump" onClick={() => onJump(single)}>
            <CornerDownRight size={12} />
            跳到定义（{describeLocation(single)}）
          </button>
        </div>
      ) : null}

      {!single && card.matches.length > 1 ? (
        <div className="symbol-card-list">
          {card.matches.map((match) => (
            <button
              type="button"
              key={`${match.relPath}:${match.line}:${match.name}`}
              className="symbol-card-item"
              onClick={() => onJump(match)}
            >
              <span className="symbol-card-item-file">
                {match.relPath.split('/').pop()}:{match.line}
              </span>
              <span className="symbol-card-item-sig">{match.signature}</span>
            </button>
          ))}
        </div>
      ) : null}

      {card.truncated ? (
        <p className="symbol-card-note">已扫描前 4000 个文件，结果可能不完整</p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: 加样式**

在 `src/styles.css` 末尾追加：

```css
.symbol-card {
  max-width: 520px;
  max-height: 420px;
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid #e3e4ea;
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14);
  font-size: 12px;
  color: #24292f;
}

.symbol-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
}

.symbol-card-name {
  font-weight: 600;
  color: #57606a;
}

.symbol-card-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #8b949e;
  cursor: pointer;
}

.symbol-card-close:hover {
  background: #f1f2f6;
  color: #24292f;
}

.symbol-card-where {
  margin: 0 0 6px;
  color: #8b949e;
}

.symbol-card-signature,
.symbol-card-doc {
  margin: 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: #f6f8fa;
  font-family: inherit;
  white-space: pre-wrap;
  word-break: break-word;
}

.symbol-card-doc {
  margin-top: 6px;
  color: #4b5563;
  line-height: 1.55;
}

.symbol-card-jump {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 4px 8px;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  background: #ffffff;
  color: #0969da;
  cursor: pointer;
}

.symbol-card-jump:hover {
  background: #f3f8ff;
}

.symbol-card-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.symbol-card-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.symbol-card-item:hover {
  background: #f3f4f8;
}

.symbol-card-item-file {
  color: #0969da;
}

.symbol-card-item-sig {
  color: #57606a;
  font-size: 11px;
}

.symbol-card-empty,
.symbol-card-note {
  margin: 0;
  color: #8b949e;
}

.symbol-card-note {
  margin-top: 8px;
  font-size: 11px;
}
```

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过（此时 `SymbolCard` 还没被引用，只校验自身）

- [ ] **Step 6: 提交**

```bash
git add src/types.ts src/symbolLookup.ts src/components/SymbolCard.tsx src/styles.css
git commit -m "$(cat <<'EOF'
feat(symbols): 渲染侧取词、查询封装与简介卡片组件
EOF
)"
```

---

## Task 7: CodeMirror 里的 Ctrl+点击与卡片

**Files:**
- Modify: `src/components/CodeMirrorHost.tsx`
- Test: 无独立单测，由 Task 9 的 UI 测试覆盖

**Interfaces:**
- Consumes: `wordAndReceiverAt`、`lookupSymbol`、`SymbolCard`、`SymbolCardState`
- Produces: 新 props `referenceEnabled: boolean`、`projectPath: string`、`onJumpToSymbol: (match: SymbolMatch) => void`、`gotoLine: number | null`

- [ ] **Step 1: 加导入**

在 `src/components/CodeMirrorHost.tsx` 顶部补充：

```tsx
import { showTooltip } from '@codemirror/view';
import type { Tooltip } from '@codemirror/view';
import { SymbolCard } from './SymbolCard';
import type { SymbolCardState } from './SymbolCard';
import { lookupSymbol, wordAndReceiverAt } from '../symbolLookup';
import type { SymbolMatch } from '../types';
```

（`X` 若最终未用到则删掉。）

- [ ] **Step 2: 定义卡片状态与工具函数**

在 `ConflictWidget` 之前加入：

```tsx
const setCard = StateEffect.define<{ pos: number; card: SymbolCardState } | null>();

const cardField = StateField.define<{ pos: number; card: SymbolCardState } | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCard)) return effect.value;
    }
    // 内容改动或用户显式关闭时收起卡片
    if (tr.docChanged) return null;
    return value;
  },
});

// 卡片用 React 渲染，卸载交给 tooltip 的 destroy。onClose 由 tooltip 的
// create(view) 提供，用来自行收起卡片。
function createCardDom(
  card: SymbolCardState,
  onJump: (m: SymbolMatch) => void,
  onClose: () => void,
): HTMLElement {
  const host = document.createElement('div');
  const root = createRoot(host);
  root.render(<SymbolCard card={card} onJump={onJump} onClose={onClose} />);
  host.addEventListener('symbol-card-removed', () => root.unmount(), { once: true });
  return host;
}
```

- [ ] **Step 3: 构造函数 `referenceExtension`**

```tsx
function referenceExtension(options: {
  isEnabled: () => boolean;
  lookup: (name: string, receiver: string) => Promise<SymbolCardState>;
  onJump: (match: SymbolMatch) => void;
}): Extension {
  const handlers = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!event.ctrlKey && !event.metaKey) return false;
      if (!options.isEnabled()) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const word = wordAndReceiverAt(view.state, pos);
      if (!word) return false;

      event.preventDefault();
      view.dispatch({ effects: setCard.of({ pos: word.from, card: { name: word.name, loading: true, truncated: false, matches: [] } }) });

      void options.lookup(word.name, word.receiver).then((card) => {
        if (view.state.field(cardField, false) === undefined) return;
        const current = view.state.field(cardField);
        // 期间用户可能已经点了别处或换了词
        if (!current || current.card.name !== card.name) return;
        view.dispatch({ effects: setCard.of({ pos: current.pos, card }) });
      });
      return true;
    },
    mouseover(event, view) {
      if (!event.ctrlKey && !event.metaKey) return false;
      if (!options.isEnabled()) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const word = wordAndReceiverAt(view.state, pos);
      view.dom.classList.toggle('cm-symbol-clickable', Boolean(word));
      return false;
    },
    mouseleave(_event, view) {
      view.dom.classList.remove('cm-symbol-clickable');
      return false;
    },
  });

  const tooltipFromField = showTooltip.from(cardField, (value) =>
    value
      ? ({
          pos: value.pos,
          above: true,
          // create 收到的 view 用来关闭卡片：tooltip 的 DOM 挂在编辑器容器里，
          // 从 DOM 反查拿不到 EditorView，必须用它
          create: (view) => ({
            dom: createCardDom(value.card, options.onJump, () =>
              view.dispatch({ effects: setCard.of(null) }),
            ),
          }),
        } satisfies Tooltip)
      : null,
  );

  return [cardField, tooltipFromField, handlers];
}
```

- [ ] **Step 4: 接进组件**

在 `CodeMirrorHostProps` 增加：

```tsx
  referenceEnabled: boolean;
  projectPath: string;
  onJumpToSymbol: (match: SymbolMatch) => void;
  gotoLine: number | null;
```

组件解构里补上这四个，并加 ref：

```tsx
  const referenceRef = useRef(new Compartment());
  const referenceEnabledRef = useRef(referenceEnabled);
  const projectPathRef = useRef(projectPath);
  const activeFileRef = useRef(filePath);
  const jumpRef = useRef(onJumpToSymbol);
  referenceEnabledRef.current = referenceEnabled;
  projectPathRef.current = projectPath;
  activeFileRef.current = filePath;
  jumpRef.current = onJumpToSymbol;
```

在重建 `EditorState.create` 的 extensions 数组里，`diagnosticsRef` 之后加入：

```tsx
          referenceRef.current.of(
            referenceExtension({
              isEnabled: () => referenceEnabledRef.current,
              lookup: async (name, receiver) => {
                const result = await lookupSymbol(projectPathRef.current, name, {
                  currentPath: activeFileRef.current,
                  receiver,
                });
                return {
                  name,
                  loading: false,
                  truncated: result.truncated,
                  matches: result.matches,
                };
              },
              onJump: (match) => jumpRef.current(match),
            }),
          ),
```

新增一个 effect，开关变化时重配：

```tsx
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: referenceRef.current.reconfigure(
        referenceExtension({
          isEnabled: () => referenceEnabledRef.current,
          lookup: async (name, receiver) => {
            const result = await lookupSymbol(projectPathRef.current, name, {
              currentPath: activeFileRef.current,
              receiver,
            });
            return { name, loading: false, truncated: result.truncated, matches: result.matches };
          },
          onJump: (match) => jumpRef.current(match),
        }),
      ),
    });
  }, [referenceEnabled]);
```

新增定位 effect：

```tsx
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !gotoLine) return;
    const clamped = Math.min(Math.max(gotoLine, 1), view.state.doc.lines);
    const line = view.state.doc.line(clamped);
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
    view.focus();
  }, [gotoLine, filePath]);
```

- [ ] **Step 5: 手型光标样式**

在 `src/styles.css` 追加：

```css
.cm-editor.cm-symbol-clickable .cm-content {
  cursor: pointer;
}
```

- [ ] **Step 6: 类型检查并构建**

Run: `npx tsc --noEmit && npx vite build`
Expected: 均通过

- [ ] **Step 7: 提交**

```bash
git add src/components/CodeMirrorHost.tsx src/styles.css
git commit -m "$(cat <<'EOF'
feat(symbols): Ctrl+点击弹出简介卡片，Ctrl+悬停显示手型光标
EOF
)"
```

---

## Task 8: EditorPane 接线与跳转

**Files:**
- Modify: `src/components/EditorPane.tsx`

**Interfaces:**
- Consumes: Task 5 的 `ref-php` / `ref-js`，Task 7 的 `referenceEnabled` / `onJumpToSymbol` / `gotoLine`

- [ ] **Step 1: 计算跳转模块**

在 `diagnosticModule` 计算之后加入：

```tsx
  const referenceModule =
    lang === 'php'
      ? enabledModules.includes('ref-php')
        ? findModule('ref-php') ?? null
        : null
      : ['js', 'mjs', 'cjs', 'jsx'].includes(lang) && enabledModules.includes('ref-js')
        ? findModule('ref-js') ?? null
        : null;
```

- [ ] **Step 2: 跳转状态与回调**

在组件内、`requestOpen` 附近加入：

```tsx
  const [gotoLine, setGotoLine] = useState<number | null>(null);

  const jumpToSymbol = useCallback(
    (match: SymbolMatch) => {
      setGotoLine(match.line);
      if (match.relPath !== activePathRef.current) {
        void open(match.relPath);
      }
    },
    [open],
  );
```

顶部导入补：

```tsx
import type { SymbolMatch } from '../types';
```

- [ ] **Step 3: 传给 CodeMirrorHost**

在 `<CodeMirrorHost ... />` 上补充：

```tsx
              referenceEnabled={Boolean(referenceModule)}
              projectPath={group.path}
              onJumpToSymbol={jumpToSymbol}
              gotoLine={gotoLine}
```

- [ ] **Step 4: 类型检查并构建**

Run: `npx tsc --noEmit && npx vite build`
Expected: 均通过

- [ ] **Step 5: 提交**

```bash
git add src/components/EditorPane.tsx
git commit -m "$(cat <<'EOF'
feat(symbols): 编辑器按当前语言挂载跳转模块，支持跳转后定位到声明行
EOF
)"
```

---

## Task 9: UI 测试

**Files:**
- Create: `tests/editor-goto-def.mjs`

**Interfaces:**
- Consumes: 全部实现

- [ ] **Step 1: 写测试**

创建 `tests/editor-goto-def.mjs`：

```js
// 编辑器 Ctrl+点击符号：弹简介卡片、跳转到定义、模块关闭后不弹。
// 需要独占 17382 端口，跑之前先关掉正在运行的 Cmd Toolbox。
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-goto-'));
const projectDir = mkdtempSync(join(tmpdir(), 'cmdtb-goto-proj-'));

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error('断言失败：' + message);
  passed += 1;
  console.log('  ok  ' + message);
}

mkdirSync(join(projectDir, 'app'), { recursive: true });
const NL = '\n';
writeFileSync(
  join(projectDir, 'app', 'target.php'),
  [
    '<?php',
    'namespace App;',
    '',
    '/**',
    ' * 去读输出对应的h标签html',
    ' *',
    ' * @param string $Name',
    ' * @param array $options',
    ' * @return string',
    ' */',
    'class HelpsVisualV2 {',
    '  public static function echoListHTags($Name, $options = []) {',
    '    return $Name;',
    '  }',
    '}',
  ].join(NL),
  'utf8',
);
writeFileSync(
  join(projectDir, 'app', 'caller.php'),
  ['<?php', 'namespace App;', '$x = HelpsVisualV2::echoListHTags("a");', 'foreach ($items as $item) {', '  echo $item;', '}'].join(NL),
  'utf8',
);
// 同名多候选：两个文件各有一个 sharedMethod
writeFileSync(
  join(projectDir, 'app', 'first.php'),
  ['<?php', 'namespace App;', 'class First {', '  public function sharedMethod() {}', '}'].join(NL),
  'utf8',
);
writeFileSync(
  join(projectDir, 'app', 'second.php'),
  ['<?php', 'namespace App;', 'class Second {', '  public function sharedMethod() {}', '}'].join(NL),
  'utf8',
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.CMDTOOLBOX_NO_UPDATE = '1';

const app = await electron.launch({
  executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
  cwd: root,
  args: ['.', `--data-dir=${dataDir}`],
  env,
});

async function openFile(page, name) {
  const exact = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const entry = page.locator('.file-row').filter({ hasText: exact }).first();
  await entry.waitFor({ timeout: 10000 });
  await entry.click();
  await page.locator('.cm-content').first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(600);
}

// 点击编辑器里第 line 行第 column 列（0 起）的字符中心
async function ctrlClickAt(page, line, column) {
  const point = await page.evaluate(
    ({ line, column }) => {
      const editor = document.querySelector('.cm-content');
      const lines = [...editor.querySelectorAll('.cm-line')];
      const target = lines[line];
      if (!target) return null;
      const range = document.createRange();
      range.setStart(target.firstChild || target, Math.min(column, (target.textContent || '').length));
      range.setEnd(range.startContainer, range.startOffset);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 1, y: rect.top + rect.height / 2 };
    },
    { line, column },
  );
  if (!point) throw new Error('定位不到目标位置');
  await page.mouse.move(point.x, point.y);
  await page.keyboard.down('Control');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Control');
}

try {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => console.log('  [pageerror]', error.message));
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.app').waitFor();
  await page.waitForTimeout(1000);

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.show();
    win?.focus();
    win?.moveTop();
  });

  await page.locator('.add-project-btn').click();
  await page.locator('.modal-card').waitFor();
  await page.locator('#project-path').fill(projectDir);
  await page.locator('#project-name').fill('goto-proj');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await page.waitForTimeout(400);
  await page.locator('.group-item').filter({ hasText: 'goto-proj' }).locator('.group-main').click();
  await page.waitForTimeout(600);
  await page
    .locator('.group-item')
    .filter({ hasText: 'goto-proj' })
    .click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  await page.getByRole('menuitem', { name: '打开编辑器', exact: true }).click();
  await page.locator('.editor-pane').waitFor();

  console.log('1. Ctrl+点击方法名弹出简介卡片');
  await openFile(page, 'caller.php');
  // 第 3 行（0 起为 2）：$x = HelpsVisualV2::echoListHTags("a");
  // 取 echoListHTags 起始处，前面 "$x = HelpsVisualV2::" 共 21 个字符
  await ctrlClickAt(page, 2, 23);
  const card = page.locator('.symbol-card');
  await card.waitFor({ timeout: 10000 });
  const cardText = await card.innerText();
  assert(cardText.includes('echoListHTags'), '卡片显示方法名');
  assert(cardText.includes('@param string $Name'), '卡片显示 @param');
  assert(cardText.includes('@return string'), '卡片显示 @return');
  assert(cardText.includes('public static function echoListHTags'), '卡片显示完整签名');

  console.log('2. 点「跳到定义」打开目标文件并定位');
  await card.getByRole('button', { name: /跳到定义/ }).click();
  await page.waitForTimeout(1200);
  const header = await page.locator('.pane-path').first().innerText();
  assert(header.endsWith('target.php'), `切到了定义所在文件，实际 ${header}`);
  const activeLine = await page.evaluate(() => {
    const focused = document.querySelector('.cm-content');
    if (!focused) return -1;
    const lines = [...focused.querySelectorAll('.cm-line')];
    return lines.findIndex((item) => item.classList.contains('cm-activeLine'));
  });
  assert(activeLine === 11, `光标停在第 12 行（0 起 11），实际 ${activeLine}`);

  console.log('3. 同名多候选时列出全部');
  await openFile(page, 'first.php');
  await ctrlClickAt(page, 3, 25);
  const listCard = page.locator('.symbol-card');
  await listCard.waitFor({ timeout: 10000 });
  const items = listCard.locator('.symbol-card-item');
  assert((await items.count()) === 2, `列出两个候选，实际 ${await items.count()}`);
  await items.nth(1).click();
  await page.waitForTimeout(1200);
  const second = await page.locator('.pane-path').first().innerText();
  assert(second.endsWith('second.php'), `点了第二项跳到第二个文件，实际 ${second}`);

  console.log('4. 模块关闭后不弹卡片');
  await page.locator('.titlebar-settings').click();
  await page.waitForSelector('.settings-body', { timeout: 10000 });
  await page.getByRole('tab', { name: '模块', exact: true }).click();
  await page
    .locator('.settings-item')
    .filter({ hasText: 'PHP 跳转与简介' })
    .getByRole('switch')
    .click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.modal-card').waitFor({ state: 'detached', timeout: 10000 });
  await openFile(page, 'caller.php');
  await ctrlClickAt(page, 2, 23);
  await page.waitForTimeout(800);
  assert((await page.locator('.symbol-card').count()) === 0, '关闭模块后 Ctrl+点击不弹卡片');
} finally {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}

console.log(`\n全部通过：${passed} 项`);
```

- [ ] **Step 2: 先构建再跑**

Run:
```bash
npx tsc --noEmit && npx vite build
powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force"
node tests/editor-goto-def.mjs
```
Expected: PASS

- [ ] **Step 3: 若列索引/列号偏移导致点不中，改用稳定定位**

把 `ctrlClickAt` 的实现换成先用 CodeMirror 的坐标 API 取位置，避免手算列号：

```js
async function ctrlClickAt(page, line, column) {
  const point = await page.evaluate(
    ({ line, column }) => {
      const lines = [...document.querySelectorAll('.cm-line')];
      const target = lines[line];
      if (!target) return null;
      const text = target.textContent || '';
      const index = Math.min(column, text.length - 1);
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
      let consumed = 0;
      let node = walker.nextNode();
      while (node) {
        if (consumed + node.textContent.length > index) break;
        consumed += node.textContent.length;
        node = walker.nextNode();
      }
      if (!node) return null;
      const range = document.createRange();
      range.setStart(node, index - consumed);
      range.setEnd(node, index - consumed);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 1, y: rect.top + rect.height / 2 };
    },
    { line, column },
  );
  if (!point) throw new Error('定位不到目标位置');
  await page.mouse.move(point.x, point.y);
  await page.keyboard.down('Control');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Control');
}
```

- [ ] **Step 4: 回归相邻测试**

Run:
```bash
node tests/module-catalog.mjs
node tests/editor-modules.mjs
```
Expected: 均 PASS（`editor-modules.mjs` 是既有编辑器功能，确认没有回归）

- [ ] **Step 5: 提交**

```bash
git add tests/editor-goto-def.mjs
git commit -m "$(cat <<'EOF'
test(symbols): Ctrl+点击跳转的端到端用例
EOF
)"
```

---

## Task 10: 文档

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 记录约定**

在 `CLAUDE.md` 的「编辑器模块」小节下追加：

```markdown
### 符号跳转与简介（Ctrl+点击）

- **解析在主进程**（`desktop/symbols.js`），不在渲染进程。要遍历文件系统，
  且全量解析会卡住编辑器输入。
- **不做常驻索引**：点击时才遍历，先用 `function name` / `class name` 文本预筛，
  只对命中文件跑 `php-parser` / `acorn`。实测 `php-parser` 约 22ms/文件，
  千文件项目全量解析要二十秒，预筛是必需的。
- **缓存按 `relPath + mtime`**，文件改动自动失效。注意它是「解析过的文件清单」，
  不是项目级符号表——不要在此基础上做全局补全，会把内存吃光。
- **`php-parser` 的 `name` 是 Identifier 对象**（`{ name: 'foo' }`），不是字符串；
  类的 docblock 挂在类节点的 `leadingComments`，方法的挂在自己节点上，要分开取。
- **签名用源码切片**（`loc.start.offset` 到 `end.offset`，遇到 `{` 截断），
  不要用 AST 重拼参数——重拼会丢默认值写法和类型原样。
- **`getWebContentsId()` 无关**，这里没有 webview；卡片用 CodeMirror 的
  `showTooltip` facet 承载 React 节点，`create(view)` 拿到的 view 用来关闭卡片。
- **`php-parser` / `acorn` / `acorn-jsx` 必须在 `dependencies`**，因为主进程
  `require` 它们；放进 devDependencies 会让打包后的应用启动即崩。
- 模块关闭时 Ctrl+点击**不拦截**，保持 CodeMirror 原生多光标行为。
```

在测试清单里补一行：

```bash
node tests/symbols.mjs           # 符号提取、项目查询、排序（离线）
node tests/editor-goto-def.mjs   # Ctrl+点击弹卡片与跳转
```

- [ ] **Step 2: 提交**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: 记录符号跳转的主进程解析约定与依赖位置
EOF
)"
```

---

## Self-Review

**Spec coverage**

| Spec 条目 | 对应任务 |
|---|---|
| Ctrl+点击弹卡片、卡片内跳转 | Task 7 / 8 |
| Ctrl+悬停手型光标 | Task 7 Step 3/5 |
| 模块可开关（`ref-php` / `ref-js`） | Task 5 |
| PHP 类 / 方法 / 函数 + docblock | Task 1 |
| JS 函数 / 类 / 箭头函数 + JSDoc | Task 2 |
| 不常驻索引、文本预筛、只解析命中文件 | Task 3 |
| 忽略 vendor / node_modules / 符号链接、1MB、4000 文件 | Task 3 |
| 排序：同文件 → 接收者类 → 同命名空间 → 路径深度 → 字典序 | Task 3 |
| 多候选全部列出让用户选 | Task 6 |
| 截断提示 | Task 6 |
| 模块关闭不拦截 | Task 7（`isEnabled`）+ Task 9 用例 4 |
| 依赖迁移到 dependencies | Task 4 |
| 离线测试 / UI 测试 | Task 1–3、Task 9 |
| CLAUDE.md 记录 | Task 10 |

**类型一致性**：`SymbolMatch`（含 `relPath`/`line`/`kind`/`name`/`owner`/`namespace`/`signature`/`doc`）在 Task 3 主进程产出、Task 6 定义、Task 7/8 消费，字段一致。`SymbolCardState` 的 `{ name, loading, truncated, matches }` 在 Task 6 定义、Task 7 构造、Task 9 断言，一致。`lookup` 的 options 键 `currentPath` / `receiver` 在 Task 3、4、6、7 一致。

**风险点**：Task 9 用「第几行第几列」点击比较脆弱，所以 Step 3 给出了基于 TreeWalker 的稳定定位实现；若首轮失败，直接替换即可。

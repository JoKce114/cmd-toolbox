# 编辑器 Git 变更行标记 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 编辑器打开文件时自动与 Git HEAD 对比，在行号旁显示新增/修改色条、删除红三角、概览标尺，并支持点击行号看 blame。

**Architecture:** 差异计算是渲染进程里的纯函数（复用 `diffFromText.ts` 的 Myers 差分）；CodeMirror 侧用一个独立 gutter 渲染标记，用 `StateField` 存**文档位置**（不是行号），用户编辑时用 `mapPos` 跟随；blame 走两个新增 IPC，卡片复用现有 `showTooltip` 模式。

**Tech Stack:** Electron / React 19 / TypeScript / CodeMirror 6 / Node 内置测试脚本

## Global Constraints

- 改了 `src/` 之后重建用 `npx tsc --noEmit && npx vite build`，**不要用 `npm run build`**（它会跑 `scripts/build-coninject.ps1` 改脏 `build/coninject.exe`）。
- 提交信息不能加任何 AI 署名（`Co-Authored-By`、`Generated with` 一律不加）。
- `.cm-editor` 的 `font-size`、`.cm-scroller` 的 `font-family` / `line-height` 只能写在 `src/editorTheme.ts`，`src/styles.css` 不得重复写。
- UI 测试必须独占 17382 端口，跑之前先关掉正在运行的 Cmd Toolbox。
- 主进程 `require` 的包必须留在 `dependencies`；本次不新增依赖。
- 新 IPC 四处同改：`desktop/main.js` 的 `ipcMain.handle` → `desktop/preload.js` 的 `invoke` → `src/global.d.ts` 的类型 → 调用方。

---

### Task 1: 行级变更计算（纯函数）

**Files:**
- Modify: `src/diffFromText.ts`（导出现有的 `diffLines`，抽出 `splitLinesForDiff`）
- Create: `src/lineChanges.ts`
- Test: `tests/line-changes.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `diffFromText.ts` 导出 `export type DiffOp = { kind: 'equal' | 'insert' | 'delete'; text: string }`、`export function diffLines(oldLines: string[], newLines: string[]): DiffOp[]`、`export function splitLinesForDiff(text: string): string[]`
  - `lineChanges.ts` 导出 `LineChangeKind`、`ChangeChunk`、`DeleteAnchor`、`LineChanges`、`computeLineChanges(oldText: string, newText: string): LineChanges`

- [ ] **Step 1: 写失败的测试**

创建 `tests/line-changes.mjs`：

```js
// 行级变更计算。离线可跑，不依赖 GUI。
let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const { computeLineChanges } = await import('../src/lineChanges.ts');

const base = ['a', 'b', 'c', 'd', 'e'].join('\n');

console.log('1. 无改动');
{
  const changes = computeLineChanges(base, base);
  assert(changes.chunks.length === 0, '相同内容没有变更块');
  assert(changes.deletes.length === 0, '相同内容没有删除锚点');
  assert(changes.totalLines === 5, 'totalLines 为 5');
}

console.log('2. 纯新增');
{
  const next = ['a', 'b', 'X', 'c', 'd', 'e'].join('\n');
  const changes = computeLineChanges(base, next);
  assert(changes.chunks.length === 1, '一个变更块');
  assert(changes.chunks[0].kind === 'added', '类型是 added');
  assert(changes.chunks[0].startLine === 3 && changes.chunks[0].endLine === 3, '落在第 3 行');
  assert(changes.deletes.length === 0, '没有删除锚点');
}

console.log('3. 纯删除');
{
  const next = ['a', 'b', 'd', 'e'].join('\n');
  const changes = computeLineChanges(base, next);
  assert(changes.chunks.length === 0, '纯删除不产生色条');
  assert(changes.deletes.length === 1, '一个删除锚点');
  assert(changes.deletes[0].texts.join('|') === 'c', '锚点带出被删原文');
  assert(changes.deletes[0].line === 3, '锚点在第 3 行（删除位置之后那一行）');
}

console.log('4. 一行改一行');
{
  const next = ['a', 'b', 'C', 'd', 'e'].join('\n');
  const changes = computeLineChanges(base, next);
  assert(changes.chunks.length === 1 && changes.chunks[0].kind === 'modified', '类型是 modified');
  assert(changes.chunks[0].startLine === 3, '落在第 3 行');
  assert(changes.deletes.length === 1, '同时有删除锚点');
  assert(changes.deletes[0].line === 3, '锚点在第 3 行');
}

console.log('5. 改一行加两行');
{
  // Myers 的最短解是 delete c + insert C,D,F（4 次编辑），只把 c 当被替换的那行，
  // 多出来的 D、F 算新增。不要按「c,d 都被替换」去期望，那是非最短差分。
  const next = ['a', 'b', 'C', 'D', 'F', 'd', 'e'].join('\n');
  const changes = computeLineChanges(base, next);
  const modified = changes.chunks.filter((chunk) => chunk.kind === 'modified');
  const added = changes.chunks.filter((chunk) => chunk.kind === 'added');
  assert(modified.length === 1 && modified[0].startLine === 3, '第 3 行算修改');
  assert(added.length === 1 && added[0].startLine === 4, '第 4、5 行算新增');
  assert(added[0].endLine === 5, '新增到第 5 行');
  assert(changes.deletes[0].line === 3, '锚点在块首行');
}

console.log('6. 文件开头删除');
{
  const changes = computeLineChanges('a\nb', 'b');
  assert(changes.deletes[0].line === 1, '锚点钳到第 1 行');
}

console.log('7. 文件末尾删除');
{
  const changes = computeLineChanges('a\nb\nc', 'a\nb');
  assert(changes.deletes[0].line === 2, '锚点钳到最后一行');
}

console.log('8. 空文件');
{
  const changes = computeLineChanges('', 'a\nb');
  assert(changes.totalLines === 2, 'totalLines 为 2');
  assert(changes.chunks.length === 1 && changes.chunks[0].kind === 'added', '整篇算新增');
  const emptied = computeLineChanges('a\nb', '');
  assert(emptied.chunks.length === 0, '清空文件不产生色条');
  assert(emptied.deletes.length === 1, '清空文件有一个锚点');
}

console.log('9. 末尾换行不算一行');
{
  const changes = computeLineChanges('a\nb\n', 'a\nb\n');
  assert(changes.totalLines === 2, '末尾换行不额外算一行');
}

console.log('10. 超大文件直接放弃');
{
  const big = Array.from({ length: 15000 }, (_, index) => `line${index}`).join('\n');
  const bigNext = big + '\nextra';
  const changes = computeLineChanges(big, bigNext);
  assert(changes.chunks.length === 0 && changes.deletes.length === 0, '超过 20000 行返回空结果');
}

console.log(`\n全部通过：${passed} 项`);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/line-changes.mjs`
Expected: FAIL —— `Cannot find module` / `src/lineChanges.ts` 不存在。

- [ ] **Step 3: 导出 `diffFromText.ts` 的既有能力**

在 `src/diffFromText.ts` 中：

1. 把 `type Op = { ... }` 改成 `export type DiffOp = { ... }`，并把文件内所有 `Op` 改为 `DiffOp`。
2. 在 `buildTextPatch` 上方新增并复用：

```ts
export function splitLinesForDiff(text: string): string[] {
  const lines = String(text ?? '').split(/\r?\n/);
  // 末尾换行会切出一个空串，比对时不该算作一行差异
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
```

3. 把 `function diffLines(` 改成 `export function diffLines(`。
4. `buildTextPatch` 里原来的三行切分与 pop 改为：

```ts
const oldLines = splitLinesForDiff(oldText);
const newLines = splitLinesForDiff(newText);
```

- [ ] **Step 4: 写 `src/lineChanges.ts`**

```ts
import { diffLines, splitLinesForDiff } from './diffFromText';
import type { DiffOp } from './diffFromText';

export type LineChangeKind = 'added' | 'modified';

export type ChangeChunk = {
  startLine: number;
  endLine: number;
  kind: LineChangeKind;
};

export type DeleteAnchor = {
  line: number;
  texts: string[];
};

export type LineChanges = {
  chunks: ChangeChunk[];
  addedLines: number[];
  modifiedLines: number[];
  deletes: DeleteAnchor[];
  totalLines: number;
};

// 与 diffFromText 的大文件兜底同量级：标记只是辅助信息，
// 不值得为超大文件付出逐行装饰的成本。
const MARKER_LINE_LIMIT = 20000;

function empty(totalLines: number): LineChanges {
  return { chunks: [], addedLines: [], modifiedLines: [], deletes: [], totalLines };
}

export function computeLineChanges(oldText: string, newText: string): LineChanges {
  const oldLines = splitLinesForDiff(oldText);
  const newLines = splitLinesForDiff(newText);
  const totalLines = Math.max(1, newLines.length);

  if (oldLines.join('\n') === newLines.join('\n')) return empty(totalLines);
  if (oldLines.length + newLines.length > MARKER_LINE_LIMIT) return empty(totalLines);

  const ops: DiffOp[] = diffLines(oldLines, newLines);
  const clamp = (line: number) => Math.min(Math.max(1, line), totalLines);

  const changes = empty(totalLines);
  let newLine = 1;
  let index = 0;

  while (index < ops.length) {
    if (ops[index].kind === 'equal') {
      newLine += 1;
      index += 1;
      continue;
    }

    const blockStart = newLine;
    const deleted: string[] = [];
    let inserts = 0;
    while (index < ops.length && ops[index].kind !== 'equal') {
      if (ops[index].kind === 'delete') {
        deleted.push(ops[index].text);
      } else {
        inserts += 1;
        newLine += 1;
      }
      index += 1;
    }

    if (inserts > 0) {
      // 删 d 行插 i 行时，前 min(d, i) 行算「修改」，多出来的算「新增」
      const modifiedCount = Math.min(deleted.length, inserts);
      if (modifiedCount > 0) {
        changes.chunks.push({
          startLine: blockStart,
          endLine: blockStart + modifiedCount - 1,
          kind: 'modified',
        });
        for (let line = blockStart; line < blockStart + modifiedCount; line += 1) {
          changes.modifiedLines.push(line);
        }
      }
      if (inserts > modifiedCount) {
        const from = blockStart + modifiedCount;
        changes.chunks.push({ startLine: from, endLine: blockStart + inserts - 1, kind: 'added' });
        for (let line = from; line < blockStart + inserts; line += 1) {
          changes.addedLines.push(line);
        }
      }
    }

    if (deleted.length > 0) {
      // 块产生了新行就锚在块首行；纯删除锚在删除位置之后那一行
      changes.deletes.push({
        line: clamp(inserts > 0 ? blockStart : newLine),
        texts: deleted,
      });
    }
  }

  return changes;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node tests/line-changes.mjs`
Expected: `全部通过：N 项`，无 FAIL。

- [ ] **Step 6: 跑一遍既有的 diff 测试确认没改坏**

Run: `node tests/diff-from-text.mjs && node tests/diff-parser.mjs`
Expected: 两个脚本都跑到底，无异常。

- [ ] **Step 7: 提交**

```bash
git add src/lineChanges.ts src/diffFromText.ts tests/line-changes.mjs
git commit -m "feat(editor): 行级变更计算，复用 Myers 差分"
```

---

### Task 2: 后端 blame 与单文件提交 diff

**Files:**
- Modify: `desktop/git.js`（新增 `blame`、`showFileDiff`，加入 `module.exports`）
- Modify: `desktop/main.js:345` 附近（两个 IPC）
- Modify: `desktop/preload.js:78` 附近（两个方法）
- Modify: `src/global.d.ts`（`git` 段两个方法）
- Test: `tests/git-blame.mjs`

**Interfaces:**
- Consumes: `runGit`、`resolveWithin`、`assertCommitHash`、`cleanError`（都已在 `desktop/git.js` 内）
- Produces:
  - `git.blame(projectPath, filePath, line)` → `{ hash, short, author, authorTime, summary, origLine } | null`
  - `git.showFileDiff(projectPath, hash, filePath)` → `{ patch: string }`
  - 渲染侧同名方法挂在 `window.api.git` 上

- [ ] **Step 1: 写失败的测试**

创建 `tests/git-blame.mjs`：

```js
// blame 与单文件提交 diff。离线可跑，用临时仓库。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const git = require('../desktop/git.js');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const repo = mkdtempSync(join(tmpdir(), 'cmdtb-blame-'));
execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
execFileSync('git', ['config', 'user.name', 'Alice'], { cwd: repo });
execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });

writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
execFileSync('git', ['add', '.'], { cwd: repo });
execFileSync('git', ['commit', '-m', '首次提交'], { cwd: repo });

const first = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

console.log('1. blame 命中');
const hit = await git.blame(repo, 'a.txt', 2);
assert(hit !== null, '能拿到 blame 结果');
assert(hit.author === 'Alice', '作者正确');
assert(hit.summary === '首次提交', '提交信息正确');
assert(hit.origLine === 2, 'origLine 为 2');
assert(hit.short === first.slice(0, 7), '短哈希正确');

console.log('2. 越界行号被钳住');
const clamped = await git.blame(repo, 'a.txt', 999);
assert(clamped !== null, '越界行号仍然能查');

console.log('3. 未跟踪文件返回 null');
writeFileSync(join(repo, 'b.txt'), 'x\n');
const untracked = await git.blame(repo, 'b.txt', 1);
assert(untracked === null, '未跟踪文件返回 null');

console.log('4. 路径越界报错');
let escaped = false;
try {
  await git.blame(repo, '../outside.txt', 1);
} catch {
  escaped = true;
}
assert(escaped, '项目目录外的路径被拒绝');

console.log('5. 单文件提交 diff');
const shown = await git.showFileDiff(repo, first, 'a.txt');
assert(shown.patch.includes('+one'), '包含新增行');
assert(shown.patch.includes('a.txt'), '包含文件路径');

console.log('6. 非法提交标识报错');
let badHash = false;
try {
  await git.showFileDiff(repo, 'not a hash !!', 'a.txt');
} catch {
  badHash = true;
}
assert(badHash, '非法 hash 被拒绝');

console.log(`\n全部通过：${passed} 项`);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/git-blame.mjs`
Expected: FAIL —— `git.blame is not a function`。

- [ ] **Step 3: 在 `desktop/git.js` 里实现两个函数**

放在 `commitDiff` 之后、`module.exports` 之前：

```js
const BLAME_TIMEOUT = 15000;
const PATCH_CHAR_LIMIT = 204800;

// porcelain 首行是 `<hash> <origLine> <finalLine> [行数]`，其余是按前缀区分的键值。
function parseBlamePorcelain(raw) {
  const lines = String(raw || '').split('\n');
  const head = (lines[0] || '').trim().match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)/);
  if (!head) return null;
  // 全 0 是「尚未提交」的行，没有可展示的提交
  if (/^0{40}$/.test(head[1])) return null;

  let author = '';
  let authorTime = 0;
  let summary = '';
  for (const line of lines.slice(1)) {
    if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('author-time ')) authorTime = Number(line.slice(12));
    else if (line.startsWith('summary ')) summary = line.slice(8);
  }

  return {
    hash: head[1],
    short: head[1].slice(0, 7),
    author,
    authorTime: Number.isFinite(authorTime) ? authorTime : 0,
    summary,
    origLine: Number(head[2]),
  };
}

async function blame(projectPath, filePath, line) {
  const root = path.resolve(projectPath);
  const target = resolveWithin(root, String(filePath || ''));
  const relative = path.relative(root, target);
  if (!relative) throw new Error('文件路径不在项目目录内');

  const lineNo = Math.max(1, Math.trunc(Number(line) || 1));
  const result = await runGit(
    projectPath,
    ['--no-pager', 'blame', '--line-porcelain', '-L', `${lineNo},${lineNo}`, '--', relative],
    { timeout: BLAME_TIMEOUT },
  );
  if (!result.ok) {
    // 未跟踪 / 不在索引里：没有可归属的提交，按「查不到」处理
    if (/no such path|does not exist|no such ref|not a valid object|fatal: no such/i.test(result.stderr)) {
      return null;
    }
    throw new Error(cleanError(result.error, result.stderr));
  }
  return parseBlamePorcelain(result.stdout);
}

async function showFileDiff(projectPath, hash, filePath) {
  const root = path.resolve(projectPath);
  const target = resolveWithin(root, String(filePath || ''));
  const relative = path.relative(root, target);
  if (!relative) throw new Error('文件路径不在项目目录内');
  const revision = assertCommitHash(hash);

  const result = await runGit(projectPath, [
    '--no-pager',
    'show',
    '--no-color',
    '--no-ext-diff',
    '-U3',
    revision,
    '--',
    relative,
  ]);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  return { patch: result.stdout.slice(0, PATCH_CHAR_LIMIT) };
}
```

在 `module.exports` 里加上 `blame,` 与 `showFileDiff,`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/git-blame.mjs`
Expected: `全部通过：N 项`。

- [ ] **Step 5: 接上 IPC 与类型**

`desktop/main.js` 在 `git:commit-diff` 那一行后面加：

```js
  ipcMain.handle('git:blame', (_event, projectPath, filePath, line) =>
    git.blame(assertProjectPath(projectPath), filePath, line),
  );

  ipcMain.handle('git:show-file-diff', (_event, projectPath, hash, filePath) =>
    git.showFileDiff(assertProjectPath(projectPath), hash, filePath),
  );
```

`desktop/preload.js` 的 `git` 段里，`commitDiff` 之后加：

```js
    blame: (projectPath, filePath, line) =>
      invoke('git:blame', projectPath, filePath, line),
    showFileDiff: (projectPath, hash, filePath) =>
      invoke('git:show-file-diff', projectPath, hash, filePath),
```

`src/global.d.ts` 的 `git` 类型里加：

```ts
        blame: (
          projectPath: string,
          filePath: string,
          line: number,
        ) => Promise<{
          hash: string;
          short: string;
          author: string;
          authorTime: number;
          summary: string;
          origLine: number;
        } | null>;
        showFileDiff: (
          projectPath: string,
          hash: string,
          filePath: string,
        ) => Promise<{ patch: string }>;
```

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 7: 提交**

```bash
git add desktop/git.js desktop/main.js desktop/preload.js src/global.d.ts tests/git-blame.mjs
git commit -m "feat(git): blame 与单文件提交 diff 接口"
```

---

### Task 3: 编辑器变更 gutter

**Files:**
- Modify: `src/components/CodeMirrorHost.tsx`
- Modify: `src/editorTheme.ts`

**Interfaces:**
- Consumes: `LineChanges`、`LineChangeKind`（Task 1）
- Produces: `CodeMirrorHostProps` 新增 `changeMarkers?: LineChanges | null`

- [ ] **Step 1: 加状态字段与 gutter**

在 `src/components/CodeMirrorHost.tsx` 顶部 import 补上：

```ts
import { gutter, GutterMarker } from '@codemirror/view';
import type { LineChangeKind, LineChanges } from '../lineChanges';
```

在 `referenceExtension` 函数之前插入：

```ts
const setChangeMarkers = StateEffect.define<LineChanges | null>();

type MarkerSpans = {
  // 行首位置 → 类型；存位置而不是行号，用户编辑时才能用 mapPos 跟随
  bars: Map<number, LineChangeKind>;
  deletes: Map<number, string[]>;
};

const EMPTY_SPANS: MarkerSpans = { bars: new Map(), deletes: new Map() };

function spansFromLines(state: EditorStateType, changes: LineChanges): MarkerSpans {
  const doc = state.doc;
  const startOf = (line: number) => doc.line(Math.min(Math.max(1, line), doc.lines)).from;

  const bars = new Map<number, LineChangeKind>();
  for (const chunk of changes.chunks) {
    const from = Math.max(1, chunk.startLine);
    const to = Math.min(chunk.endLine, doc.lines);
    for (let line = from; line <= to; line += 1) bars.set(startOf(line), chunk.kind);
  }

  const deletes = new Map<number, string[]>();
  for (const anchor of changes.deletes) deletes.set(startOf(anchor.line), anchor.texts);
  return { bars, deletes };
}

const changeMarkerField = StateField.define<MarkerSpans>({
  create: () => EMPTY_SPANS,
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(setChangeMarkers)) {
        next = effect.value ? spansFromLines(tr.state, effect.value) : EMPTY_SPANS;
      }
    }
    // 上一次标记还没被新行号覆盖时，按位置跟随，避免打字时下方标记整体错行
    if (tr.docChanged && next === value && value !== EMPTY_SPANS) {
      const bars = new Map<number, LineChangeKind>();
      for (const [pos, kind] of value.bars) bars.set(tr.changes.mapPos(pos, -1), kind);
      const deletes = new Map<number, string[]>();
      for (const [pos, texts] of value.deletes) deletes.set(tr.changes.mapPos(pos, 1), texts);
      next = { bars, deletes };
    }
    return next;
  },
});

function sameTexts(a: string[] | null, b: string[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

class ChangeGutterMarker extends GutterMarker {
  constructor(
    readonly kind: LineChangeKind | null,
    readonly deleted: string[] | null,
  ) {
    super();
  }

  eq(other: GutterMarker): boolean {
    const target = other as ChangeGutterMarker;
    return this.kind === target.kind && sameTexts(this.deleted, target.deleted);
  }

  toDOM(): HTMLElement {
    const host = document.createElement('div');
    host.className = 'cm-change-marker';
    if (this.kind) host.classList.add(`is-${this.kind}`);
    if (this.deleted) {
      const triangle = document.createElement('span');
      triangle.className = 'cm-change-triangle';
      const head = this.deleted.slice(0, 5);
      const rest = this.deleted.length - head.length;
      triangle.title = head.join('\n') + (rest > 0 ? `\n… 还有 ${rest} 行` : '');
      host.appendChild(triangle);
    }
    return host;
  }
}

const changeGutter = gutter({
  class: 'cm-change-gutter',
  lineMarker(view, line) {
    const spans = view.state.field(changeMarkerField, false);
    if (!spans) return null;
    const kind = spans.bars.get(line.from) ?? null;
    const deleted = spans.deletes.get(line.from) ?? null;
    if (!kind && !deleted) return null;
    return new ChangeGutterMarker(kind, deleted);
  },
});
```

- [ ] **Step 2: 接上 props 与 effect**

`CodeMirrorHostProps` 加一行（放在 `onConflictCountChange` 之后）：

```ts
  // 与 Git HEAD 的行级差异；null 表示不显示标记
  changeMarkers?: LineChanges | null;
```

函数参数解构里加 `changeMarkers`。

在其它 ref 声明附近加：

```ts
  const changeMarkersRef = useRef(changeMarkers);
  changeMarkersRef.current = changeMarkers;
```

在主 `extensions` 数组里，`conflictField,` 之后加：

```ts
          changeMarkerField,
          changeGutter,
```

在 `viewRef.current = view;` 之后加：

```ts
    // 首次创建时补一次：effect 依赖相同引用时不会重跑
    view.dispatch({ effects: setChangeMarkers.of(changeMarkersRef.current ?? null) });
```

在组件内新增一个 effect（放在 `filePath` 重建 effect 之后）：

```ts
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setChangeMarkers.of(changeMarkers ?? null) });
  }, [changeMarkers]);
```

- [ ] **Step 3: 加主题样式**

`src/editorTheme.ts` 的 `lightTheme` 主题对象里加：

```ts
    '.cm-change-gutter': { width: '14px' },
    '.cm-change-gutter .cm-gutterElement': { display: 'flex', alignItems: 'center' },
    '.cm-change-marker': { position: 'relative', width: '100%', height: '100%' },
    '.cm-change-marker.is-added': {
      borderLeft: '3px solid #1e88e5',
      marginLeft: '5px',
    },
    '.cm-change-marker.is-modified': {
      borderLeft: '3px solid #e8a33d',
      marginLeft: '5px',
    },
    '.cm-change-triangle': {
      position: 'absolute',
      top: '1px',
      left: '1px',
      width: '0',
      height: '0',
      borderTop: '4px solid transparent',
      borderBottom: '4px solid transparent',
      borderLeft: '5px solid #e5484d',
    },
```

`darkTheme` 里同样的结构，只换颜色：`#4fa3ff`、`#e2b436`、`#f14c4c`。

- [ ] **Step 4: 类型检查与构建**

Run: `npx tsc --noEmit && npx vite build`
Expected: 都通过。

- [ ] **Step 5: 提交**

```bash
git add src/components/CodeMirrorHost.tsx src/editorTheme.ts
git commit -m "feat(editor): 变更行 gutter 与删除三角"
```

---

### Task 4: 概览标尺

**Files:**
- Create: `src/components/EditorOverviewRuler.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `LineChanges`（Task 1）
- Produces: `export function EditorOverviewRuler({ changes }: { changes: LineChanges | null })`

- [ ] **Step 1: 写组件**

```tsx
import type { LineChanges } from '../lineChanges';

// 只读展示：按行号占比把变更画成短色条，不参与任何交互
export function EditorOverviewRuler({ changes }: { changes: LineChanges | null }) {
  if (!changes) return null;
  if (!changes.chunks.length && !changes.deletes.length) return null;

  const total = Math.max(1, changes.totalLines);
  const percent = (line: number) => ((line - 1) / total) * 100;

  return (
    <div className="editor-overview-ruler" aria-hidden="true">
      {changes.chunks.map((chunk, index) => (
        <span
          key={`chunk-${chunk.startLine}-${index}`}
          className={`editor-overview-mark is-${chunk.kind}`}
          style={{
            top: `${percent(chunk.startLine)}%`,
            height: `max(3px, ${((chunk.endLine - chunk.startLine + 1) / total) * 100}%)`,
          }}
        />
      ))}
      {changes.deletes.map((anchor, index) => (
        <span
          key={`delete-${anchor.line}-${index}`}
          className="editor-overview-mark is-deleted"
          style={{ top: `${percent(anchor.line)}%` }}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: 加样式**

`src/styles.css` 在 `.codemirror-host` 规则之后加：

```css
/* 概览标尺：贴右缘、避开 10px 系统滚动条，不抢鼠标事件 */
.editor-overview-ruler {
  position: absolute;
  top: 0;
  right: 10px;
  bottom: 0;
  width: 8px;
  pointer-events: none;
  z-index: 2;
}

.editor-overview-mark {
  position: absolute;
  left: 1px;
  width: 6px;
  border-radius: 1px;
}

.editor-overview-mark.is-added {
  background: #1e88e5;
}

.editor-overview-mark.is-modified {
  background: #e8a33d;
}

.editor-overview-mark.is-deleted {
  height: 3px;
  background: #e5484d;
}
```

- [ ] **Step 3: 构建**

Run: `npx tsc --noEmit && npx vite build`
Expected: 通过（组件尚未挂载，只是确保能编译）。

- [ ] **Step 4: 提交**

```bash
git add src/components/EditorOverviewRuler.tsx src/styles.css
git commit -m "feat(editor): 变更概览标尺组件"
```

---

### Task 5: 接线——拉取基准、防抖重算、挂标尺

**Files:**
- Modify: `src/components/EditorPane.tsx`
- Modify: `src/App.tsx`
- Test: `tests/editor-change-markers.mjs`

**Interfaces:**
- Consumes: `computeLineChanges`（Task 1）、`CodeMirrorHost` 的 `changeMarkers` prop（Task 3）、`EditorOverviewRuler`（Task 4）
- Produces: `EditorPaneProps` 新增 `gitStateKey?: string`

- [ ] **Step 1: 写失败的 GUI 测试**

创建 `tests/editor-change-markers.mjs`（沿用 `tests/git-panel.mjs` 的启动方式）：

```js
// 编辑器 Git 变更标记。需要独占 17382 端口。
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-marker-data-'));
const repo = mkdtempSync(join(tmpdir(), 'cmdtb-marker-repo-'));

execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });

// 提交版本：sample.txt 有改动，clean.txt 提交后保持原样
writeFileSync(join(repo, 'sample.txt'), 'a\nb\nc\nd\n');
writeFileSync(join(repo, 'clean.txt'), 'hello\n');
execFileSync('git', ['add', '.'], { cwd: repo });
execFileSync('git', ['commit', '-m', '初始提交'], { cwd: repo });

// 工作区版本：第 2 行改掉（modified，同时有删除锚点），第 4 行插入一行（added）。
// 不要写成 a/B/X/d——那样 Myers 会算成「2、3 行都修改」，没有 added 色条可断言。
writeFileSync(join(repo, 'sample.txt'), 'a\nB\nc\nX\nd\n');
// 未跟踪文件对 HEAD 对比时整篇算新增
writeFileSync(join(repo, 'new.txt'), 'brand new\n');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log('  ok  ' + message);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.CMDTOOLBOX_NO_UPDATE = '1';

const app = await electron.launch({
  executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
  cwd: root,
  args: ['.', `--data-dir=${dataDir}`],
  env,
});
const page = await app.firstWindow();
page.on('pageerror', (error) => console.log('  [pageerror]', error.message));
await page.waitForLoadState('domcontentloaded');
await page.locator('.app').waitFor();
await page.waitForFunction(() => !document.querySelector('.boot-screen'));

// 主进程不认 --project 参数，项目必须走界面添加
async function addProject(path, name) {
  const modal = page.locator('.modal-card');
  const deadline = Date.now() + 20000;
  while ((await modal.count()) === 0) {
    if (Date.now() > deadline) throw new Error('等待超时：添加项目弹窗未出现');
    await page.locator('.add-project-btn').click({ force: true });
    await page.waitForTimeout(600);
  }
  await page.locator('#project-path').fill(path);
  await page.locator('#project-name').fill(name);
  await page.getByRole('button', { name: '保存项目', exact: true }).click({ force: true });
  await modal.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(600);
}

await addProject(repo, 'marker-proj');

async function openFile(name) {
  await page.locator(`.file-tree .file-row[title="${name}"]`).click();
  await page.locator('.cm-editor').first().waitFor();
  await page.waitForTimeout(1200);
}

console.log('1. 修改与新增行显示色条');
await openFile('sample.txt');
assert(
  (await page.locator('.cm-change-marker.is-modified').count()) >= 1,
  '出现 modified 色条',
);
assert((await page.locator('.cm-change-marker.is-added').count()) >= 1, '出现 added 色条');
assert((await page.locator('.cm-change-triangle').count()) >= 1, '出现删除三角');

console.log('2. 概览标尺');
assert((await page.locator('.editor-overview-ruler .editor-overview-mark').count()) >= 2, '标尺有标记');

console.log('3. 干净文件没有标记');
await openFile('clean.txt');
await page.waitForTimeout(600);
assert((await page.locator('.cm-change-marker').count()) === 0, '干净文件没有色条');
assert((await page.locator('.editor-overview-ruler').count()) === 0, '干净文件不画标尺');

console.log('3b. 未跟踪文件整篇算新增');
await openFile('new.txt');
await page.waitForTimeout(600);
assert((await page.locator('.cm-change-marker.is-added').count()) >= 1, '未跟踪文件显示 added 色条');

await app.close();
console.log(`\n全部通过：${passed} 项`);
```

- [ ] **Step 2: 运行确认失败**

先清理残留进程：

```bash
powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force"
```

Run: `node tests/editor-change-markers.mjs`
Expected: FAIL —— 找不到 `.cm-change-marker`。

- [ ] **Step 3: `EditorPane` 加基准拉取与重算**

在 `EditorPaneProps` 类型里加：

```ts
  // Git 变更条目的指纹，变化时重新拉 HEAD 基准
  gitStateKey?: string;
```

解构里加 `gitStateKey`。

在 state 声明区（`editorGitStatus` 附近）加：

```ts
  const [changeMarkers, setChangeMarkers] = useState<LineChanges | null>(null);
  const baseTextRef = useRef(new Map<string, { text: string; at: number }>());
  const [baseRefreshToken, setBaseRefreshToken] = useState(0);
```

import 补上：

```ts
import { computeLineChanges } from '../lineChanges';
import type { LineChanges } from '../lineChanges';
import { EditorOverviewRuler } from './EditorOverviewRuler';
```

在组件内加三个 effect（放在 `useEffect` 依赖 `diffSource` 那一段之前）：

```ts
  const loadHeadBase = useCallback(
    async (relPath: string): Promise<string | null> => {
      const cached = baseTextRef.current.get(relPath);
      if (cached && Date.now() - cached.at < 60_000) return cached.text;
      try {
        const result = await window.api.git.fileDiff(group.path, relPath, 'modified', 'HEAD');
        const text = result.baseContent ?? '';
        baseTextRef.current.set(relPath, { text, at: Date.now() });
        return text;
      } catch {
        // 非 Git 项目 / git 不可用：静默不显示标记
        return null;
      }
    },
    [group.path],
  );

  // 窗口重新获得焦点时丢掉缓存：提交完切回来，标记应当自动消失
  useEffect(() => {
    const onFocus = () => {
      baseTextRef.current.clear();
      setBaseRefreshToken((value) => value + 1);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // Git 状态条目变化（提交 / 暂存 / 放弃 / 切分支）同样让缓存失效
  useEffect(() => {
    baseTextRef.current.clear();
    setBaseRefreshToken((value) => value + 1);
  }, [gitStateKey]);

  useEffect(() => {
    if (!activePath || isUntitledPath(activePath) || !file || file.readOnly) {
      setChangeMarkers(null);
      return;
    }
    const relPath = activePath;
    const content = file.content;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadHeadBase(relPath).then((base) => {
        if (cancelled) return;
        setChangeMarkers(base === null ? null : computeLineChanges(base, content));
      });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activePath, file, loadHeadBase, baseRefreshToken]);
```

- [ ] **Step 4: 挂到编辑器与容器上**

`<CodeMirrorHost ...>` 里加一行：

```tsx
                  changeMarkers={changeMarkers}
```

在 `.editor-diff-pane` 那个 `div` 的子节点（`<CodeMirrorHost>` 之后、`</div>` 之前）加：

```tsx
                <EditorOverviewRuler changes={changeMarkers} />
```

- [ ] **Step 5: `App.tsx` 传指纹**

在 `App.tsx` 里加（放在 `gitStatus` 可用的位置之后）：

```ts
  const editorGitStateKey = useMemo(() => {
    if (!gitStatus?.ok) return '';
    return gitStatus.changes
      .map((change) => `${change.path}:${change.indexStatus ?? ''}:${change.worktreeStatus ?? ''}`)
      .join('|');
  }, [gitStatus]);
```

`<EditorPane ...>` 上补一个 prop：

```tsx
          gitStateKey={editorGitStateKey}
```

> `useMemo` 与 `GitStatus` 已在 `App.tsx` 顶部引入；若 `useMemo` 未在 import 里，补上。

- [ ] **Step 6: 构建并跑测试**

Run: `npx tsc --noEmit && npx vite build && node tests/editor-change-markers.mjs`
Expected: 测试全部通过。

- [ ] **Step 7: 提交**

```bash
git add src/components/EditorPane.tsx src/App.tsx tests/editor-change-markers.mjs
git commit -m "feat(editor): 打开文件自动对比 HEAD 并显示变更标记"
```

---

### Task 6: 行号点击与内联 blame

**Files:**
- Create: `src/blameLookup.ts`
- Create: `src/components/BlameCard.tsx`
- Modify: `src/components/CodeMirrorHost.tsx`
- Modify: `src/styles.css`
- Test: 扩展 `tests/editor-change-markers.mjs`

**Interfaces:**
- Consumes: `window.api.git.blame` / `showFileDiff`（Task 2）、`parsePatch`（`src/diffParser.ts`）
- Produces:
  - `blameLookup.ts`：`export type BlameInfo`、`export async function lookupBlame(projectPath, filePath, line): Promise<BlameInfo | null>`、`export async function lookupCommitFileDiff(projectPath, hash, filePath): Promise<string>`、`export function pickHunkForLine(patch: string, line: number): DiffHunk | null`
  - `CodeMirrorHostProps` 新增 `blameEnabled?: boolean`

- [ ] **Step 1: 写 `src/blameLookup.ts`**

```ts
import { parsePatch } from './diffParser';
import type { DiffHunk } from './diffParser';

export type BlameInfo = {
  hash: string;
  short: string;
  author: string;
  authorTime: number;
  summary: string;
  origLine: number;
};

export async function lookupBlame(
  projectPath: string,
  filePath: string,
  line: number,
): Promise<BlameInfo | null> {
  try {
    return await window.api.git.blame(projectPath, filePath, line);
  } catch {
    return null;
  }
}

export async function lookupCommitFileDiff(
  projectPath: string,
  hash: string,
  filePath: string,
): Promise<string> {
  try {
    const result = await window.api.git.showFileDiff(projectPath, hash, filePath);
    return result.patch;
  } catch {
    return '';
  }
}

// 只取覆盖该旧行号的 hunk；新增文件的 hunk 是 -0,0，匹配不到就当作无片段
export function pickHunkForLine(patch: string, line: number): DiffHunk | null {
  const parsed = parsePatch(patch);
  for (const hunk of parsed.hunks) {
    const match = hunk.header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (line >= start && line < start + Math.max(count, 1)) return hunk;
  }
  return null;
}
```

- [ ] **Step 2: 写 `src/components/BlameCard.tsx`**

```tsx
import { useState } from 'react';
import { Copy } from 'lucide-react';
import type { BlameInfo } from '../blameLookup';
import type { DiffHunk } from '../diffParser';

const RELATIVE_UNITS: Array<[number, Intl.RelativeTimeFormatUnit]> = [
  [60, 'second'],
  [60, 'minute'],
  [24, 'hour'],
  [30, 'day'],
  [12, 'month'],
];

function relativeTime(epochSeconds: number): string {
  let value = Math.max(0, Date.now() / 1000 - epochSeconds);
  const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
  for (const [step, unit] of RELATIVE_UNITS) {
    if (value < step) return formatter.format(-Math.round(value), unit);
    value /= step;
  }
  return formatter.format(-Math.round(value), 'year');
}

export type BlameCardState = {
  info: BlameInfo;
  hunk: DiffHunk | null;
};

export function BlameCard({ state }: { state: BlameCardState }) {
  const [copied, setCopied] = useState(false);
  const { info, hunk } = state;
  const shown = hunk ? hunk.lines.slice(0, 40) : [];
  const hidden = hunk ? hunk.lines.length - shown.length : 0;

  return (
    <div className="blame-card">
      <div className="blame-card-head">
        <span className="blame-author">{info.author}</span>
        <span className="blame-time">{relativeTime(info.authorTime)}</span>
      </div>
      <p className="blame-summary">{info.summary || '(无提交信息)'}</p>
      <div className="blame-card-hash">
        <code>{info.short}</code>
        <button
          type="button"
          className="icon-btn"
          title="复制提交哈希"
          onClick={() => {
            void navigator.clipboard.writeText(info.hash).then(
              () => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              },
              () => {},
            );
          }}
        >
          <Copy size={12} />
        </button>
        {copied ? <span className="blame-copied">已复制</span> : null}
      </div>
      {shown.length ? (
        <div className="blame-diff">
          {shown.map((line, index) => (
            <div key={index} className={`blame-diff-row is-${line.kind}`}>
              <span className="blame-diff-sign">
                {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
              </span>
              <span className="blame-diff-text">{line.text || ' '}</span>
            </div>
          ))}
          {hidden > 0 ? <div className="blame-diff-more">… 还有 {hidden} 行</div> : null}
        </div>
      ) : (
        <p className="blame-empty">该提交没有可展示的片段</p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 在 `CodeMirrorHost` 里加 blame 字段与交互**

import 补上：

```ts
import { lookupBlame, lookupCommitFileDiff, pickHunkForLine } from '../blameLookup';
import type { BlameInfo } from '../blameLookup';
import type { DiffHunk } from '../diffParser';
import { BlameCard } from './BlameCard';
import type { BlameCardState } from './BlameCard';
```

在 `changeGutter` 定义之后插入：

```ts
type BlameFieldValue = {
  line: number;
  status: 'loading' | 'ready' | 'failed';
  info: BlameInfo | null;
  hunk: DiffHunk | null;
} | null;

const setBlame = StateEffect.define<BlameFieldValue>();

const blameField = StateField.define<BlameFieldValue>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setBlame)) return effect.value;
    }
    if (tr.docChanged) return null;
    return value;
  },
});

class BlameWidget extends WidgetType {
  constructor(readonly value: NonNullable<BlameFieldValue>) {
    super();
  }

  eq(other: BlameWidget): boolean {
    return (
      other.value.line === this.value.line &&
      other.value.status === this.value.status &&
      other.value.info?.hash === this.value.info?.hash
    );
  }

  toDOM(): HTMLElement {
    const host = document.createElement('span');
    host.className = 'cm-blame-inline';
    if (this.value.status === 'loading') {
      host.textContent = '正在读取提交…';
    } else if (this.value.status === 'failed' || !this.value.info) {
      host.textContent = '没有提交记录';
    } else {
      const { info } = this.value;
      host.textContent = `${info.author} · ${info.short} · ${info.summary}`;
    }
    return host;
  }
}

const blameDecorations = EditorView.decorations.compute([blameField], (state) => {
  const value = state.field(blameField, false);
  if (!value) return Decoration.none;
  const line = state.doc.line(Math.min(value.line, state.doc.lines));
  return Decoration.set([
    Decoration.widget({ widget: new BlameWidget(value), side: 1 }).range(line.to),
  ]);
});
```

在 `CodeMirrorHost` 组件内加入 ref：

```ts
  const blameLookupRef = useRef<(line: number) => void>(() => {});
```

用 `useEffect` 维护它（在其它 ref 赋值之后）：

```ts
  blameLookupRef.current = (line: number) => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.field(blameField, false);
    // 点同一行再次点击就收起
    if (current && current.line === line && current.status !== 'loading') {
      view.dispatch({ effects: setBlame.of(null) });
      return;
    }
    view.dispatch({ effects: setBlame.of({ line, status: 'loading', info: null, hunk: null }) });
    void lookupBlame(projectPathRef.current, activeFileRef.current, line).then(async (info) => {
      const latest = view.state.field(blameField, false);
      if (!latest || latest.line !== line) return;
      if (!info) {
        view.dispatch({ effects: setBlame.of({ line, status: 'failed', info: null, hunk: null }) });
        return;
      }
      const patch = await lookupCommitFileDiff(
        projectPathRef.current,
        info.hash,
        activeFileRef.current,
      );
      const stillLatest = view.state.field(blameField, false);
      if (!stillLatest || stillLatest.line !== line) return;
      view.dispatch({
        effects: setBlame.of({
          line,
          status: 'ready',
          info,
          hunk: pickHunkForLine(patch, info.origLine),
        }),
      });
    });
  };
```

在 `referenceExtension` 之外新增一个扩展工厂（放在 `referenceExtension` 函数之后）：

```ts
function blameExtension(options: {
  isEnabled: () => boolean;
  onLineClick: (line: number) => void;
}): Extension {
  const clickHandler = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!options.isEnabled()) return false;
      if (event.button !== 0) return false;
      const element = event.target instanceof Element ? event.target.closest('.cm-gutterElement') : null;
      if (!element) return false;
      // 只在行号 gutter 与变更 gutter 上响应
      if (!element.closest('.cm-lineNumbers, .cm-change-gutter')) return false;

      const rect = element.getBoundingClientRect();
      const block = view.lineBlockAtHeight(rect.top + rect.height / 2 - view.documentTop);
      const line = view.state.doc.lineAt(block.from).number;
      event.preventDefault();
      options.onLineClick(line);
      return true;
    },
  });

  const tooltip = showTooltip.compute([blameField], (state) => {
    const value = state.field(blameField, false);
    if (!value || value.status !== 'ready' || !value.info) return null;
    return {
      pos: state.doc.line(Math.min(value.line, state.doc.lines)).to,
      above: false,
      create: () => {
        const host = document.createElement('div');
        const root = createRoot(host);
        const cardState: BlameCardState = { info: value.info!, hunk: value.hunk };
        root.render(<BlameCard state={cardState} />);
        return { dom: host, destroy: () => root.unmount() };
      },
    } satisfies Tooltip;
  });

  return [blameField, clickHandler, blameDecorations, tooltip];
}
```

在 `CodeMirrorHostProps` 加：

```ts
  // 是否响应行号点击看 blame（只读文件与空白窗口由上层关掉）
  blameEnabled?: boolean;
```

解构里加 `blameEnabled`。

ref：

```ts
  const blameEnabledRef = useRef(blameEnabled);
  blameEnabledRef.current = blameEnabled;
```

在主 `extensions` 数组的 `referenceRef.current.of(referenceExtensionOption()),` 之后加：

```ts
          blameRef.current.of(
            blameExtension({
              isEnabled: () => blameEnabledRef.current,
              onLineClick: (line) => blameLookupRef.current(line),
            }),
          ),
```

ref 声明：

```ts
  const blameRef = useRef(new Compartment());
```

在 `EditorPane.tsx` 里给 `<CodeMirrorHost>` 加：

```tsx
                  blameEnabled={Boolean(activePath) && !file.readOnly && !isUntitledPath(activePath)}
```

- [ ] **Step 4: 加卡片与内联小字样式**

`src/styles.css` 末尾追加：

```css
/* blame 内联小字：不抢光标，也不挡住行尾编辑 */
.cm-blame-inline {
  margin-left: 12px;
  font-size: 11px;
  color: #9a9da5;
  opacity: 0.85;
  user-select: none;
  cursor: default;
  white-space: nowrap;
}

.blame-card {
  min-width: 280px;
  max-width: 520px;
  padding: 10px 12px;
  font-size: 12px;
  color: #1f1f1f;
}

.blame-card-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.blame-author {
  font-weight: 600;
}

.blame-time {
  color: #6b6f76;
  font-size: 11px;
}

.blame-summary {
  margin: 6px 0;
  line-height: 1.5;
}

.blame-card-hash {
  display: flex;
  gap: 6px;
  align-items: center;
  color: #6b6f76;
  font-size: 11px;
}

.blame-copied {
  color: #1a7f37;
}

.blame-diff {
  margin-top: 8px;
  border-top: 1px solid #e5e6ea;
  padding-top: 6px;
  max-height: 220px;
  overflow: auto;
  font-family: var(--cm-font-family, monospace);
  font-size: 11px;
}

.blame-diff-row {
  display: flex;
  gap: 6px;
  white-space: pre;
}

.blame-diff-row.is-added {
  background: #e6ffec;
}

.blame-diff-row.is-removed {
  background: #ffebe9;
}

.blame-diff-sign {
  width: 10px;
  color: #9a9da5;
}

.blame-diff-more,
.blame-empty {
  color: #9a9da5;
  font-size: 11px;
  padding: 4px 0;
}
```

- [ ] **Step 5: 扩展 GUI 测试**

在 `tests/editor-change-markers.mjs` 的「3. 干净文件没有标记」之前插入：

```js
console.log('2b. 点击行号看 blame');
{
  await openFile('sample.txt');
  await page.locator('.cm-lineNumbers .cm-gutterElement').nth(1).click();
  await page.locator('.cm-blame-inline').first().waitFor({ timeout: 8000 });
  assert(await page.locator('.cm-blame-inline').count() > 0, '出现内联 blame 小字');
  await page.locator('.cm-blame-inline').first().hover();
  await page.locator('.blame-card').waitFor({ timeout: 8000 });
  assert(await page.locator('.blame-card').count() > 0, '悬停弹出 blame 卡片');
  assert(
    await page.locator('.blame-card .blame-diff-row').count() > 0,
    '卡片里有 diff 片段',
  );
}
```

- [ ] **Step 6: 构建并跑测试**

Run: `npx tsc --noEmit && npx vite build && node tests/editor-change-markers.mjs`
Expected: 全部通过。

- [ ] **Step 7: 提交**

```bash
git add src/blameLookup.ts src/components/BlameCard.tsx src/components/CodeMirrorHost.tsx src/components/EditorPane.tsx src/styles.css tests/editor-change-markers.mjs
git commit -m "feat(editor): 点击行号查看 blame 与提交片段"
```

---

### Task 7: 鼠标中键选择

**Files:**
- Modify: `src/components/CodeMirrorHost.tsx`
- Test: 扩展 `tests/editor-change-markers.mjs`

**Interfaces:**
- Consumes: 无
- Produces: 内部扩展 `middleClickSelection`，不导出

- [ ] **Step 1: 实现插件**

import 补上 `EditorSelection`：

```ts
import { EditorState, Compartment, StateField, StateEffect, RangeSetBuilder, Transaction, EditorSelection } from '@codemirror/state';
```

在 `changeGutter` 之后插入：

```ts
// 中键与左键一样做普通文本选择。必须把 mousemove / mouseup 挂在 window 上：
// 拖到编辑器外再松手时，只挂编辑器 DOM 会收不到 mouseup，选区会一直跟着鼠标走。
const middleClickSelection = ViewPlugin.fromClass(
  class {
    private readonly view: EditorView;
    private anchor: number | null = null;

    private readonly onMove = (event: MouseEvent) => {
      if (this.anchor === null) return;
      if ((event.buttons & 4) === 0) {
        this.stop();
        return;
      }
      const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
      // 拖出编辑器外时 posAtCoords 返回 null，保留上一次的位置，不跳回
      if (pos === null) return;
      this.view.dispatch({ selection: EditorSelection.range(this.anchor, pos) });
    };

    private readonly onUp = () => this.stop();

    constructor(view: EditorView) {
      this.view = view;
    }

    destroy() {
      this.stop();
    }

    private stop() {
      this.anchor = null;
      window.removeEventListener('mousemove', this.onMove);
      window.removeEventListener('mouseup', this.onUp);
    }

    handleMouseDown(event: MouseEvent): boolean {
      if (event.button !== 1) return false;
      const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      // 不 preventDefault 会让 Chromium 进入中键自动滚动模式
      event.preventDefault();
      this.stop();
      this.anchor = pos;
      this.view.dispatch({ selection: EditorSelection.cursor(pos) });
      window.addEventListener('mousemove', this.onMove);
      window.addEventListener('mouseup', this.onUp);
      return true;
    }
  },
  {
    eventHandlers: {
      mousedown(event) {
        return this.handleMouseDown(event);
      },
    },
  },
);
```

在主 `extensions` 数组里 `changeGutter,` 之后加 `middleClickSelection,`。

- [ ] **Step 2: 扩展测试**

在 `tests/editor-change-markers.mjs` 的「3. 干净文件没有标记」之前插入：

```js
console.log('2c. 中键拖拽选择');
{
  await openFile('sample.txt');
  const lines = page.locator('.cm-content .cm-line');
  const first = await lines.nth(0).boundingBox();
  const third = await lines.nth(2).boundingBox();
  await page.mouse.move(first.x + 40, first.y + first.height / 2);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(third.x + 40, third.y + third.height / 2, { steps: 8 });
  await page.mouse.up({ button: 'middle' });
  const selected = await page.evaluate(() => window.getSelection()?.toString() || '');
  assert(selected.length > 0, '中键拖拽产生了选区');
}
```

- [ ] **Step 3: 构建并跑测试**

Run: `npx tsc --noEmit && npx vite build && node tests/editor-change-markers.mjs`
Expected: 全部通过。

- [ ] **Step 4: 提交**

```bash
git add src/components/CodeMirrorHost.tsx tests/editor-change-markers.mjs
git commit -m "feat(editor): 鼠标中键拖拽选择文本"
```

---

### Task 8: Alt+F5 跳到下一个改动

**Files:**
- Modify: `src/components/CodeMirrorHost.tsx`
- Test: 扩展 `tests/editor-change-markers.mjs`

**Interfaces:**
- Consumes: `changeMarkerField`
- Produces: 内部键位，不导出

- [ ] **Step 1: 实现键位**

在 `middleClickSelection` 之后插入：

```ts
// 只在编辑器有焦点时生效，不与终端 / 浏览器的 F5 抢键
function jumpToNextChange(view: EditorView): boolean {
  const spans = view.state.field(changeMarkerField, false);
  if (!spans || spans.bars.size === 0) return true; // 吃掉按键，不弹提示

  const doc = view.state.doc;
  const currentLine = doc.lineAt(view.state.selection.main.head).number;
  const starts = [...spans.bars.keys()].sort((a, b) => a - b);
  const lines = starts.map((pos) => doc.lineAt(pos).number);
  const target = lines.find((line) => line > currentLine) ?? lines[0];
  const pos = doc.line(target).from;

  view.dispatch({
    selection: EditorSelection.cursor(pos),
    effects: EditorView.scrollIntoView(pos, { y: 'center' }),
  });
  return true;
}

const changeKeymap = keymap.of([
  { key: 'Alt-F5', run: jumpToNextChange, preventDefault: true },
]);
```

在主 `extensions` 数组里 `keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),` 之后加 `changeKeymap,`。

- [ ] **Step 2: 扩展测试**

在「3. 干净文件没有标记」之前插入：

```js
console.log('2d. Alt+F5 跳转下一个改动');
{
  await openFile('sample.txt');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Alt+F5');
  const firstLine = await page.evaluate(() => {
    const head = document.querySelector('.cm-cursor');
    const line = head?.closest('.cm-line');
    const lines = [...document.querySelectorAll('.cm-content .cm-line')];
    return line ? lines.indexOf(line) + 1 : 0;
  });
  assert(firstLine > 0, '光标落到了某个变更行');
  await page.keyboard.press('Alt+F5');
  const secondLine = await page.evaluate(() => {
    const head = document.querySelector('.cm-cursor');
    const line = head?.closest('.cm-line');
    const lines = [...document.querySelectorAll('.cm-content .cm-line')];
    return line ? lines.indexOf(line) + 1 : 0;
  });
  assert(secondLine !== firstLine, '再按一次跳到另一个变更块');
}
```

- [ ] **Step 3: 构建并跑测试**

Run: `npx tsc --noEmit && npx vite build && node tests/editor-change-markers.mjs`
Expected: 全部通过。

- [ ] **Step 4: 提交**

```bash
git add src/components/CodeMirrorHost.tsx tests/editor-change-markers.mjs
git commit -m "feat(editor): Alt+F5 跳到下一个变更块"
```

---

### Task 9: 文档与回归

**Files:**
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: 前八个任务的产物
- Produces: 无

- [ ] **Step 1: `CLAUDE.md` 补一节**

在「### 文件树与对比」之前插入：

```markdown
### 编辑器变更标记

- **基准是 Git HEAD，不是暂存区**：打开文件时用 `git.fileDiff(path, rel, 'modified', 'HEAD')`
  取 `baseContent`，差异在渲染进程用 `computeLineChanges` 算。不要改成读暂存区——
  那需要新增 IPC，且与右键菜单的「与 Git HEAD 比较」语义不一致。
- **标记字段存文档位置，不存行号**。用户键入时用 `tr.changes.mapPos` 跟随，
  行号在渲染时现算。存行号会让「在标记上方插入一行」把下面所有标记错开一整行，
  直到 300ms 防抖重算完成，表现为打字时标记乱跳。
- **变更 gutter 是独立 gutter，不在 `displayExtensions` 的 Compartment 里**。
  关掉「显示行号」后变更色条照常显示。
- **替换行同时有色条和删除三角**（VS Code 也是这样）：色条表示这一行变了，
  三角表示这里吞掉了原文。不要为了「一个改动只画一个记号」去掉其中一个。
- **blame 的 diff 片段按 `origLine` 找 hunk**：`git blame` 给的是该行在原提交里的
  行号，`git show` 的 hunk 头也是旧行号区间，两者能直接对上。不要用当前行号匹配。
- **中键选择的 mousemove / mouseup 必须挂在 `window` 上**。只挂编辑器 DOM 时，
  拖到编辑器外松手收不到 mouseup，选区会一直跟着鼠标走。
- **Alt+F5 只跳有色条的行**，纯删除的锚点不是跳转目标；到末尾回绕到第一个。
- **未跟踪文件整篇显示为新增**（`fileDiff` 对未跟踪返回 `baseContent: ''` + `untracked: true`），
  与 VS Code 一致。不要按 `untracked` 字段跳过标记——那样新文件反而看不到自己「全是新的」。
```

- [ ] **Step 2: `CHANGELOG.md` 顶部加一节**

按现有格式（`## [x.y.z] - YYYY-MM-DD`）在文件最上方插入本节。**不要改
`package.json` 的 `version`**——版本号与锁文件在真正发版时才动（见 CLAUDE.md 的发版四步）。

内容只用 `###` / `####` / `-` / `**加粗**` / `` `代码` `` 这几种子集（公告弹窗只认这些），
总长度控制在 2400 字符内：

```markdown
## [1.9.0] - 2026-11-04

### 编辑器

- **Git 变更行标记**：打开文件自动对比 Git HEAD，行号旁显示新增（蓝）与修改（琥珀）色条，
  删除位置显示红色三角，悬停可看被删内容。
- **变更概览标尺**：编辑器右缘按行号比例标出全文件的增删分布。
- **点击行号看 blame**：显示最近一次改动的作者、时间与提交信息，悬停可看该提交对本文件的 diff 片段。
- **Alt+F5**：光标跳到下一个变更块，到末尾自动回绕。
- **鼠标中键拖拽选择**：与左键一样可选任意范围的文本。
```

- [ ] **Step 3: 全量离线回归**

Run:

```bash
node tests/line-changes.mjs
node tests/git-blame.mjs
node tests/diff-from-text.mjs
node tests/diff-parser.mjs
node tests/git-core.mjs
node tests/commit-diff.mjs
```

Expected: 全部通过。

- [ ] **Step 4: 类型检查与构建**

Run: `npx tsc --noEmit && npx vite build`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "docs: 变更标记的使用约定与更新说明"
```

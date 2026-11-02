# 编辑器文件树升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把编辑器左侧栏从只读文件树升级为可操作的文件管理器，并支持三种文件对比。

**Architecture:** 文件操作落在主进程 `desktop/file-api.js`，经 `resolveWithin` 校验后落盘；渲染侧新增 `EditorSidebar`（包住「打开的编辑器」与「文件」两个可折叠区）和 `fileClipboard`（应用内剪贴板）；对比复用现有 `DiffPane`，新增一个 `text` 变体接收自算的 unified diff。

**Tech Stack:** Electron 主进程（CommonJS）、React 19、TypeScript、`shell.trashItem`、现有 `diffParser.parsePatch`。

## Global Constraints

- 所有文件操作路径必须经 `desktop/path-guard.js` 的 `resolveWithin` 校验，杜绝 `..` 与符号链接逃逸。
- 新建与移动**绝不覆盖**已存在的目标：`createFile` 用 `fs.open(..., 'wx')`，`createDir` 不带 `recursive`，`move` 先判目标是否存在。
- 删除走 Electron `shell.trashItem`（系统回收站），不使用 `unlink`。
- 每次文件写操作成功后调用 `symbols.invalidate(projectPath)`。
- 应用内剪贴板**不碰系统剪贴板**，跨项目粘贴一律拒绝。
- 不引入第三方文件树 / diff 库。
- 不做快捷键（需求明确要求）。
- 不做拖拽移动文件。
- IPC 四处齐全：`ipcMain.handle` → `preload.js` 的 `invoke` → `window.api.*` → `global.d.ts`；通道命名 `<模块>:<动作>`。
- UI 测试断言文案用中文；提交信息不含 AI 署名。
- UI 测试独占 17382 端口，改完 `src/` 先 `npx tsc --noEmit && npx vite build`。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `desktop/file-api.js` | 新增 `createFile` / `createDir` / `move` / `trash` |
| `desktop/main.js` | 四个新 IPC + 写后 invalidate 符号索引 |
| `desktop/preload.js` | 暴露四个方法 |
| `src/global.d.ts` | 类型声明 |
| `src/diffFromText.ts` | 新建：两段文本 → unified diff |
| `src/fileClipboard.ts` | 新建：应用内剪贴板状态 |
| `src/components/OpenEditors.tsx` | 新建：「打开的编辑器」列表 |
| `src/components/EditorSidebar.tsx` | 新建：两个可折叠区的容器 |
| `src/components/FileTree.tsx` | 工具栏、右键菜单、内联重命名、刷新 |
| `src/components/DiffPane.tsx` | `DiffTarget` 增加 `text` 变体 |
| `src/components/EditorPane.tsx` | 挂载 `EditorSidebar`、对比分栏 |
| `src/styles.css` | 工具栏、内联重命名、对比分栏样式 |
| `tests/file-ops.mjs` | 新建离线测试 |
| `tests/diff-from-text.mjs` | 新建离线测试 |
| `tests/editor-file-tree.mjs` | 新建 UI 测试 |
| `CLAUDE.md` | 记录约束 |

---

## Task 1: diffFromText — 两段文本生成 unified diff

**Files:**
- Create: `src/diffFromText.ts`
- Test: `tests/diff-from-text.mjs`

**Interfaces:**
- Produces: `buildTextPatch(oldName: string, oldText: string, newName: string, newText: string): string`
  返回标准 unified diff（`--- old` / `+++ new` / `@@ -a,b +c,d @@` / ` ` `+` `-` 行前缀），
  两段文本相同则返回 `''`。

**为什么自己写：** 存量没有 diff 库，而 `diffParser.parsePatch` 已经能解析 unified diff。
写一个最小 LCS 行差异（约 70 行）比引入依赖更划算。

- [ ] **Step 1: 写失败的测试**

创建 `tests/diff-from-text.mjs`：

```js
// 两段文本 → unified diff。离线可跑，不依赖 GUI。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

// 直连 TS 需要 Node >= 22.7；用 strip-types 在测试运行时转译
const { buildTextPatch } = await import('../src/diffFromText.ts');

console.log('1. 相同内容');
assert(buildTextPatch('a', 'x\ny', 'b', 'x\ny') === '', '完全相同返回空串');

console.log('2. 新增行');
const added = buildTextPatch('a', 'x', 'b', 'x\ny');
assert(added.includes('--- a'), '带旧文件名');
assert(added.includes('+++ b'), '带新文件名');
assert(added.includes('@@'), '带 hunk 头');
assert(added.includes('+y'), '新增行带 + 前缀');
assert(!added.includes('-x'), '未改动行不加 -');

console.log('3. 删除行');
const removed = buildTextPatch('a', 'x\ny', 'b', 'x');
assert(removed.includes('-y'), '删除行带 - 前缀');

console.log('4. 修改行');
const changed = buildTextPatch('a', 'x\ny\nz', 'b', 'x\nY\nz');
assert(changed.includes('-y'), '旧内容标删除');
assert(changed.includes('+Y'), '新内容标新增');

console.log('5. 空文件');
const fromEmpty = buildTextPatch('a', '', 'b', 'x');
assert(fromEmpty.includes('+x'), '空文件到有内容标新增');
const toEmpty = buildTextPatch('a', 'x', 'b', '');
assert(toEmpty.includes('-x'), '有内容到空文件标删除');

console.log('6. 多段不连续改动');
const multi = buildTextPatch('a', 'a\nb\nc\nd\ne', 'b', 'A\nb\nc\nd\nE');
const hunks = (multi.match(/^@@/gm) || []).length;
assert(hunks >= 1, `至少一个 hunk，实际 ${hunks}`);

console.log(`\n全部通过：${passed} 项`);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/diff-from-text.mjs`
Expected: FAIL —— 找不到 `src/diffFromText.ts` 或 `buildTextPatch` 未定义

- [ ] **Step 3: 实现**

创建 `src/diffFromText.ts`：

```ts
// 两段文本的最小 unified diff。
// 仓库里没有 diff 库，而 diffParser.parsePatch 已经能解析 unified diff，
// 所以这里只负责生成标准格式，渲染完全复用 DiffPane。

type Op = { kind: 'equal' | 'insert' | 'delete'; text: string };

// LCS 动态规划。文件是编辑器里的文本，行数上万时 O(n*m) 会吃内存，
// 所以先剥掉首尾公共部分，只对中间不同的区间做 DP。
function diffLines(oldLines: string[], newLines: string[]): Op[] {
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start += 1;
  }

  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  const ops: Op[] = [];
  for (let index = 0; index < start; index += 1) {
    ops.push({ kind: 'equal', text: oldLines[index] });
  }

  const a = oldLines.slice(start, oldEnd);
  const b = newLines.slice(start, newEnd);
  const n = a.length;
  const m = b.length;

  if (n > 0 || m > 0) {
    // table[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
    const table: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i][j] =
          a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }

    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ops.push({ kind: 'equal', text: a[i] });
        i += 1;
        j += 1;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        ops.push({ kind: 'delete', text: a[i] });
        i += 1;
      } else {
        ops.push({ kind: 'insert', text: b[j] });
        j += 1;
      }
    }
    while (i < n) {
      ops.push({ kind: 'delete', text: a[i] });
      i += 1;
    }
    while (j < m) {
      ops.push({ kind: 'insert', text: b[j] });
      j += 1;
    }
  }

  for (let index = oldEnd; index < oldLines.length; index += 1) {
    ops.push({ kind: 'equal', text: oldLines[index] });
  }
  return ops;
}

// 把连续的改动聚成一个 hunk，前后各带 3 行上下文（与 git 默认一致）
function buildHunks(ops: Op[]): string[] {
  const CONTEXT = 3;
  const hunks: string[] = [];

  let index = 0;
  while (index < ops.length) {
    if (ops[index].kind === 'equal') {
      index += 1;
      continue;
    }

    // 往前带上下文
    const head = Math.max(0, index - CONTEXT);
    let end = index;
    // 向后吞掉改动，直到后面有超过 2*CONTEXT 行的公共段
    let gap = 0;
    while (end < ops.length) {
      if (ops[end].kind === 'equal') {
        gap += 1;
        if (gap > CONTEXT * 2) break;
      } else {
        gap = 0;
      }
      end += 1;
    }
    // 结尾再带 CONTEXT 行上下文
    const tail = Math.min(ops.length, end);
    const slice = ops.slice(head, tail);

    let oldStart = 1;
    let newStart = 1;
    for (let k = 0; k < head; k += 1) {
      if (ops[k].kind !== 'insert') oldStart += 1;
      if (ops[k].kind !== 'delete') newStart += 1;
    }

    const oldCount = slice.filter((op) => op.kind !== 'insert').length;
    const newCount = slice.filter((op) => op.kind !== 'delete').length;
    const lines = [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`];
    for (const op of slice) {
      const prefix = op.kind === 'insert' ? '+' : op.kind === 'delete' ? '-' : ' ';
      lines.push(`${prefix}${op.text}`);
    }
    hunks.push(lines.join('\n'));
    index = tail;
  }

  return hunks;
}

export function buildTextPatch(
  oldName: string,
  oldText: string,
  newName: string,
  newText: string,
): string {
  const oldLines = String(oldText ?? '').split(/\r?\n/);
  const newLines = String(newText ?? '').split(/\r?\n/);
  // 末尾换行会切出一个空串，比对时不该算作一行差异
  if (oldLines.length && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length && newLines[newLines.length - 1] === '') newLines.pop();

  if (oldLines.join('\n') === newLines.join('\n')) return '';

  const ops = diffLines(oldLines, newLines);
  const hunks = buildHunks(ops);
  if (!hunks.length) return '';

  return [`--- ${oldName}`, `+++ ${newName}`, ...hunks].join('\n');
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/diff-from-text.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/diffFromText.ts tests/diff-from-text.mjs
git commit -m "$(cat <<'EOF'
feat(diff): 两段文本生成 unified diff

对比功能要把编辑器内存内容和磁盘内容显示成差异，仓库里没有 diff 库。
只实现生成这一段，渲染复用现有的 diffParser 与 DiffPane。
EOF
)"
```

---

## Task 2: 文件操作层（主进程）

**Files:**
- Modify: `desktop/file-api.js`
- Test: `tests/file-ops.mjs`

**Interfaces:**
- Produces: `createFile(projectPath, relPath, content)`, `createDir(projectPath, relPath)`,
  `move(projectPath, fromRel, toRel)`, `trash(projectPath, relPath, shell)`
- `trash` 的 `shell` 参数用于测试注入假实现；不传时用 `require('electron').shell`

- [ ] **Step 1: 写失败的测试**

创建 `tests/file-ops.mjs`：

```js
// 文件操作层：新建、新建目录、移动、删除。
// 全部使用临时目录，不碰真实项目与真实回收站。
import { createRequire } from 'node:module';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const fileApi = require('../desktop/file-api.js');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const dir = mkdtempSync(join(tmpdir(), 'cmdtb-fileops-'));

try {
  console.log('1. createFile');
  await fileApi.createFile(dir, 'new.txt', 'hello');
  assert(readFileSync(join(dir, 'new.txt'), 'utf8') === 'hello', '内容写入正确');

  // 关键：同名文件绝不能被覆盖
  let overwrote = false;
  try {
    await fileApi.createFile(dir, 'new.txt', 'OTHER');
  } catch {
    overwrote = true;
  }
  assert(overwrote, '同名文件创建时报错');
  assert(readFileSync(join(dir, 'new.txt'), 'utf8') === 'hello', '原文件内容未被覆盖');

  console.log('2. createFile 自动创建父目录');
  await fileApi.createFile(dir, 'sub/deep/a.txt', 'x');
  assert(existsSync(join(dir, 'sub/deep/a.txt')), '父目录自动创建');

  console.log('3. createDir');
  await fileApi.createDir(dir, 'folder');
  assert(existsSync(join(dir, 'folder')), '目录创建成功');
  let dirDup = false;
  try {
    await fileApi.createDir(dir, 'folder');
  } catch {
    dirDup = true;
  }
  assert(dirDup, '同名目录创建时报错');

  console.log('4. move');
  writeFileSync(join(dir, 'src.txt'), 'MOVE_ME', 'utf8');
  await fileApi.move(dir, 'src.txt', 'dst.txt');
  assert(!existsSync(join(dir, 'src.txt')), '原位置消失');
  assert(readFileSync(join(dir, 'dst.txt'), 'utf8') === 'MOVE_ME', '新位置内容正确');

  // 目标已存在时不能覆盖
  writeFileSync(join(dir, 'occupied.txt'), 'KEEP', 'utf8');
  writeFileSync(join(dir, 'willmove.txt'), 'MOVER', 'utf8');
  let moveDup = false;
  try {
    await fileApi.move(dir, 'willmove.txt', 'occupied.txt');
  } catch {
    moveDup = true;
  }
  assert(moveDup, '目标已存在时移动报错');
  assert(readFileSync(join(dir, 'occupied.txt'), 'utf8') === 'KEEP', '目标文件未被覆盖');

  console.log('5. 路径逃逸被拒');
  for (const [label, fn] of [
    ['createFile ../evil', () => fileApi.createFile(dir, '../evil.txt', 'x')],
    ['createDir ../evil', () => fileApi.createDir(dir, '../evildir')],
    ['move 目标越界', () => fileApi.move(dir, 'dst.txt', '../evil.txt')],
    ['trash 越界', () => fileApi.trash(dir, '../evil.txt', async () => {})],
  ]) {
    let rejected = false;
    try {
      await fn();
    } catch {
      rejected = true;
    }
    assert(rejected, `${label} 被拒绝`);
  }

  console.log('6. trash 调用注入的 shell');
  const calls = [];
  writeFileSync(join(dir, 'trashme.txt'), 'BYE', 'utf8');
  await fileApi.trash(dir, 'trashme.txt', async (target) => {
    calls.push(target);
  });
  assert(calls.length === 1, `shell.trashItem 被调用一次，实际 ${calls.length}`);
  assert(calls[0].endsWith('trashme.txt'), `传入了正确路径，实际 ${calls[0]}`);

  console.log('7. move 目录');
  mkdirSync(join(dir, 'd1'), { recursive: true });
  writeFileSync(join(dir, 'd1/f.txt'), 'IN', 'utf8');
  await fileApi.move(dir, 'd1', 'd2');
  assert(existsSync(join(dir, 'd2/f.txt')), '目录移动后内容仍在');
  assert(!existsSync(join(dir, 'd1')), '原目录消失');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n全部通过：${passed} 项`);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/file-ops.mjs`
Expected: FAIL —— `fileApi.createFile is not a function`

- [ ] **Step 3: 实现**

在 `desktop/file-api.js` 的 `writeMinified` 之后插入：

```js
// 新建文件。用 'wx' 标志：目标已存在时抛 EEXIST，绝不覆盖用户现有文件。
async function createFile(projectPath, relPath, content = '') {
  const target = resolveWithin(projectPath, relPath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const handle = await fsp.open(target, 'wx');
  try {
    await handle.writeFile(String(content ?? ''), 'utf8');
  } finally {
    await handle.close();
  }
  return { ok: true };
}

// 新建目录。不带 recursive：同名目录已存在时要报错，而不是静默通过。
async function createDir(projectPath, relPath) {
  const target = resolveWithin(projectPath, relPath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.mkdir(target);
  return { ok: true };
}

// 移动/重命名。目标已存在时报错——粘贴和重命名都不该覆盖现有内容。
async function move(projectPath, fromRel, toRel) {
  const from = resolveWithin(projectPath, fromRel);
  const to = resolveWithin(projectPath, toRel);
  try {
    await fsp.lstat(to);
    throw new Error('目标位置已有同名项');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
  return { ok: true };
}

// 删除到系统回收站，用户可恢复。
// shell 可注入：单测不碰真实回收站，只验证调用参数。
async function trash(projectPath, relPath, shell) {
  const target = resolveWithin(projectPath, relPath);
  const impl = shell || require('electron').shell;
  if (!impl || typeof impl.trashItem !== 'function') {
    throw new Error('当前环境不支持删除到回收站');
  }
  await impl.trashItem(target);
  return { ok: true };
}
```

把导出行改成：

```js
module.exports = {
  list,
  read,
  write,
  stat,
  writeMinified,
  detectEncoding,
  search,
  createFile,
  createDir,
  move,
  trash,
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/file-ops.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add desktop/file-api.js tests/file-ops.mjs
git commit -m "$(cat <<'EOF'
feat(fs): 新建文件、新建目录、移动与删除到回收站

四处都经 resolveWithin 校验。新建用 'wx'、移动先判目标是否存在，
两者都不覆盖用户现有文件。删除走 shell.trashItem 进系统回收站。
EOF
)"
```

---

## Task 3: 四个文件操作 IPC

**Files:**
- Modify: `desktop/main.js`
- Modify: `desktop/preload.js`
- Modify: `src/global.d.ts`

**Interfaces:**
- Consumes: Task 2 的四个函数
- Produces: `window.api.files.createFile(projectPath, relPath, content?)` 等四个方法

- [ ] **Step 1: 注册 IPC**

在 `desktop/main.js` 的 `fs:write-minified` handler 之后加入：

```js
  // 以下四个都会改动磁盘，成功后让符号索引失效：
  // 否则新建的文件在索引里不存在，Ctrl+点击会漏掉。
  ipcMain.handle('fs:create-file', async (_event, projectPath, relPath, content) => {
    const known = assertProjectPath(projectPath);
    const result = await fileApi.createFile(known, relPath, content);
    symbols.invalidate(known);
    return result;
  });

  ipcMain.handle('fs:create-dir', async (_event, projectPath, relPath) => {
    const known = assertProjectPath(projectPath);
    const result = await fileApi.createDir(known, relPath);
    symbols.invalidate(known);
    return result;
  });

  ipcMain.handle('fs:move', async (_event, projectPath, fromRel, toRel) => {
    const known = assertProjectPath(projectPath);
    const result = await fileApi.move(known, fromRel, toRel);
    symbols.invalidate(known);
    return result;
  });

  ipcMain.handle('fs:trash', async (_event, projectPath, relPath) => {
    const known = assertProjectPath(projectPath);
    const result = await fileApi.trash(known, relPath);
    symbols.invalidate(known);
    return result;
  });
```

- [ ] **Step 2: preload 暴露**

在 `desktop/preload.js` 的 `files` 块里（`search` 之后）加入：

```js
    createFile: (projectPath, relPath, content) =>
      invoke('fs:create-file', projectPath, relPath, content),
    createDir: (projectPath, relPath) => invoke('fs:create-dir', projectPath, relPath),
    move: (projectPath, fromRel, toRel) => invoke('fs:move', projectPath, fromRel, toRel),
    trash: (projectPath, relPath) => invoke('fs:trash', projectPath, relPath),
```

- [ ] **Step 3: 类型声明**

在 `src/global.d.ts` 里 `files` 类型块中（`search` 之后）加入：

```ts
        createFile: (
          projectPath: string,
          relPath: string,
          content?: string,
        ) => Promise<{ ok: boolean }>;
        createDir: (projectPath: string, relPath: string) => Promise<{ ok: boolean }>;
        move: (
          projectPath: string,
          fromRel: string,
          toRel: string,
        ) => Promise<{ ok: boolean }>;
        trash: (projectPath: string, relPath: string) => Promise<{ ok: boolean }>;
```

- [ ] **Step 4: 验证**

Run:
```bash
node --check desktop/main.js && node --check desktop/preload.js && npx tsc --noEmit
```
Expected: 全部无输出

- [ ] **Step 5: 提交**

```bash
git add desktop/main.js desktop/preload.js src/global.d.ts
git commit -m "$(cat <<'EOF'
feat(fs): 暴露新建、移动、删除的 IPC

四处接入点齐全；每次写盘后让符号索引失效。
EOF
)"
```

---

## Task 4: 应用内剪贴板

**Files:**
- Create: `src/fileClipboard.ts`
- Test: `tests/diff-from-text.mjs`（追加一组纯函数断言）

**Interfaces:**
- Produces: `type FileClip = { kind: 'copy' | 'cut'; relPath: string; projectPath: string }`，
  `canPaste(clip, projectPath): { ok: true } | { ok: false; reason: string }`，
  `pasteTargetDir(clip, targetDir): string`

- [ ] **Step 1: 追加失败的测试**

在 `tests/diff-from-text.mjs` 的 `全部通过` 之前插入：

```js
console.log('7. 剪贴板粘贴校验');
const clip = await import('../src/fileClipboard.ts');

const crossProject = clip.canPaste(
  { kind: 'copy', relPath: 'a.txt', projectPath: 'D:/p1' },
  'D:/p2',
);
assert(crossProject.ok === false, '跨项目粘贴被拒绝');
assert(crossProject.reason.includes('跨项目'), `拒绝理由说明是跨项目，实际 ${crossProject.reason}`);

const sameProject = clip.canPaste(
  { kind: 'copy', relPath: 'a.txt', projectPath: 'D:/p1' },
  'D:/p1',
);
assert(sameProject.ok === true, '同项目粘贴允许');

// Windows 路径大小写不敏感，比较时必须归一
const caseDiff = clip.canPaste(
  { kind: 'copy', relPath: 'a.txt', projectPath: 'D:/P1' },
  'd:/p1',
);
assert(caseDiff.ok === true, '项目路径大小写不同仍视为同一项目');

const noClip = clip.canPaste(null, 'D:/p1');
assert(noClip.ok === false, '剪贴板为空时不能粘贴');

assert(
  clip.pasteTargetDir({ kind: 'copy', relPath: 'dir/a.txt', projectPath: 'D:/p1' }, 'sub') ===
    'sub/a.txt',
  '粘贴目标路径拼在目标目录下',
);
assert(
  clip.pasteTargetDir({ kind: 'copy', relPath: 'a.txt', projectPath: 'D:/p1' }, '') === 'a.txt',
  '粘贴到根目录时没有多余斜杠',
);
```

- [ ] **Step 2: 运行确认失败**

Run: `node tests/diff-from-text.mjs`
Expected: FAIL —— 找不到 `src/fileClipboard.ts`

- [ ] **Step 3: 实现**

创建 `src/fileClipboard.ts`：

```ts
// 应用内文件剪贴板。
// 刻意不碰系统剪贴板：把文件放进 Windows 剪贴板需要在主进程写
// CF_HDROP 格式，还要处理与资源管理器互操作的各种边界，
// 而这里的需求只是应用内复制粘贴。

export type FileClip = {
  kind: 'copy' | 'cut';
  relPath: string;
  // 记录来源项目，用于拒绝跨项目粘贴
  projectPath: string;
};

export type PasteCheck = { ok: true } | { ok: false; reason: string };

// Windows 路径大小写不敏感，比较前统一成小写并去掉尾部斜杠
function normalizeProjectPath(value: string): string {
  return String(value || '')
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

export function canPaste(clip: FileClip | null, projectPath: string): PasteCheck {
  if (!clip) return { ok: false, reason: '剪贴板为空' };
  if (normalizeProjectPath(clip.projectPath) !== normalizeProjectPath(projectPath)) {
    return { ok: false, reason: '不能跨项目粘贴文件' };
  }
  return { ok: true };
}

// 粘贴到 targetDir 下，保留原文件名
export function pasteTargetDir(clip: FileClip, targetDir: string): string {
  const base = clip.relPath.split('/').pop() || clip.relPath;
  return targetDir ? `${targetDir}/${base}` : base;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node tests/diff-from-text.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/fileClipboard.ts tests/diff-from-text.mjs
git commit -m "$(cat <<'EOF'
feat(editor): 应用内文件剪贴板与跨项目粘贴校验

不碰系统剪贴板。项目路径比较前归一小写与斜杠，避免 Windows 下
大小写不同被误判为跨项目。
EOF
)"
```

---

## Task 5: 打开的编辑器列表

**Files:**
- Create: `src/components/OpenEditors.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Produces: `OpenEditors` 组件
- Props: `{ openPaths: string[]; activePath: string; onSelect: (relPath: string) => void; onContextMenu?: (event: React.MouseEvent, relPath: string) => void }`

- [ ] **Step 1: 实现组件**

创建 `src/components/OpenEditors.tsx`：

```tsx
import { File } from 'lucide-react';
import { cn } from '../lib';

type OpenEditorsProps = {
  openPaths: string[];
  activePath: string;
  onSelect: (relPath: string) => void;
  // 可选：对比菜单在 Task 9 接上，届时才传
  onContextMenu?: (event: React.MouseEvent, relPath: string) => void;
};

// 「打开的编辑器」列表：与文件树共用 .file-row 样式，点击切换文件。
export function OpenEditors({
  openPaths,
  activePath,
  onSelect,
  onContextMenu,
}: OpenEditorsProps) {
  if (!openPaths.length) {
    return <p className="file-tree-empty">没有打开的文件</p>;
  }

  return (
    <div className="file-tree">
      {openPaths.map((relPath) => {
        const name = relPath.split('/').pop() || relPath;
        return (
          <button
            key={relPath}
            type="button"
            className={cn('file-row', relPath === activePath && 'active')}
            title={relPath}
            onClick={() => onSelect(relPath)}
            onContextMenu={
              onContextMenu ? (event) => onContextMenu(event, relPath) : undefined
            }
          >
            <span className="file-caret-spacer" />
            <File size={13} />
            <span className="file-name">{name}</span>
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: 加样式**

在 `src/styles.css` 末尾追加：

```css
/* 「打开的编辑器」与文件树共用 .file-row；两者都放在 EditorSidebar 里 */
.editor-sidebar {
  flex: 0 0 220px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: #fbfbfd;
}

.editor-sidebar-section {
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 文件区吃掉剩余高度，它自己滚动 */
.editor-sidebar-section.is-grow {
  flex: 1;
}

.editor-sidebar-section .file-tree {
  flex: 1;
  min-height: 0;
  border-right: 0;
}

.file-tree-empty {
  margin: 0;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--muted);
}
```

- [ ] **Step 3: 构建验证**

Run: `npx tsc --noEmit && npx vite build`
Expected: 均通过

- [ ] **Step 4: 提交**

```bash
git add src/components/OpenEditors.tsx src/styles.css
git commit -m "$(cat <<'EOF'
feat(editor): 打开的编辑器列表

与文件树共用行样式，点击切换文件，右键留给对比菜单。
EOF
)"
```

---

## Task 6: FileTree 工具栏与刷新

**Files:**
- Modify: `src/components/FileTree.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: Task 3 的 IPC
- Produces: `FileTree` 新增 props `onAfterWrite?: () => void`

- [ ] **Step 1: 加工具栏与刷新能力**

在 `src/components/FileTree.tsx` 顶部导入补 `useState` 已有，新增图标导入：

```tsx
import { ChevronRight, File, FilePlus, Folder, FolderOpen, FolderPlus, RefreshCw, ChevronsDownUp } from 'lucide-react';
```

把组件签名改为接收新 prop：

```tsx
type FileTreeProps = {
  group: Group;
  activePath: string;
  onOpen: (relPath: string) => void;
  onMinify: (relPath: string) => void;
  canMinify: (relPath: string) => boolean;
  onError: (message: string) => void;
};
```

（保持不变；工具栏只操作本组件状态与 IPC。）

在 `loadDir` 之后加入刷新与折叠逻辑：

```tsx
  // 刷新：重新列所有已展开的目录。文件在外部被增删时用它同步。
  const reloadAll = useCallback(async () => {
    const dirs = Array.from(expanded);
    setChildren({});
    await Promise.all(dirs.map((dir) => loadDir(dir)));
  }, [expanded, loadDir]);

  const collapseAll = useCallback(() => {
    setExpanded(new Set(['']));
  }, []);

  // 新建按钮的落点：选中项若在树里就取它，否则用项目根
  const createTargetDir = useCallback((isDir: boolean) => {
    if (!activePath) return '';
    return isDir ? activePath : ancestorsOf(activePath).pop() || '';
  }, [activePath]);

  const createFile = useCallback(
    async (relDir: string) => {
      const relPath = await promptName('新建文件', relDir, '');
      if (!relPath) return;
      try {
        await window.api.files.createFile(group.path, relPath, '');
        await loadDir(relDir);
        setExpanded((previous) => new Set(previous).add(relDir));
        onOpen(relPath);
      } catch (error) {
        onError(toErrorMessage(error));
      }
    },
    [group.path, loadDir, onError, onOpen],
  );

  const createFolder = useCallback(
    async (relDir: string) => {
      const relPath = await promptName('新建文件夹', relDir, '');
      if (!relPath) return;
      try {
        await window.api.files.createDir(group.path, relPath);
        await loadDir(relDir);
        setExpanded((previous) => new Set(previous).add(relDir));
      } catch (error) {
        onError(toErrorMessage(error));
      }
    },
    [group.path, loadDir, onError],
  );
```

在组件文件底部加入名字输入辅助（用浏览器 `prompt` 会阻塞且样式不一致，改用 `window.prompt` 的最小封装；本项目其它地方也用 `window.confirm`，保持一致）：

```tsx
// 与项目里已有的 window.confirm 用法保持一致，避免再造一套输入弹窗
async function promptName(label: string, relDir: string, initial: string): Promise<string> {
  const raw = window.prompt(`${label}（${relDir || '项目根目录'}）`, initial);
  if (raw === null) return '';
  const name = raw.trim();
  if (!name) return '';
  if (name.includes('/') || name.includes('\\')) {
    window.alert('名字里不能包含斜杠');
    return '';
  }
  return relDir ? `${relDir}/${name}` : name;
}
```

在 JSX 的 `<div className="file-tree">` 之前插入工具栏：

```tsx
  return (
    <div className="file-tree-wrap">
      <div className="file-tree-toolbar">
        <button
          type="button"
          className="icon-btn"
          title="新建文件夹"
          onClick={() => void createFolder(createTargetDir(true))}
        >
          <FolderPlus size={13} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="新建文件"
          onClick={() => void createFile(createTargetDir(false))}
        >
          <FilePlus size={13} />
        </button>
        <button type="button" className="icon-btn" title="刷新" onClick={() => void reloadAll()}>
          <RefreshCw size={13} />
        </button>
        <button type="button" className="icon-btn" title="全部折叠" onClick={collapseAll}>
          <ChevronsDownUp size={13} />
        </button>
      </div>
      <div className="file-tree">
        {renderDir('', 0)}
        {menu ? <PopupMenu state={menu} onClose={() => setMenu(null)} /> : null}
      </div>
    </div>
  );
```

- [ ] **Step 2: 加样式**

在 `src/styles.css` 追加：

```css
.file-tree-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.file-tree-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px 6px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}

.file-tree-toolbar .icon-btn {
  width: 22px;
  height: 22px;
}
```

- [ ] **Step 3: 类型检查与构建**

Run: `npx tsc --noEmit && npx vite build`
Expected: 均通过

- [ ] **Step 4: 提交**

```bash
git add src/components/FileTree.tsx src/styles.css
git commit -m "$(cat <<'EOF'
feat(editor): 文件树工具栏——新建文件、新建文件夹、刷新、全部折叠
EOF
)"
```

---

## Task 7: FileTree 右键菜单（复制、剪切、粘贴、重命名、复制路径、删除）

**Files:**
- Modify: `src/components/FileTree.tsx`
- Modify: `src/components/EditorPane.tsx`（把剪贴板状态传给 FileTree）

**Interfaces:**
- Consumes: Task 2/3 的 IPC、Task 4 的 `canPaste` / `pasteTargetDir`
- Produces: `FileTree` 新增 props `clip`, `onClipChange`, `onRequestDelete`

- [ ] **Step 1: 扩展 FileTree 的 props 与菜单**

把 `FileTreeProps` 改为：

```tsx
type FileTreeProps = {
  group: Group;
  activePath: string;
  onOpen: (relPath: string) => void;
  onMinify: (relPath: string) => void;
  canMinify: (relPath: string) => boolean;
  onError: (message: string) => void;
  clip: FileClip | null;
  onClipChange: (clip: FileClip | null) => void;
  onRequestDelete: (relPath: string) => void;
};
```

导入补：

```tsx
import { canPaste, pasteTargetDir } from '../fileClipboard';
import type { FileClip } from '../fileClipboard';
```

把 `openRowMenu` 整个替换为：

```tsx
  // 右键菜单按目标分两套：文件/文件夹一套，空白处一套。
  const openRowMenu = (event: React.MouseEvent, entry: FileEntry) => {
    event.preventDefault();
    event.stopPropagation();
    const dir = entry.isDir ? entry.relPath : ancestorsOf(entry.relPath).pop() || '';
    const paste = canPaste(clip, group.path);

    const items: MenuEntry[] = [
      {
        type: 'item',
        id: 'new-file',
        label: '新建文件',
        onSelect: () => void createFile(dir),
      },
      {
        type: 'item',
        id: 'new-folder',
        label: '新建文件夹',
        onSelect: () => void createFolder(dir),
      },
      { type: 'separator', id: 'sep-new' },
      {
        type: 'item',
        id: 'copy',
        label: '复制',
        onSelect: () =>
          onClipChange({ kind: 'copy', relPath: entry.relPath, projectPath: group.path }),
      },
      {
        type: 'item',
        id: 'cut',
        label: '剪切',
        onSelect: () =>
          onClipChange({ kind: 'cut', relPath: entry.relPath, projectPath: group.path }),
      },
      {
        type: 'item',
        id: 'paste',
        label: '粘贴',
        disabled: !paste.ok,
        onSelect: () => void pasteInto(dir),
      },
      { type: 'separator', id: 'sep-edit' },
      {
        type: 'item',
        id: 'rename',
        label: '重命名',
        onSelect: () => void renameEntry(entry.relPath),
      },
      {
        type: 'item',
        id: 'copy-path',
        label: '复制路径',
        onSelect: () => void copyPath(entry.relPath, false),
      },
      {
        type: 'item',
        id: 'copy-rel-path',
        label: '复制相对路径',
        onSelect: () => void copyPath(entry.relPath, true),
      },
      { type: 'separator', id: 'sep-danger' },
      {
        type: 'item',
        id: 'delete',
        label: '删除',
        onSelect: () => onRequestDelete(entry.relPath),
      },
    ];

    // 保留既有的「生成 xxx.min.js」
    if (!entry.isDir && canMinify(entry.relPath)) {
      const target = minifiedName(entry.relPath);
      const name = target.split('/').pop() || target;
      items.push({ type: 'separator', id: 'sep-minify' });
      items.push({
        type: 'item',
        id: 'file-minify',
        label: `生成 ${name}`,
        onSelect: () => onMinify(entry.relPath),
      });
    }

    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const openBlankMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const paste = canPaste(clip, group.path);
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { type: 'item', id: 'blank-new-file', label: '新建文件', onSelect: () => void createFile('') },
        { type: 'item', id: 'blank-new-folder', label: '新建文件夹', onSelect: () => void createFolder('') },
        {
          type: 'item',
          id: 'blank-paste',
          label: '粘贴',
          disabled: !paste.ok,
          onSelect: () => void pasteInto(''),
        },
        { type: 'separator', id: 'blank-sep' },
        { type: 'item', id: 'blank-refresh', label: '刷新', onSelect: () => void reloadAll() },
        { type: 'item', id: 'blank-collapse', label: '全部折叠', onSelect: collapseAll },
      ],
    });
  };
```

加入三个辅助操作：

```tsx
  const pasteInto = useCallback(
    async (targetDir: string) => {
      const check = canPaste(clip, group.path);
      if (!clip || !check.ok) {
        onError(check.ok ? '剪贴板为空' : check.reason);
        return;
      }
      const toRel = pasteTargetDir(clip, targetDir);
      try {
        await window.api.files.move(group.path, clip.relPath, toRel);
        if (clip.kind === 'cut') onClipChange(null);
        await loadDir(targetDir);
        setExpanded((previous) => new Set(previous).add(targetDir));
        // 目录被移动后原目录的内容也失效了，整棵树重列一次最稳
        await reloadAll();
      } catch (error) {
        onError(toErrorMessage(error));
      }
    },
    [clip, group.path, loadDir, onClipChange, onError, reloadAll],
  );

  const renameEntry = useCallback(
    async (relPath: string) => {
      const dir = ancestorsOf(relPath).pop() || '';
      const current = relPath.split('/').pop() || relPath;
      const raw = window.prompt('重命名', current);
      if (raw === null) return;
      const name = raw.trim();
      if (!name || name === current) return;
      if (name.includes('/') || name.includes('\\')) {
        onError('名字里不能包含斜杠');
        return;
      }
      const toRel = dir ? `${dir}/${name}` : name;
      try {
        await window.api.files.move(group.path, relPath, toRel);
        await loadDir(dir);
      } catch (error) {
        onError(toErrorMessage(error));
      }
    },
    [group.path, loadDir, onError],
  );

  // 绝对路径要转成 Windows 分隔符，相对路径保持树里的 / 写法。
  // 仓库没有暴露 path.separator，用 group.path 自身判断分隔符最可靠。
  const copyPath = useCallback(
    async (relPath: string, relative: boolean) => {
      const sep = group.path.includes('\\') ? '\\' : '/';
      const absolute = `${group.path}${sep}${relPath.split('/').join(sep)}`;
      try {
        await window.api.clipboard.write(relative ? relPath : absolute);
        onError(`已复制${relative ? '相对' : ''}路径`);
      } catch (error) {
        onError(toErrorMessage(error));
      }
    },
    [group.path, onError],
  );
```

在 `<div className="file-tree">` 上加右键处理：

```tsx
      <div className="file-tree" onContextMenu={openBlankMenu}>
```

- [ ] **Step 2: 在 EditorPane 里维护剪贴板与删除状态**

在 `src/components/EditorPane.tsx` 的 `useEditorFiles` 调用之后加入：

```tsx
  const [fileClip, setFileClip] = useState<FileClip | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
```

导入：

```tsx
import type { FileClip } from '../fileClipboard';
import { ConfirmDialog } from './ConfirmDialog';
```

加删除处理：

```tsx
  const confirmDelete = useCallback(async () => {
    const relPath = pendingDelete;
    if (!relPath) return;
    setPendingDelete(null);
    try {
      // 先关掉指向该文件的页签，否则会留下指向不存在文件的编辑器
      if (files[relPath]) close(relPath);
      await window.api.files.trash(group.path, relPath);
      onToast(`已删除 ${relPath}`, 'success');
    } catch (error) {
      onToast(toErrorMessage(error), 'error');
    }
  }, [pendingDelete, files, close, group.path, onToast]);
```

把 `<FileTree ... />` 的调用补上新 props：

```tsx
            clip={fileClip}
            onClipChange={setFileClip}
            onRequestDelete={setPendingDelete}
```

在组件 return 的末尾（`pendingClose` 弹窗之后）加入确认弹窗：

```tsx
      {pendingDelete ? (
        <ConfirmDialog
          title="删除到回收站"
          message={
            files[pendingDelete]?.dirty
              ? `「${pendingDelete}」有未保存的修改，删除后不可恢复。确定删除到回收站吗？`
              : `确定把「${pendingDelete}」删除到回收站吗？`
          }
          confirmLabel="删除"
          onClose={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      ) : null}
```

- [ ] **Step 3: 类型检查与构建**

Run: `npx tsc --noEmit && npx vite build`
Expected: 均通过。若 `MenuEntry` 的 `disabled` 字段不存在，去 `src/types.ts` 的 `MenuEntry` 定义确认并补上该可选字段：

```ts
  disabled?: boolean;
```

- [ ] **Step 4: 提交**

```bash
git add src/components/FileTree.tsx src/components/EditorPane.tsx src/types.ts src/styles.css
git commit -m "$(cat <<'EOF'
feat(editor): 文件树右键菜单

复制/剪切进应用内剪贴板，粘贴前校验跨项目与目标冲突；
重命名与复制路径一并接上。删除回调留给下一步接确认弹窗。
EOF
)"
```

---

## Task 8: EditorSidebar——两个可折叠区

**Files:**
- Create: `src/components/EditorSidebar.tsx`
- Modify: `src/components/EditorPane.tsx`

**Interfaces:**
- Consumes: `OpenEditors`（Task 5）、`FileTree`（Task 6/7）
- Produces: `EditorSidebar` 组件

- [ ] **Step 1: 实现**

创建 `src/components/EditorSidebar.tsx`：

```tsx
import type { ReactElement } from 'react';
import type { ReactNode } from 'react';
import { useCollapsedSection } from '../useCollapsedSection';

type SidebarSectionProps = {
  id: string;
  title: string;
  grow?: boolean;
  children: ReactNode;
};

// 与侧栏其它折叠区同一套样式：标题是 <button>，带 aria-expanded 与 .section-caret
function SidebarSection({ id, title, grow, children }: SidebarSectionProps): ReactElement {
  const [collapsed, toggle] = useCollapsedSection(id);

  return (
    <div className={`editor-sidebar-section${grow ? ' is-grow' : ''}`}>
      <button
        type="button"
        className="sidebar-section-title"
        aria-expanded={!collapsed}
        onClick={toggle}
      >
        <span className={`section-caret${collapsed ? '' : ' is-open'}`}>▸</span>
        {title}
      </button>
      {collapsed ? null : children}
    </div>
  );
}

type EditorSidebarProps = {
  openEditors: ReactNode;
  fileTree: ReactNode;
};

export function EditorSidebar({ openEditors, fileTree }: EditorSidebarProps) {
  return (
    <div className="editor-sidebar">
      <SidebarSection id="editor-open-editors" title="打开的编辑器">
        {openEditors}
      </SidebarSection>
      <SidebarSection id="editor-file-tree" title="文件" grow>
        {fileTree}
      </SidebarSection>
    </div>
  );
}
```

- [ ] **Step 2: 在 EditorPane 里替换两侧栏**

把 `<div className="editor-body">` 里原来的 `FileTree` / `SearchPanel` 分支替换为：

```tsx
        <EditorSidebar
          openEditors={
            <OpenEditors
              openPaths={openPaths}
              activePath={activePath}
              onSelect={(relPath) => setActivePath(relPath)}
            />
          }
          fileTree={
            searchOpen ? (
              <SearchPanel
                group={group}
                onOpen={(relPath) => {
                  requestOpen(relPath);
                  setSearchOpen(false);
                }}
                onClose={() => setSearchOpen(false)}
                onError={onError}
              />
            ) : (
              <FileTree
                group={group}
                activePath={activePath}
                onOpen={requestOpen}
                onMinify={runMinify}
                canMinify={canMinify}
                onError={onError}
                clip={fileClip}
                onClipChange={setFileClip}
                onRequestDelete={setPendingDelete}
              />
            )
          }
        />
```

「打开的编辑器」的右键菜单在 Task 9 接上对比入口，本任务不渲染菜单。

导入补：

```tsx
import { EditorSidebar } from './EditorSidebar';
import { OpenEditors } from './OpenEditors';
```

- [ ] **Step 3: 构建验证**

Run: `npx tsc --noEmit && npx vite build`
Expected: 均通过。若 `sidebar-section-title` / `section-caret` 类名与现有侧栏不一致，去 `src/components/Sidebar.tsx` 抄准确类名。

- [ ] **Step 4: 提交**

```bash
git add src/components/EditorSidebar.tsx src/components/EditorPane.tsx
git commit -m "$(cat <<'EOF'
feat(editor): 左栏拆成「打开的编辑器」与「文件」两个可折叠区
EOF
)"
```

---

## Task 9: 对比功能

**Files:**
- Modify: `src/components/DiffPane.tsx`
- Modify: `src/components/EditorPane.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `buildTextPatch`（Task 1）、`DiffPane`
- Produces: `DiffTarget` 新增 `{ kind: 'text'; title: string; patch: string }`

- [ ] **Step 1: 扩展 DiffTarget**

把 `src/components/DiffPane.tsx` 的 `DiffTarget` 改为：

```tsx
export type DiffTarget =
  | { kind: 'change'; change: GitChange }
  | { kind: 'commit'; commit: CommitRef }
  // 两段文本直接算好的 patch，不读磁盘也不读 git
  | { kind: 'text'; title: string; patch: string };
```

读取分支里补上：

```tsx
  const textPatch = target.kind === 'text' ? target.patch : '';
```

在决定 patch 的那段逻辑里，`kind === 'text'` 时直接把 `textPatch` 当结果、不发起读取：

```tsx
  useEffect(() => {
    if (target.kind === 'text') {
      setPatch(target.patch);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        // ……原有的 change / commit 读取逻辑保持不变……
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);
```

- [ ] **Step 2: EditorPane 里接三种对比**

加状态：

```tsx
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);
  const [diffCompareWith, setDiffCompareWith] = useState<string | null>(null);
  const [diffRatio, setDiffRatio] = useState(0.5);
  const diffDragRef = useRef<{ x: number; ratio: number; width: number } | null>(null);
  const [diffDragging, setDiffDragging] = useState(false);
```

三种模式：

```tsx
  // 与磁盘版本比较：左旧（磁盘）右新（内存）
  const compareWithDisk = useCallback(
    async (relPath: string) => {
      const entry = files[relPath];
      if (!entry) return;
      try {
        const disk = await window.api.files.read(group.path, relPath);
        setDiffTarget({
          kind: 'text',
          title: `${relPath} ↔ 磁盘版本`,
          patch: buildTextPatch('磁盘版本', disk.content, '当前编辑', entry.content),
        });
        setDiffCompareWith(null);
      } catch (error) {
        onToast(toErrorMessage(error), 'error');
      }
    },
    [files, group.path, onToast],
  );

  // 两个已打开文件互比
  const compareTwoFiles = useCallback(
    (leftRel: string, rightRel: string) => {
      const left = files[leftRel];
      const right = files[rightRel];
      if (!left || !right) return;
      setDiffTarget({
        kind: 'text',
        title: `${leftRel} ↔ ${rightRel}`,
        patch: buildTextPatch(leftRel, left.content, rightRel, right.content),
      });
      setDiffCompareWith(null);
    },
    [files],
  );

  // 与 Git HEAD 比较：复用现成的 patch
  const compareWithHead = useCallback(
    async (relPath: string) => {
      try {
        const result = await window.api.git.fileDiff(group.path, relPath, 'modified');
        setDiffTarget({
          kind: 'text',
          title: `${relPath} ↔ Git HEAD`,
          patch: result.patch || '',
        });
        setDiffCompareWith(null);
      } catch (error) {
        onToast(toErrorMessage(error), 'error');
      }
    },
    [group.path, onToast],
  );
```

加菜单状态与右键处理：

```tsx
  const [editorMenu, setEditorMenu] = useState<{
    x: number;
    y: number;
    relPath: string;
  } | null>(null);

  const openOpenEditorMenu = useCallback(
    (event: React.MouseEvent, relPath: string) => {
      event.preventDefault();
      setEditorMenu({
        x: event.clientX,
        y: event.clientY,
        relPath,
      });
    },
    [],
  );
```

先在 Task 8 的 `<OpenEditors>` 上补 `onContextMenu`：

```tsx
              onContextMenu={(event, relPath) => openOpenEditorMenu(event, relPath)}
```

导入补上一行：

```tsx
import { PopupMenu } from './PopupMenu';
```

在 return 末尾渲染菜单：

```tsx
      {editorMenu ? (
        <PopupMenu
          state={{
            x: editorMenu.x,
            y: editorMenu.y,
            items: [
              {
                type: 'item',
                id: 'diff-disk',
                label: '与已保存文件比较',
                onSelect: () => {
                  void compareWithDisk(editorMenu.relPath);
                  setEditorMenu(null);
                },
              },
              {
                type: 'item',
                id: 'diff-pick',
                label: diffCompareWith ? `与 ${diffCompareWith} 比较` : '选择以进行比较',
                onSelect: () => {
                  if (!diffCompareWith) {
                    setDiffCompareWith(editorMenu.relPath);
                  } else {
                    compareTwoFiles(diffCompareWith, editorMenu.relPath);
                  }
                  setEditorMenu(null);
                },
              },
              {
                type: 'item',
                id: 'diff-head',
                label: '与 Git HEAD 比较',
                onSelect: () => {
                  void compareWithHead(editorMenu.relPath);
                  setEditorMenu(null);
                },
              },
            ],
          }}
          onClose={() => setEditorMenu(null)}
        />
      ) : null}
```

- [ ] **Step 3: 对比分栏布局**

把 `<div className="editor-main">` 的内容改为按 `diffTarget` 分支：

```tsx
        <div className="editor-main">
          {diffTarget ? (
            <div className={`editor-diff-split${diffDragging ? ' is-resizing' : ''}`}>
              <div className="editor-diff-pane" style={{ flex: `${diffRatio} 1 0` }}>
                {activePath ? (
                  <CodeMirrorHost
                    /* 原有 props 原样保留 */
                    /* … */
                  />
                ) : (
                  <p className="editor-placeholder">从左侧选择文件</p>
                )}
              </div>
              <button
                type="button"
                className={`split-resizer${diffDragging ? ' is-dragging' : ''}`}
                aria-label="调整对比宽度"
                onPointerDown={handleDiffPointerDown}
                onPointerMove={handleDiffPointerMove}
                onPointerUp={handleDiffPointerUp}
                onPointerCancel={handleDiffPointerUp}
              />
              <div className="editor-diff-pane" style={{ flex: `${1 - diffRatio} 1 0` }}>
                <DiffPane
                  projectPath={group.path}
                  wordWrap={wordWrap}
                  target={diffTarget}
                  active
                  onClose={() => setDiffTarget(null)}
                  onOpenFile={requestOpen}
                  onToast={onToast}
                />
              </div>
            </div>
          ) : activePath ? (
            <CodeMirrorHost /* 原有 props 原样保留 */ />
          ) : (
            <p className="editor-placeholder">从左侧选择文件</p>
          )}
        </div>
```

拖拽处理（与 App.tsx 的 split-resizer 同一套思路）：

```tsx
  const handleDiffPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const root = event.currentTarget.parentElement;
    if (!root) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDiffDragging(true);
    diffDragRef.current = {
      x: event.clientX,
      ratio: diffRatio,
      width: Math.max(root.getBoundingClientRect().width, 80),
    };
  }, [diffRatio]);

  const handleDiffPointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const state = diffDragRef.current;
    if (!state) return;
    const delta = (event.clientX - state.x) / state.width;
    setDiffRatio(Math.min(0.85, Math.max(0.15, state.ratio + delta)));
  }, []);

  const handleDiffPointerUp = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    diffDragRef.current = null;
    setDiffDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);
```

- [ ] **Step 4: 加样式**

```css
.editor-diff-split {
  display: flex;
  height: 100%;
  min-height: 0;
}

.editor-diff-pane {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
```

- [ ] **Step 5: 类型检查与构建**

Run: `npx tsc --noEmit && npx vite build`
Expected: 均通过

- [ ] **Step 6: 提交**

```bash
git add src/components/DiffPane.tsx src/components/EditorPane.tsx src/styles.css
git commit -m "$(cat <<'EOF'
feat(editor): 三种文件对比——与磁盘、两文件互比、与 Git HEAD

DiffPane 增加 text 变体直接渲染自算的 patch；对比时分栏可拖拽调宽。
EOF
)"
```

---

## Task 10: UI 测试

**Files:**
- Create: `tests/editor-file-tree.mjs`

**Interfaces:**
- Consumes: 全部实现

- [ ] **Step 1: 写测试**

创建 `tests/editor-file-tree.mjs`：

```js
// 编辑器文件树：工具栏、右键文件操作、打开的编辑器、三种对比。
// 需要独占 17382 端口，跑之前先关掉正在运行的 Cmd Toolbox。
import { _electron as electron } from 'playwright-core';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-ftree-'));
const projectDir = mkdtempSync(join(tmpdir(), 'cmdtb-ftree-proj-'));

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error('断言失败：' + message);
  passed += 1;
  console.log('  ok  ' + message);
}

mkdirSync(join(projectDir, 'sub'), { recursive: true });
writeFileSync(join(projectDir, 'alpha.php'), '<?php\necho 1;\n', 'utf8');
writeFileSync(join(projectDir, 'beta.php'), '<?php\necho 2;\n', 'utf8');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.CMDTOOLBOX_NO_UPDATE = '1';

let app;
try {
  app = await electron.launch({
    executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
    cwd: root,
    args: ['.', `--data-dir=${dataDir}`],
    env,
  });

  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.app').waitFor();
  await page.waitForTimeout(1000);
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.show();
    win?.focus();
    win?.moveTop();
  });

  // 加项目并打开编辑器
  await page.locator('.add-project-btn').click();
  await page.locator('.modal-card').waitFor();
  await page.locator('#project-path').fill(projectDir);
  await page.locator('#project-name').fill('ftree');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await page.waitForTimeout(400);
  await page.locator('.group-item').filter({ hasText: 'ftree' }).locator('.group-main').click();
  await page.waitForTimeout(600);
  await page.locator('.group-item').filter({ hasText: 'ftree' }).click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  await page.getByRole('menuitem', { name: '打开编辑器', exact: true }).click();
  await page.locator('.editor-pane').waitFor();

  console.log('1. 两个可折叠区');
  assert(
    (await page.locator('.editor-sidebar-section').count()) === 2,
    '左栏有两个可折叠区',
  );
  assert(
    (await page.locator('.editor-sidebar-section').first().innerText()).includes('打开的编辑器'),
    '第一个区是「打开的编辑器」',
  );
  assert(
    (await page.locator('.editor-sidebar-section').last().innerText()).includes('文件'),
    '第二个区是「文件」',
  );

  console.log('2. 打开的编辑器随文件打开而变化');
  const alphaRow = page.locator('.file-tree .file-row').filter({ hasText: /^alpha\.php$/ });
  await alphaRow.click();
  await page.locator('.cm-content').first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  assert(
    (await page.locator('.editor-sidebar-section').first().innerText()).includes('alpha.php'),
    '打开的文件出现在「打开的编辑器」里',
  );

  console.log('3. 工具栏新建文件');
  page.once('dialog', (d) => d.accept('created.php'));
  await page.locator('.file-tree-toolbar button[title="新建文件"]').click();
  await page.waitForTimeout(1200);
  assert(existsSync(join(projectDir, 'created.php')), '新建文件落在磁盘上');

  console.log('4. 工具栏新建文件夹');
  page.once('dialog', (d) => d.accept('newdir'));
  await page.locator('.file-tree-toolbar button[title="新建文件夹"]').click();
  await page.waitForTimeout(1000);
  assert(existsSync(join(projectDir, 'newdir')), '新建文件夹落在磁盘上');

  console.log('5. 刷新能看见外部新建的文件');
  writeFileSync(join(projectDir, 'external.php'), '<?php\n', 'utf8');
  await page.locator('.file-tree-toolbar button[title="刷新"]').click();
  await page.waitForTimeout(1200);
  assert(
    (await page.locator('.file-tree .file-row').filter({ hasText: /^external\.php$/ }).count()) === 1,
    '外部新建的文件出现在树里',
  );

  console.log('6. 右键复制 → 粘贴到 sub');
  const betaRow = page.locator('.file-tree .file-row').filter({ hasText: /^beta\.php$/ }).first();
  await betaRow.click({ button: 'right' });
  await page.locator('.popup-menu').waitFor();
  await page.getByRole('menuitem', { name: '复制', exact: true }).click();
  await page.waitForTimeout(300);

  const subRow = page.locator('.file-tree .file-row').filter({ hasText: /^sub$/ }).first();
  await subRow.click({ button: 'right' });
  await page.locator('.popup-menu').waitFor();
  await page.getByRole('menuitem', { name: '粘贴', exact: true }).click();
  await page.waitForTimeout(1200);
  assert(existsSync(join(projectDir, 'sub', 'beta.php')), '粘贴后文件出现在 sub 下');
  assert(existsSync(join(projectDir, 'beta.php')), '复制粘贴后原文件仍在');

  console.log('7. 右键剪切 → 粘贴');
  const createdRow = page
    .locator('.file-tree .file-row')
    .filter({ hasText: /^created\.php$/ })
    .first();
  await createdRow.click({ button: 'right' });
  await page.locator('.popup-menu').waitFor();
  await page.getByRole('menuitem', { name: '剪切', exact: true }).click();
  await page.waitForTimeout(300);
  await subRow.click({ button: 'right' });
  await page.locator('.popup-menu').waitFor();
  await page.getByRole('menuitem', { name: '粘贴', exact: true }).click();
  await page.waitForTimeout(1200);
  assert(!existsSync(join(projectDir, 'created.php')), '剪切后原位置消失');
  assert(existsSync(join(projectDir, 'sub', 'created.php')), '剪切后新位置出现');

  console.log('8. 删除弹确认，确认后进回收站');
  const externalRow = page
    .locator('.file-tree .file-row')
    .filter({ hasText: /^external\.php$/ })
    .first();
  await externalRow.click({ button: 'right' });
  await page.locator('.popup-menu').waitFor();
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  await page.locator('.modal-card').filter({ hasText: '删除到回收站' }).waitFor({ timeout: 8000 });
  assert(true, '弹出删除确认');
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.waitForTimeout(1500);
  assert(!existsSync(join(projectDir, 'external.php')), '文件已被移走');

  console.log('9. 与已保存文件比较');
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n// changed in memory');
  await page.waitForTimeout(300);
  const openAlpha = page
    .locator('.editor-sidebar-section')
    .first()
    .locator('.file-row')
    .filter({ hasText: /^alpha\.php$/ })
    .first();
  await openAlpha.click({ button: 'right' });
  await page.locator('.popup-menu').waitFor();
  await page.getByRole('menuitem', { name: '与已保存文件比较', exact: true }).click();
  await page.waitForTimeout(1500);
  assert((await page.locator('.editor-diff-split').count()) === 1, '打开对比分栏');
  assert(
    (await page.locator('.editor-diff-split').innerText()).includes('changed in memory'),
    '对比里能看到内存中的改动',
  );
} finally {
  await app?.close().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}

console.log(`\n全部通过：${passed} 项`);
```

- [ ] **Step 2: 运行**

Run:
```bash
npx tsc --noEmit && npx vite build
powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force"
node tests/editor-file-tree.mjs
```
Expected: PASS

- [ ] **Step 3: 回归相邻测试**

Run:
```bash
node tests/file-ops.mjs
node tests/diff-from-text.mjs
node tests/editor-goto-def.mjs
node tests/editor-modules.mjs
```
Expected: 全部 PASS

- [ ] **Step 4: 提交**

```bash
git add tests/editor-file-tree.mjs
git commit -m "$(cat <<'EOF'
test(editor): 文件树工具栏、右键操作与对比的端到端用例
EOF
)"
```

---

## Task 11: 文档

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 记录约定**

在 `CLAUDE.md` 的「编辑器模块」小节下追加：

```markdown
### 文件树与对比

- **文件操作全部经 `resolveWithin`**（`desktop/file-api.js`）。`createFile` 用
  `fs.open(..., 'wx')`、`createDir` 不带 `recursive`、`move` 先 `lstat` 判目标——
  **三者都绝不覆盖已存在的文件**，粘贴和新建撞名时报错而不是静默替换。
- **删除走 `shell.trashItem`**（系统回收站），不用 `unlink`。删除已打开的文件时
  **先关页签再删**，否则留下指向不存在文件的编辑器。有未保存修改时确认弹窗要
  额外提示不可恢复。
- **每次写盘后调 `symbols.invalidate(projectPath)`**，否则新建的文件在符号索引里
  不存在，Ctrl+点击会漏。
- **剪贴板是应用内的**（`src/fileClipboard.ts`），不碰系统剪贴板。项目路径比较前
  **必须归一小写和斜杠**——Windows 下 `D:/P1` 与 `d:/p1` 是同一个项目。
- **对比的三种模式共用 `DiffPane`**：与磁盘版本、两文件互比、与 Git HEAD。前两种
  用 `src/diffFromText.ts` 自算 unified diff（仓库没有 diff 库，而 `diffParser`
  已经能解析这个格式），第三种直接复用 `git.fileDiff` 的 patch。
  `DiffTarget` 的 `text` 变体不读磁盘也不读 git。
- **左栏两个折叠区用 `useCollapsedSection`**，id 是 `editor-open-editors` 与
  `editor-file-tree`。文件区是 `is-grow`（吃掉剩余高度并自己滚动）。
- **不做快捷键、不做拖拽移动**：需求明确不要快捷键；拖拽要处理树内拖放、跨目录、
  视觉反馈，工作量远大于本次其它功能。
```

在 UI 测试清单里补一行：

```bash
node tests/editor-file-tree.mjs  # 文件树工具栏、右键操作与对比
```

在离线测试清单里补两行：

```bash
node tests/file-ops.mjs          # 新建/移动/删除到回收站
node tests/diff-from-text.mjs    # 文本差异生成 unified diff
```

- [ ] **Step 2: 提交**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: 记录文件树操作与对比的约定
EOF
)"
```

---

## Self-Review

**Spec coverage**

| Spec 条目 | 对应任务 |
|---|---|
| 左栏两个可折叠区 | Task 8 |
| 工具栏四个按钮 | Task 6 |
| 右键菜单（文件/文件夹、空白处、打开条目） | Task 7、Task 8、Task 9 |
| 复制/剪切/粘贴语义与跨项目拒绝 | Task 4、Task 7 |
| 删除到回收站 + 二次确认 + 关页签 | Task 2、Task 7 |
| 与磁盘 / 两文件 / Git HEAD 三种对比 | Task 9 |
| 对比分栏可拖拽 | Task 9 |
| 新建/移动绝不覆盖 | Task 2 |
| 写后 invalidate 符号索引 | Task 3 |
| 离线与 UI 测试 | Task 1、2、4、10 |
| 文档 | Task 11 |

**类型一致性**：`FileClip` 由 Task 4 定义，Task 7 消费；`DiffTarget` 的 `text` 变体
在 Task 9 定义并立即使用；`buildTextPatch` 签名在 Task 1 定义，Task 9 消费。

**已知风险**

- Task 6 用 `window.prompt` 取名，测试里要用 `page.once('dialog')` 应答。若后续想要
  树内联输入框，替换 `promptName` 一个函数即可。
- Task 8 的 `sidebar-section-title` / `section-caret` 类名需按 `Sidebar.tsx`
  的实际类名核对，不一致就照抄。
- Task 9 里 `CodeMirrorHost` 的完整 props 列表很长，实现时**原样保留现有那一份**，
  只是多包一层 `.editor-diff-pane`。

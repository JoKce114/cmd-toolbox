# Git 面板：提交历史、撤销提交、stash、冲突行跳转 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Git 面板支持查看单个提交的 diff、撤销 / 修改最后一次提交、收起与恢复 stash，并让冲突文件能直接跳进编辑器解决。

**Architecture:** 全部能力落在既有的 `desktop/git.js`（主进程 `execFile` 调 git）→ `ipcMain.handle` → `preload` 桥 → `window.api.git` 四层链路上。渲染侧复用现有 `DiffPane`（改成判别联合 props 增加「提交模式」）、`ConfirmDialog`、`Modal`、`useCollapsedSection`。提交 patch 的多文件切分抽成纯函数 `src/commitDiff.ts`，可用离线测试覆盖。

**Tech Stack:** Electron 33 · React 19 · TypeScript 5.7 · Vite 6 · CodeMirror 6 · Playwright（`playwright-core` 驱动真实 Electron）· 无新增依赖。

## Global Constraints

- 平台仅 Windows。终端注入依赖 `build/coninject.exe`，与本计划无关但构建脚本会编译它。
- **IPC 四处同步**：`ipcMain.handle`（`desktop/main.js`）→ `desktop/preload.js` 的 `invoke()` 包装 → `window.api.*` → `src/global.d.ts` 类型声明。缺一处就是运行时错误或类型报错。通道命名沿用 `<模块>:<动作>`。
- 所有 `git:*` 通道的第一个参数必须过 `assertProjectPath()`（已存在于 `desktop/main.js`），不得绕过。
- **不要在 `dependencies` 里新增包**；本计划不新增任何依赖。
- 所有面向用户的中文文案必须与计划里的字符串**逐字一致**，UI 测试依赖它们。
- 离线测试：`node tests/git-core.mjs`、`node tests/commit-diff.mjs`。
- UI 测试：`node tests/git-panel.mjs`，**运行前必须关闭正在运行的 Cmd Toolbox**（`desktop/pane-api.js` 写死端口 17382）；测试环境需 `CMDTOOLBOX_NO_UPDATE=1`（`tests/git-panel.mjs` 已设置）。
- 每次提交前跑 `npm run typecheck`。
- 提交信息用中文，格式 `feat(git): …` / `test(git): …`。

---

### Task 1: 后端 — HEAD 信息、撤销提交、修改提交

**Files:**
- Modify: `desktop/git.js`（在 `mergeInto` 之后、`module.exports` 之前新增函数；在导出表里追加 3 项）
- Modify: `desktop/main.js`（在 `git:merge-into` 注册之后追加 3 个通道）
- Modify: `desktop/preload.js`（`git:` 对象内追加 3 个方法）
- Modify: `src/types.ts`（新增 `HeadCommit` 类型）
- Modify: `src/global.d.ts`（`git:` 接口追加 3 个方法）
- Test: `tests/git-core.mjs`（在文件末尾 `全部通过` 那行之前追加第 16、17 节）

**Interfaces:**
- Produces:
  - `git.headCommit(projectPath): Promise<{ hash: string; short: string; subject: string; message: string; pushed: boolean } | null>` — 空仓库返回 `null`
  - `git.undoCommit(projectPath): Promise<{ message: string; wasPushed: boolean }>`
  - `git.amend(projectPath, message): Promise<{ commit: string; summary: string }>`
  - IPC：`git:head-commit`、`git:undo-commit`、`git:amend`
  - `window.api.git.headCommit(projectPath)`、`.undoCommit(projectPath)`、`.amend(projectPath, message)`
  - TS：`export type HeadCommit = { hash: string; short: string; subject: string; message: string; pushed: boolean };`

- [ ] **Step 1: 先写失败测试**

在 `tests/git-core.mjs` 末尾 `console.log(\`\n全部通过：${passed} 项\`);` 之前插入：

```js
console.log('16. 撤销提交');
const undoRepo = makeRepo();
writeFileSync(join(undoRepo, 'one.txt'), 'a\n');
await git.stageAll(undoRepo);
await git.commit(undoRepo, '第一次');
writeFileSync(join(undoRepo, 'two.txt'), 'b\n');
await git.stageAll(undoRepo);
await git.commit(undoRepo, '第二次');

const undone = await git.undoCommit(undoRepo);
assert(undone.message === '第二次', '返回被撤销提交的完整信息');
assert(undone.wasPushed === false, '无远端时标记为未推送');
const afterUndo = await git.status(undoRepo);
assert(afterUndo.ok && afterUndo.stagedCount === 1, '改动回到暂存区');
assert(
  execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: undoRepo, encoding: 'utf8' }).trim() ===
    '第一次',
  'HEAD 回退到上一个提交',
);

const firstUndo = await git.undoCommit(undoRepo);
assert(firstUndo.message === '第一次', '可继续撤销到首次提交');
assert((await git.headCommit(undoRepo)) === null, '撤销首次提交后没有 HEAD');
const unbornStatus = await git.status(undoRepo);
assert(unbornStatus.ok && unbornStatus.stagedCount === 2, '首次提交撤销后文件全部暂存');

console.log('17. 修改提交');
const amendRepo = makeRepo();
writeFileSync(join(amendRepo, 'a.txt'), 'a\n');
await git.stageAll(amendRepo);
await git.commit(amendRepo, '原始信息');
writeFileSync(join(amendRepo, 'b.txt'), 'b\n');
await git.stageAll(amendRepo);
const amended = await git.amend(amendRepo, '修改后的信息');
assert(amended.summary === '修改后的信息', '返回新的提交信息');
assert(
  execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: amendRepo, encoding: 'utf8' }).trim() ===
    '修改后的信息',
  '提交信息已更新',
);
assert(
  execFileSync('git', ['rev-list', '--count', 'HEAD'], {
    cwd: amendRepo,
    encoding: 'utf8',
  }).trim() === '1',
  '仍然只有一条提交',
);
assert(
  execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], {
    cwd: amendRepo,
    encoding: 'utf8',
  }).includes('b.txt'),
  '暂存改动并入提交',
);

let amendError = '';
try {
  await git.amend(amendRepo, '修改后的信息');
} catch (error) {
  amendError = error.message;
}
assert(amendError.includes('未修改'), '无变更时拒绝 amend');

const headRepo = makeRepo();
assert((await git.headCommit(headRepo)) === null, '空仓库 headCommit 返回 null');
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/git-core.mjs`
Expected: FAIL，报 `git.headCommit is not a function`（或 `undoCommit is not a function`）。

- [ ] **Step 3: 实现 git.js 三个函数**

在 `desktop/git.js` 的 `mergeInto` 函数之后、`module.exports` 之前插入：

```js
// 字段分隔符用不可见字符，避免提交信息里的空格干扰 split
const UNIT = String.fromCharCode(31);
const COMMIT_HASH = /^[0-9a-f]{4,40}$/;

function assertCommitHash(hash) {
  const value = String(hash || '').trim().toLowerCase();
  if (!COMMIT_HASH.test(value)) throw new Error('提交标识不合法');
  return value;
}

// 空仓库返回 null，调用方据此禁用「撤销 / 修改提交」
async function headCommit(projectPath) {
  if (!isDirectory(projectPath)) throw new Error('项目目录不存在');
  const result = await runGit(projectPath, [
    'log',
    '-1',
    `--pretty=%H${UNIT}%h${UNIT}%s${UNIT}%B`,
  ]);
  if (!result.ok) {
    if (/does not have any commits|unknown revision|bad default revision/i.test(result.stderr)) {
      return null;
    }
    throw new Error(cleanError(result.error, result.stderr));
  }
  const parts = result.stdout.split(UNIT);
  const hash = (parts[0] || '').trim();
  const short = (parts[1] || '').trim();
  const subject = (parts[2] || '').trim();
  const message = (parts.slice(3).join(UNIT) || subject).trim();

  // 无远端仓库时输出为空，pushed 为 false 是正确的
  const remote = await runGit(projectPath, ['branch', '-r', '--contains', hash]);
  return {
    hash,
    short,
    subject: subject || '(无提交信息)',
    message,
    pushed: Boolean(remote.ok && remote.stdout.trim()),
  };
}

async function undoCommit(projectPath) {
  if (!isDirectory(projectPath)) throw new Error('项目目录不存在');
  const head = await headCommit(projectPath);
  if (!head) throw new Error('还没有任何提交可以撤销');

  // 首次提交没有 HEAD~1，只能删掉引用；此时索引保留，文件仍处于已暂存状态
  const parent = await runGit(projectPath, ['rev-parse', '--verify', '--quiet', 'HEAD~1']);
  const args = parent.ok ? ['reset', '--soft', 'HEAD~1'] : ['update-ref', '-d', 'HEAD'];
  const result = await runGit(projectPath, args);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));

  return { message: head.message, wasPushed: head.pushed };
}

async function amend(projectPath, message) {
  const text = String(message || '').trim();
  if (!text) throw new Error('请填写提交信息');
  if (!isDirectory(projectPath)) throw new Error('项目目录不存在');

  const head = await headCommit(projectPath);
  if (!head) throw new Error('还没有提交可以修改');

  const current = await status(projectPath);
  const stagedCount = current.ok ? current.stagedCount : 0;
  // git commit --amend 在无改动时会静默改掉提交时间，这里先拦住
  if (text === head.message && stagedCount === 0) {
    throw new Error('提交信息未修改，也没有暂存改动');
  }

  const result = await runGit(
    projectPath,
    text === head.message
      ? ['commit', '--amend', '--no-edit']
      : ['commit', '--amend', '-m', text],
  );
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));

  const head2 = await runGit(projectPath, ['rev-parse', '--short', 'HEAD']);
  return { commit: head2.stdout.trim(), summary: text.split('\n')[0] };
}
```

- [ ] **Step 4: 导出新函数**

在 `desktop/git.js` 的 `module.exports = { ... }` 对象中追加（放在 `mergeInto,` 之后）：

```js
  headCommit,
  undoCommit,
  amend,
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node tests/git-core.mjs`
Expected: PASS，最后一行 `全部通过：NN 项`，其中包含「16. 撤销提交」「17. 修改提交」全部断言。

- [ ] **Step 6: 注册 IPC**

在 `desktop/main.js` 中 `ipcMain.handle('git:merge-into', ...)` 之后追加：

```js
  ipcMain.handle('git:head-commit', (_event, projectPath) =>
    git.headCommit(assertProjectPath(projectPath)),
  );

  ipcMain.handle('git:undo-commit', (_event, projectPath) =>
    git.undoCommit(assertProjectPath(projectPath)),
  );

  ipcMain.handle('git:amend', (_event, projectPath, message) =>
    git.amend(assertProjectPath(projectPath), message),
  );
```

- [ ] **Step 7: 暴露到 preload**

在 `desktop/preload.js` 的 `git: { ... }` 对象里 `mergeInto` 之后追加：

```js
    headCommit: (projectPath) => invoke('git:head-commit', projectPath),
    undoCommit: (projectPath) => invoke('git:undo-commit', projectPath),
    amend: (projectPath, message) => invoke('git:amend', projectPath, message),
```

- [ ] **Step 8: 补类型声明**

`src/types.ts` 在 `GitChange` 类型之后新增：

```ts
export type HeadCommit = {
  hash: string;
  short: string;
  subject: string;
  message: string;
  pushed: boolean;
};
```

`src/global.d.ts` 顶部 `import type { ... }` 列表加入 `HeadCommit`，并在 `git:` 接口里 `mergeInto` 之后追加：

```ts
        headCommit: (projectPath: string) => Promise<HeadCommit | null>;
        undoCommit: (
          projectPath: string,
        ) => Promise<{ message: string; wasPushed: boolean }>;
        amend: (
          projectPath: string,
          message: string,
        ) => Promise<{ commit: string; summary: string }>;
```

- [ ] **Step 9: 类型检查**

Run: `npm run typecheck`
Expected: 无输出错误（退出码 0）。

- [ ] **Step 10: 提交**

```bash
git add desktop/git.js desktop/main.js desktop/preload.js src/types.ts src/global.d.ts tests/git-core.mjs
git commit -m "feat(git): 后端支持撤销与修改最后一次提交"
```

---

### Task 2: 后端 — stash 的列出、收起、恢复、丢弃

**Files:**
- Modify: `desktop/git.js`（新增 4 个函数 + 导出）
- Modify: `desktop/main.js`（4 个通道）
- Modify: `desktop/preload.js`（4 个方法）
- Modify: `src/types.ts`（`StashEntry`）
- Modify: `src/global.d.ts`（4 个方法）
- Test: `tests/git-core.mjs`（追加第 18 节）

**Interfaces:**
- Consumes: `headCommit` / `status` / `collectConflicts`（Task 1 与既有实现）
- Produces:
  - `git.stashList(projectPath): Promise<{ stashes: StashEntry[] }>`
  - `git.stashSave(projectPath): Promise<{ ok: true }>`
  - `git.stashPop(projectPath, ref): Promise<{ ok: true; conflicts: string[] }>`
  - `git.stashDrop(projectPath, ref): Promise<{ ok: true }>`
  - IPC：`git:stash-list`、`git:stash-save`、`git:stash-pop`、`git:stash-drop`
  - TS：`export type StashEntry = { ref: string; message: string; when: string };`

- [ ] **Step 1: 先写失败测试**

在 `tests/git-core.mjs` 的 `全部通过` 行之前继续追加：

```js
console.log('18. stash');
const stashRepo = makeRepo();
writeFileSync(join(stashRepo, 'tracked.txt'), 'v1\n');
await git.stageAll(stashRepo);
await git.commit(stashRepo, '初始');
writeFileSync(join(stashRepo, 'tracked.txt'), 'v2\n');
writeFileSync(join(stashRepo, 'untracked.txt'), 'u\n');

await git.stashSave(stashRepo);
const cleanStatus = await git.status(stashRepo);
assert(
  cleanStatus.ok && cleanStatus.stagedCount === 0 && cleanStatus.unstagedCount === 0,
  '收起后工作区干净',
);
assert(!existsSync(join(stashRepo, 'untracked.txt')), '未跟踪文件一并收起');

const listed = await git.stashList(stashRepo);
assert(listed.stashes.length === 1, 'stash 列表有一条');
assert(/^stash@\{0\}$/.test(listed.stashes[0].ref), 'ref 格式正确');

await git.stashPop(stashRepo, listed.stashes[0].ref);
assert(readFileSync(join(stashRepo, 'tracked.txt'), 'utf8') === 'v2\n', '恢复后改动回来');
assert(existsSync(join(stashRepo, 'untracked.txt')), '未跟踪文件一并恢复');
assert((await git.stashList(stashRepo)).stashes.length === 0, '恢复后列表清空');

writeFileSync(join(stashRepo, 'tracked.txt'), 'v3\n');
await git.stashSave(stashRepo);
writeFileSync(join(stashRepo, 'untracked.txt'), 'u2\n');
await git.stashSave(stashRepo);
const twoStashes = await git.stashList(stashRepo);
assert(twoStashes.stashes.length === 2, '两次收起得到两条');
await git.stashDrop(stashRepo, twoStashes.stashes[0].ref);
assert((await git.stashList(stashRepo)).stashes.length === 1, '丢弃后剩一条');

let refError = '';
try {
  await git.stashDrop(stashRepo, 'stash@{-1}');
} catch (error) {
  refError = error.message;
}
assert(refError.includes('不合法'), '非法 stash ref 被拒绝');

let popError = '';
try {
  await git.stashPop(stashRepo, '../../x');
} catch (error) {
  popError = error.message;
}
assert(popError.includes('不合法'), '越界 stash ref 被拒绝');

let noChangeError = '';
try {
  await git.stashSave(stashRepo);
} catch (error) {
  noChangeError = error.message;
}
assert(noChangeError.includes('没有可收起的改动'), '无改动时给出提示');
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/git-core.mjs`
Expected: FAIL，报 `git.stashSave is not a function`。

- [ ] **Step 3: 实现四个 stash 函数**

在 `desktop/git.js` 的 `amend` 之后、`module.exports` 之前插入：

```js
const STASH_REF = /^stash@\{\d+\}$/;

function assertStashRef(ref) {
  const value = String(ref || '').trim();
  if (!STASH_REF.test(value)) throw new Error('stash 标识不合法');
  return value;
}

async function stashList(projectPath) {
  if (!isDirectory(projectPath)) throw new Error('项目目录不存在');
  const result = await runGit(projectPath, [
    'stash',
    'list',
    `--format=%gd${UNIT}%gs${UNIT}%cr`,
  ]);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  const stashes = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 20)
    .map((line) => {
      const parts = line.split(UNIT);
      return {
        ref: (parts[0] || '').trim(),
        message: (parts[1] || '').trim() || '(无说明)',
        when: (parts[2] || '').trim(),
      };
    });
  return { stashes };
}

// -u 把未跟踪文件一起收起，否则切分支时它们仍会碍事
async function stashSave(projectPath) {
  if (!isDirectory(projectPath)) throw new Error('项目目录不存在');
  const result = await runGit(projectPath, ['stash', 'push', '-u', '-m', 'Cmd Toolbox']);
  const output = `${result.stdout}${result.stderr}`;
  if (/No local changes to save/i.test(output)) throw new Error('没有可收起的改动');
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  return { ok: true };
}

async function stashPop(projectPath, ref) {
  const target = assertStashRef(ref);
  const result = await runGit(projectPath, ['stash', 'pop', target]);
  if (!result.ok) {
    // 冲突时 git 不会删除 stash，工作区进入冲突态：这不是失败，交给调用方提示
    const conflicts = await collectConflicts(projectPath, result);
    if (conflicts.length) return { ok: true, conflicts };
    throw new Error(cleanError(result.error, result.stderr));
  }
  return { ok: true, conflicts: [] };
}

async function stashDrop(projectPath, ref) {
  const target = assertStashRef(ref);
  const result = await runGit(projectPath, ['stash', 'drop', target]);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  return { ok: true };
}
```

- [ ] **Step 4: 导出**

在 `module.exports` 里追加：

```js
  stashList,
  stashSave,
  stashPop,
  stashDrop,
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node tests/git-core.mjs`
Expected: PASS，包含「18. stash」全部断言。

- [ ] **Step 6: 注册 IPC**

`desktop/main.js`，在上一步 `git:amend` 之后：

```js
  ipcMain.handle('git:stash-list', (_event, projectPath) =>
    git.stashList(assertProjectPath(projectPath)),
  );

  ipcMain.handle('git:stash-save', (_event, projectPath) =>
    git.stashSave(assertProjectPath(projectPath)),
  );

  ipcMain.handle('git:stash-pop', (_event, projectPath, ref) =>
    git.stashPop(assertProjectPath(projectPath), ref),
  );

  ipcMain.handle('git:stash-drop', (_event, projectPath, ref) =>
    git.stashDrop(assertProjectPath(projectPath), ref),
  );
```

- [ ] **Step 7: preload 暴露**

`desktop/preload.js` 的 `git: { ... }` 中追加：

```js
    stashList: (projectPath) => invoke('git:stash-list', projectPath),
    stashSave: (projectPath) => invoke('git:stash-save', projectPath),
    stashPop: (projectPath, ref) => invoke('git:stash-pop', projectPath, ref),
    stashDrop: (projectPath, ref) => invoke('git:stash-drop', projectPath, ref),
```

- [ ] **Step 8: 类型声明**

`src/types.ts` 在 `HeadCommit` 之后新增：

```ts
export type StashEntry = {
  ref: string;
  message: string;
  when: string;
};
```

`src/global.d.ts` 的 import 列表加入 `StashEntry`，`git:` 接口追加：

```ts
        stashList: (projectPath: string) => Promise<{ stashes: StashEntry[] }>;
        stashSave: (projectPath: string) => Promise<{ ok: true }>;
        stashPop: (
          projectPath: string,
          ref: string,
        ) => Promise<{ ok: true; conflicts: string[] }>;
        stashDrop: (projectPath: string, ref: string) => Promise<{ ok: true }>;
```

- [ ] **Step 9: 类型检查**

Run: `npm run typecheck`
Expected: 退出码 0。

- [ ] **Step 10: 提交**

```bash
git add desktop/git.js desktop/main.js desktop/preload.js src/types.ts src/global.d.ts tests/git-core.mjs
git commit -m "feat(git): 后端支持 stash 收起、列出、恢复与丢弃"
```

---

### Task 3: 后端 — 提交 patch 与多文件切分

**Files:**
- Modify: `desktop/git.js`（`commitDiff` + 导出）
- Modify: `desktop/main.js`（`git:commit-diff`）
- Modify: `desktop/preload.js`（`commitDiff`）
- Create: `src/commitDiff.ts`
- Modify: `src/types.ts`（`CommitRef`、`CommitFile`）
- Modify: `src/global.d.ts`（`commitDiff`）
- Test: `tests/commit-diff.mjs`（新建）

**Interfaces:**
- Consumes: `parsePatch(patch): ParsedDiff`（`src/diffParser.ts`，已存在）
- Produces:
  - `git.commitDiff(projectPath, hash): Promise<{ patch: string }>`
  - IPC `git:commit-diff`
  - `window.api.git.commitDiff(projectPath, hash)`
  - `splitCommitPatch(patch: string): CommitFile[]`
  - `export type CommitRef = { hash: string; short: string; subject: string };`
  - `export type CommitFile = { path: string; origPath?: string; status: GitChangeStatus; added: number; removed: number; patch: string };`

- [ ] **Step 1: 写失败测试**

新建 `tests/commit-diff.mjs`：

```js
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const git = require('../desktop/git.js');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

// src/ 下是 TS，Node 不能直接 import；用本地 tsc 编译成 CJS 到临时目录再 require
const buildDir = mkdtempSync(join(tmpdir(), 'cmdtb-ts-'));
execFileSync(
  process.execPath,
  [
    join(root, 'node_modules/typescript/bin/tsc'),
    'src/commitDiff.ts',
    'src/diffParser.ts',
    '--outDir',
    buildDir,
    '--module',
    'commonjs',
    '--target',
    'es2022',
    '--moduleResolution',
    'node',
    '--skipLibCheck',
  ],
  { cwd: root, stdio: 'inherit' },
);
const { splitCommitPatch } = require(join(buildDir, 'commitDiff.js'));

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'cmdtb-cdiff-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
  return dir;
}

const repo = makeRepo();
writeFileSync(join(repo, 'keep.txt'), 'one\n');
writeFileSync(join(repo, 'gone.txt'), 'two\n');
writeFileSync(join(repo, 'old.txt'), 'old\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['commit', '-m', '初始'], { cwd: repo });

writeFileSync(join(repo, 'keep.txt'), 'one changed\n');
rmSync(join(repo, 'gone.txt'));
writeFileSync(join(repo, 'brand-new.txt'), 'new\n');
execFileSync('git', ['mv', 'old.txt', 'renamed.txt'], { cwd: repo });
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['commit', '-m', '第二'], { cwd: repo });
const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

console.log('1. 多文件 patch 切分');
const { patch } = await git.commitDiff(repo, hash);
const files = splitCommitPatch(patch);
const byPath = Object.fromEntries(files.map((file) => [file.path, file]));
assert(files.length === 4, '切成 4 块');
assert(
  byPath['keep.txt'].status === 'modified' &&
    byPath['keep.txt'].added === 1 &&
    byPath['keep.txt'].removed === 1,
  '修改文件的状态与增删数正确',
);
assert(
  byPath['gone.txt'].status === 'deleted' && byPath['gone.txt'].removed === 1,
  '删除文件识别正确',
);
assert(
  byPath['brand-new.txt'].status === 'added' && byPath['brand-new.txt'].added === 1,
  '新增文件识别正确',
);
assert(
  byPath['renamed.txt'].status === 'renamed' && byPath['renamed.txt'].origPath === 'old.txt',
  '重命名识别正确且保留原路径',
);

console.log('2. 非法与不存在的提交');
let hashError = '';
try {
  await git.commitDiff(repo, 'HEAD; rm -rf /');
} catch (error) {
  hashError = error.message;
}
assert(hashError.includes('不合法'), '非法 hash 被拒绝');

let missingError = '';
try {
  await git.commitDiff(repo, 'deadbeef');
} catch (error) {
  missingError = error.message;
}
assert(missingError.includes('不在本地历史'), '不存在的提交给出明确提示');

console.log('3. merge commit 相对第一父');
execFileSync('git', ['checkout', '-b', 'side'], { cwd: repo });
writeFileSync(join(repo, 'side.txt'), 'side\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['commit', '-m', 'side 提交'], { cwd: repo });
execFileSync('git', ['checkout', 'main'], { cwd: repo });
writeFileSync(join(repo, 'main.txt'), 'main\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['commit', '-m', 'main 提交'], { cwd: repo });
execFileSync('git', ['merge', '--no-ff', 'side', '-m', '合并 side'], { cwd: repo });
const mergeHash = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repo,
  encoding: 'utf8',
}).trim();
const mergePatch = (await git.commitDiff(repo, mergeHash)).patch;
assert(mergePatch.trim().length > 0, 'merge commit 输出非空 diff');
const mergeFiles = splitCommitPatch(mergePatch);
assert(
  mergeFiles.some((file) => file.path === 'side.txt'),
  '包含来自被合并分支的文件',
);

rmSync(buildDir, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 项`);
```

- [ ] **Step 2: 运行确认失败**

Run: `node tests/commit-diff.mjs`
Expected: FAIL —— tsc 报错 `Cannot find module './commitDiff'` 之前先出现 `git.commitDiff is not a function`。

- [ ] **Step 3: 实现 commitDiff**

`desktop/git.js` 的 `stashDrop` 之后插入：

```js
async function commitDiff(projectPath, hash) {
  const target = assertCommitHash(hash);
  if (!isDirectory(projectPath)) throw new Error('项目目录不存在');

  // 默认的 git show 对 merge commit 不输出 diff；-m --first-parent 让它相对第一父输出
  const result = await runGit(projectPath, [
    '--no-pager',
    'show',
    '--no-color',
    '--no-ext-diff',
    '-U3',
    '-m',
    '--first-parent',
    '--format=',
    target,
  ]);
  if (!result.ok) {
    if (/unknown revision|bad object|invalid object name|bad revision/i.test(result.stderr)) {
      throw new Error('该提交已不在本地历史中');
    }
    throw new Error(cleanError(result.error, result.stderr));
  }
  return { patch: result.stdout };
}
```

并在 `module.exports` 追加 `commitDiff,`。

- [ ] **Step 4: 新建 src/commitDiff.ts**

```ts
import { parsePatch } from './diffParser';
import type { CommitFile } from './types';

// 一个提交的 patch 里每个文件以 "diff --git " 开头；内容行都带 +/-/空格前缀，不会误切
export function splitCommitPatch(patch: string): CommitFile[] {
  if (!patch.trim()) return [];
  return patch
    .split(/^diff --git /m)
    .slice(1)
    .map((chunk) => parseChunk(`diff --git ${chunk}`))
    .filter((file): file is CommitFile => file !== null);
}

function parseChunk(body: string): CommitFile | null {
  const lines = body.split('\n');
  let status: CommitFile['status'] = 'modified';
  let minusPath = '';
  let plusPath = '';
  let renameFrom = '';
  let renameTo = '';

  for (const line of lines) {
    if (line.startsWith('new file mode')) {
      status = 'added';
    } else if (line.startsWith('deleted file mode')) {
      status = 'deleted';
    } else if (line.startsWith('rename from ')) {
      renameFrom = line.slice('rename from '.length).trim();
      status = 'renamed';
    } else if (line.startsWith('rename to ')) {
      renameTo = line.slice('rename to '.length).trim();
      status = 'renamed';
    } else if (line.startsWith('--- ')) {
      const value = line.slice(4).trim();
      if (value !== '/dev/null') minusPath = value.replace(/^a\//, '');
    } else if (line.startsWith('+++ ')) {
      const value = line.slice(4).trim();
      if (value !== '/dev/null') plusPath = value.replace(/^b\//, '');
    }
  }

  // 纯重命名没有 ---/+++ 行；删除文件只有 --- 侧；新增文件只有 +++ 侧
  const path = plusPath || renameTo || minusPath || renameFrom;
  if (!path) return null;

  const parsed = parsePatch(body);
  return {
    path,
    origPath: renameFrom || undefined,
    status,
    added: parsed.added,
    removed: parsed.removed,
    patch: body,
  };
}
```

- [ ] **Step 5: 补类型**

`src/types.ts`：

```ts
export type CommitRef = {
  hash: string;
  short: string;
  subject: string;
};

export type CommitFile = {
  path: string;
  origPath?: string;
  status: GitChangeStatus;
  added: number;
  removed: number;
  patch: string;
};
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node tests/commit-diff.mjs`
Expected: PASS，最后一行 `全部通过：8 项`。

- [ ] **Step 7: 接到 IPC / preload / 类型**

`desktop/main.js` 在 `git:stash-drop` 之后：

```js
  ipcMain.handle('git:commit-diff', (_event, projectPath, hash) =>
    git.commitDiff(assertProjectPath(projectPath), hash),
  );
```

`desktop/preload.js` 的 `git:` 里追加：

```js
    commitDiff: (projectPath, hash) => invoke('git:commit-diff', projectPath, hash),
```

`src/global.d.ts` 的 `git:` 接口追加：

```ts
        commitDiff: (projectPath: string, hash: string) => Promise<{ patch: string }>;
```

- [ ] **Step 8: 类型检查**

Run: `npm run typecheck`
Expected: 退出码 0。

- [ ] **Step 9: 提交**

```bash
git add desktop/git.js desktop/main.js desktop/preload.js src/commitDiff.ts src/types.ts src/global.d.ts tests/commit-diff.mjs
git commit -m "feat(git): 支持读取单个提交的 diff 并切分多文件 patch"
```

---

### Task 4: 渲染 — 提交历史打开 diff 页签

**Files:**
- Modify: `src/types.ts`（`Tab.diffCommit`）
- Modify: `src/components/DiffPane.tsx`（判别联合 props + 提交模式）
- Modify: `src/components/GitPanel.tsx`（历史行改为按钮，新增 `onOpenCommit` prop）
- Modify: `src/App.tsx`（`openCommitDiffTab`、`renderWorkbenchPane`、`GitPanel` 传参、会话保存/恢复）
- Modify: `desktop/session.js`（`diffCommit` 归一化）
- Modify: `src/global.d.ts`（`SessionTab.diffCommit`）
- Modify: `src/styles.css`（历史按钮、提交文件下拉）
- Test: `tests/git-panel.mjs`（追加第 14 节）

**Interfaces:**
- Consumes: `splitCommitPatch`、`CommitFile`、`CommitRef`（Task 3）、`window.api.git.commitDiff`（Task 3）
- Produces:
  - `DiffPane` 新 props：`target: DiffTarget`（替代原来的 `change`）
  - `export type DiffTarget = { kind: 'change'; change: GitChange } | { kind: 'commit'; commit: CommitRef };`
  - `GitPanel` 新 prop：`onOpenCommit(commit: { hash: string; short: string; author: string; when: string; subject: string }): void`

- [ ] **Step 1: 写失败测试**

在 `tests/git-panel.mjs` 末尾（`await page.screenshot(...)` 之前）追加：

```js
console.log('14. 提交历史打开 diff 页签');
execFileSync('git', ['checkout', 'main'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: repo, stdio: 'ignore' });
rmSync(join(repo, 'dirty.txt'), { force: true });
writeFileSync(join(repo, 'history-a.txt'), 'a\n');
writeFileSync(join(repo, 'history-b.txt'), 'b\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['commit', '-m', '历史多文件'], { cwd: repo });
await page.waitForTimeout(1200);
await click(page.locator('.git-icon-btn'));

const historyToggle = page.locator('.git-history-toggle');
if ((await page.locator('.git-history-button').count()) === 0) await click(historyToggle);
await waitFor(
  async () => (await page.locator('.git-history-button').count()) > 0,
  '提交历史列表出现',
);
await click(page.locator('.git-history-button').first());
await waitFor(
  async () => (await page.locator('.diff-file-select').count()) > 0,
  '提交 diff 页签出现',
);
assert(
  (await page.locator('.diff-file-select option').count()) === 2,
  '文件下拉有 2 个文件',
);

const firstBody = await page.locator('.diff-body').innerText();
await page.locator('.diff-file-select').selectOption({ index: 1 });
await page.waitForTimeout(400);
const secondBody = await page.locator('.diff-body').innerText();
assert(firstBody !== secondBody, '切换文件后正文变化');
```

- [ ] **Step 2: 运行确认失败**

Run: `node tests/git-panel.mjs`
（先确认没有正在运行的 Cmd Toolbox）
Expected: FAIL，等待超时于「提交历史列表出现」。

- [ ] **Step 3: 扩展 Tab 类型**

`src/types.ts` 的 `Tab` 类型中 `diffChange?: GitChange;` 之后新增：

```ts
  diffCommit?: CommitRef;
```

- [ ] **Step 4: DiffPane 改成判别联合**

用以下内容整体替换 `src/components/DiffPane.tsx`：

```tsx
import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { cn, toErrorMessage } from '../lib';
import { splitCommitPatch } from '../commitDiff';
import { parsePatch, type DiffLine } from '../diffParser';
import type { CommitRef, GitChange } from '../types';

export type DiffTarget =
  | { kind: 'change'; change: GitChange }
  | { kind: 'commit'; commit: CommitRef };

export type DiffPaneProps = {
  projectPath: string;
  wordWrap: boolean;
  target: DiffTarget;
  active: boolean;
  onClose: () => void;
  onOpenFile: (relPath: string) => void;
  onToast: (message: string, kind?: 'info' | 'success' | 'error') => void;
};

export function DiffPane({
  projectPath,
  wordWrap,
  target,
  active,
  onClose,
  onOpenFile,
  onToast,
}: DiffPaneProps) {
  const [patch, setPatch] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedPath, setSelectedPath] = useState('');

  // target 对象每次渲染都是新的，依赖必须落在原始值上，否则会无限重取
  const commitHash = target.kind === 'commit' ? target.commit.hash : '';
  const changePath = target.kind === 'change' ? target.change.path : '';
  const changeStatus =
    target.kind === 'change'
      ? target.change.worktreeStatus ?? target.change.indexStatus ?? 'modified'
      : '';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSelectedPath('');
    const load = async () => {
      const result = commitHash
        ? await window.api.git.commitDiff(projectPath, commitHash)
        : await window.api.git.fileDiff(projectPath, changePath, changeStatus);
      return result.patch;
    };
    void load()
      .then((next) => {
        if (!cancelled) setPatch(next);
      })
      .catch((error) => {
        if (!cancelled) onToast(toErrorMessage(error), 'error');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, commitHash, changePath, changeStatus, onToast]);

  const files = useMemo(
    () => (commitHash ? splitCommitPatch(patch) : []),
    [commitHash, patch],
  );
  const activeFile = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
  const parsed = parsePatch(commitHash ? activeFile?.patch || '' : patch);

  const title = commitHash
    ? `${target.kind === 'commit' ? target.commit.short : ''} · ${
        target.kind === 'commit' ? target.commit.subject : ''
      }`
    : target.kind === 'change' && target.change.origPath
      ? `${target.change.origPath} → ${target.change.path}`
      : changePath;

  const openPath = commitHash ? activeFile?.path || '' : changePath;
  const openDisabled = commitHash
    ? !activeFile || activeFile.status === 'deleted'
    : false;

  return (
    <section className={`terminal-pane diff-pane${active ? '' : ' is-hidden'}`}>
      <header className="pane-header">
        <span className="pane-path" title={title}>
          {title}
        </span>
        {!parsed.isEmpty ? (
          <span className="diff-stats">
            <span className="diff-added">+{parsed.added}</span>
            <span className="diff-removed">−{parsed.removed}</span>
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn-secondary btn-sm diff-open-file"
          title="打开文件编辑"
          disabled={openDisabled}
          onClick={() => {
            if (openPath) onOpenFile(openPath);
          }}
        >
          打开文件
        </button>
        <button type="button" className="icon-btn" title="关闭" onClick={onClose}>
          <X size={14} />
        </button>
      </header>

      {commitHash ? (
        <div className="diff-file-bar">
          <span className="diff-file-label">文件 {files.length}</span>
          <select
            className="diff-file-select"
            value={activeFile?.path || ''}
            onChange={(event) => setSelectedPath(event.target.value)}
          >
            {files.map((file) => (
              <option key={file.path} value={file.path}>
                {file.status === 'renamed' && file.origPath
                  ? `${file.origPath} → ${file.path}`
                  : file.path}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className={`diff-body${wordWrap ? ' is-wrapped' : ''}`}>
        {loading ? (
          <p className="diff-placeholder">正在读取差异…</p>
        ) : parsed.isEmpty ? (
          <p className="diff-placeholder">没有可显示的差异</p>
        ) : (
          parsed.hunks.map((hunk, hunkIndex) => (
            <div className="diff-hunk" key={`${hunk.header}:${hunkIndex}`}>
              <div className="diff-hunk-header">{hunk.header}</div>
              {hunk.lines.map((line, lineIndex) => (
                <DiffRow key={lineIndex} line={line} />
              ))}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  if (line.kind === 'header') return null;
  return (
    <div className={cn('diff-row', `is-${line.kind}`)}>
      <span className="diff-gutter">{line.oldLine ?? ''}</span>
      <span className="diff-gutter">{line.newLine ?? ''}</span>
      <span className="diff-sign">
        {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
      </span>
      <span className="diff-text">{line.text || ' '}</span>
    </div>
  );
}
```

- [ ] **Step 5: GitPanel 历史行可点击**

`src/components/GitPanel.tsx`：

1. props 类型里 `commits` 之后新增：

```ts
  onOpenCommit: (commit: {
    hash: string;
    short: string;
    author: string;
    when: string;
    subject: string;
  }) => void;
```

2. 解构参数里加上 `onOpenCommit,`（放在 `commits` 之后）。

3. 历史列表渲染块（`<li key={commit.hash} …>` 内）改成：

```tsx
              <li key={commit.hash} className="git-history-item">
                <button
                  type="button"
                  className="git-history-button"
                  title={`${commit.short} · ${commit.subject}`}
                  onClick={() => onOpenCommit(commit)}
                >
                  <span className="git-history-subject">{commit.subject}</span>
                  <span className="git-history-meta">
                    {commit.short} · {commit.when}
                  </span>
                </button>
              </li>
```

- [ ] **Step 6: App 增加 openCommitDiffTab 并适配 renderWorkbenchPane**

`src/App.tsx` 的 `openDiffTab` 之后新增：

```tsx
  const openCommitDiffTab = useCallback(
    (group: Group, commit: CommitRef) => {
      if (!group.exists) {
        pushToast('项目目录不存在，请先编辑项目路径', 'error');
        return;
      }
      const groupTabs = tabsRef.current[group.key] || [];
      const existing = groupTabs.find(
        (item) => item.shellId === 'diff' && item.diffCommit?.hash === commit.hash,
      );
      if (existing) {
        setActiveGroupKey(group.key);
        setActiveTabByGroup((previous) => ({ ...previous, [group.key]: existing.id }));
        return;
      }
      const tab: Tab = {
        id: crypto.randomUUID(),
        groupKey: group.key,
        sessionId: '',
        shellId: 'diff',
        seq: 1,
        paneNo: nextPaneNo(groupTabs.map((item) => item.paneNo)),
        descriptor: commit.short,
        custom: true,
        cwd: group.path,
        diffCommit: commit,
        exited: false,
      };
      applyTabs({ ...tabsRef.current, [group.key]: [...groupTabs, tab] });
      setActiveGroupKey(group.key);
      setActiveTabByGroup((previous) => ({ ...previous, [group.key]: tab.id }));
    },
    [applyTabs, pushToast],
  );
```

顶部 import 从 `./types` 增加 `CommitRef`（与既有类型同一行）。

`renderWorkbenchPane` 里的 diff 分支改成：

```tsx
    if (isDiffTab(tab) && (tab.diffChange || tab.diffCommit)) {
      return (
        <DiffPane
          key={tab.id}
          projectPath={group.path}
          wordWrap={prefs.editorWordWrap}
          target={
            tab.diffCommit
              ? { kind: 'commit', commit: tab.diffCommit }
              : { kind: 'change', change: tab.diffChange! }
          }
          active={active}
          onClose={() => closeTabs(tab.groupKey, [tab.id])}
          onOpenFile={(relPath) => openEditorFile(group, relPath)}
          onToast={pushToast}
        />
      );
    }
```

（`tab.diffChange!` 在 `tab.diffCommit` 为假且外层条件已判真的分支里成立。）

`<GitPanel … />` 传参追加：

```tsx
                onOpenCommit={(commit) => {
                  if (gitGroup) openCommitDiffTab(gitGroup, commit);
                }}
```

- [ ] **Step 7: 会话保存与恢复**

`src/App.tsx` 两处 tab 序列化（`session.save` 与 `saveSync`）在 `diffChange: tab.diffChange || null,` 之后各加一行：

```tsx
            diffCommit: tab.diffCommit || null,
```

恢复分支（`if (saved.shellId === 'diff' && saved.diffChange && saved.diffChange.path)`）替换为：

```tsx
          if (
            saved.shellId === 'diff' &&
            ((saved.diffChange && saved.diffChange.path) || saved.diffCommit?.hash)
          ) {
            restoredTabs[saved.groupKey] = [
              ...existing,
              {
                id: saved.id,
                groupKey: saved.groupKey,
                sessionId: '',
                shellId: 'diff',
                seq: saved.seq || 1,
                paneNo,
                descriptor: saved.descriptor || '差异',
                custom: saved.custom,
                cwd: group.path,
                diffChange: saved.diffChange?.path ? saved.diffChange : undefined,
                diffCommit: saved.diffCommit?.hash ? saved.diffCommit : undefined,
                exited: false,
              },
            ];
            continue;
          }
```

`desktop/session.js` 的 `normalizeTab` 返回对象中，`diffChange: ...` 之后新增：

```js
    diffCommit:
      value.diffCommit && typeof value.diffCommit === 'object' && value.diffCommit.hash
        ? {
            hash: String(value.diffCommit.hash).slice(0, 40),
            short: String(value.diffCommit.short || '').slice(0, 40),
            subject: String(value.diffCommit.subject || '').slice(0, 200),
          }
        : null,
```

`src/global.d.ts` 的 `SessionTab` 接口在 `diffChange` 之后新增：

```ts
  diffCommit?: import('./types').CommitRef | null;
```

- [ ] **Step 8: 样式**

`src/styles.css` 在 `.git-history-item:hover` 之后追加：

```css
.git-history-button {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
```

在 diff 相关样式附近追加：

```css
.diff-file-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft);
}

.diff-file-label {
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
}

.diff-file-select {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  font-size: 12px;
}
```

- [ ] **Step 9: 类型检查 + 跑 UI 测试**

Run: `npm run typecheck`
Expected: 退出码 0。

Run: `node tests/git-panel.mjs`（先关闭正在运行的 Cmd Toolbox）
Expected: PASS，末尾出现「14. 提交历史打开 diff 页签」全部断言。

- [ ] **Step 10: 提交**

```bash
git add src/types.ts src/global.d.ts src/components/DiffPane.tsx src/components/GitPanel.tsx src/App.tsx desktop/session.js src/styles.css tests/git-panel.mjs
git commit -m "feat(git): 提交历史可打开 diff 页签并按文件切换"
```

---

### Task 5: 渲染 — 撤销提交、修改提交、收起改动按钮

**Files:**
- Create: `src/components/AmendModal.tsx`
- Modify: `src/components/GitPanel.tsx`（ops 行、确认弹窗、AmendModal）
- Modify: `src/App.tsx`（`headCommit` 状态 + 3 个回调 + 传参）
- Modify: `src/styles.css`（`.git-ops-row`）
- Test: `tests/git-panel.mjs`（追加第 15、16 节）

**Interfaces:**
- Consumes: `window.api.git.headCommit/undoCommit/amend/stashSave`（Task 1、2）
- Produces:
  - `GitPanel` 新 props：`head: HeadCommit | null`、`onUndoCommit(): Promise<string | null>`、`onAmend(message: string): Promise<boolean>`、`onStashSave(): Promise<boolean>`
  - 稳定的测试选择器：`.git-ops-button[data-action="stash" | "undo" | "amend"]`

- [ ] **Step 1: 写失败测试**

`tests/git-panel.mjs` 在「14.」之后继续追加：

```js
console.log('15. 撤销提交');
await click(page.locator('.git-ops-button[data-action="undo"]'));
await page.locator('.modal-card').filter({ hasText: '撤销提交' }).waitFor({ timeout: 8000 });
await click(page.getByRole('button', { name: '确定撤销', exact: true }));
await waitFor(
  async () => (await page.locator('.git-message').inputValue()).includes('历史多文件'),
  '撤销后提交信息回填到输入框',
);
assert(
  execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: repo, encoding: 'utf8' }).trim() !==
    '历史多文件',
  '提交确实被撤销',
);
assert(
  execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' }).includes(
    'history-a.txt',
  ),
  '改动回到暂存区',
);

console.log('16. 修改提交');
// 先重新提交，让 HEAD 恢复存在
await click(page.getByRole('button', { name: '提交', exact: true }));
await waitFor(
  async () => (await page.locator('.git-ops-button[data-action="amend"]').count()) > 0,
  '提交完成',
);
await page.waitForTimeout(800);
await click(page.locator('.git-ops-button[data-action="amend"]'));
await page.locator('#amend-message').waitFor({ timeout: 8000 });
await page.locator('#amend-message').fill('改写后的信息');
await click(page.getByRole('button', { name: '保存修改', exact: true }));
await waitFor(
  async () =>
    execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: repo, encoding: 'utf8' }).trim() ===
    '改写后的信息',
  '提交信息已更新',
);
```

- [ ] **Step 2: 运行确认失败**

Run: `node tests/git-panel.mjs`
Expected: FAIL，等待超时（`.git-ops-button` 不存在）。

- [ ] **Step 3: 新建 AmendModal**

`src/components/AmendModal.tsx`：

```tsx
import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { Modal } from './Modal';

export type AmendModalProps = {
  current: string;
  stagedCount: number;
  pushed: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: (message: string) => Promise<void>;
};

export function AmendModal({
  current,
  stagedCount,
  pushed,
  busy,
  onClose,
  onConfirm,
}: AmendModalProps) {
  const [message, setMessage] = useState(current);
  const [submitting, setSubmitting] = useState(false);
  const canSave = message.trim().length > 0 && !submitting && !busy;

  return (
    <Modal
      title="修改提交"
      subtitle="改写最后一次提交"
      icon={<Pencil size={18} />}
      onClose={onClose}
      closeDisabled={submitting}
    >
      <label className="modal-field">
        <span className="modal-label">提交信息</span>
        <textarea
          id="amend-message"
          className="modal-textarea"
          rows={4}
          value={message}
          spellCheck={false}
          onChange={(event) => setMessage(event.target.value)}
        />
      </label>
      {stagedCount > 0 ? (
        <p className="modal-note">当前 {stagedCount} 项暂存改动会并入这次提交。</p>
      ) : null}
      {pushed ? (
        <p className="modal-warning">这个提交已经推送过，修改后需要强推才能同步远端。</p>
      ) : null}
      <div className="modal-footer">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canSave}
          onClick={async () => {
            setSubmitting(true);
            try {
              await onConfirm(message.trim());
            } finally {
              setSubmitting(false);
            }
          }}
        >
          {submitting ? '保存中…' : '保存修改'}
        </button>
      </div>
    </Modal>
  );
}
```

先确认 `src/styles.css` 里是否已有 `.modal-field` / `.modal-label` / `.modal-textarea` / `.modal-note` / `.modal-warning`：

Run: `grep -n "modal-field\|modal-label\|modal-textarea\|modal-note\|modal-warning" src/styles.css`

缺失的类在 `src/styles.css` 末尾补齐（已有的不要重复定义）：

```css
.modal-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}

.modal-label {
  color: var(--text-secondary);
  font-size: 12px;
}

.modal-textarea {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
}

.modal-note {
  margin: 4px 0;
  color: var(--muted);
  font-size: 12px;
}

.modal-warning {
  margin: 4px 0;
  color: #b45309;
  font-size: 12px;
}
```

- [ ] **Step 4: GitPanel 加 ops 行**

`src/components/GitPanel.tsx`：

1. import 增加 `Archive`, `RotateCcw`, `Pencil` 三个 lucide 图标，以及：

```tsx
import { AmendModal } from './AmendModal';
import type { HeadCommit } from '../types';
```

2. props 类型追加（`onOpenCommit` 已在 Task 4 加过，这里不要重复）：

```ts
  head: HeadCommit | null;
  onUndoCommit: () => Promise<string | null>;
  onAmend: (message: string) => Promise<boolean>;
  onStashSave: () => Promise<boolean>;
```

3. 解构参数追加 `head,`、`onUndoCommit,`、`onAmend,`、`onStashSave,`。

4. 组件内新增状态：

```tsx
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [amendOpen, setAmendOpen] = useState(false);
  const [amendBusy, setAmendBusy] = useState(false);
  const [stashSaving, setStashSaving] = useState(false);
```

5. 在 `<div className={cn('git-panel-body', panelCollapsed && 'is-hidden')}>` 的**第一行**插入：

```tsx
        <div className="git-ops-row">
          <button
            type="button"
            className="btn btn-secondary btn-sm git-ops-button"
            data-action="stash"
            title="把全部未提交改动收进 stash"
            disabled={!status.hasChanges || stashSaving}
            onClick={async () => {
              setStashSaving(true);
              try {
                await onStashSave();
              } finally {
                setStashSaving(false);
              }
            }}
          >
            <Archive size={13} />
            {stashSaving ? '收起中…' : '收起改动'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm git-ops-button"
            data-action="undo"
            title="撤销最后一次提交，改动回到暂存区"
            disabled={!head || undoBusy}
            onClick={() => setConfirmUndo(true)}
          >
            <RotateCcw size={13} />
            {undoBusy ? '撤销中…' : '撤销提交'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm git-ops-button"
            data-action="amend"
            title="修改最后一次提交的信息"
            disabled={!head || amendBusy}
            onClick={() => setAmendOpen(true)}
          >
            <Pencil size={13} />
            修改提交
          </button>
        </div>
```

6. 在渲染 `confirmDiscard` 弹窗的那段旁边新增：

```tsx
      {confirmUndo ? (
        <ConfirmDialog
          title="撤销提交"
          confirmLabel="确定撤销"
          message={
            <>
              <p>撤销最后一次提交？改动会回到暂存区。</p>
              {head?.pushed ? (
                <p className="confirm-note">
                  这个提交已经推送过，撤销后需要强推才能同步远端。
                </p>
              ) : null}
            </>
          }
          onClose={() => setConfirmUndo(false)}
          onConfirm={async () => {
            setConfirmUndo(false);
            setUndoBusy(true);
            try {
              const restored = await onUndoCommit();
              if (restored) {
                setMessage(restored);
                setPhase('idle');
              }
            } finally {
              setUndoBusy(false);
            }
          }}
        />
      ) : null}

      {amendOpen && head ? (
        <AmendModal
          current={head.message}
          stagedCount={status.stagedCount}
          pushed={head.pushed}
          busy={amendBusy}
          onClose={() => setAmendOpen(false)}
          onConfirm={async (next) => {
            setAmendBusy(true);
            try {
              if (await onAmend(next)) setAmendOpen(false);
            } finally {
              setAmendBusy(false);
            }
          }}
        />
      ) : null}
```

- [ ] **Step 5: App 提供 head 状态与三个回调**

`src/App.tsx`，在 `gitCommits` 的 effect 之后新增：

```tsx
  const [headCommit, setHeadCommit] = useState<HeadCommit | null>(null);

  useEffect(() => {
    const group = gitGroupRef.current;
    if (!group) {
      setHeadCommit(null);
      return;
    }
    let cancelled = false;
    void window.api.git
      .headCommit(group.path)
      .then((result) => {
        if (!cancelled) setHeadCommit(result);
      })
      .catch(() => {
        if (!cancelled) setHeadCommit(null);
      });
    return () => {
      cancelled = true;
    };
  }, [gitStatus]);
```

在 `gitCommit` 之后新增：

```tsx
  const gitUndoCommit = useCallback(async (): Promise<string | null> => {
    const group = gitGroupRef.current;
    if (!group) return null;
    try {
      const result = await window.api.git.undoCommit(group.path);
      pushToast('已撤销提交，改动回到暂存区', 'success');
      await refreshGit();
      return result.message;
    } catch (error) {
      pushToast(toErrorMessage(error), 'error');
      return null;
    }
  }, [pushToast, refreshGit]);

  const gitAmend = useCallback(
    async (message: string) => {
      const group = gitGroupRef.current;
      if (!group) return false;
      try {
        const result = await window.api.git.amend(group.path, message);
        pushToast(`已修改提交 ${result.commit}`, 'success');
        await refreshGit();
        return true;
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
        return false;
      }
    },
    [pushToast, refreshGit],
  );

  const gitStashSave = useCallback(async () => {
    const group = gitGroupRef.current;
    if (!group) return false;
    try {
      await window.api.git.stashSave(group.path);
      pushToast('改动已收起', 'success');
      await refreshGit();
      return true;
    } catch (error) {
      pushToast(toErrorMessage(error), 'error');
      return false;
    }
  }, [pushToast, refreshGit]);
```

顶部 import 从 `./types` 补 `HeadCommit`。

`<GitPanel … />` 传参追加：

```tsx
                head={headCommit}
                onUndoCommit={gitUndoCommit}
                onAmend={gitAmend}
                onStashSave={gitStashSave}
```

- [ ] **Step 6: 样式**

`src/styles.css` 的 `.git-actions` 之前追加：

```css
.git-ops-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 10px 8px;
}

.git-ops-button {
  gap: 4px;
  font-size: 11.5px;
}
```

- [ ] **Step 7: 类型检查 + 跑测试**

Run: `npm run typecheck`
Expected: 退出码 0。

Run: `node tests/git-panel.mjs`
Expected: PASS，包含「15. 撤销提交」「16. 修改提交」。

- [ ] **Step 8: 提交**

```bash
git add src/components/AmendModal.tsx src/components/GitPanel.tsx src/App.tsx src/styles.css tests/git-panel.mjs
git commit -m "feat(git): 面板支持撤销提交、修改提交与收起改动"
```

---

### Task 6: 渲染 — 暂存的改动列表

**Files:**
- Modify: `src/components/GitPanel.tsx`（stash 区）
- Modify: `src/App.tsx`（`stashes` 状态 + 恢复/丢弃回调 + 传参）
- Modify: `src/styles.css`
- Test: `tests/git-panel.mjs`（追加第 17 节）

**Interfaces:**
- Consumes: `window.api.git.stashList/stashPop/stashDrop`（Task 2）
- Produces:
  - `GitPanel` 新 props：`stashes: StashEntry[]`、`stashBusy: string | null`、`onStashPop(ref: string): Promise<boolean>`、`onStashDrop(ref: string): Promise<boolean>`

- [ ] **Step 1: 写失败测试**

`tests/git-panel.mjs` 在「16.」之后追加：

```js
console.log('17. 收起与恢复改动');
writeFileSync(join(repo, 'stash-ui.txt'), 's\n');
await page.waitForTimeout(1200);
await click(page.locator('.git-icon-btn'));
await waitFor(
  async () => (await page.locator('.git-change-row').count()) > 0,
  '出现待收起的改动',
);
await click(page.locator('.git-ops-button[data-action="stash"]'));
await waitFor(
  async () => (await page.locator('.git-stash-item').count()) === 1,
  '出现 stash 记录',
);
assert(!existsSync(join(repo, 'stash-ui.txt')), '文件已被收起');

await click(
  page.locator('.git-stash-item').first().locator('.git-row-action[title="恢复"]'),
);
await waitFor(async () => existsSync(join(repo, 'stash-ui.txt')), '恢复后文件回来');
await waitFor(
  async () => (await page.locator('.git-stash-item').count()) === 0,
  '恢复后列表清空',
);
```

- [ ] **Step 2: 运行确认失败**

Run: `node tests/git-panel.mjs`
Expected: FAIL，等待超时于「出现 stash 记录」。

- [ ] **Step 3: 给 useCollapsedSection 增加 setter**

`src/useCollapsedSection.ts` 改为返回第三项 `setCollapsed`（侧栏现有的两处解构不受影响）：

```ts
import { useCallback, useState } from 'react';

const STORAGE_PREFIX = 'cmd-toolbox.sidebar.collapsed.';

function persist(id: string, collapsed: boolean) {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + id, collapsed ? '1' : '0');
  } catch {
    // 存不进去只影响下次启动的展开状态，不值得打断交互
  }
}

export function useCollapsedSection(id: string, defaultCollapsed = false) {
  const [collapsed, setCollapsedState] = useState(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_PREFIX + id);
      return raw === null ? defaultCollapsed : raw === '1';
    } catch {
      return defaultCollapsed;
    }
  });

  const toggle = useCallback(() => {
    setCollapsedState((current) => {
      const next = !current;
      persist(id, next);
      return next;
    });
  }, [id]);

  // 操作成功后自动展开（例如收起改动后显示 stash 列表）
  const setCollapsed = useCallback(
    (next: boolean) => {
      setCollapsedState(next);
      persist(id, next);
    },
    [id],
  );

  return [collapsed, toggle, setCollapsed] as const;
}
```

- [ ] **Step 4: App 提供 stash 状态与回调**

`src/App.tsx`，在 `headCommit` 的 effect 之后新增：

```tsx
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [stashBusy, setStashBusy] = useState<string | null>(null);

  useEffect(() => {
    const group = gitGroupRef.current;
    if (!group) {
      setStashes([]);
      return;
    }
    let cancelled = false;
    void window.api.git
      .stashList(group.path)
      .then((result) => {
        if (!cancelled) setStashes(result.stashes);
      })
      .catch(() => {
        if (!cancelled) setStashes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [gitStatus]);
```

在 `gitStashSave` 之后新增：

```tsx
  const gitStashPop = useCallback(
    async (ref: string) => {
      const group = gitGroupRef.current;
      if (!group) return false;
      setStashBusy(ref);
      try {
        const result = await window.api.git.stashPop(group.path, ref);
        if (result.conflicts.length) {
          pushToast(`恢复后有 ${result.conflicts.length} 处冲突，stash 记录已保留`, 'error');
        } else {
          pushToast('已恢复收起的改动', 'success');
        }
        await refreshGit();
        return true;
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
        return false;
      } finally {
        setStashBusy(null);
      }
    },
    [pushToast, refreshGit],
  );

  const gitStashDrop = useCallback(
    async (ref: string) => {
      const group = gitGroupRef.current;
      if (!group) return false;
      setStashBusy(ref);
      try {
        await window.api.git.stashDrop(group.path, ref);
        pushToast('已丢弃 stash 记录', 'success');
        await refreshGit();
        return true;
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
        return false;
      } finally {
        setStashBusy(null);
      }
    },
    [pushToast, refreshGit],
  );
```

顶部 import 补 `StashEntry`。

`<GitPanel … />` 传参追加：

```tsx
                stashes={stashes}
                stashBusy={stashBusy}
                onStashPop={gitStashPop}
                onStashDrop={gitStashDrop}
```

- [ ] **Step 5: GitPanel 渲染 stash 区**

props 类型追加：

```ts
  stashes: StashEntry[];
  stashBusy: string | null;
  onStashPop: (ref: string) => Promise<boolean>;
  onStashDrop: (ref: string) => Promise<boolean>;
```

import 补 `type { StashEntry }`（与 `HeadCommit` 同一行）。

解构参数追加 `stashes, stashBusy, onStashPop, onStashDrop,`。

组件内折叠状态：

```tsx
  const [stashCollapsed, toggleStash, setStashCollapsed] = useCollapsedSection(
    'git-stash',
    true,
  );
  const [confirmDropStash, setConfirmDropStash] = useState<string | null>(null);
```

同时把 Task 5 里「收起改动」按钮的 `onClick` 换成：

```tsx
            onClick={async () => {
              setStashSaving(true);
              try {
                if (await onStashSave()) setStashCollapsed(false);
              } finally {
                setStashSaving(false);
              }
            }}
```

在 `</div>`（`git-panel-body` 结束）与 `<div className="git-history">` 之间插入：

```tsx
      <div className="git-stash">
        <button
          type="button"
          className="git-group-head git-stash-toggle"
          aria-expanded={!stashCollapsed}
          title={stashCollapsed ? '展开暂存的改动' : '收起暂存的改动'}
          onClick={toggleStash}
        >
          <ChevronRight
            size={12}
            className={cn('section-caret', !stashCollapsed && 'is-open')}
          />
          <span className="git-group-title">暂存的改动</span>
          <span className="git-group-count">{stashes.length}</span>
        </button>
        {stashCollapsed ? null : stashes.length === 0 ? (
          <p className="git-panel-hint">没有收起的改动</p>
        ) : (
          <ul className="git-stash-list">
            {stashes.map((stash) => (
              <li key={stash.ref} className="git-stash-item">
                <span className="git-stash-ref">{stash.ref}</span>
                <span className="git-stash-message" title={stash.message}>
                  {stash.message}
                </span>
                <span className="git-stash-meta">{stash.when}</span>
                <button
                  type="button"
                  className="git-row-action"
                  title="恢复"
                  disabled={stashBusy === stash.ref}
                  onClick={() => void onStashPop(stash.ref)}
                >
                  <Undo2 size={13} />
                </button>
                <button
                  type="button"
                  className="git-row-action"
                  title="丢弃"
                  disabled={stashBusy === stash.ref}
                  onClick={() => setConfirmDropStash(stash.ref)}
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {confirmDropStash ? (
        <ConfirmDialog
          title="丢弃 stash"
          confirmLabel="确定丢弃"
          message={
            <>
              <p>丢弃「{confirmDropStash}」？丢弃后无法恢复。</p>
            </>
          }
          onClose={() => setConfirmDropStash(null)}
          onConfirm={async () => {
            const ref = confirmDropStash;
            setConfirmDropStash(null);
            if (ref) await onStashDrop(ref);
          }}
        />
      ) : null}
```

- [ ] **Step 6: 样式**

`src/styles.css` 在 `.git-history` 规则之前追加：

```css
.git-stash {
  margin-top: 12px;
  padding-top: 6px;
  border-top: 1px solid var(--border);
}

.git-stash-toggle {
  width: 100%;
  border: 0;
  border-radius: 6px;
  background: transparent;
  text-align: left;
}

.git-stash-toggle:hover {
  background: #ececf1;
}

.git-stash-list {
  margin: 4px 0 0;
  padding: 0;
  max-height: 120px;
  overflow-y: auto;
  list-style: none;
}

.git-stash-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 6px;
}

.git-stash-item:hover {
  background: #f2f2f6;
}

.git-stash-ref {
  flex: 0 0 auto;
  color: var(--faint);
  font-size: 10px;
  font-family: "Cascadia Mono", Consolas, monospace;
}

.git-stash-message {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-size: 11.5px;
}

.git-stash-meta {
  flex: 0 0 auto;
  color: var(--faint);
  font-size: 10px;
  white-space: nowrap;
}
```

- [ ] **Step 7: 类型检查 + 跑测试**

Run: `npm run typecheck`
Expected: 退出码 0。

Run: `node tests/git-panel.mjs`
Expected: PASS，包含「17. 收起与恢复改动」。

- [ ] **Step 8: 提交**

```bash
git add src/components/GitPanel.tsx src/App.tsx src/styles.css tests/git-panel.mjs
git commit -m "feat(git): 面板新增暂存的改动列表，可恢复与丢弃"
```

---

### Task 7: 渲染 — 冲突行「解决冲突」与全量回归

**Files:**
- Modify: `src/components/GitPanel.tsx`（冲突分支按钮）
- Modify: `src/styles.css`（`.git-resolve-btn`）
- Test: `tests/git-panel.mjs`（追加第 18 节）

**Interfaces:**
- Consumes: `onOpenInEditor(change)`（既有 prop）
- Produces: 稳定的测试选择器 `.git-resolve-btn`

- [ ] **Step 1: 写失败测试**

`tests/git-panel.mjs` 在「17.」之后、`await page.screenshot(...)` 之前追加：

```js
console.log('18. 冲突行可直接进入编辑器');
// 上一步恢复的未跟踪文件会干扰 checkout，先清干净
rmSync(join(repo, 'stash-ui.txt'), { force: true });
execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['checkout', '-b', 'conflict-a'], { cwd: repo, stdio: 'ignore' });
writeFileSync(join(repo, 'index.php'), '<?php echo "a";\n');
execFileSync('git', ['commit', '-am', 'a 改'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['checkout', 'main'], { cwd: repo, stdio: 'ignore' });
writeFileSync(join(repo, 'index.php'), '<?php echo "b";\n');
execFileSync('git', ['commit', '-am', 'b 改'], { cwd: repo, stdio: 'ignore' });
try {
  execFileSync('git', ['merge', 'conflict-a'], { cwd: repo, stdio: 'ignore' });
} catch {
  // 冲突时 git merge 退出码非零，属预期
}
await page.waitForTimeout(1200);
await click(page.locator('.git-icon-btn'));
await waitFor(
  async () => (await page.locator('.git-resolve-btn').count()) > 0,
  '出现解决冲突按钮',
);
await click(page.locator('.git-resolve-btn').first());
await waitFor(
  async () => (await page.locator('.conflict-bar').count()) > 0,
  '编辑器打开冲突文件并显示工具栏',
);
```

- [ ] **Step 2: 运行确认失败**

Run: `node tests/git-panel.mjs`
Expected: FAIL，等待超时于「出现解决冲突按钮」。

- [ ] **Step 3: 替换冲突分支**

`src/components/GitPanel.tsx` 中：

```tsx
        {conflicted ? (
          <span className="git-conflict-hint" title="冲突需要先在终端解决">
            需在终端解决
          </span>
        ) : staged ? (
```

替换为：

```tsx
        {conflicted ? (
          <button
            type="button"
            className="git-resolve-btn"
            title="在编辑器中解决冲突"
            onClick={() => onOpenInEditor(change)}
          >
            解决冲突
          </button>
        ) : staged ? (
```

- [ ] **Step 4: 样式**

`src/styles.css` 用 `.git-resolve-btn` 替换原来的 `.git-conflict-hint` 规则（原规则只服务于那段被删掉的文本）：

```css
.git-resolve-btn {
  flex: 0 0 auto;
  padding: 2px 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #b45309;
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}

.git-resolve-btn:hover {
  background: #fef3c7;
}
```

- [ ] **Step 5: 跑全量离线测试与类型检查**

Run: `npm run typecheck`
Expected: 退出码 0。

Run: `node tests/updates.mjs`
Expected: PASS。

Run: `node tests/git-core.mjs`
Expected: PASS。

Run: `node tests/commit-diff.mjs`
Expected: PASS。

Run: `node tests/git-pull.mjs`
Expected: PASS。

- [ ] **Step 6: 跑全量 UI 测试**

关闭正在运行的 Cmd Toolbox 后：

Run: `node tests/git-panel.mjs`
Expected: PASS，包含 1 到 18 全部小节。

Run: `node tests/settings.mjs`
Expected: PASS。

- [ ] **Step 7: 手动验证（真实应用）**

Run: `npm run dev`

依次确认：

1. 打开一个有提交历史的项目，展开「最近提交」，点最上面一条 → 出现 `<short> · <subject>` 页签；下拉切换文件时正文变化
2. 改一个文件 → 点「收起改动」→ 变更列表清空，「暂存的改动 (1)」出现一条 → 点恢复 → 文件回来
3. 暂存一个文件后点「修改提交」→ 弹窗预填上一次提交信息，提示「当前 1 项暂存改动会并入这次提交」→ 保存后 `git log -1` 信息已改
4. 点「撤销提交」→ 确认 → 输入框回填原提交信息，文件回到「已暂存」
5. 制造一次合并冲突 → 冲突行显示「解决冲突」→ 点击打开编辑器，冲突块上方有「采用当前 / 采用传入 / 两者都保留」

- [ ] **Step 8: 提交**

```bash
git add src/components/GitPanel.tsx src/styles.css tests/git-panel.mjs
git commit -m "feat(git): 冲突文件可直接跳转编辑器解决"
```

---

## 完成标准

- `npm run typecheck` 退出码 0
- `node tests/git-core.mjs`、`node tests/commit-diff.mjs`、`node tests/git-pull.mjs`、`node tests/updates.mjs` 全部通过
- `node tests/git-panel.mjs`、`node tests/settings.mjs` 全部通过（运行前已关闭应用）
- 手动验证 5 项全部符合预期
- 未新增任何 npm 依赖，未改动 `package.json` 的 `dependencies` / `devDependencies`

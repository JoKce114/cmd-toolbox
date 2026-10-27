# Git 面板：暂存、放弃、分支与合并 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Git 面板支持文件级暂存/取消暂存/放弃、分组批量操作，以及本地分支的切换、新建与合并。

**Architecture:** `GitChange` 从单一 `status` 改为 `indexStatus` / `worktreeStatus` 双状态，`GitStatus` 增加两个计数；`desktop/git.js` 新增 8 个操作函数，经 IPC 暴露；`GitPanel` 改为「已暂存 / 更改」两组列表，分支栏变为弹出菜单，新建分支走 Modal。

**Tech Stack:** Electron 33、React 19、TypeScript、系统 git 2.47（`execFile`）、Playwright

**规格：** `docs/superpowers/specs/2026-10-27-git-panel-staging-branches-design.md`

## Global Constraints

- 项目根目录：`D:\deskTop\CmdToolbox\cmd-toolbox`（git 仓库，基线 `4cb1df7`）
- 所有 Git 调用使用 `execFile('git', args)`，**禁止**拼接 shell 命令字符串
- 路径参数一律先过 `resolveWithin(projectPath, relPath)`（`desktop/path-guard.js` 已存在）
- 未跟踪文件的删除用 `fs/promises.rm`，逐个删除，不走 `git clean`
- 所有 IPC 经 `assertProjectPath` 白名单（`desktop/main.js` 已存在）
- 超时：status/commit/init/diff/stage/unstage/discard/branches/checkout/merge 15 秒，push 120 秒
- 不引入新依赖
- 文案中文，2 空格缩进，单引号，`cn()` 拼类名，`toErrorMessage()` 转错误
- 构建验证：`npm run typecheck && npx vite build`（**不要** `npm run build`）
- e2e 若因端口 17382 被占用而超时，用隔离副本（见下方「e2e 运行方法」）

## e2e 运行方法（每个涉及 Electron 的测试都适用）

`tests/*.mjs` 直接 `node` 运行会占用 17382 端口；用户可能开着应用。做法：

1. 创建临时目录，复制 `desktop/`、`dist/`、`build/`、`package.json`，把 `node_modules` 用目录联接指回原处
2. 把副本 `desktop/pane-api.js` 的 `DEFAULT_PORT` 改成 17997
3. 注释掉副本 `desktop/main.js` 中的 `mcpConfig.installGlobal(mcp);`
4. 用 `sed` 生成测试副本，把 `cwd: root` 改成 `cwd: <副本>`
5. 运行副本测试；跑完删除临时目录

**绝不**杀掉用户正在运行的进程。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `desktop/git.js` | 新增 stage/unstage/discard/stageAll/discardAll/branches/checkout/createBranch/merge；`parseStatus` 改双状态；`commit` 移除自动 add |
| `desktop/main.js` | 注册 8 个 IPC |
| `desktop/preload.js` | 暴露新 API |
| `src/types.ts` | `GitChange` 改双状态、`GitStatus` 加计数、新增 `BranchInfo` |
| `src/global.d.ts` | 补类型 |
| `src/components/GitPanel.tsx` | 分组列表、行内图标、分支栏按钮 |
| `src/components/BranchMenu.tsx` | 新增，分支列表（切换 / 合并 / 新建入口） |
| `src/components/NewBranchModal.tsx` | 新增，分支名 + 起点分支 |
| `src/App.tsx` | 注入新回调、分支状态 |
| `src/styles.css` | 分组标题、行内图标、分支按钮样式 |
| `tests/git-core.mjs` | 新增暂存/放弃/分支场景 |
| `tests/git-panel.mjs` | 新增交互场景 |

---

### Task 1: 双状态模型与暂存/放弃

**Files:**
- Modify: `desktop/git.js`
- Modify: `src/types.ts`
- Modify: `src/components/GitPanel.tsx`（最小改动，保持可编译）
- Test: `tests/git-core.mjs`

**Interfaces:**
- Consumes: `resolveWithin`（`desktop/path-guard.js`）
- Produces:
  - `GitChange = { path: string; origPath?: string; indexStatus: GitChangeStatus | null; worktreeStatus: GitChangeStatus | null }`
  - `GitStatus` 增加 `stagedCount: number` / `unstagedCount: number`
  - `git.stage(projectPath, paths)`, `git.unstage(projectPath, paths)`, `git.discard(projectPath, { tracked, untracked })`, `git.stageAll(projectPath)`, `git.discardAll(projectPath)`，均返回 `Promise<{ ok: true }>`
  - `git.commit(projectPath, message)` 不再自动 `git add -A`

- [ ] **Step 1: 更新测试到双状态模型并新增暂存场景**

把 `tests/git-core.mjs` 中所有 `c.status ===` 的断言改到新字段。原第 3 组末尾追加：

```js
console.log('3b. 双状态字段');
const dual = await git.status(repo);
const phpChange = dual.changes.find((c) => c.path === 'index.php');
assert(phpChange.indexStatus === null && phpChange.worktreeStatus === 'untracked', '未跟踪文件只有工作区状态');
assert(dual.stagedCount === 0 && dual.unstagedCount === 2, '计数按双状态统计');
```

把原第 4 组「提交」改为先暂存再提交：

```js
console.log('4. 暂存后提交');
await git.stage(repo, ['index.php', '中文 文件.txt']);
const staged = await git.status(repo);
assert(staged.stagedCount === 2 && staged.unstagedCount === 0, '暂存后两个文件进入暂存区');
const result = await git.commit(repo, '首次提交');
assert(result.summary === '首次提交', '返回提交摘要');
const logged = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: repo, encoding: 'utf8' }).trim();
assert(logged === '首次提交', 'git log 中的提交信息一致');
const afterCommit = await git.status(repo);
assert(afterCommit.hasChanges === false, '提交后工作区干净');
```

原第 5 组改为验证同时有暂存与工作区改动，并在其后追加取消暂存与放弃：

```js
console.log('5. 同时有暂存与工作区改动');
writeFileSync(join(repo, 'index.php'), '<?php echo 2;\n');
await git.stage(repo, ['index.php']);
writeFileSync(join(repo, 'index.php'), '<?php echo 3;\n');
const mixed = await git.status(repo);
const mixedChange = mixed.changes.find((c) => c.path === 'index.php');
assert(mixedChange.indexStatus === 'modified' && mixedChange.worktreeStatus === 'modified', '同一文件两处状态都在');
assert(mixed.stagedCount === 1 && mixed.unstagedCount === 1, '两个计数都计入该文件');

console.log('5b. 取消暂存');
await git.unstage(repo, ['index.php']);
const unstaged = await git.status(repo);
const unstagedChange = unstaged.changes.find((c) => c.path === 'index.php');
assert(unstagedChange.indexStatus === null, '取消暂存后暂存区状态为空');
assert(unstagedChange.worktreeStatus === 'modified', '工作区改动保留');

console.log('5c. 放弃已跟踪文件的修改');
await git.discard(repo, { tracked: ['index.php'], untracked: [] });
assert(readFileSync(join(repo, 'index.php'), 'utf8') === '<?php echo 1;\n', '内容恢复到已提交版本');

console.log('5d. 放弃未跟踪文件等于删除');
writeFileSync(join(repo, 'scratch.txt'), 'x\n');
await git.discard(repo, { tracked: [], untracked: ['scratch.txt'] });
assert(!existsSync(join(repo, 'scratch.txt')), '未跟踪文件已删除');

console.log('5e. 全部暂存与全部放弃');
writeFileSync(join(repo, 'index.php'), '<?php echo 4;\n');
await git.stageAll(repo);
const allStaged = await git.status(repo);
assert(allStaged.unstagedCount === 0 && allStaged.stagedCount >= 1, '全部暂存后工作区无改动');
await git.discardAll(repo);
const allDiscarded = await git.status(repo);
assert(allDiscarded.hasChanges === false, '全部放弃后工作区干净');
```

原第 6 组「空提交信息」保留。原第 7 组推送无上游保留。原第 8/9/10/11 组保留。

文件顶部 import 补 `readFileSync` 与 `existsSync`：

```js
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/git-core.mjs`
Expected: FAIL，`git.stage is not a function`

- [ ] **Step 3: 改 `parseStatus` 为双状态**

把 `desktop/git.js` 中的 `TYPE_BY_CHAR` / `mapStatus` / `parseStatus` 整体替换为：

```js
const TYPE_BY_CHAR = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'added',
  T: 'modified',
};

// XY 两位：X 是暂存区状态，Y 是工作区状态，'.' 表示该侧无变化
function statusFromChar(char) {
  if (!char || char === '.' || char === ' ') return null;
  return TYPE_BY_CHAR[char] || 'modified';
}

function parseStatus(raw) {
  const parts = raw.split('\0');
  const changes = [];
  let branch = '';
  let upstream = '';
  let ahead = 0;
  let behind = 0;

  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (!entry) continue;

    if (entry.startsWith('# branch.head ')) {
      branch = entry.slice('# branch.head '.length).trim();
      if (branch === '(detached)') branch = '游离 HEAD';
      continue;
    }
    if (entry.startsWith('# branch.upstream ')) {
      upstream = entry.slice('# branch.upstream '.length).trim();
      continue;
    }
    if (entry.startsWith('# branch.ab ')) {
      const match = entry.match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (entry.startsWith('# ')) continue;

    if (entry.startsWith('? ')) {
      changes.push({ path: entry.slice(2), indexStatus: null, worktreeStatus: 'untracked' });
      continue;
    }
    if (entry.startsWith('! ')) continue;
    if (entry.startsWith('u ')) {
      const fields = entry.split(' ');
      changes.push({
        path: fields.slice(10).join(' '),
        indexStatus: 'conflicted',
        worktreeStatus: 'conflicted',
      });
      continue;
    }
    if (entry.startsWith('1 ')) {
      const fields = entry.split(' ');
      const xy = fields[1] || '..';
      changes.push({
        path: fields.slice(8).join(' '),
        indexStatus: statusFromChar(xy[0]),
        worktreeStatus: statusFromChar(xy[1]),
      });
      continue;
    }
    if (entry.startsWith('2 ')) {
      const fields = entry.split(' ');
      const xy = fields[1] || '..';
      const origPath = parts[index + 1] || '';
      index += 1;
      changes.push({
        path: fields.slice(9).join(' '),
        origPath,
        indexStatus: statusFromChar(xy[0]),
        worktreeStatus: statusFromChar(xy[1]),
      });
      continue;
    }
  }

  return {
    ok: true,
    branch,
    upstream,
    ahead,
    behind,
    changes,
    hasChanges: changes.length > 0,
    stagedCount: changes.filter((change) => change.indexStatus !== null).length,
    unstagedCount: changes.filter((change) => change.worktreeStatus !== null).length,
  };
}
```

- [ ] **Step 4: `commit` 移除自动暂存**

把 `commit` 里这两行删掉：

```js
  const add = await runGit(projectPath, ['add', '-A']);
  if (!add.ok) throw new Error(cleanError(add.error, add.stderr));
```

并把无变更的判断改为：

```js
    if (/nothing to commit|no changes added/i.test(`${result.stdout}${result.stderr}`)) {
      throw new Error('没有已暂存的内容可提交');
    }
```

- [ ] **Step 5: 新增暂存与放弃函数**

在 `commit` 之后加入：

```js
async function stage(projectPath, paths) {
  const list = (Array.isArray(paths) ? paths : []).filter(Boolean);
  if (!list.length) return { ok: true };
  list.forEach((item) => resolveWithin(projectPath, item));
  const result = await runGit(projectPath, ['add', '--', ...list]);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  return { ok: true };
}

async function unstage(projectPath, paths) {
  const list = (Array.isArray(paths) ? paths : []).filter(Boolean);
  if (!list.length) return { ok: true };
  list.forEach((item) => resolveWithin(projectPath, item));
  const result = await runGit(projectPath, ['restore', '--staged', '--', ...list]);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  return { ok: true };
}

async function discard(projectPath, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const tracked = (Array.isArray(input.tracked) ? input.tracked : []).filter(Boolean);
  const untracked = (Array.isArray(input.untracked) ? input.untracked : []).filter(Boolean);

  if (tracked.length) {
    tracked.forEach((item) => resolveWithin(projectPath, item));
    const result = await runGit(projectPath, ['restore', '--', ...tracked]);
    if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  }

  for (const item of untracked) {
    const target = resolveWithin(projectPath, item);
    await fsp.rm(target, { force: true });
  }

  return { ok: true };
}

async function stageAll(projectPath) {
  const result = await runGit(projectPath, ['add', '-A']);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  return { ok: true };
}

async function discardAll(projectPath) {
  // 先清空暂存区再丢弃工作区改动，否则已暂存的新增文件会残留
  const unstageResult = await runGit(projectPath, ['restore', '--staged', '.']);
  if (!unstageResult.ok) throw new Error(cleanError(unstageResult.error, unstageResult.stderr));

  const restoreResult = await runGit(projectPath, ['restore', '.']);
  if (!restoreResult.ok) throw new Error(cleanError(restoreResult.error, restoreResult.stderr));

  // 未跟踪文件没有被 restore 覆盖，需要逐个删除
  const current = await status(projectPath);
  if (current.ok) {
    for (const change of current.changes) {
      if (change.worktreeStatus !== 'untracked') continue;
      await fsp.rm(resolveWithin(projectPath, change.path), { force: true });
    }
  }

  return { ok: true };
}
```

文件顶部 `path` 之后补两个 require：

```js
const fsp = require('fs/promises');
const { resolveWithin } = require('./path-guard');
```

（`resolveWithin` 可能已存在，存在则跳过这行。）

导出改为：

```js
module.exports = {
  status,
  commit,
  push,
  init,
  diffCommand,
  stage,
  unstage,
  discard,
  stageAll,
  discardAll,
};
```

- [ ] **Step 6: 改类型**

`src/types.ts` 的 `GitChange` 替换为：

```ts
export type GitChange = {
  path: string;
  origPath?: string;
  indexStatus: GitChangeStatus | null;
  worktreeStatus: GitChangeStatus | null;
};
```

`GitStatus` 的成功分支加：

```ts
      stagedCount: number;
      unstagedCount: number;
```

- [ ] **Step 7: 让 GitPanel 编译通过**

`src/components/GitPanel.tsx` 中，把 `change.status` 的两处用法改为：

```tsx
const displayStatus = change.indexStatus ?? change.worktreeStatus ?? 'modified';
```

在 `map` 回调内声明该常量，并用于 `STATUS_LABEL[displayStatus]` 与 `` `is-${displayStatus}` ``；点击分支判断改为 `change.worktreeStatus !== 'deleted'`。

- [ ] **Step 8: 运行测试**

Run: `node tests/git-core.mjs`
Expected: 全部通过
Run: `npm run typecheck`
Expected: 通过

- [ ] **Step 9: 提交**

```bash
git add desktop/git.js src/types.ts src/components/GitPanel.tsx tests/git-core.mjs
git commit -m "feat(git): track index and worktree status separately, add staging operations"
```

---

### Task 2: 分支与合并

**Files:**
- Modify: `desktop/git.js`
- Test: `tests/git-core.mjs`

**Interfaces:**
- Consumes: Task 1 的 `runGit` / `cleanError`
- Produces:
  - `git.branches(projectPath) => Promise<{ current: string; list: string[] }>`
  - `git.checkout(projectPath, branch) => Promise<{ ok: true }>`
  - `git.createBranch(projectPath, name, startPoint) => Promise<{ ok: true }>`
  - `git.merge(projectPath, branch) => Promise<{ ok: true; conflicted: string[] }>`

- [ ] **Step 1: 写失败的测试**

在 `tests/git-core.mjs` 末尾（`全部通过` 那行之前）追加：

```js
console.log('12. 分支列表与切换');
const branchInfo = await git.branches(repo);
assert(branchInfo.current === 'main', '当前分支为 main');
assert(branchInfo.list[0] === 'main', '当前分支置顶');
await git.createBranch(repo, 'feature-a', 'main');
const afterCreate = await git.branches(repo);
assert(afterCreate.current === 'feature-a', '新建后立即切换');
assert(afterCreate.list.includes('main') && afterCreate.list.includes('feature-a'), '两个分支都在列表');

writeFileSync(join(repo, 'a.txt'), 'feature\n');
await git.stageAll(repo);
await git.commit(repo, 'feature 提交');
await git.checkout(repo, 'main');
const backToMain = await git.branches(repo);
assert(backToMain.current === 'main', '切回 main');

console.log('13. 合并');
const mergeResult = await git.merge(repo, 'feature-a');
assert(mergeResult.ok === true && mergeResult.conflicted.length === 0, '无冲突合并成功');
assert(existsSync(join(repo, 'a.txt')), '合并后文件出现');

console.log('14. 合并冲突不抛错');
await git.checkout(repo, 'feature-a');
writeFileSync(join(repo, 'a.txt'), 'feature 版本\n');
await git.stageAll(repo);
await git.commit(repo, 'feature 改 a');
await git.checkout(repo, 'main');
writeFileSync(join(repo, 'a.txt'), 'main 版本\n');
await git.stageAll(repo);
await git.commit(repo, 'main 改 a');
const conflictResult = await git.merge(repo, 'feature-a');
assert(conflictResult.conflicted.includes('a.txt'), '返回冲突文件列表');
const afterConflict = await git.status(repo);
assert(
  afterConflict.changes.some((c) => c.path === 'a.txt' && c.indexStatus === 'conflicted'),
  '状态中标记为冲突',
);
execFileSync('git', ['merge', '--abort'], { cwd: repo });

console.log('15. 分支名校验');
let badName = '';
try {
  await git.createBranch(repo, 'bad name', 'main');
} catch (error) {
  badName = error.message;
}
assert(badName.length > 0, '非法分支名被拒绝');
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/git-core.mjs`
Expected: FAIL，`git.branches is not a function`

- [ ] **Step 3: 实现分支函数**

在 `discardAll` 之后加入：

```js
const BRANCH_NAME = /^(?!.*\.\.)(?!.*\s)[^\x00-\x20~^:?*\[\\]+$/;

function assertBranchName(name) {
  const value = String(name || '').trim();
  if (!value) throw new Error('请填写分支名');
  if (value.length > 100) throw new Error('分支名过长');
  if (!BRANCH_NAME.test(value)) throw new Error('分支名包含不允许的字符');
  if (value.startsWith('/') || value.endsWith('/') || value.endsWith('.lock')) {
    throw new Error('分支名格式不合法');
  }
  return value;
}

async function branches(projectPath) {
  const result = await runGit(projectPath, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
  ]);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));

  const head = await runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const current = head.ok ? head.stdout.trim() : '';

  const all = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const list = current && all.includes(current)
    ? [current, ...all.filter((item) => item !== current).sort()]
    : all.sort();

  return { current, list };
}

async function checkout(projectPath, branch) {
  const name = assertBranchName(branch);
  const result = await runGit(projectPath, ['checkout', name]);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  return { ok: true };
}

async function createBranch(projectPath, name, startPoint) {
  const branchName = assertBranchName(name);
  const base = startPoint ? assertBranchName(startPoint) : '';
  const args = base
    ? ['checkout', '-b', branchName, base]
    : ['checkout', '-b', branchName];
  const result = await runGit(projectPath, args);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  return { ok: true };
}

async function merge(projectPath, branch) {
  const name = assertBranchName(branch);
  const result = await runGit(projectPath, ['merge', name]);
  if (result.ok) return { ok: true, conflicted: [] };

  const conflicted = [
    ...new Set(
      `${result.stdout}\n${result.stderr}`
        .split('\n')
        .map((line) => line.match(/Merge conflict in (.+)$/))
        .filter(Boolean)
        .map((match) => match[1].trim()),
    ),
  ];
  if (conflicted.length) return { ok: true, conflicted };

  throw new Error(cleanError(result.error, result.stderr));
}
```

导出追加：

```js
module.exports = {
  status,
  commit,
  push,
  init,
  diffCommand,
  stage,
  unstage,
  discard,
  stageAll,
  discardAll,
  branches,
  checkout,
  createBranch,
  merge,
};
```

文件顶部 import 已含 `execFileSync` 的不需要改；`tests/git-core.mjs` 需要 `execFileSync`（已有）。

- [ ] **Step 4: 运行测试**

Run: `node tests/git-core.mjs`
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add desktop/git.js tests/git-core.mjs
git commit -m "feat(git): add branch listing, checkout, creation and merge"
```

---

### Task 3: IPC 与类型

**Files:**
- Modify: `desktop/main.js`
- Modify: `desktop/preload.js`
- Modify: `src/global.d.ts`
- Test: `tests/git-ipc.mjs`

**Interfaces:**
- Consumes: Task 1/2 的 git.js 导出
- Produces: `window.api.git` 增加 `stage/unstage/discard/stageAll/discardAll/branches/checkout/createBranch/merge`

- [ ] **Step 1: 写失败的测试**

在 `tests/git-ipc.mjs` 末尾（`app.close()` 之前）追加：

```js
const staged = await page.evaluate((p) => window.api.git.stage(p, ['a.txt']), repo);
assert(staged.ok === true, 'IPC 暂存');
const afterStage = await page.evaluate((p) => window.api.git.status(p), repo);
assert(afterStage.stagedCount === 1, '暂存后计数正确');

await page.evaluate((p) => window.api.git.unstage(p, ['a.txt']), repo);
const afterUnstage = await page.evaluate((p) => window.api.git.status(p), repo);
assert(afterUnstage.stagedCount === 0, '取消暂存生效');

const branchList = await page.evaluate((p) => window.api.git.branches(p), repo);
assert(branchList.current === 'main', 'IPC 返回当前分支');

let badName = '';
try {
  await page.evaluate((p) => window.api.git.createBranch(p, 'bad name', 'main'), repo);
} catch (error) {
  badName = error.message;
}
assert(badName.length > 0, 'IPC 拒绝非法分支名');
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/git-ipc.mjs`（用隔离副本，见开头的 e2e 运行方法）
Expected: FAIL，`window.api.git.stage is not a function`

- [ ] **Step 3: 注册 IPC**

在 `desktop/main.js` 的 `git:diff` handler 之后插入：

```js
  ipcMain.handle('git:stage', (_event, projectPath, paths) =>
    git.stage(assertProjectPath(projectPath), paths),
  );

  ipcMain.handle('git:unstage', (_event, projectPath, paths) =>
    git.unstage(assertProjectPath(projectPath), paths),
  );

  ipcMain.handle('git:discard', (_event, projectPath, payload) =>
    git.discard(assertProjectPath(projectPath), payload),
  );

  ipcMain.handle('git:stage-all', (_event, projectPath) =>
    git.stageAll(assertProjectPath(projectPath)),
  );

  ipcMain.handle('git:discard-all', (_event, projectPath) =>
    git.discardAll(assertProjectPath(projectPath)),
  );

  ipcMain.handle('git:branches', (_event, projectPath) =>
    git.branches(assertProjectPath(projectPath)),
  );

  ipcMain.handle('git:checkout', (_event, projectPath, branch) =>
    git.checkout(assertProjectPath(projectPath), branch),
  );

  ipcMain.handle('git:create-branch', (_event, projectPath, name, startPoint) =>
    git.createBranch(assertProjectPath(projectPath), name, startPoint),
  );

  ipcMain.handle('git:merge', (_event, projectPath, branch) =>
    git.merge(assertProjectPath(projectPath), branch),
  );
```

- [ ] **Step 4: 暴露到 preload**

`desktop/preload.js` 的 `git:` 段内，`diff` 之后加入：

```js
    stage: (projectPath, paths) => invoke('git:stage', projectPath, paths),
    unstage: (projectPath, paths) => invoke('git:unstage', projectPath, paths),
    discard: (projectPath, payload) => invoke('git:discard', projectPath, payload),
    stageAll: (projectPath) => invoke('git:stage-all', projectPath),
    discardAll: (projectPath) => invoke('git:discard-all', projectPath),
    branches: (projectPath) => invoke('git:branches', projectPath),
    checkout: (projectPath, branch) => invoke('git:checkout', projectPath, branch),
    createBranch: (projectPath, name, startPoint) =>
      invoke('git:create-branch', projectPath, name, startPoint),
    merge: (projectPath, branch) => invoke('git:merge', projectPath, branch),
```

- [ ] **Step 5: 补类型**

`src/global.d.ts` 的 `git` 段内、`diff` 之后加入：

```ts
        stage: (projectPath: string, paths: string[]) => Promise<{ ok: true }>;
        unstage: (projectPath: string, paths: string[]) => Promise<{ ok: true }>;
        discard: (
          projectPath: string,
          payload: { tracked: string[]; untracked: string[] },
        ) => Promise<{ ok: true }>;
        stageAll: (projectPath: string) => Promise<{ ok: true }>;
        discardAll: (projectPath: string) => Promise<{ ok: true }>;
        branches: (projectPath: string) => Promise<{ current: string; list: string[] }>;
        checkout: (projectPath: string, branch: string) => Promise<{ ok: true }>;
        createBranch: (
          projectPath: string,
          name: string,
          startPoint: string,
        ) => Promise<{ ok: true }>;
        merge: (
          projectPath: string,
          branch: string,
        ) => Promise<{ ok: true; conflicted: string[] }>;
```

- [ ] **Step 6: 验证**

Run: `npm run typecheck && npx vite build`
Run: `node tests/git-ipc.mjs`（隔离副本）
Expected: 均通过

- [ ] **Step 7: 提交**

```bash
git add desktop/main.js desktop/preload.js src/global.d.ts tests/git-ipc.mjs
git commit -m "feat(git): expose staging and branch operations over IPC"
```

---

### Task 4: 分组列表与行内操作

**Files:**
- Modify: `src/components/GitPanel.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: Task 3 的 API
- Produces: `GitPanel` 新增 props：
  - `onStage(paths: string[]): Promise<boolean>`
  - `onUnstage(paths: string[]): Promise<boolean>`
  - `onDiscard(payload: { tracked: string[]; untracked: string[] }): Promise<boolean>`
  - `onStageAll(): Promise<boolean>`
  - `onDiscardAll(): Promise<boolean>`

- [ ] **Step 1: 扩展 props 与本地状态**

`GitPanelProps` 加入上面五个回调。组件内加入：

```tsx
  const [busyPaths, setBusyPaths] = useState<Set<string>>(new Set());
  const [groupBusy, setGroupBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<
    | { kind: 'single'; change: GitChange }
    | { kind: 'all' }
    | null
  >(null);

  const runPathAction = async (key: string, action: () => Promise<boolean>) => {
    setBusyPaths((previous) => new Set(previous).add(key));
    try {
      await action();
    } finally {
      setBusyPaths((previous) => {
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
    }
  };

  const runGroupAction = async (action: () => Promise<boolean>) => {
    setGroupBusy(true);
    try {
      await action();
    } finally {
      setGroupBusy(false);
    }
  };
```

- [ ] **Step 2: 拆出两个分组**

把现有单一 `<ul className="git-change-list">` 替换为：

```tsx
      {stagedChanges.length > 0 ? (
        <div className="git-group">
          <div className="git-group-head">
            <span className="git-group-title">已暂存</span>
            <span className="git-group-count">{stagedChanges.length}</span>
            <button
              type="button"
              className="git-group-action"
              title="全部取消暂存"
              disabled={groupBusy}
              onClick={() =>
                void runGroupAction(() => onUnstage(stagedChanges.map((c) => c.path)))
              }
            >
              <Undo2 size={13} />
            </button>
          </div>
          <ul className="git-change-list">
            {stagedChanges.map((change) => renderRow(change, true))}
          </ul>
        </div>
      ) : null}

      {unstagedChanges.length > 0 ? (
        <div className="git-group">
          <div className="git-group-head">
            <span className="git-group-title">更改</span>
            <span className="git-group-count">{unstagedChanges.length}</span>
            <button
              type="button"
              className="git-group-action"
              title="全部放弃"
              disabled={groupBusy}
              onClick={() => setConfirmDiscard({ kind: 'all' })}
            >
              <Trash2 size={13} />
            </button>
            <button
              type="button"
              className="git-group-action"
              title="全部暂存"
              disabled={groupBusy}
              onClick={() => void runGroupAction(() => onStageAll())}
            >
              <Plus size={13} />
            </button>
          </div>
          <ul className="git-change-list">
            {unstagedChanges.map((change) => renderRow(change, false))}
          </ul>
        </div>
      ) : null}
```

在 return 之前计算：

```tsx
  const stagedChanges = status.ok ? status.changes.filter((c) => c.indexStatus !== null) : [];
  const unstagedChanges = status.ok ? status.changes.filter((c) => c.worktreeStatus !== null) : [];
```

注意 `status.ok` 在早返回分支之后才有意义，因此这段放在「成功分支」内、`return` 之前，并用 `status.changes` 直接访问。

- [ ] **Step 3: 行渲染函数**

在 return 之前加入：

```tsx
  const renderRow = (change: GitChange, staged: boolean) => {
    const display = staged ? change.indexStatus : change.worktreeStatus;
    const badge = display ?? 'modified';
    const busy = busyPaths.has(change.path);

    return (
      <li key={`${staged ? 's' : 'w'}:${change.path}`} className="git-change-item">
        <button
          type="button"
          className="git-change-row"
          title={change.origPath ? `${change.origPath} → ${change.path}` : change.path}
          onClick={() =>
            change.worktreeStatus === 'deleted' ? onOpenDiff(change) : onOpenInEditor(change)
          }
        >
          <span className={cn('git-change-badge', `is-${badge}`)}>{STATUS_LABEL[badge]}</span>
          <span className="git-change-path">
            {change.origPath ? `${change.origPath} → ${change.path}` : change.path}
          </span>
        </button>

        {staged ? (
          <button
            type="button"
            className="git-row-action"
            title="取消暂存"
            disabled={busy}
            onClick={() => void runPathAction(change.path, () => onUnstage([change.path]))}
          >
            <Undo2 size={13} />
          </button>
        ) : (
          <>
            <button
              type="button"
              className="git-row-action"
              title="放弃修改"
              disabled={busy}
              onClick={() => setConfirmDiscard({ kind: 'single', change })}
            >
              <Trash2 size={13} />
            </button>
            <button
              type="button"
              className="git-row-action"
              title="暂存"
              disabled={busy}
              onClick={() => void runPathAction(change.path, () => onStage([change.path]))}
            >
              <Plus size={13} />
            </button>
          </>
        )}
      </li>
    );
  };
```

`lucide-react` import 改为：

```tsx
import { ArrowUp, Check, FileDiff, Plus, RefreshCw, Trash2, Undo2 } from 'lucide-react';
```

- [ ] **Step 4: 放弃确认框**

在组件返回的 `<section>` 末尾、`</section>` 之前加入：

```tsx
      {confirmDiscard ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card editor-confirm">
            <p className="confirm-message">{discardMessage}</p>
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirmDiscard(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const target = confirmDiscard;
                  setConfirmDiscard(null);
                  if (target.kind === 'all') void runGroupAction(() => onDiscardAll());
                  else {
                    const change = target.change;
                    const tracked = change.worktreeStatus === 'untracked' ? [] : [change.path];
                    const untracked = change.worktreeStatus === 'untracked' ? [change.path] : [];
                    void runPathAction(change.path, () => onDiscard({ tracked, untracked }));
                  }
                }}
              >
                确定放弃
              </button>
            </div>
          </div>
        </div>
      ) : null}
```

并在其上计算文案：

```tsx
  const discardMessage =
    confirmDiscard?.kind === 'all'
      ? `放弃全部 ${unstagedChanges.length} 项修改？其中未跟踪文件将被删除。此操作无法撤销。`
      : confirmDiscard
        ? confirmDiscard.change.worktreeStatus === 'untracked'
          ? `删除未跟踪文件「${confirmDiscard.change.path}」？此操作无法撤销。`
          : `放弃对「${confirmDiscard.change.path}」的修改？此操作无法撤销。`
        : '';
```

- [ ] **Step 5: 提交按钮改用 stagedCount**

`canCommit` 改为：

```tsx
  const canCommit =
    phase === 'idle' && messageFilled && Boolean(status?.ok && status.stagedCount > 0);
```

「没有变更」提示改为三种：两组都为空时显示「没有变更」；有未暂存但无已暂存时，提交按钮禁用且输入框仍显示。把原来 `status.hasChanges || phase === 'committed'` 的条件改为 `status.hasChanges || phase === 'committed'`（不变），但按钮禁用逻辑由 `canCommit` 覆盖。

- [ ] **Step 6: App 接线（暂存相关）**

`src/App.tsx` 中 `gitInit` 之后加入：

```tsx
  const withGitGroup = useCallback(
    async (action: (path: string) => Promise<unknown>, successMessage = '') => {
      const group = gitGroupRef.current;
      if (!group) return false;
      try {
        await action(group.path);
        if (successMessage) pushToast(successMessage, 'success');
        await refreshGit();
        return true;
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
        return false;
      }
    },
    [pushToast, refreshGit],
  );

  const gitStage = useCallback(
    (paths: string[]) => withGitGroup((path) => window.api.git.stage(path, paths)),
    [withGitGroup],
  );

  const gitUnstage = useCallback(
    (paths: string[]) => withGitGroup((path) => window.api.git.unstage(path, paths)),
    [withGitGroup],
  );

  const gitDiscard = useCallback(
    (payload: { tracked: string[]; untracked: string[] }) =>
      withGitGroup((path) => window.api.git.discard(path, payload), '已放弃修改'),
    [withGitGroup],
  );

  const gitStageAll = useCallback(
    () => withGitGroup((path) => window.api.git.stageAll(path)),
    [withGitGroup],
  );

  const gitDiscardAll = useCallback(
    () => withGitGroup((path) => window.api.git.discardAll(path), '已放弃全部修改'),
    [withGitGroup],
  );
```

`<GitPanel ... />` 中 `onOpenInEditor` 之后加入：

```tsx
                onStage={gitStage}
                onUnstage={gitUnstage}
                onDiscard={gitDiscard}
                onStageAll={gitStageAll}
                onDiscardAll={gitDiscardAll}
```

- [ ] **Step 7: 样式**

在 `src/styles.css` 的 `.git-change-list` 规则之前插入：

```css
.git-group {
  margin-top: 9px;
}

.git-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px 3px 8px;
}

.git-group-title {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--faint);
}

.git-group-count {
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: #ededf1;
  color: #8b8f98;
  font-size: 9.5px;
}

.git-group-action {
  width: 22px;
  height: 22px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--faint);
}

.git-group-action:first-of-type {
  margin-left: auto;
}

.git-group-action:hover:not(:disabled) {
  background: #ebebef;
  color: var(--text);
}

.git-group-action:disabled {
  opacity: 0.4;
}
```

并把 `.git-change-list` 的 `margin` 改为 `margin: 2px 0 0;`。

- [ ] **Step 8: 验证**

Run: `npm run typecheck && npx vite build`
Expected: 通过
Run: `node tests/git-core.mjs`
Expected: 仍全部通过

- [ ] **Step 9: 提交**

```bash
git add src/components/GitPanel.tsx src/App.tsx src/styles.css
git commit -m "feat(git): group changes by stage state with row actions"
```

---

### Task 5: 分支菜单与 App 接线

**Files:**
- Create: `src/components/BranchMenu.tsx`
- Create: `src/components/NewBranchModal.tsx`
- Modify: `src/components/GitPanel.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: Task 3 的 API、Task 4 的 GitPanel props
- Produces:
  - `BranchMenu` props `{ branches, current, onSelect, onMerge, onCreate, onClose }`
  - `NewBranchModal` props `{ branches, current, onClose, onConfirm(name, startPoint) }`
  - `App` 新增 `gitStage/gitUnstage/gitDiscard/gitStageAll/gitDiscardAll/gitCheckout/gitCreateBranch/gitMerge` 回调

- [ ] **Step 1: 分支菜单组件**

创建 `src/components/BranchMenu.tsx`：

```tsx
import { Check, GitMerge, Plus } from 'lucide-react';
import { cn } from '../lib';

export type BranchMenuProps = {
  branches: string[];
  current: string;
  busy: boolean;
  onSelect: (branch: string) => void;
  onMerge: (branch: string) => void;
  onCreate: () => void;
  onClose: () => void;
};

export function BranchMenu({
  branches,
  current,
  busy,
  onSelect,
  onMerge,
  onCreate,
  onClose,
}: BranchMenuProps) {
  return (
    <div className="branch-menu" role="menu" onMouseDown={(event) => event.stopPropagation()}>
      <div className="branch-menu-list">
        {branches.map((branch) => {
          const isCurrent = branch === current;
          return (
            <div key={branch} className={cn('branch-menu-row', isCurrent && 'is-current')}>
              <button
                type="button"
                className="branch-menu-name"
                role="menuitem"
                disabled={isCurrent || busy}
                title={isCurrent ? '当前分支' : `切换到 ${branch}`}
                onClick={() => {
                  onSelect(branch);
                  onClose();
                }}
              >
                <span className="branch-menu-text">{branch}</span>
                {isCurrent ? <Check size={12} /> : null}
              </button>
              {isCurrent ? null : (
                <button
                  type="button"
                  className="branch-menu-merge"
                  title={`把 ${branch} 合并到 ${current}`}
                  disabled={busy}
                  onClick={() => {
                    onMerge(branch);
                    onClose();
                  }}
                >
                  <GitMerge size={13} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="branch-menu-create"
        role="menuitem"
        disabled={busy}
        onClick={() => {
          onCreate();
          onClose();
        }}
      >
        <Plus size={13} />
        <span>新建分支…</span>
      </button>
    </div>
  );
}
```

- [ ] **Step 2: 新建分支弹窗**

创建 `src/components/NewBranchModal.tsx`：

```tsx
import { useState } from 'react';
import { Modal } from './Modal';

export type NewBranchModalProps = {
  branches: string[];
  current: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (name: string, startPoint: string) => void;
};

export function NewBranchModal({
  branches,
  current,
  busy,
  onClose,
  onConfirm,
}: NewBranchModalProps) {
  const [name, setName] = useState('');
  const [startPoint, setStartPoint] = useState(current);

  const canSubmit = name.trim().length > 0 && !busy;

  return (
    <Modal
      title="新建分支"
      subtitle="从选中分支创建并立即切换过去"
      onClose={onClose}
      closeDisabled={busy}
    >
      <div className="modal-form">
        <label className="field">
          <span className="field-label">分支名称</span>
          <input
            id="new-branch-name"
            value={name}
            autoFocus
            spellCheck={false}
            placeholder="feature/新功能"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canSubmit) onConfirm(name.trim(), startPoint);
            }}
          />
        </label>

        <label className="field">
          <span className="field-label">起点分支</span>
          <select
            id="new-branch-start"
            value={startPoint}
            onChange={(event) => setStartPoint(event.target.value)}
          >
            {branches.map((branch) => (
              <option key={branch} value={branch}>
                {branch}
              </option>
            ))}
          </select>
        </label>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canSubmit}
            onClick={() => onConfirm(name.trim(), startPoint)}
          >
            {busy ? '创建中…' : '创建并切换'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 3: GitPanel 分支栏改为按钮**

`GitPanelProps` 加入：

```ts
  branches: string[];
  currentBranch: string;
  branchBusy: boolean;
  onCheckout: (branch: string) => void;
  onCreateBranch: (name: string, startPoint: string) => void;
  onMerge: (branch: string) => void;
```

组件内加入状态：

```tsx
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
```

把现有 `.git-branch-bar` 整块替换为：

```tsx
      <div className="git-branch-bar">
        <button
          type="button"
          className="git-branch-button"
          title="切换或新建分支"
          onClick={() => setBranchMenuOpen((open) => !open)}
        >
          <GitBranch size={12} />
          <span className="git-branch-name">{status.branch || '未知分支'}</span>
          {status.ahead > 0 ? <span className="git-ahead">↑{status.ahead}</span> : null}
          {status.behind > 0 ? <span className="git-behind">↓{status.behind}</span> : null}
        </button>

        {branchMenuOpen ? (
          <BranchMenu
            branches={branches}
            current={currentBranch || status.branch}
            busy={branchBusy}
            onSelect={onCheckout}
            onMerge={onMerge}
            onCreate={() => setNewBranchOpen(true)}
            onClose={() => setBranchMenuOpen(false)}
          />
        ) : null}
      </div>

      {newBranchOpen ? (
        <NewBranchModal
          branches={branches}
          current={currentBranch || status.branch}
          busy={branchBusy}
          onClose={() => setNewBranchOpen(false)}
          onConfirm={(name, startPoint) => {
            setNewBranchOpen(false);
            onCreateBranch(name, startPoint);
          }}
        />
      ) : null}
```

import 补：

```tsx
import { GitBranch } from 'lucide-react';
import { BranchMenu } from './BranchMenu';
import { NewBranchModal } from './NewBranchModal';
```

（`lucide-react` 的 import 合并到现有那一行。）

- [ ] **Step 4: 分支样式**

`src/styles.css` 的 `.git-branch-bar` 规则之后加入：

```css
.git-branch-button {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 2px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 11.5px;
}

.git-branch-button:hover {
  background: #ebebef;
  color: var(--text);
}

.branch-menu {
  margin-top: 4px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface);
  box-shadow: var(--shadow-md);
}

.branch-menu-list {
  max-height: 200px;
  overflow-y: auto;
}

.branch-menu-row {
  display: flex;
  align-items: center;
}

.branch-menu-name {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 7px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11.5px;
  text-align: left;
}

.branch-menu-name:hover:not(:disabled) {
  background: #f2f2f6;
  color: var(--text);
}

.branch-menu-name.is-current,
.branch-menu-row.is-current .branch-menu-name {
  color: var(--text);
  font-weight: 600;
}

.branch-menu-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branch-menu-merge {
  flex: 0 0 22px;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--faint);
  opacity: 0;
}

.branch-menu-row:hover .branch-menu-merge {
  opacity: 1;
}

.branch-menu-merge:hover:not(:disabled) {
  background: #ebebef;
  color: var(--text);
}

.branch-menu-create {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding: 5px 7px;
  border: 0;
  border-top: 1px solid var(--border);
  border-radius: 0 0 6px 6px;
  background: transparent;
  color: var(--accent);
  font-size: 11.5px;
}

.branch-menu-create:hover:not(:disabled) {
  background: #f2f2f6;
}
```

- [ ] **Step 5: App 分支状态与回调**

`src/App.tsx` 的 `useGitStatus` 调用之后加入：

```tsx
  const [gitBranches, setGitBranches] = useState<{ current: string; list: string[] }>({
    current: '',
    list: [],
  });
  const [branchBusy, setBranchBusy] = useState(false);

  useEffect(() => {
    const group = gitGroupRef.current;
    if (!group) {
      setGitBranches({ current: '', list: [] });
      return;
    }
    let cancelled = false;
    void window.api.git
      .branches(group.path)
      .then((result) => {
        if (!cancelled) setGitBranches(result);
      })
      .catch(() => {
        if (!cancelled) setGitBranches({ current: '', list: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [gitStatus]);
```

在 `gitDiscardAll` 之后加入：

```tsx
  const gitCheckout = useCallback(
    async (branch: string) => {
      const group = gitGroupRef.current;
      if (!group) return;
      const dirty = Boolean(
        gitStatus?.ok && (gitStatus.stagedCount > 0 || gitStatus.unstagedCount > 0),
      );
      if (dirty) {
        pushToast('有未提交的改动，请先提交或放弃后再切换分支', 'error');
        return;
      }
      setBranchBusy(true);
      try {
        await window.api.git.checkout(group.path, branch);
        pushToast(`已切换到 ${branch}`, 'success');
        await refreshGit();
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
      } finally {
        setBranchBusy(false);
      }
    },
    [gitStatus, pushToast, refreshGit],
  );

  const gitCreateBranch = useCallback(
    async (name: string, startPoint: string) => {
      const group = gitGroupRef.current;
      if (!group) return;
      setBranchBusy(true);
      try {
        await window.api.git.createBranch(group.path, name, startPoint);
        pushToast(`已创建并切换到 ${name}`, 'success');
        await refreshGit();
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
      } finally {
        setBranchBusy(false);
      }
    },
    [pushToast, refreshGit],
  );

  const gitMerge = useCallback(
    async (branch: string) => {
      const group = gitGroupRef.current;
      if (!group) return;
      setBranchBusy(true);
      try {
        const result = await window.api.git.merge(group.path, branch);
        if (result.conflicted.length > 0) {
          pushToast(`合并 ${branch} 时发生冲突，请到终端处理`, 'error');
        } else {
          pushToast(`已合并 ${branch}`, 'success');
        }
        await refreshGit();
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
      } finally {
        setBranchBusy(false);
      }
    },
    [pushToast, refreshGit],
  );
```

`<GitPanel ... />` 中加入：

```tsx
                branches={gitBranches.list}
                currentBranch={gitBranches.current}
                branchBusy={branchBusy}
                onCheckout={(branch) => void gitCheckout(branch)}
                onCreateBranch={(name, startPoint) => void gitCreateBranch(name, startPoint)}
                onMerge={(branch) => void gitMerge(branch)}
```

`src/App.tsx` 顶部 import 已有 `useState` / `useEffect`；确认 `useState` 在 import 列表中。

- [ ] **Step 6: 验证**

Run: `npm run typecheck && npx vite build`
Expected: 通过
Run: `node tests/git-panel.mjs`（隔离副本）
Expected: 现有 12 项仍通过（部分断言可能因文案变化需要更新，见 Task 6）

- [ ] **Step 7: 提交**

```bash
git add src/components/BranchMenu.tsx src/components/NewBranchModal.tsx src/components/GitPanel.tsx src/App.tsx src/styles.css
git commit -m "feat(git): add branch switcher, creator and merge"
```

---

### Task 6: 端到端测试

**Files:**
- Modify: `tests/git-panel.mjs`

**Interfaces:**
- Consumes: 全部前序任务

- [ ] **Step 1: 更新既有的提交相关断言**

原第 3 组「提交后进入推送态」在提交前需要先暂存。把：

```js
await page.locator('.git-message').fill('面板提交测试');
```

改为：

```js
await page.locator('.git-group-action[title="全部暂存"]').click();
await waitFor(
  async () => (await page.locator('.git-change-badge').count()) >= 2,
  '暂存后两组都出现',
);
await page.locator('.git-message').fill('面板提交测试');
```

- [ ] **Step 2: 追加新场景**

在 `await app.close();` 之前追加：

```js
console.log('7. 分组与行内操作');
await selectProject('git-proj');
writeFileSync(join(repo, 'index.php'), '<?php echo 7;\n');
writeFileSync(join(repo, 'new-file.txt'), 'n\n');
await click(page.locator('.git-icon-btn'));
await waitFor(
  async () => (await page.locator('.git-change-row').count()) >= 2,
  '刷新后看到两个变更',
);
assert(
  (await page.locator('.git-group-title').allInnerTexts()).join(',') === '更改',
  '此时只有「更改」组',
);
const newRow = page.locator('.git-change-item').filter({ hasText: 'new-file.txt' });
await click(newRow.locator('.git-row-action[title="暂存"]'));
await waitFor(
  async () => (await page.locator('.git-group-title').allInnerTexts()).length === 2,
  '暂存后出现「已暂存」组',
);
assert(
  (await page.locator('.git-group-title').first().innerText()) === '已暂存',
  '第一组为已暂存',
);

console.log('8. 取消暂存');
const stagedRow = page.locator('.git-change-item').filter({ hasText: 'new-file.txt' });
await click(stagedRow.locator('.git-row-action[title="取消暂存"]'));
await waitFor(
  async () => (await page.locator('.git-group-title').allInnerTexts()).length === 1,
  '取消后回到单组',
);

console.log('9. 放弃需要确认，取消则不改变文件');
const beforeDiscard = readFileSync(join(repo, 'index.php'), 'utf8');
await click(
  page.locator('.git-change-item').filter({ hasText: 'index.php' }).locator('.git-row-action[title="放弃修改"]'),
);
await page.locator('.editor-confirm').waitFor({ timeout: 8000 });
await click(page.getByRole('button', { name: '取消', exact: true }));
await page.waitForTimeout(400);
assert(readFileSync(join(repo, 'index.php'), 'utf8') === beforeDiscard, '取消后文件未变');

console.log('10. 确认放弃后文件恢复');
await click(
  page.locator('.git-change-item').filter({ hasText: 'index.php' }).locator('.git-row-action[title="放弃修改"]'),
);
await page.locator('.editor-confirm').waitFor({ timeout: 8000 });
await click(page.getByRole('button', { name: '确定放弃', exact: true }));
await waitFor(
  async () => readFileSync(join(repo, 'index.php'), 'utf8') !== beforeDiscard,
  '放弃后文件恢复原内容',
);

console.log('11. 未暂存时提交按钮禁用');
await page.locator('.git-message').fill('不该能提交');
await waitFor(
  async () => (await page.locator('.git-group-title').count()) === 1,
  '仍有未暂存改动',
);
assert(
  await page.getByRole('button', { name: '提交', exact: true }).isDisabled(),
  '没有已暂存内容时提交按钮禁用',
);

console.log('12. 分支列表与切换');
writeFileSync(join(repo, 'index.php'), '<?php echo 8;\n');
await click(page.locator('.git-icon-btn'));
await page.waitForTimeout(800);
await click(page.getByRole('button', { name: '全部暂存' })).catch(() => {});
await page.locator('.git-branch-button').click();
await page.locator('.branch-menu').waitFor({ timeout: 8000 });
assert(
  (await page.locator('.branch-menu-name').first().innerText()).includes('main'),
  '当前分支在列表首位',
);
await click(page.getByRole('menuitem', { name: '新建分支…' }));
await page.locator('#new-branch-name').waitFor({ timeout: 8000 });
await page.locator('#new-branch-name').fill('feature-test');
await page.locator('#new-branch-start').selectOption('main');
await click(page.getByRole('button', { name: '创建并切换', exact: true }));
await waitFor(
  async () => (await page.locator('.git-branch-name').innerText()) === 'feature-test',
  '分支名更新为新分支',
);
assert(
  execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() ===
    'feature-test',
  'git 中已切换',
);

console.log('13. 有改动时切换分支被阻止');
writeFileSync(join(repo, 'dirty.txt'), 'd\n');
await page.waitForTimeout(1500);
await click(page.locator('.git-icon-btn'));
await page.waitForTimeout(800);
await page.locator('.git-branch-button').click();
await page.locator('.branch-menu').waitFor({ timeout: 8000 });
await click(page.locator('.branch-menu-name').filter({ hasText: 'main' }));
await waitFor(
  async () => (await page.locator('.toast').allInnerTexts()).some((t) => t.includes('未提交')),
  '提示需要先提交或放弃',
);
assert(
  execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() ===
    'feature-test',
  '分支未变',
);
```

文件顶部 import 补：

```js
import { readFileSync, writeFileSync } from 'node:fs';
```

（`writeFileSync` 可能已有，合并即可。）

- [ ] **Step 3: 运行测试**

Run: 隔离副本方式运行 `tests/git-panel.mjs`
Expected: 全部通过

- [ ] **Step 4: 全套回归**

Run: `node tests/git-core.mjs`
Run: `node tests/file-api.mjs`
Run: 隔离副本 `tests/git-ipc.mjs`
Run: 隔离副本 `tests/editor.mjs`
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add tests/git-panel.mjs
git commit -m "test(git): cover staging, discard, branch switching and merge"
```

---

## 计划自检

**规格覆盖**

| 规格条目 | 任务 |
|---|---|
| 分组「已暂存 / 更改」 | Task 4 |
| 单文件暂存/取消暂存/放弃 | Task 4 |
| 分组全部暂存/全部取消/全部放弃 | Task 4 |
| 提交只提交已暂存 | Task 1 + Task 4 |
| 放弃二次确认，未跟踪=删除 | Task 1 + Task 4 |
| 分支栏点击弹菜单 | Task 5 |
| 本地分支切换 | Task 2 + Task 5 |
| 新建分支可选起点、创建即切换 | Task 2 + Task 5 |
| 脏工作区阻止切换 | Task 5 |
| 分支合并、冲突只提示 | Task 2 + Task 5 |
| 分支名校验 | Task 2 |

**已知偏离规格**

- 规格写「放弃全部时未跟踪文件由渲染侧传入列表」；实现改为主进程在 `discardAll` 内部调用 `status()` 自行获取。理由：避免渲染侧传入过期列表导致误删。
- 规格提到「打开目录」图标，实际实现为「用编辑器打开」（上一轮已改）。

**类型一致性**

`GitChange` 在 Task 1 定义双状态，Task 4 的 `renderRow` 与 Task 5 的 `discardMessage` 均按 `worktreeStatus` 判断；`GitStatus.stagedCount` 在 Task 1 定义，Task 4 的 `canCommit` 与 Task 5 的 `gitCheckout` 消费；`git.discard` 的 payload 形状 `{ tracked, untracked }` 在 Task 1、3、4、5 中一致。

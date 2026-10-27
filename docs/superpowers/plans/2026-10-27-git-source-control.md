# Git 源代码管理面板实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在侧边栏为当前项目提供轻量 Git 面板：查看状态、填写提交信息、提交全部变更，再点一次按钮推送。

**Architecture:** 主进程新增 `desktop/git.js` 封装对系统 git 的调用，经 5 个 IPC 通道暴露给渲染进程；渲染侧用 `useGitStatus` 钩子管理单一活动项目的状态与事件驱动刷新，`GitPanel` 作为纯展示组件由 `App` 注入回调。

**Tech Stack:** Electron 33、React 19、TypeScript、Node `child_process.execFile`、Playwright（`_electron`）做端到端验证。

**规格：** `docs/superpowers/specs/2026-10-27-git-source-control-design.md`

## Global Constraints

- 项目根目录：`D:\deskTop\CmdToolbox\cmd-toolbox`
- `cmd-toolbox` 当前**不是 git 仓库**。执行前先 `git init`，否则跳过每个任务的 commit 步骤
- 所有 Git 调用使用 `execFile('git', args)`，**禁止**拼接 shell 命令字符串
- 提交信息始终作为独立参数传给 `-m`
- 超时：`status` / `commit` / `init` / `diff` 为 15 秒，`push` 为 120 秒
- `status` 解析必须用 `-c core.quotepath=false status --porcelain=v2 --branch -z`
- 所有 IPC handler 必须校验路径属于已保存项目
- 不引入任何新依赖
- 文案使用中文，与现有界面风格一致
- 现有代码风格：2 空格缩进、单引号、`cn()` 拼类名、`toErrorMessage()` 转错误文案

## 与规格的两处修订

规格中 `GitStatus` 的 `reason` 只有三个值，但实际可能有其他 git 失败（权限、索引损坏）。本计划增加 `'error'`。

`GitPanel` 的 `onOpenDiff` 需要文件状态才能区分未跟踪文件，参数从 `(path: string)` 改为 `(change: GitChange)`；`onCommit` / `onPush` / `onInit` 返回 `Promise<boolean>`，错误提示由 `App` 统一用 toast 处理，面板只负责阶段切换。

这两处修订需同步回规格文件（Task 5 的步骤中包含）。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `desktop/git.js` | 新增。唯一执行 git 的模块，无 Electron 依赖 |
| `desktop/main.js` | 修改。注册 5 个 handler 与路径白名单 |
| `desktop/preload.js` | 修改。暴露 `window.api.git` |
| `src/types.ts` | 修改。新增 `GitChange` / `GitStatus` |
| `src/global.d.ts` | 修改。补 `window.api.git` 类型 |
| `src/gitStatus.ts` | 新增。`useGitStatus` 钩子：拉取、防抖、焦点刷新 |
| `src/components/GitPanel.tsx` | 新增。纯展示组件，含两段式按钮状态机 |
| `src/components/Sidebar.tsx` | 修改。渲染 `GitPanel` |
| `src/App.tsx` | 修改。注入回调，`createTerminal` 返回 `Tab` 以支持 diff |
| `src/styles.css` | 修改。面板样式 |
| `tests/git-core.mjs` | 新增。`desktop/git.js` 的真仓库测试 |
| `tests/git-ipc.mjs` | 新增。IPC 与面板状态的端到端测试 |
| `tests/git-panel.mjs` | 新增。完整场景回归 |

---

### Task 1: Git 核心模块

**Files:**
- Create: `desktop/git.js`
- Test: `tests/git-core.mjs`

**Interfaces:**
- Produces:
  - `status(projectPath: string) => Promise<GitStatus>`
  - `commit(projectPath: string, message: string) => Promise<{ commit: string; summary: string }>`
  - `push(projectPath: string) => Promise<{ upstream: string }>`
  - `init(projectPath: string) => Promise<{ ok: true }>`
  - `diffCommand(projectPath: string, filePath: string, changeStatus: string) => Promise<{ command: string }>`

- [ ] **Step 1: 写失败的测试**

创建 `tests/git-core.mjs`：

```js
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

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'cmdtb-git-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}

console.log('1. 非仓库与缺失目录');
const plain = mkdtempSync(join(tmpdir(), 'cmdtb-plain-'));
const plainStatus = await git.status(plain);
assert(plainStatus.ok === false && plainStatus.reason === 'not-repo', '普通目录返回 not-repo');
const missing = await git.status(join(plain, 'nope'));
assert(missing.ok === false && missing.reason === 'missing-dir', '不存在的目录返回 missing-dir');

console.log('2. 干净仓库');
const repo = makeRepo();
const clean = await git.status(repo);
assert(clean.ok === true && clean.hasChanges === false, '空仓库没有变更');
assert(clean.branch === 'main', '读到分支名 main');
assert(clean.upstream === '', '没有上游时 upstream 为空');

console.log('3. 中文与空格的未跟踪文件');
writeFileSync(join(repo, 'index.php'), '<?php echo 1;\n');
writeFileSync(join(repo, '中文 文件.txt'), 'hello\n');
const withFiles = await git.status(repo);
assert(withFiles.changes.length === 2, '识别到两个变更');
assert(
  withFiles.changes.some((c) => c.path === '中文 文件.txt' && c.status === 'untracked'),
  '中文空格路径原样返回，未加引号',
);

console.log('4. 提交');
const result = await git.commit(repo, '首次提交');
assert(result.summary === '首次提交', '返回提交摘要');
const logged = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: repo, encoding: 'utf8' }).trim();
assert(logged === '首次提交', 'git log 中的提交信息一致');
const afterCommit = await git.status(repo);
assert(afterCommit.hasChanges === false, '提交后工作区干净');

console.log('5. 修改与删除状态');
writeFileSync(join(repo, 'index.php'), '<?php echo 2;\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
writeFileSync(join(repo, 'index.php'), '<?php echo 3;\n');
const mixed = await git.status(repo);
assert(
  mixed.changes.some((c) => c.path === 'index.php' && c.status === 'modified'),
  '已暂存后又修改的文件标记为 modified',
);

console.log('6. 提交空信息被拒绝');
let rejected = false;
try {
  await git.commit(repo, '   ');
} catch {
  rejected = true;
}
assert(rejected, '空提交信息抛错');

console.log('7. 推送无上游');
let noUpstream = '';
try {
  await git.push(repo);
} catch (error) {
  noUpstream = error.message;
}
assert(noUpstream.includes('上游'), '无上游时提示中包含「上游」');
assert(noUpstream.includes('main'), '提示中包含分支名');

console.log('8. diff 命令生成');
const trackedDiff = await git.diffCommand(repo, 'index.php', 'modified');
assert(trackedDiff.command.includes('--no-pager diff --'), '已跟踪文件使用普通 diff');
assert(trackedDiff.command.includes('"index.php"'), '路径被双引号包裹');
const untrackedDiff = await git.diffCommand(repo, '中文 文件.txt', 'untracked');
assert(untrackedDiff.command.includes('--no-index'), '未跟踪文件使用 --no-index');

console.log('9. 路径越界被拒绝');
let escaped = false;
try {
  await git.diffCommand(repo, '../outside.txt', 'modified');
} catch {
  escaped = true;
}
assert(escaped, '拒绝项目目录之外的路径');

console.log('10. 初始化仓库');
const fresh = mkdtempSync(join(tmpdir(), 'cmdtb-init-'));
writeFileSync(join(fresh, 'a.txt'), 'a\n');
await git.init(fresh);
const inited = await git.status(fresh);
assert(inited.ok === true && inited.hasChanges === true, '初始化后能看到未跟踪文件');

console.log(`\n全部通过：${passed} 项`);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/git-core.mjs`
Expected: FAIL，报错 `Cannot find module '../desktop/git.js'`

- [ ] **Step 3: 实现 `desktop/git.js`**

```js
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const FAST_TIMEOUT = 15000;
const PUSH_TIMEOUT = 120000;
const MAX_BUFFER = 8 * 1024 * 1024;

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function cleanError(error, stderr) {
  const text = String(stderr || '').trim() || (error && error.message) || 'git 执行失败';
  return text.split('\n').filter(Boolean).slice(-3).join('\n').slice(0, 300);
}

function runGit(cwd, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        windowsHide: true,
        timeout: options.timeout || FAST_TIMEOUT,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          error,
          enoent: Boolean(error && error.code === 'ENOENT'),
          stdout: stdout || '',
          stderr: stderr || '',
        });
      },
    );
  });
}

const TYPE_BY_CHAR = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'added',
  T: 'modified',
};

// XY 两位分别表示暂存区与工作区状态；工作区有变化时以工作区为准。
function mapStatus(xy) {
  const worktree = xy[1];
  const index = xy[0];
  const picked = worktree !== '.' && worktree !== '?' ? worktree : index;
  return TYPE_BY_CHAR[picked] || 'modified';
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
      changes.push({ path: entry.slice(2), status: 'untracked' });
      continue;
    }
    if (entry.startsWith('! ')) continue;
    if (entry.startsWith('u ')) {
      const fields = entry.split(' ');
      changes.push({ path: fields.slice(10).join(' '), status: 'conflicted' });
      continue;
    }
    if (entry.startsWith('1 ')) {
      const fields = entry.split(' ');
      changes.push({
        path: fields.slice(8).join(' '),
        status: mapStatus(fields[1] || '..'),
      });
      continue;
    }
    if (entry.startsWith('2 ')) {
      const fields = entry.split(' ');
      const origPath = parts[index + 1] || '';
      index += 1;
      changes.push({
        path: fields.slice(9).join(' '),
        origPath,
        status: 'renamed',
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
  };
}

async function status(projectPath) {
  if (!isDirectory(projectPath)) {
    return { ok: false, reason: 'missing-dir', message: '项目目录不存在' };
  }
  const result = await runGit(projectPath, [
    '-c',
    'core.quotepath=false',
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
  ]);
  if (result.enoent) {
    return {
      ok: false,
      reason: 'no-git',
      message: '未检测到 Git，请先安装 Git for Windows',
    };
  }
  if (!result.ok) {
    if (/not a git repository/i.test(result.stderr)) {
      return { ok: false, reason: 'not-repo', message: '当前项目不是 Git 仓库' };
    }
    return { ok: false, reason: 'error', message: cleanError(result.error, result.stderr) };
  }
  return parseStatus(result.stdout);
}

async function commit(projectPath, message) {
  const text = String(message || '').trim();
  if (!text) throw new Error('请填写提交信息');
  if (!isDirectory(projectPath)) throw new Error('项目目录不存在');

  const add = await runGit(projectPath, ['add', '-A']);
  if (!add.ok) throw new Error(cleanError(add.error, add.stderr));

  const result = await runGit(projectPath, ['commit', '-m', text]);
  if (!result.ok) {
    if (/nothing to commit|no changes added/i.test(`${result.stdout}${result.stderr}`)) {
      throw new Error('没有可提交的变更');
    }
    throw new Error(cleanError(result.error, result.stderr));
  }

  const head = await runGit(projectPath, ['rev-parse', '--short', 'HEAD']);
  return { commit: head.stdout.trim(), summary: text.split('\n')[0] };
}

async function push(projectPath) {
  const pre = await runGit(projectPath, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]);
  const upstream = pre.ok ? pre.stdout.trim() : '';
  if (!upstream) {
    const branchResult = await runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = branchResult.stdout.trim() || '当前分支';
    throw new Error(`当前分支没有上游，请先在终端执行 git push -u origin ${branch}`);
  }

  const result = await runGit(projectPath, ['push'], { timeout: PUSH_TIMEOUT });
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  return { upstream };
}

async function init(projectPath) {
  if (!isDirectory(projectPath)) throw new Error('项目目录不存在');
  const result = await runGit(projectPath, ['init']);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  return { ok: true };
}

async function diffCommand(projectPath, filePath, changeStatus) {
  const root = path.resolve(projectPath);
  const target = path.resolve(root, String(filePath || ''));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('文件路径不在项目目录内');
  }
  if (/["\r\n]/.test(relative)) throw new Error('文件路径包含不支持的字符');

  const quoted = `"${relative}"`;
  if (changeStatus === 'untracked') {
    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
    return { command: `git --no-pager diff --no-index -- ${nullDevice} ${quoted}` };
  }
  return { command: `git --no-pager diff -- ${quoted}` };
}

module.exports = { status, commit, push, init, diffCommand };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/git-core.mjs`
Expected: 全部通过，末尾打印 `全部通过：N 项`

- [ ] **Step 5: 提交**

```bash
git add desktop/git.js tests/git-core.mjs
git commit -m "feat(git): add git core module with porcelain v2 status parsing"
```

---

### Task 2: IPC 桥接

**Files:**
- Modify: `desktop/main.js`（在 `projects:reorder` handler 之后插入）
- Modify: `desktop/preload.js`
- Modify: `src/global.d.ts`
- Modify: `src/types.ts`
- Test: `tests/git-ipc.mjs`

**Interfaces:**
- Consumes: Task 1 的 `desktop/git.js` 五个导出
- Produces:
  - `window.api.git.status(projectPath) => Promise<GitStatus>`
  - `window.api.git.commit(projectPath, message) => Promise<{ commit: string; summary: string }>`
  - `window.api.git.push(projectPath) => Promise<{ upstream: string }>`
  - `window.api.git.init(projectPath) => Promise<{ ok: true }>`
  - `window.api.git.diff(projectPath, filePath, changeStatus) => Promise<{ command: string }>`
  - `GitStatus` / `GitChange` 类型

- [ ] **Step 1: 写失败的测试**

创建 `tests/git-ipc.mjs`：

```js
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-data-'));
const repo = mkdtempSync(join(tmpdir(), 'cmdtb-ipc-'));
execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
writeFileSync(join(repo, 'a.txt'), 'a\n');
const plain = mkdtempSync(join(tmpdir(), 'cmdtb-plain-'));

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
  cwd: root,
  args: ['.', `--data-dir=${dataDir}`],
  env,
});
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.locator('.app').waitFor();
await page.waitForTimeout(1200);

// 先把两个目录保存为项目，IPC 白名单才放行
await page.evaluate(
  async ([repoPath, plainPath]) => {
    await window.api.projects.save({ name: 'ipc-repo', path: repoPath });
    await window.api.projects.save({ name: 'ipc-plain', path: plainPath });
  },
  [repo, plain],
);

const status = await page.evaluate((p) => window.api.git.status(p), repo);
assert(status.ok === true, '已保存的仓库返回状态');
assert(status.branch === 'main', '分支名正确');
assert(status.changes.length === 1, '变更数量正确');

const notRepo = await page.evaluate((p) => window.api.git.status(p), plain);
assert(notRepo.ok === false && notRepo.reason === 'not-repo', '非仓库返回 not-repo');

const missing = await page.evaluate((p) => window.api.git.status(p), join(repo, 'nope'));
assert(missing.ok === false && missing.reason === 'missing-dir', '缺失目录返回 missing-dir');

let blocked = '';
try {
  await page.evaluate(() => window.api.git.status('C:\\Windows'));
} catch (error) {
  blocked = error.message;
}
assert(blocked.includes('未保存'), '未保存路径被白名单拒绝');

const diff = await page.evaluate((p) => window.api.git.diff(p, 'a.txt', 'untracked'), repo);
assert(diff.command.includes('--no-index'), 'diff 命令可获取');

await app.close();
rmSync(dataDir, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 项`);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/git-ipc.mjs`
Expected: FAIL，`window.api.git` 为 undefined

- [ ] **Step 3: 在主进程注册 handler**

在 `desktop/main.js` 顶部 require 区加入：

```js
const git = require('./git');
```

在 `projects:reorder` handler 之后插入：

```js
  // 渲染进程只能对已保存项目执行 git 操作
  function assertProjectPath(input) {
    const target = normalizeDir(input);
    const known = store
      .list()
      .find((project) => project.path.toLowerCase() === target.toLowerCase());
    if (!known) throw new Error('项目未保存，无法执行 Git 操作');
    return known.path;
  }

  ipcMain.handle('git:status', (_event, projectPath) =>
    git.status(assertProjectPath(projectPath)),
  );

  ipcMain.handle('git:commit', (_event, projectPath, message) =>
    git.commit(assertProjectPath(projectPath), message),
  );

  ipcMain.handle('git:push', (_event, projectPath) =>
    git.push(assertProjectPath(projectPath)),
  );

  ipcMain.handle('git:init', (_event, projectPath) =>
    git.init(assertProjectPath(projectPath)),
  );

  ipcMain.handle('git:diff', (_event, projectPath, filePath, changeStatus) =>
    git.diffCommand(assertProjectPath(projectPath), filePath, changeStatus),
  );
```

- [ ] **Step 4: 在 preload 暴露 API**

在 `desktop/preload.js` 的 `shell:` 段之后加入：

```js
  git: {
    status: (projectPath) => invoke('git:status', projectPath),
    commit: (projectPath, message) => invoke('git:commit', projectPath, message),
    push: (projectPath) => invoke('git:push', projectPath),
    init: (projectPath) => invoke('git:init', projectPath),
    diff: (projectPath, filePath, changeStatus) =>
      invoke('git:diff', projectPath, filePath, changeStatus),
  },
```

- [ ] **Step 5: 补类型定义**

`src/types.ts` 末尾追加：

```ts
export type GitChangeStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted';

export type GitChange = {
  path: string;
  origPath?: string;
  status: GitChangeStatus;
};

export type GitStatus =
  | {
      ok: false;
      reason: 'no-git' | 'not-repo' | 'missing-dir' | 'error';
      message: string;
    }
  | {
      ok: true;
      branch: string;
      upstream: string;
      ahead: number;
      behind: number;
      changes: GitChange[];
      hasChanges: boolean;
    };
```

`src/global.d.ts` 的 `import type` 行改为：

```ts
import type { AppInfo, GitChange, GitStatus, Project } from './types';
```

在 `Window.api` 的 `shell` 段之后加入：

```ts
      git: {
        status: (projectPath: string) => Promise<GitStatus>;
        commit: (
          projectPath: string,
          message: string,
        ) => Promise<{ commit: string; summary: string }>;
        push: (projectPath: string) => Promise<{ upstream: string }>;
        init: (projectPath: string) => Promise<{ ok: true }>;
        diff: (
          projectPath: string,
          filePath: string,
          changeStatus: GitChange['status'],
        ) => Promise<{ command: string }>;
      };
```

- [ ] **Step 6: 类型检查并运行测试**

Run: `npm run typecheck`
Expected: 无输出（通过）

Run: `npm run build && node tests/git-ipc.mjs`
Expected: 全部通过

- [ ] **Step 7: 提交**

```bash
git add desktop/main.js desktop/preload.js src/types.ts src/global.d.ts tests/git-ipc.mjs
git commit -m "feat(git): expose git IPC channels to renderer"
```

---

### Task 3: 状态钩子

**Files:**
- Create: `src/gitStatus.ts`

**Interfaces:**
- Consumes: `window.api.git.status`（Task 2）、`subscribeAllData`（`src/ptyBus.ts`）
- Produces: `useGitStatus(activeGroup, options) => { status, refreshing, refresh, setStatus }`

- [ ] **Step 1: 写实现**

创建 `src/gitStatus.ts`：

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeAllData } from './ptyBus';
import { toErrorMessage } from './lib';
import type { GitStatus, Group } from './types';

const REFRESH_DEBOUNCE = 800;

type GitStatusOptions = {
  isSessionActive?: (sessionId: string) => boolean;
};

export function useGitStatus(activeGroup: Group | null, options: GitStatusOptions = {}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const groupRef = useRef<Group | null>(activeGroup);
  const optionsRef = useRef(options);
  const requestIdRef = useRef(0);

  groupRef.current = activeGroup;
  optionsRef.current = options;

  const refresh = useCallback(async () => {
    const group = groupRef.current;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (!group || group.kind !== 'project') {
      setStatus(null);
      setRefreshing(false);
      return;
    }

    setRefreshing(true);
    try {
      const next = await window.api.git.status(group.path);
      if (requestId === requestIdRef.current) setStatus(next);
    } catch (error) {
      if (requestId === requestIdRef.current) {
        setStatus({ ok: false, reason: 'error', message: toErrorMessage(error) });
      }
    } finally {
      if (requestId === requestIdRef.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    setStatus(null);
    void refresh();
  }, [activeGroup?.key, refresh]);

  useEffect(() => {
    const handleFocus = () => void refresh();
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [refresh]);

  useEffect(() => {
    let timer: number | null = null;
    const unsubscribe = subscribeAllData((sessionId, data) => {
      if (!/[\r\n]/.test(data)) return;
      const isActive = optionsRef.current.isSessionActive;
      if (isActive && !isActive(sessionId)) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void refresh();
      }, REFRESH_DEBOUNCE);
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [refresh]);

  return { status, refreshing, refresh, setStatus };
}
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add src/gitStatus.ts
git commit -m "feat(git): add event-driven git status hook"
```

---

### Task 4: GitPanel 组件与样式

**Files:**
- Create: `src/components/GitPanel.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `GitStatus` / `GitChange`（Task 2）、`cn` / 现有 `.btn` 样式
- Produces: `GitPanel` 组件，props 为 `{ status, refreshing, onRefresh, onCommit, onPush, onInit, onOpenDiff, onContinueEditing? }`

- [ ] **Step 1: 创建组件**

创建 `src/components/GitPanel.tsx`：

```tsx
import { useState } from 'react';
import { ArrowUp, Check, RefreshCw } from 'lucide-react';
import { cn } from '../lib';
import type { GitChange, GitChangeStatus, GitStatus } from '../types';

type Phase = 'idle' | 'committing' | 'committed' | 'pushing';

const STATUS_LABEL: Record<GitChangeStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
  conflicted: '!',
};

export type GitPanelProps = {
  status: GitStatus | null;
  refreshing: boolean;
  onRefresh: () => void;
  onCommit: (message: string) => Promise<boolean>;
  onPush: () => Promise<boolean>;
  onInit: () => Promise<boolean>;
  onOpenDiff: (change: GitChange) => void;
};

export function GitPanel({
  status,
  refreshing,
  onRefresh,
  onCommit,
  onPush,
  onInit,
  onOpenDiff,
}: GitPanelProps) {
  const [message, setMessage] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [committedMessage, setCommittedMessage] = useState('');

  const busy = phase === 'committing' || phase === 'pushing';
  const ready = phase === 'idle' && message.trim().length > 0;
  const canCommit = ready && Boolean(status?.ok && status.hasChanges);

  const resetToIdle = () => {
    setPhase('idle');
    setMessage('');
    setCommittedMessage('');
  };

  const runCommit = async () => {
    if (!canCommit) return;
    setPhase('committing');
    const ok = await onCommit(message.trim());
    if (!ok) {
      setPhase('idle');
      return;
    }
    setCommittedMessage(message.trim());
    setMessage('');
    setPhase('committed');
  };

  const runPush = async () => {
    setPhase('pushing');
    const ok = await onPush();
    if (!ok) {
      setPhase('committed');
      return;
    }
    resetToIdle();
  };

  const submit = () => {
    if (phase === 'committed') void runPush();
    else void runCommit();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && event.ctrlKey) {
      event.preventDefault();
      submit();
    }
  };

  const header = (
    <header className="git-panel-head">
      <span className="git-panel-title">源代码管理</span>
      <button
        type="button"
        className="git-icon-btn"
        title="刷新"
        aria-label="刷新 Git 状态"
        disabled={refreshing}
        onClick={onRefresh}
      >
        <RefreshCw size={13} className={refreshing ? 'is-spinning' : undefined} />
      </button>
    </header>
  );

  if (!status) {
    return (
      <section className="git-panel">
        {header}
        <p className="git-panel-hint">正在读取 Git 状态…</p>
      </section>
    );
  }

  if (!status.ok) {
    return (
      <section className="git-panel">
        {header}
        <p className="git-panel-hint">{status.message}</p>
        {status.reason === 'not-repo' ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm git-init-btn"
            onClick={() => void onInit()}
          >
            初始化仓库
          </button>
        ) : null}
      </section>
    );
  }

  return (
    <section className="git-panel">
      {header}
      <div className="git-branch-bar">
        <span className="git-branch-name">{status.branch || '未知分支'}</span>
        {status.ahead > 0 ? <span className="git-ahead">↑{status.ahead}</span> : null}
        {status.behind > 0 ? <span className="git-behind">↓{status.behind}</span> : null}
      </div>

      {status.hasChanges || phase === 'committed' ? (
        <>
          <textarea
            className="git-message"
            value={phase === 'committed' ? `已提交：${committedMessage}` : message}
            readOnly={phase === 'committed'}
            rows={3}
            placeholder="提交信息（Ctrl+Enter 提交）"
            spellCheck={false}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="git-actions">
            <button
              type="button"
              className={cn('btn', 'git-submit', phase === 'committed' ? 'btn-primary' : 'btn-secondary')}
              disabled={busy || (phase === 'idle' && !canCommit)}
              onClick={submit}
            >
              {phase === 'committed' || phase === 'pushing' ? (
                <>
                  <ArrowUp size={13} />
                  {phase === 'pushing' ? '推送中…' : '推送'}
                </>
              ) : (
                <>
                  <Check size={13} />
                  {phase === 'committing' ? '提交中…' : '提交'}
                </>
              )}
            </button>
            {phase === 'committed' ? (
              <button type="button" className="git-continue" onClick={resetToIdle}>
                继续编辑
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <p className="git-panel-hint">没有变更</p>
      )}

      {status.changes.length > 0 ? (
        <ul className="git-change-list">
          {status.changes.map((change) => (
            <li key={`${change.status}:${change.path}`}>
              <button
                type="button"
                className="git-change-row"
                title={change.origPath ? `${change.origPath} → ${change.path}` : change.path}
                onClick={() => onOpenDiff(change)}
              >
                <span className={cn('git-change-badge', `is-${change.status}`)}>
                  {STATUS_LABEL[change.status]}
                </span>
                <span className="git-change-path">
                  {change.origPath ? `${change.origPath} → ${change.path}` : change.path}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 2: 添加样式**

在 `src/styles.css` 的 `.add-project-btn` 规则之后追加：

```css
/* ---------- Git panel ---------- */

.git-panel {
  margin-top: 14px;
  padding: 0 2px 6px;
  border-top: 1px solid #e9e9ed;
}

.git-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 6px 6px 8px;
}

.git-panel-title {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--faint);
}

.git-icon-btn {
  width: 23px;
  height: 23px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--faint);
}

.git-icon-btn:hover:not(:disabled) {
  background: #ebebef;
  color: var(--text);
}

.git-icon-btn:disabled {
  opacity: 0.5;
}

.git-panel-hint {
  margin: 0;
  padding: 2px 8px 8px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--muted);
}

.git-init-btn {
  margin: 0 8px 8px;
}

.git-branch-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 7px;
  font-size: 11.5px;
  color: var(--muted);
}

.git-branch-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-ahead {
  color: #0e9f6e;
}

.git-behind {
  color: #d97706;
}

.git-message {
  width: 100%;
  min-height: 56px;
  max-height: 120px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fbfbfd;
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
  line-height: 1.5;
  resize: vertical;
  outline: none;
}

.git-message:focus {
  border-color: #c9ced8;
  background: #ffffff;
}

.git-message:read-only {
  color: var(--muted);
  background: #f5f5f8;
}

.git-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 7px;
}

.git-submit {
  flex: 1;
  justify-content: center;
  gap: 5px;
}

.git-continue {
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent);
  font-size: 11.5px;
}

.git-continue:hover {
  text-decoration: underline;
}

.git-change-list {
  margin: 9px 0 0;
  padding: 0;
  max-height: 168px;
  overflow-y: auto;
  list-style: none;
}

.git-change-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11.5px;
  text-align: left;
}

.git-change-row:hover {
  background: #f2f2f6;
  color: var(--text);
}

.git-change-badge {
  flex: 0 0 12px;
  font-weight: 600;
  font-size: 11px;
  text-align: center;
}

.git-change-badge.is-modified {
  color: #d97706;
}

.git-change-badge.is-added {
  color: #0e9f6e;
}

.git-change-badge.is-deleted {
  color: #d92d20;
}

.git-change-badge.is-renamed {
  color: #2563eb;
}

.git-change-badge.is-untracked {
  color: var(--faint);
}

.git-change-badge.is-conflicted {
  color: #d92d20;
}

.git-change-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

面板左右需要留出与项目列表一致的间距，`.git-panel` 上方已有 `margin-top`。若在实物上贴边，把 `.git-panel` 的 `padding` 改为 `0 4px 6px`。

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 通过

- [ ] **Step 4: 提交**

```bash
git add src/components/GitPanel.tsx src/styles.css
git commit -m "feat(git): add source control panel component"
```

---

### Task 5: 接入侧边栏与 App

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `useGitStatus`（Task 3）、`GitPanel`（Task 4）、`window.api.git`（Task 2）
- Produces:
  - `createTerminal(group, shellId?) => Promise<Tab | null>`
  - `Sidebar` 新增 `gitPanel` 与 `onOpenDiff` 相关 props

- [ ] **Step 1: 扩展 Sidebar**

`src/components/Sidebar.tsx`：

`import` 区加入：

```tsx
import type { ReactNode } from 'react';
```

`SidebarProps` 加入：

```tsx
  gitPanel: ReactNode;
```

解构参数加入 `gitPanel`。

在 `projects-scroll` 的 `</div>` 之后、外层 `.sidebar-scroll` 的 `</div>` 之前插入：

```tsx
        {gitPanel}
```

- [ ] **Step 2: App 接入钩子与回调**

`src/App.tsx` 的 imports 加入：

```tsx
import { useGitStatus } from './gitStatus';
import type { GitChange } from './types';
```

在 `pushToast` 定义之后加入：

```tsx
  const projectGroupForGit = activeGroup && activeGroup.kind === 'project' && activeGroup.exists
    ? activeGroup
    : null;
  const gitGroupRef = useRef<Group | null>(projectGroupForGit);
  gitGroupRef.current = projectGroupForGit;

  const {
    status: gitStatus,
    refreshing: gitRefreshing,
    refresh: refreshGit,
  } = useGitStatus(projectGroupForGit, {
    isSessionActive: (sessionId) => {
      const key = activeGroupKeyRef.current;
      return (tabsRef.current[key] || []).some((tab) => tab.sessionId === sessionId);
    },
  });

  const gitCommit = useCallback(
    async (message: string) => {
      const group = gitGroupRef.current;
      if (!group) return false;
      try {
        const result = await window.api.git.commit(group.path, message);
        pushToast(`已提交 ${result.commit}`, 'success');
        await refreshGit();
        return true;
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
        return false;
      }
    },
    [pushToast, refreshGit],
  );

  const gitPush = useCallback(async () => {
    const group = gitGroupRef.current;
    if (!group) return false;
    try {
      const result = await window.api.git.push(group.path);
      pushToast(`已推送到 ${result.upstream}`, 'success');
      await refreshGit();
      return true;
    } catch (error) {
      pushToast(toErrorMessage(error), 'error');
      return false;
    }
  }, [pushToast, refreshGit]);

  const gitInit = useCallback(async () => {
    const group = gitGroupRef.current;
    if (!group) return false;
    try {
      await window.api.git.init(group.path);
      pushToast('已初始化 Git 仓库', 'success');
      await refreshGit();
      return true;
    } catch (error) {
      pushToast(toErrorMessage(error), 'error');
      return false;
    }
  }, [pushToast, refreshGit]);
```

`useEffect` 里已有的 `tabsRef`、`activeGroupKeyRef` 定义位于文件更早处，可直接使用。

- [ ] **Step 3: 让 createTerminal 返回创建的页签**

`src/App.tsx` 中 `createTerminal` 的签名由：

```tsx
  const createTerminal = useCallback(
    async (group: Group, shellId?: string) => {
```

改为：

```tsx
  const createTerminal = useCallback(
    async (group: Group, shellId?: string): Promise<Tab | null> => {
```

函数内所有提前 `return;` 改为 `return null;`（`createBrowser` 分支改为 `createBrowser(group); return null;`）。

在 `try` 块末尾、`catch` 之前加上：

```tsx
        return tab;
```

- [ ] **Step 4: 打开 diff 页签**

在 `gitInit` 之后加入：

```tsx
  const gitOpenDiff = useCallback(
    async (change: GitChange) => {
      const group = gitGroupRef.current;
      if (!group) return;
      try {
        const { command } = await window.api.git.diff(
          group.path,
          change.path,
          change.status,
        );
        const tab = await createTerminal(group, 'cmd');
        if (!tab || !tab.sessionId) return;
        window.api.pty.write(tab.sessionId, `${command}\r`);
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
      }
    },
    [createTerminal, pushToast],
  );
```

- [ ] **Step 5: 传给 Sidebar**

在 `<Sidebar ... />` 中，`onReorderProjects` 之后加入：

```tsx
          gitPanel={
            projectGroupForGit ? (
              <GitPanel
                status={gitStatus}
                refreshing={gitRefreshing}
                onRefresh={() => void refreshGit()}
                onCommit={gitCommit}
                onPush={gitPush}
                onInit={gitInit}
                onOpenDiff={(change) => void gitOpenDiff(change)}
              />
            ) : null
          }
```

`import` 区加入：

```tsx
import { GitPanel } from './components/GitPanel';
```

- [ ] **Step 6: 类型检查与构建**

Run: `npm run typecheck && npm run build`
Expected: 均通过

- [ ] **Step 7: 手工冒烟**

Run: `node tests/smoke.mjs`
Expected: 既有用例全部通过（回归）

- [ ] **Step 8: 同步规格文件**

编辑 `docs/superpowers/specs/2026-10-27-git-source-control-design.md`：

- `GitStatus` 的 `reason` 联合类型加入 `'error'`
- `GitPanel` props 中 `onOpenDiff` 改为 `(change: GitChange) => void`，`onCommit` / `onPush` / `onInit` 改为 `Promise<boolean>`

- [ ] **Step 9: 提交**

```bash
git add src/App.tsx src/components/Sidebar.tsx docs/superpowers/specs/2026-10-27-git-source-control-design.md
git commit -m "feat(git): wire source control panel into sidebar"
```

---

### Task 6: 端到端回归测试

**Files:**
- Create: `tests/git-panel.mjs`

**Interfaces:**
- Consumes: 全部前序任务

- [ ] **Step 1: 写测试**

创建 `tests/git-panel.mjs`：

```js
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-data-'));
const repo = mkdtempSync(join(tmpdir(), 'cmdtb-repo-'));
const plain = mkdtempSync(join(tmpdir(), 'cmdtb-plain-'));
const shotDir = resolve(root, 'test-shots');
mkdirSync(shotDir, { recursive: true });

execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
writeFileSync(join(repo, 'index.php'), '<?php echo 1;\n');
writeFileSync(join(repo, '中文 文件.txt'), 'hello\n');
writeFileSync(join(plain, 'a.txt'), 'a\n');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
  cwd: root,
  args: ['.', `--data-dir=${dataDir}`],
  env,
});
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.locator('.app').waitFor();
await page.waitForTimeout(1200);

async function addProject(path, name) {
  await page.locator('.add-project-btn').click({ force: true });
  await page.locator('.modal-card').waitFor();
  await page.locator('#project-path').fill(path);
  await page.locator('#project-name').fill(name);
  await page.getByRole('button', { name: '保存项目', exact: true }).click({ force: true });
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await page.waitForTimeout(500);
}

console.log('1. 非 Git 项目显示初始化按钮');
await addProject(plain, 'plain-proj');
await page.locator('.group-item').filter({ hasText: 'plain-proj' }).locator('.group-main').click();
await page.waitForTimeout(900);
assert(await page.locator('.git-panel').isVisible(), 'Git 面板可见');
assert(
  (await page.locator('.git-panel').innerText()).includes('不是 Git 仓库'),
  '显示非仓库提示',
);
await page.getByRole('button', { name: '初始化仓库', exact: true }).click();
await page.waitForTimeout(1400);
assert(
  (await page.locator('.git-panel').innerText()).includes('a.txt'),
  '初始化后出现变更列表',
);

console.log('2. 仓库项目显示变更');
await addProject(repo, 'git-proj');
await page.locator('.group-item').filter({ hasText: 'git-proj' }).locator('.group-main').click();
await page.waitForTimeout(1200);
const panelText = await page.locator('.git-panel').innerText();
assert(panelText.includes('index.php'), '列出 index.php');
assert(panelText.includes('中文 文件.txt'), '列出中文空格文件名');
assert(panelText.includes('main'), '显示分支名');
assert((await page.locator('.git-change-row').count()) === 2, '变更行数为 2');

console.log('3. 提交后有可推送状态');
await page.locator('.git-message').fill('面板提交测试');
assert(
  await page.getByRole('button', { name: '提交', exact: true }).isEnabled(),
  '填写信息后提交按钮可用',
);
await page.getByRole('button', { name: '提交', exact: true }).click();
await page.waitForTimeout(1600);
const pushed = page.getByRole('button', { name: '推送', exact: true });
assert(await pushed.isVisible(), '提交后按钮变为「推送」');
assert(await page.locator('.git-message').isEditable().then((v) => !v), '输入框变为只读');
const logged = execFileSync('git', ['log', '-1', '--pretty=%s'], {
  cwd: repo,
  encoding: 'utf8',
}).trim();
assert(logged === '面板提交测试', 'git log 中的提交信息一致');

console.log('4. 继续编辑回到提交态');
await page.getByRole('button', { name: '继续编辑', exact: true }).click();
await page.waitForTimeout(400);
assert(
  await page.getByRole('button', { name: '提交', exact: true }).isVisible(),
  '按钮回到「提交」',
);

console.log('5. 推送失败保留推送态');
await page.getByRole('button', { name: '提交', exact: true }).isDisabled();
await page.locator('.git-message').fill('第二次提交');
await page.getByRole('button', { name: '提交', exact: true }).click();
await page.waitForTimeout(1500);
await page.getByRole('button', { name: '推送', exact: true }).click();
await page.waitForTimeout(1800);
const toastText = await page.locator('.toast').last().innerText();
assert(toastText.includes('上游'), '推送无上游时提示上游信息');
assert(
  await page.getByRole('button', { name: '推送', exact: true }).isVisible(),
  '失败后仍停留在「推送」',
);

console.log('6. 点击变更文件打开 diff 页签');
await page.locator('.group-item').filter({ hasText: 'plain-proj' }).locator('.group-main').click();
await page.waitForTimeout(600);
writeFileSync(join(plain, 'b.txt'), 'b\n');
await page.locator('.git-icon-btn').click();
await page.waitForTimeout(900);
const beforeTabs = await page.locator('.tab').count();
await page.locator('.git-change-row').filter({ hasText: 'b.txt' }).click();
await page.waitForTimeout(2200);
assert((await page.locator('.tab').count()) === beforeTabs + 1, '打开了一个新页签');
const rows = await page.locator('.terminal-pane:not(.is-hidden) .xterm-rows').innerText();
assert(rows.includes('b.txt'), 'diff 内容出现在终端中');

await page.screenshot({ path: join(shotDir, 'git-panel.png') });
await app.close();
rmSync(dataDir, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 项`);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/git-panel.mjs`
Expected: 首次运行时若面板未接入会 FAIL（前序任务已完成则应直接进入 Step 3）

- [ ] **Step 3: 运行测试确认通过**

Run: `npm run build && node tests/git-panel.mjs`
Expected: 全部通过

- [ ] **Step 4: 手工验证清单**

构建后 `npm start`，逐项确认：

- 浅色与深色主题下终端右侧只有一条滚动条
- 侧栏收起后 Git 面板不残留
- 项目较多时向下滚动可以完整看到 Git 面板
- 在终端执行 `git commit -am x` 后，列表在 1 秒内自动更新
- 提交按钮在提交信息为空时禁用

- [ ] **Step 5: 提交**

```bash
git add tests/git-panel.mjs
git commit -m "test(git): add end-to-end source control panel coverage"
```

---

## 计划自检

**规格覆盖**

| 规格条目 | 对应任务 |
|---|---|
| 分支/上游/ahead/behind 显示 | Task 1 解析 + Task 4 分支栏 |
| 变更列表 | Task 1 + Task 4 |
| 提交全部变更 | Task 1 `commit` |
| 两段式按钮 | Task 4 状态机 |
| 继续编辑 | Task 4 `resetToIdle` |
| 非 Git 初始化 | Task 1 `init` + Task 4 |
| 点击文件看 diff | Task 1 `diffCommand` + Task 5 `gitOpenDiff` |
| 事件驱动刷新 | Task 3 |
| 路径白名单 | Task 2 `assertProjectPath` |
| 错误提示 | Task 1 抛错 + Task 5 toast |
| 测试 | Task 1/2/6 |

**已知缺口**

规格提到「目录不存在」时沿用现有无效态。实现上 `useGitStatus` 只对 `kind === 'project' && exists` 的组发起查询，目录不存在的项目不会渲染面板（`gitPanel` 传 `null`）。与「显示项目目录不存在」的表述有差异，行为上更简单且不误导用户，实施时以本计划为准。

**类型一致性**

`GitChange.status` 在 Task 2 定义，Task 1 的 `mapStatus` 返回值为其子集，Task 4 的 `STATUS_LABEL` 覆盖全部六个值。`diffCommand` 的参数在 Task 1、2、5 中均为 `(projectPath, filePath, changeStatus)`。

# 发布分支（Publish Branch）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让新建分支能在应用内直接发布到远端（`git push -u`），并在界面上以「发布」代替「推送」。

**Architecture:** 后端 `desktop/git.js` 在 `push()` 检测到没有上游时自动选择远端并执行 `push -u`，`status()` 补出远端列表；渲染侧 `GitPanel` 以「当前分支无上游」为唯一判据显示「发布」按钮与文案。

**Tech Stack:** Electron 主进程（Node CJS）、React + TypeScript、Playwright 驱动真实 Electron 的端到端测试、Node 内置 test 风格的离线脚本。

## Global Constraints

- 唯一版本号源头是 `package.json` 的 `version`，本计划不涉及发版，**不要改版本号**。
- 提交信息只写改动本身和原因，**不加任何 AI 署名**（见 `CLAUDE.md` 的「不要做的事」）。
- 渲染进程改完后用 `npx tsc --noEmit && npx vite build` 重建，**不要用 `npm run build`**（会改脏 `build/coninject.exe`）。
- UI 测试必须独占，跑之前先清掉残留 electron 进程并确认 17382 端口空闲。
- Git 命令一律走 `execFile` 参数数组，**不得拼接 shell 字符串**。
- 发布远端选择顺序固定为：`origin` → 唯一远端 → 报错，**不加远端选择弹窗**。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `desktop/git.js` | Git 后端：状态解析、推送/发布 | 修改 `status()`、`push()`，新增 `listRemotes` / `symbolicBranch` / `pushFailure` |
| `src/types.ts` | 共享类型 | `GitStatus` 加 `remotes`，`GitPushResult` 加 `published`，失败原因加两个枚举 |
| `src/components/GitPanel.tsx` | 源代码管理面板 | 新增「发布」按钮与文案切换 |
| `src/App.tsx` | 推送结果的 toast | 按 `published` 分支文案 |
| `src/styles.css` | 发布按钮样式 | 新增 `.git-publish-button` |
| `tests/git-core.mjs` | 后端离线测试 | 更新第 7 节（无远端） |
| `tests/git-pull.mjs` | 拉取/推送离线测试 | 新增第 11–16 节 |
| `tests/git-panel.mjs` | 面板端到端测试 | 更新第 3、5 节，新增 5e |
| `CLAUDE.md` | 项目规则 | 新增「Git 发布分支」小节 |

---

### Task 1: 后端支持发布分支

**Files:**
- Modify: `desktop/git.js:204-230`（`status()`）、`desktop/git.js:414-439`（`push()`）
- Modify: `desktop/git.js:66-79` 之后新增两个辅助函数
- Test: `tests/git-core.mjs:171-175`
- Test: `tests/git-pull.mjs`（文件末尾追加）

**Interfaces:**
- Consumes: 现有 `runGit`、`upstreamOf`、`currentBranch`、`cleanError`
- Produces:
  - `status(projectPath)` 成功返回增加 `remotes: string[]`
  - `push(projectPath, options)` 成功返回 `{ ok: true, upstream: string, published: boolean }`
  - 失败返回新增 `reason: 'detached' | 'no-remote'`

- [ ] **Step 1: 写失败的测试**

修改 `tests/git-core.mjs` 第 171–175 行为：

```js
console.log('7. 推送无远端');
const noRemoteResult = await git.push(repo);
assert(
  noRemoteResult.ok === false && noRemoteResult.reason === 'no-remote',
  '无远端时返回 no-remote',
);
assert(noRemoteResult.message.includes('远端'), '提示中包含「远端」');
```

在 `tests/git-pull.mjs` 末尾（`console.log(\`\n全部通过：${passed} 项\`);` 之前）插入：

```js
console.log('11. 未发布的分支可以发布并建立上游');
const publishRepo = clone('publish');
run(publishRepo, ['checkout', '-q', '-b', 'feature']);
const beforePublish = await git.status(publishRepo);
assert(beforePublish.upstream === '', '新分支没有上游');
assert(beforePublish.remotes.includes('origin'), 'status 带出远端列表');
const publishResult = await git.push(publishRepo);
assert(publishResult.ok === true && publishResult.published === true, '发布成功');
assert(publishResult.upstream === 'origin/feature', '返回 origin/feature 作为上游');
const afterPublish = await git.status(publishRepo);
assert(afterPublish.upstream === 'origin/feature', '发布后上游已建立');
assert(
  run(base, ['rev-parse', '--verify', 'refs/heads/feature']).trim() ===
    run(publishRepo, ['rev-parse', 'HEAD']).trim(),
  '远端分支指向同一个提交',
);

console.log('12. 已发布分支再推送时 published 为 false');
writeFileSync(join(publishRepo, 'feature.txt'), 'f\n');
run(publishRepo, ['add', '-A']);
run(publishRepo, ['commit', '-qm', 'feature work']);
const republish = await git.push(publishRepo);
assert(republish.ok === true && republish.published === false, '已有上游时 published 为 false');
assert(republish.upstream === 'origin/feature', '上游保持不变');

console.log('13. 没有远端时返回 no-remote');
const noRemoteRepo = mkdtempSync(join(tmpdir(), 'publish-noremote-'));
run(noRemoteRepo, ['init', '-b', 'main']);
run(noRemoteRepo, ['config', 'user.email', 't@e.com']);
run(noRemoteRepo, ['config', 'user.name', 'T']);
run(noRemoteRepo, ['config', 'commit.gpgsign', 'false']);
writeFileSync(join(noRemoteRepo, 'x.txt'), 'x\n');
run(noRemoteRepo, ['add', '-A']);
run(noRemoteRepo, ['commit', '-qm', 'init']);
const noRemotePush = await git.push(noRemoteRepo);
assert(noRemotePush.ok === false && noRemotePush.reason === 'no-remote', '没有远端时返回 no-remote');
assert(noRemotePush.message.includes('远端'), '提示说明没有远端');

console.log('14. 多个远端时 origin 优先，没有 origin 时报错');
const multiRepo = clone('multi');
const backup = mkdtempSync(join(tmpdir(), 'publish-backup-'));
run(backup, ['init', '--bare', '-b', 'main']);
run(multiRepo, ['remote', 'add', 'upstream', backup]);
run(multiRepo, ['checkout', '-q', '-b', 'multi-feature']);
const multiPush = await git.push(multiRepo);
assert(
  multiPush.ok === true && multiPush.upstream === 'origin/multi-feature',
  '多个远端时优先 origin',
);

const ambiguousRepo = clone('ambiguous');
run(ambiguousRepo, ['remote', 'rename', 'origin', 'alpha']);
const beta = mkdtempSync(join(tmpdir(), 'publish-beta-'));
run(beta, ['init', '--bare', '-b', 'main']);
run(ambiguousRepo, ['remote', 'add', 'beta', beta]);
run(ambiguousRepo, ['checkout', '-q', '-b', 'amb-feature']);
const ambiguousPush = await git.push(ambiguousRepo);
assert(
  ambiguousPush.ok === false && ambiguousPush.reason === 'no-remote',
  '多个远端且无 origin 时返回 no-remote',
);
assert(
  ambiguousPush.message.includes('alpha') && ambiguousPush.message.includes('beta'),
  '提示列出候选远端',
);

console.log('15. 只有一个非 origin 远端时使用它');
const singleRepo = clone('single');
run(singleRepo, ['remote', 'rename', 'origin', 'only']);
run(singleRepo, ['checkout', '-q', '-b', 'only-feature']);
const singlePush = await git.push(singleRepo);
assert(
  singlePush.ok === true && singlePush.upstream === 'only/only-feature',
  '唯一远端被使用',
);

console.log('16. 游离 HEAD 返回 detached');
const detachedRepo = clone('detached');
run(detachedRepo, ['checkout', '-q', '--detach', 'HEAD']);
const detachedPush = await git.push(detachedRepo);
assert(
  detachedPush.ok === false && detachedPush.reason === 'detached',
  '游离 HEAD 返回 detached',
);
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node tests/git-core.mjs
```

Expected: FAIL —— `无远端时返回 no-remote` 断言失败（当前返回 `no-upstream`）。

```bash
node tests/git-pull.mjs
```

Expected: FAIL —— 发布返回 `ok: false`（`no-upstream`）。

- [ ] **Step 3: 实现 `listRemotes` 与 `symbolicBranch`**

在 `desktop/git.js` 的 `upstreamOf`（约第 79 行）之后插入：

```js
async function listRemotes(projectPath) {
  const result = await runGit(projectPath, ['remote']);
  if (!result.ok) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// 空仓库（尚无提交）没有 HEAD，只能从符号引用取分支名
async function symbolicBranch(projectPath) {
  const result = await runGit(projectPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return result.ok ? result.stdout.trim() : '';
}
```

- [ ] **Step 4: 让 `status()` 带出远端列表**

把 `desktop/git.js` 中 `status()` 的最后一行 `return parseStatus(result.stdout);` 改为：

```js
  const parsed = parseStatus(result.stdout);
  parsed.remotes = await listRemotes(projectPath);
  return parsed;
```

- [ ] **Step 5: 重写 `push()`**

用下面的实现替换 `desktop/git.js` 第 414–439 行的整个 `push` 函数，并在它之前插入 `pushFailure`：

```js
function pushFailure(result) {
  const text = `${result.stdout}\n${result.stderr}`;
  // 非快进是分叉场景，交给上层弹出「拉取合并 / 拉取变基 / 强制推送」的选择
  if (/non-fast-forward|fetch first|\[rejected\]|rejected/i.test(text)) {
    return {
      ok: false,
      reason: 'rejected',
      message: '线上分支有本地没有的提交，推送被拒绝',
    };
  }
  return null;
}

async function push(projectPath, options = {}) {
  const upstream = await upstreamOf(projectPath);
  if (upstream) {
    const args = options.force ? ['push', '--force-with-lease'] : ['push'];
    const result = await runGit(projectPath, args, { timeout: PUSH_TIMEOUT });
    if (result.ok) return { ok: true, upstream, published: false };
    const failure = pushFailure(result);
    if (failure) return failure;
    throw new Error(cleanError(result.error, result.stderr));
  }

  // 没有上游 = 分支还没发布过，push -u 一次完成建上游和推送
  const branch = (await currentBranch(projectPath)) || (await symbolicBranch(projectPath));
  if (!branch || branch === 'HEAD') {
    return { ok: false, reason: 'detached', message: '当前不在任何分支上，无法发布分支' };
  }

  const remotes = await listRemotes(projectPath);
  if (!remotes.length) {
    return { ok: false, reason: 'no-remote', message: '没有配置远端仓库，无法发布分支' };
  }
  const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : '';
  if (!remote) {
    return {
      ok: false,
      reason: 'no-remote',
      message: `仓库有多个远端（${remotes.join('、')}）且没有 origin，请在终端指定要发布到哪个远端`,
    };
  }

  const args = ['push', '-u', remote, branch];
  if (options.force) args.push('--force-with-lease');
  const result = await runGit(projectPath, args, { timeout: PUSH_TIMEOUT });
  if (result.ok) return { ok: true, upstream: `${remote}/${branch}`, published: true };
  const failure = pushFailure(result);
  if (failure) return failure;
  throw new Error(cleanError(result.error, result.stderr));
}
```

- [ ] **Step 6: 运行测试确认通过**

```bash
node tests/git-core.mjs
node tests/git-pull.mjs
```

Expected: 两个脚本都输出「全部通过」，无断言失败。

- [ ] **Step 7: 提交**

```bash
git add desktop/git.js tests/git-core.mjs tests/git-pull.mjs
git commit -m "feat(git): 无上游时自动 push -u 发布分支并带出远端列表"
```

---

### Task 2: 类型定义

**Files:**
- Modify: `src/types.ts:124-155`

**Interfaces:**
- Consumes: Task 1 的返回结构
- Produces:
  - `GitStatus` 成功分支含 `remotes: string[]`
  - `GitPushResult` = `{ ok: true; upstream: string; published: boolean } | GitSyncFailure`
  - `GitSyncFailure['reason']` 含 `'detached' | 'no-remote'`

- [ ] **Step 1: 修改 `GitStatus`**

在 `src/types.ts` 的成功分支里，`behind: number;` 之后加一行：

```ts
      remotes: string[];
```

- [ ] **Step 2: 修改失败原因与推送结果**

```ts
export type GitSyncFailure = {
  ok: false;
  reason:
    | 'no-upstream'
    | 'diverged'
    | 'conflict'
    | 'rejected'
    | 'multiple-branches'
    | 'detached'
    | 'no-remote';
  message: string;
  conflicted?: string[];
};
```

```ts
export type GitPushResult = { ok: true; upstream: string; published: boolean } | GitSyncFailure;
```

- [ ] **Step 3: 类型检查**

```bash
npx tsc --noEmit
```

Expected: 报错集中在 `GitPanel.tsx` / 测试无关的地方都不应出现新的 `remotes` / `published` 缺失错误——这一步应通过，因为主进程 JS 不受类型约束，渲染侧尚未使用新字段。

- [ ] **Step 4: 提交**

```bash
git add src/types.ts
git commit -m "feat(git): 类型加入 remotes 与 published 字段"
```

---

### Task 3: 面板显示「发布」

**Files:**
- Modify: `src/components/GitPanel.tsx:203-206`（派生值）、`:443-469`（分支栏）、`:533-561`（提交块）
- Modify: `src/App.tsx:1276`
- Modify: `src/styles.css:2035` 之后

**Interfaces:**
- Consumes: `status.remotes`、`status.upstream`、`result.published`
- Produces: 新的 `.git-publish-button` 类名（测试依赖它）

- [ ] **Step 1: 增加派生值**

在 `src/components/GitPanel.tsx` 第 205 行 `const showBarPush = ...` 之后插入：

```tsx
  // 没有上游 = 分支还没发布过；此时「发布」代替「推送」，一次完成建上游与推送
  const unpublished = Boolean(
    status && status.ok && !status.upstream && status.branch !== '游离 HEAD',
  );
  const canPublish = Boolean(unpublished && status && status.ok && status.remotes.length > 0);
```

- [ ] **Step 2: 分支栏加发布按钮**

在 `.git-sync-actions` 里、`{showBarPush ? ... : null}` 之后、`</div>` 之前插入：

```tsx
          {canPublish ? (
            <button
              type="button"
              className="git-publish-button"
              title={`把 ${status.branch} 发布到远端并建立上游`}
              disabled={pushBusy || pullBusy}
              onClick={runBarPush}
            >
              <ArrowUp size={12} className={pushBusy ? 'is-spinning' : undefined} />
              <span>{pushBusy ? '发布中…' : '发布'}</span>
            </button>
          ) : null}
```

- [ ] **Step 3: 提交块文案按上游切换**

把 `GitPanel.tsx` 中提交按钮的文案块：

```tsx
              {phase === 'committed' || phase === 'pushing' ? (
                <>
                  <ArrowUp size={13} />
                  {phase === 'pushing' ? '推送中…' : '推送'}
                </>
```

改为：

```tsx
              {phase === 'committed' || phase === 'pushing' ? (
                <>
                  <ArrowUp size={13} />
                  {phase === 'pushing'
                    ? unpublished
                      ? '发布中…'
                      : '推送中…'
                    : unpublished
                      ? '发布'
                      : '推送'}
                </>
```

- [ ] **Step 4: 成功提示区分发布与推送**

把 `src/App.tsx` 第 1276 行：

```tsx
        pushToast(`已推送到 ${result.upstream}`, 'success');
```

改为：

```tsx
        pushToast(
          result.published ? `已发布分支 ${result.upstream}` : `已推送到 ${result.upstream}`,
          'success',
        );
```

- [ ] **Step 5: 加样式**

在 `src/styles.css` 第 2035 行（`.git-push-button:disabled` 块）之后插入：

```css
.git-publish-button {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border: 1px solid #b7e0c2;
  border-radius: 6px;
  background: #eefbf1;
  color: #15803d;
  font-size: 11px;
}

.git-publish-button:hover:not(:disabled) {
  background: #ddf6e4;
  border-color: #8fd0a3;
}

.git-publish-button:disabled {
  opacity: 0.6;
}
```

- [ ] **Step 6: 类型检查并重建**

```bash
npx tsc --noEmit && npx vite build
```

Expected: 均无报错。

- [ ] **Step 7: 提交**

```bash
git add src/components/GitPanel.tsx src/App.tsx src/styles.css
git commit -m "feat(git): 未发布分支在面板显示「发布」入口"
```

---

### Task 4: 端到端测试

**Files:**
- Modify: `tests/git-panel.mjs:150-207`（第 3、5 节）
- Modify: `tests/git-panel.mjs:262` 之后（新增 5e）

**Interfaces:**
- Consumes: `.git-publish-button`、toast 文案「已发布分支」
- Produces: 无

- [ ] **Step 1: 更新第 3 节的按钮文案断言**

把第 152–155 行：

```js
await waitFor(
  async () => (await page.getByRole('button', { name: '推送', exact: true }).count()) > 0,
  '提交后按钮变为「推送」',
);
```

改为：

```js
await waitFor(
  async () => (await page.getByRole('button', { name: '发布', exact: true }).count()) > 0,
  '提交后按钮变为「发布」',
);
```

- [ ] **Step 2: 更新第 5 节（无远端）**

把第 185–207 行整块替换为：

```js
console.log('5. 没有远端时提交后显示「发布」并提示没有远端');
// commit 不再自动暂存，第二次提交前同样需要先暂存
await click(page.locator('.git-group-action[title="全部暂存"]'));
await waitFor(
  async () => (await page.locator('.git-group-title').allInnerTexts())[0] === '已暂存',
  '第二次提交前文件进入暂存区',
);
await page.locator('.git-message').fill('第二次提交');
await click(page.getByRole('button', { name: '提交', exact: true }));
await waitFor(
  async () => (await page.getByRole('button', { name: '发布', exact: true }).count()) > 0,
  '第二次提交后按钮变为「发布」',
);
await click(page.getByRole('button', { name: '发布', exact: true }));
await waitFor(
  async () =>
    (await page.locator('.toast').allInnerTexts()).some((text) =>
      text.includes('没有配置远端'),
    ),
  '发布失败提示说明没有配置远端',
);
assert(
  await page.getByRole('button', { name: '发布', exact: true }).isVisible(),
  '失败后仍停留在「发布」',
);
```

- [ ] **Step 3: 新增 5e 用例**

在第 5b 节结束处（`'推送完成后按钮消失'` 的 `waitFor` 之后，第 261 行）插入：

```js
console.log('5e. 未发布分支显示发布按钮并完成发布');
execFileSync('git', ['checkout', '-q', '-b', 'feature-publish'], { cwd: repo });
await click(page.locator('.git-icon-btn'));
await waitFor(
  async () => (await page.locator('.git-branch-name').innerText()) === 'feature-publish',
  '切换到新分支',
);
await waitFor(
  async () => (await page.locator('.git-publish-button').count()) > 0,
  '未发布分支出现发布按钮',
);
assert(
  (await page.locator('.git-push-button').count()) === 0,
  '未发布时不显示推送按钮',
);
await click(page.locator('.git-publish-button'));
await waitFor(
  async () =>
    (await page.locator('.toast').allInnerTexts()).some((text) => text.includes('已发布')),
  '发布成功提示',
);
assert(
  execFileSync('git', ['rev-parse', 'feature-publish'], {
    cwd: remote,
    encoding: 'utf8',
  }).trim() ===
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  '远端已有该分支',
);
await waitFor(
  async () => (await page.locator('.git-publish-button').count()) === 0,
  '发布完成后按钮消失',
);
execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo });
await click(page.locator('.git-icon-btn'));
await waitFor(
  async () => (await page.locator('.git-branch-name').innerText()) === 'main',
  '回到 main',
);
```

- [ ] **Step 4: 清理环境并运行测试**

```bash
powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force"
sleep 3
netstat -ano | grep LISTENING | grep 17382 || echo PORT_FREE
node tests/git-panel.mjs
```

Expected: 全部断言通过，无 `等待超时`。

- [ ] **Step 5: 提交**

```bash
git add tests/git-panel.mjs
git commit -m "test(git): 覆盖未发布分支的发布入口与无远端提示"
```

---

### Task 5: 更新项目规则

**Files:**
- Modify: `CLAUDE.md`（在「## 界面约定」之前插入新小节）

**Interfaces:**
- Consumes: Task 1–4 的最终行为
- Produces: 无

- [ ] **Step 1: 写入「Git 发布分支」小节**

在 `CLAUDE.md` 的 `## 界面约定` 之前插入：

```markdown
## Git 发布分支

- **「有没有上游」是未发布的唯一判据**（`status.upstream` 为空）。不要改用 ahead 数或改动数：
  干净的新分支也要能直接发布，有改动的分支在提交前同样要看得到发布入口。
- **发布 = `git push -u <remote> <branch>`**，一次完成建上游与推送；成功后返回
  `{ ok: true, upstream, published: true }`，已发布分支的普通推送返回 `published: false`。
- **远端选择顺序固定**：`origin` → 唯一的远端 → 报错（`reason: 'no-remote'`，提示里列出候选）。
  不要加远端选择弹窗。
- **按钮文案跟着上游走**：无上游时分支栏与提交块都叫「发布」，有上游才叫「推送」，
  避免点了「推送」实际却在执行发布。
- **取当前分支名**先 `rev-parse --abbrev-ref HEAD`，失败再 `symbolic-ref --short HEAD`
  （空仓库没有 HEAD）；两边都拿不到或得到 `HEAD` 才算游离 HEAD，返回 `reason: 'detached'`。
- **不要在 `no-upstream` 时提示用户去终端执行 `git push -u`**——那正是这条路径原本不可用的原因。
- `tests/git-pull.mjs` 覆盖发布、远端优先级与游离 HEAD；`tests/git-panel.mjs` 的 5e 覆盖界面。
```

- [ ] **Step 2: 提交**

```bash
git add CLAUDE.md
git commit -m "docs: 记录 Git 发布分支的判据与远端选择规则"
```

---

## 验收清单

- [ ] `node tests/git-core.mjs`、`node tests/git-pull.mjs` 全绿
- [ ] `npx tsc --noEmit && npx vite build` 无报错
- [ ] `node tests/git-panel.mjs` 全绿（独占运行）
- [ ] 手动确认：新建分支后分支栏出现「发布」，点击后远端出现同名分支，按钮消失
- [ ] 手动确认：无远端仓库点击「发布」提示「没有配置远端仓库，无法发布分支」

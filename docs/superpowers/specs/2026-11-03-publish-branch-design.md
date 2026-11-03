# 发布分支（Publish Branch）

## 问题

在应用里新建分支后无法把它推到远端。原因在 `desktop/git.js` 的 `push()`：没有上游时直接返回
`reason: 'no-upstream'`，提示用户去终端执行 `git push -u origin <branch>`。而新建分支必然没有
上游，等于把「发布」这条路封死。此外 `GitPanel` 的推送按钮只在 `ahead > 0` 时出现，
干净的新分支连入口都没有。

## 行为定义

判断依据只有一条：**当前分支有没有上游**（`status.upstream` 为空即未发布）。与有没有未提交
改动无关。

| 场景 | 分支栏 | 提交块按钮 |
|---|---|---|
| 未发布分支，无暂存改动 | 「发布」 | — |
| 未发布分支，有暂存改动 | 「发布」 | 「提交」→ 提交后变「发布」 |
| 已发布分支，本地领先 | 「推送」 | 「提交」→ 提交后变「推送」 |

点「发布」执行 `git push -u <remote> <branch>`，一次完成建上游与推送。提交后不会先出现一个
「推送」再变成「发布」。

## 后端 `desktop/git.js`

### `status()`

返回值增加 `remotes: string[]`，取自 `git remote`。刷新路径本来就先 `fetch`，多一条本地命令
开销可忽略。`parseStatus()` 保持纯函数，`remotes` 由 `status()` 补齐。

### `push(projectPath, options)`

有上游时行为不变，仅返回值加 `published: false`。

无上游时进入发布流程：

1. 当前为游离 HEAD（`currentBranch()` 返回空或 `HEAD`）→ 返回
   `reason: 'detached'`，message「当前不在任何分支上，无法发布分支」。
2. 选择远端：
   - 有 `origin` → `origin`
   - 否则只有一个远端 → 用它
   - 没有远端 → `reason: 'no-remote'`，message「没有配置远端仓库，无法发布分支」
   - 多个远端且无 `origin` → `reason: 'no-remote'`，message 列出候选远端名，提示在终端指定
3. 执行 `git push -u <remote> <branch>`；`options.force` 时改为
   `git push -u <remote> <branch> --force-with-lease`。
4. 成功返回 `{ ok: true, upstream: '<remote>/<branch>', published: true }`。
5. 被拒（远端已有同名分支且分叉）沿用现有 `rejected` 分支，复用「拉取合并 / 拉取变基 /
   强制推送」弹窗，不新增界面。

## 类型与 IPC

- `src/types.ts`
  - `GitStatus` 成功分支增加 `remotes: string[]`
  - `GitPushResult` 成功分支增加 `published: boolean`
  - `GitSyncFailure.reason` 增加 `'detached' | 'no-remote'`
- IPC 通道不变，仍是 `git:push`，`desktop/preload.js` 与 `src/global.d.ts` 的签名不用改。

## 界面 `src/components/GitPanel.tsx`

- 新增派生值 `unpublished = status.ok && !status.upstream && status.branch !== '游离 HEAD'`。
- 分支栏在 `unpublished && status.remotes.length > 0` 时显示「发布」按钮，复用
  `.git-push-button` 样式，`title` 为「把 <branch> 发布到远端并建立上游」。它与现有推送按钮
  互斥显示。
- 提交块：`phase === 'committed'` 时，`unpublished` 分支显示「发布」，否则显示「推送」；
  图标都用 `ArrowUp`，点击仍走 `onPush`。
- 没有配置远端时不显示分支栏按钮；提交块的「发布」按钮保留，点击后由后端返回
  「没有配置远端仓库，无法发布分支」的 toast，而不是让人去终端敲 `push -u`。

## 提示文案 `src/App.tsx`

`gitPush` 成功时按 `result.published` 分支：

- `true` → 「已发布到 origin/xxx」
- `false` → 「已推送到 xxx」（保持现状）

## 测试

`tests/git-pull.mjs` 新增离线用例：

- 新分支无上游 + 有 origin → 发布成功，`status.upstream` 变为 `<remote>/<branch>`
- 无远端 → `no-remote`
- 多个远端时 `origin` 优先
- 只有一个非 origin 远端 → 使用它
- 多个远端且无 origin → `no-remote` 且 message 列出候选
- 游离 HEAD → `detached`

`tests/git-panel.mjs`：

- 第 5 节改为：无远端仓库点击「发布」提示「没有配置远端」，按钮保留。
- 新增端到端用例：新建分支 → 分支栏出现「发布」→ 点击成功 → 远端确有该分支 →
  按钮消失，`ahead/behind` 归零。

## 文档

`CLAUDE.md` 增加「Git 发布分支」小节，写明：

- 未发布的唯一判据是 `status.upstream` 为空
- 远端选择优先级：`origin` → 唯一远端 → 报错
- 不要改回「提示用户去终端执行 git push -u」

## 不做

- 不弹远端选择框
- 不在新建分支后自动发布
- 不改动拉取逻辑

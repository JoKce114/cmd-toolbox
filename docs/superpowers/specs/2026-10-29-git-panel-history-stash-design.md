# Git 面板增强：提交历史、撤销提交、stash、冲突行跳转

日期：2026-10-29
状态：待实施
前置：`2026-10-27-git-panel-staging-branches-design.md`、`2026-10-27-git-conflict-editor-design.md`

## 背景

Git 面板已覆盖暂存、提交、推送、分支切换与合并。剩下四类操作仍要回终端：

1. 提交历史只能看文字，点不开，无法回溯某个提交改了什么
2. 提交信息写错、或提交后发现漏了文件，只能 `git reset` / `--amend`
3. 想临时收起改动切分支，没有 stash 入口
4. 冲突文件提示「需在终端解决」，而编辑器其实早就能逐块解决冲突

本设计补齐这四项，让 Git 面板不再需要为日常操作切回终端。

## 需求范围

### 做

- 点「最近提交」里的一条 → 打开该提交的 diff 页签，可切换查看提交内的各个文件
- 「撤销提交」：撤销最后一次提交，改动回到暂存区，提交信息回填到输入框
- 「修改提交」：弹窗预填 HEAD 信息，确认后 `--amend`（可顺带并入当前暂存改动）
- 「收起改动」：把全部未提交改动存成 stash；「暂存的改动」区列出并可恢复 / 丢弃
- 冲突文件行从「需在终端解决」改为「解决冲突」按钮，跳转编辑器

### 不做

- 回退到任意历史提交（只针对 HEAD）
- stash 备注输入框、指定单个文件 stash
- 提交间的文件对比（`A..B`）、历史搜索、作者筛选
- 编辑器内的冲突定位（只打开文件，不自动滚动到第一处冲突）
- 提交历史的撤销状态跨会话恢复

## 数据模型

### Tab 增加提交页签

```ts
export type Tab = {
  // ...现有字段
  diffChange?: GitChange;
  diffCommit?: { hash: string; short: string; subject: string };
};
```

`diffChange` 与 `diffCommit` 互斥。`shellId` 仍为 `'diff'`，`isDiffTab()` 的判定不变。

### 新增 StashEntry

```ts
export type StashEntry = {
  ref: string;      // stash@{0}
  message: string;  // WIP on main: a1b2c3d 提交信息
  when: string;     // 2 hours ago
};
```

`GitStatus` 不新增字段：判断是否已推送复用现有的 `ahead` / `behind`，判断 HEAD 是否在远端用 `git branch -r --contains`。

### 新增 CommitFile

```ts
export type CommitFile = {
  path: string;
  status: GitChangeStatus;
  added: number;
  removed: number;
  patch: string;   // 该单文件的 unified diff
};
```

## 主进程接口

### 新增函数（`desktop/git.js`）

| 函数 | 实现 | 返回 |
|---|---|---|
| `commitDiff(projectPath, hash)` | `git --no-pager show --no-color --no-ext-diff -U3 -m --first-parent --format= <hash>` | `{ patch }` |
| `headCommit(projectPath)` | `git log -1 --pretty=%H<US>%h<US>%s<US>%B`，再 `git branch -r --contains <hash>` | `{ hash, short, subject, message, pushed }` |
| `amend(projectPath, message)` | `git commit --amend --no-edit` 或 `--amend -m <message>` | `{ commit, summary }` |
| `undoCommit(projectPath)` | `git reset --soft HEAD~1`；无父提交时 `git update-ref -d HEAD` | `{ message, wasPushed }` |
| `stashList(projectPath)` | `git stash list --format=%gd<US>%gs<US>%cr`，最多 20 条 | `{ stashes: StashEntry[] }` |
| `stashSave(projectPath)` | `git stash push -u -m "Cmd Toolbox"` | `{ ok: true }` |
| `stashPop(projectPath, ref)` | `git stash pop <ref>` | `{ ok: true, conflicts: string[] }` |
| `stashDrop(projectPath, ref)` | `git stash drop <ref>` | `{ ok: true }` |

`US` 是 `String.fromCharCode(31)`，与现有 `log()` 保持一致，避免提交信息里的空格干扰分割。

### 参数校验

- `hash`：必须匹配 `/^[0-9a-f]{4,40}$/`，否则抛「提交标识不合法」
- `stash ref`：必须匹配 `/^stash@\{\d+\}$/`，否则抛「stash 标识不合法」
- 两者最终都会进入 `execFile` 的参数数组（不经 shell），但渲染层传入的字符串仍需在主进程侧校验

### commitDiff 的 `-m --first-parent`

默认 `git show` 对 merge commit **不输出任何 diff**，面板会显示成空页签。加 `-m --first-parent` 后，merge commit 输出版本相对第一父（即合并前当前分支）的差异，符合直觉。非 merge commit 不受影响。

### headCommit 的 pushed 判定

```js
const remote = await runGit(projectPath, ['branch', '-r', '--contains', hash]);
const pushed = remote.ok && remote.stdout.trim().length > 0;
```

无远端仓库时 stdout 为空，`pushed` 为 false，属于正确行为（本地提交确实没推送）。

### undoCommit 的边界

- 有父提交：`git reset --soft HEAD~1`，改动留在暂存区
- 首次提交（无父）：`HEAD~1` 会失败，改走 `git update-ref -d HEAD`，效果等同于撤销首个提交、所有文件变为新增待提交
- 两种情况都在执行前先取 `headCommit()`，把 `message` 与 `wasPushed` 一并返回给渲染层
- 执行后必须调用方 `refresh()`，否则面板仍显示已提交的文件

### amend 的边界

- 提交信息与 HEAD 一致且 `stagedCount === 0` 时直接抛「提交信息未修改，也没有暂存改动」，避免生成一个空 amend
- `git commit --amend` 在无暂存改动时会重写提交时间戳，这是 git 自身行为，不做拦截

### stashPop 的冲突语义

`git stash pop` 遇到冲突时退出码非零，但 **stash 不会自动删除**，工作区进入冲突态。因此：

- 不当作失败抛错，返回 `{ ok: true, conflicts: [...] }`
- 冲突文件用既有的 `collectConflicts()` 提取（优先读索引状态，不依赖输出语言）
- UI 侧 toast 提示「恢复后有 N 处冲突，stash 记录已保留」

## IPC 通道

| 通道 | 参数 | 返回 |
|---|---|---|
| `git:commit-diff` | `projectPath, hash` | `{ patch }` |
| `git:head-commit` | `projectPath` | `{ hash, short, subject, message, pushed }` |
| `git:amend` | `projectPath, message` | `{ commit, summary }` |
| `git:undo-commit` | `projectPath` | `{ message, wasPushed }` |
| `git:stash-list` | `projectPath` | `{ stashes }` |
| `git:stash-save` | `projectPath` | `{ ok: true }` |
| `git:stash-pop` | `projectPath, ref` | `{ ok: true, conflicts }` |
| `git:stash-drop` | `projectPath, ref` | `{ ok: true }` |

按项目约定，`main.js` → `preload.js` → `global.d.ts` 三处同步，缺一处就是运行时错误或类型报错。

## 渲染层

### 提交 diff

`DiffPane` 的 props 由 `change: GitChange` 改为判别联合：

```ts
type DiffTarget =
  | { kind: 'change'; change: GitChange }
  | { kind: 'commit'; commit: { hash: string; short: string; subject: string } };
```

**提交模式**：

- 标题栏 `a1b2c3d · 修复登录超时`
- 标题栏下方：`文件 3 ▾` 下拉 + 当前文件的 `+30 −5`
- 正文只渲染选中文件的 hunk，复用现有 `parsePatch` 与 `.diff-*` 样式
- 「打开文件」在选中文件为 `deleted` 时禁用
- 页签去重按 `diffCommit.hash` 判断（对应现有按 `diffChange.path` 去重）

**改动模式**：行为完全不变。

新增 `src/commitDiff.ts`（纯函数，无 DOM 依赖）：

```ts
// 把多文件 patch 按 "diff --git" 边界切块，
// 逐块解析路径、状态（新增/删除/重命名/修改）与增删行数
export function splitCommitPatch(patch: string): CommitFile[];
```

路径解析要处理三种头部：

- `--- a/x` + `+++ b/x` → 普通修改
- `new file mode` → `added`
- `deleted file mode` → `deleted`
- `rename from` / `rename to` → `renamed`（路径取 `+++` 侧）

### 撤销 / 修改提交

`.git-actions` 行最左侧新增三个次要按钮：`收起改动` / `撤销提交` / `修改提交`。抽成独立小组件，**在没有变更（当前显示「没有变更」）时也要渲染**，否则干净仓库里没有撤销入口。

- **撤销提交**：`ConfirmDialog` 确认；`wasPushed` 为真时追加一句「这个提交已经推送过，撤销后需要强推才能同步远端」。成功后把返回的 `message` 回填输入框，toast「已撤销，改动回到暂存区」
- **修改提交**：`AmendModal`（新组件，基于 `Modal`），预填 `headCommit().message`，下方提示「当前 N 项暂存改动会并入这次提交」，`pushed` 为真时多一条警告。确认走 `git:amend`
- 两者执行前都先调用 `headCommit()`，拿不到 HEAD（空仓库）时按钮禁用

### stash

- **收起改动**：有任何未提交改动时可用，成功后刷新状态并自动展开 stash 区
- **暂存的改动 (N)**：新的可折叠区，`useCollapsedSection('git-stash', true)` 默认收起，位置在「更改」与「最近提交」之间
- 每行：`stash@{0}` + `message` + `when` + 两个图标按钮（恢复 / 丢弃），左右排布与现有 `.git-history-item` 一致
- **恢复** → `git:stash-pop`；返回 `conflicts` 非空时 toast「恢复后有 N 处冲突，stash 记录已保留」并刷新
- **丢弃** → `ConfirmDialog`，文案写明「丢弃后无法恢复」
- stash 列表跟随 `gitStatus` 刷新节奏重新拉取，与现有 `gitCommits`、`gitBranches` 两个 effect 一致

### 冲突行

`GitPanel.tsx` 中冲突分支的「需在终端解决」文本替换为「解决冲突」按钮，点击调用现有的 `onOpenInEditor(change)`。编辑器的 `ConflictBar` 与「标记为已解决」直接可用，不需要新增逻辑。

`hasConflicts` 对「全部暂存 / 全部放弃」的禁用保持不变。

### 页签创建（`App.tsx`）

新增 `openCommitDiffTab(group, commit)`：

- 按 `diffCommit.hash` 查重，已存在则激活
- `Tab` 不设 `diffChange`，`descriptor` 取 `short`

`renderWorkbenchPane` 中 `isDiffTab(tab)` 分支改为按 `tab.diffChange` / `tab.diffCommit` 二选一构造 `target`。

业务回调 `gitUndoCommit`、`gitAmend`、`gitStashSave`、`gitStashPop`、`gitStashDrop`、`gitHeadCommit` 按现有 `useCallback` + `pushToast` + `refreshGit()` 的模式写在 `App.tsx`，注入 `GitPanel`。

## 错误处理

- 全部后端错误经 `cleanError` 上抛，前端统一 `pushToast(toErrorMessage(error), 'error')`
- 每个操作独立忙碌态：`undoBusy` / `amendBusy` 为布尔，`stashBusy` 存正在处理的 stash ref（`null` 表示空闲）；期间对应按钮禁用，防止连点触发两次 `reset --soft`
- `commitDiff` 遇到 hash 已不存在（force push 后的历史）返回「该提交已不在本地历史中」，面板回到空状态
- `stashPop` 冲突按上文处理，不作为错误路径
- 所有操作成功后都 `refreshGit()`，保证面板与实际仓库状态一致

## 涉及文件

| 文件 | 变更 |
|---|---|
| `desktop/git.js` | 新增 8 个函数，导出 |
| `desktop/main.js` | 注册 8 个 IPC |
| `desktop/preload.js` | 暴露 8 个 API |
| `src/types.ts` | `Tab.diffCommit`、`StashEntry`、`CommitFile` |
| `src/global.d.ts` | 补类型 |
| `src/commitDiff.ts` | 新增，多文件 patch 切分（纯函数） |
| `src/components/DiffPane.tsx` | props 改判别联合，新增提交模式 |
| `src/components/AmendModal.tsx` | 新增，修改提交信息 |
| `src/components/GitPanel.tsx` | 提交操作按钮、stash 区、冲突行按钮、提交历史可点击 |
| `src/App.tsx` | `openCommitDiffTab` + 6 个业务回调 |
| `src/styles.css` | stash 区、提交文件下拉、提交操作按钮 |
| `tests/git-core.mjs` | 后端单元测试 |
| `tests/commit-diff.mjs` | 新增，patch 切分测试 |
| `tests/git-panel.mjs` | UI 交互测试 |

## 测试

### `tests/git-core.mjs` 新增（离线，沿用 `makeRepo()`）

1. `undoCommit` 后 HEAD 回退一条，`stagedCount` 等于原提交的文件数，返回 `message` 与原文一致
2. 首次提交时 `undoCommit` 不报错，仓库回到无 HEAD 状态
3. `amend` 改信息后 `log` 只有一条且 subject 已更新
4. 信息未变且无暂存改动时 `amend` 抛错
5. `stashSave` 后工作区干净、`stashList` 有一条
6. `stashPop` 后改动回来、列表清空
7. `stashDrop` 后列表减少一条
8. 非法 ref（`stash@{-1}`、`../../x`）与非法 hash 被拒绝
9. 无远端仓库时 `headCommit().pushed === false`

### `tests/commit-diff.mjs` 新增（离线）

10. 三文件 patch 切成 3 块，路径 / 状态 / 增删数正确
11. 含新建与重命名的 patch 状态识别正确
12. merge commit 的 patch（`-m --first-parent` 产出）能正常切分

### `tests/git-panel.mjs` 新增（UI，需先关闭运行中的实例）

13. 点历史提交行 → 出现 `a1b2c3d · …` 页签，文件下拉有对应项，切换文件正文随之变化
14. 暂存后点「撤销提交」→ 确认 → 提交列表少一条、该文件回到变更列表
15. 点「收起改动」→ stash 区出现一条 → 点恢复 → 变更列表恢复
16. 冲突文件行显示「解决冲突」，点击后编辑器页签打开且 `.conflict-bar` 存在

第 12 条需要 merge commit 夹具，在测试里用两次分支合并生成。

## 已知风险

- UI 测试占用固定端口 17382，运行前必须关闭正在运行的 Cmd Toolbox，否则表现为 `firstWindow: Timeout 30000ms exceeded`
- 测试启动需设 `CMDTOOLBOX_NO_UPDATE=1`，避免真实请求 GitHub
- 改动 UI 文案时需同步 `tests/` 中的断言（设置面板、公告弹窗依赖中文文案）

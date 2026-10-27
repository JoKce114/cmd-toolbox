# Git 面板增强：暂存、放弃、分支切换

日期：2026-10-27
状态：待实施
前置：`2026-10-27-git-source-control-design.md`

## 背景

Git 面板已能查看状态、提交、推送。但日常使用中还有三类高频操作要回到终端：

1. 挑选部分文件提交（现在只能整体提交）
2. 撤销改错的修改
3. 切换分支

本设计补齐这三项，让面板覆盖「日常 Git 操作」的绝大多数场景。

## 需求范围

### 做

- 变更列表分「已暂存 / 更改」两组
- 单文件：暂存、取消暂存、放弃修改、打开所在目录
- 分组级：全部暂存、全部取消暂存、全部放弃
- 提交只提交已暂存内容
- 分支栏点击弹出本地分支列表，可切换
- 新建分支时可选择起点分支，创建后立即切换
- 把指定本地分支合并到当前分支

### 不做

- 远程分支列表与跟踪分支创建
- 删除、重命名分支
- rebase、cherry-pick
- 冲突解决界面（合并遇冲突只提示，不自动处理）
- `git stash`
- 单行级别或 hunk 级别的暂存

## 数据模型

### GitChange 变更

原模型把 XY 两位压成一个 `status`，无法表达「既有暂存又有工作区改动」。改为保留两位：

```ts
export type GitChange = {
  path: string;
  origPath?: string;
  indexStatus: GitChangeStatus | null;    // 暂存区（X 位），'.' 映射为 null
  worktreeStatus: GitChangeStatus | null; // 工作区（Y 位），'.' 映射为 null
};
```

一个文件可能同时有两者（`MM`），此时**同时出现在两个分组里**。这与 git 和 VS Code 的语义一致。

### GitStatus 新增

```ts
stagedCount: number;   // indexStatus !== null 的文件数
unstagedCount: number; // worktreeStatus !== null 的文件数
```

用于分组标题的数量徽标，以及提交按钮的可用判断。

`GitChangeStatus`、`GitStatus` 的其余字段不变。

## 主进程接口

### 新增函数（`desktop/git.js`）

```js
stage(projectPath, paths)                    // git add -- <paths...>
unstage(projectPath, paths)                  // git restore --staged -- <paths...>
discard(projectPath, { tracked, untracked }) // 见下
stageAll(projectPath)                        // git add -A
discardAll(projectPath)                      // 见下
branches(projectPath)                        // → { current, list: string[] }
checkout(projectPath, branch)                // git checkout <branch>
createBranch(projectPath, name, startPoint)  // git checkout -b <name> <startPoint>
merge(projectPath, branch)                   // git merge <branch>
```

### discard 的实现

```js
async function discard(projectPath, { tracked = [], untracked = [] }) {
  // tracked: git restore -- <paths...>
  // untracked: 逐个 fs.rm，路径必须落在项目根目录内
}
```

未跟踪文件的删除在主进程用 `fs.rm` 完成，不走 `git clean`——`git clean` 的忽略规则和 `-f` 语义容易误删，直接删除具体文件更可控。

每个路径先经 `resolveWithin(projectPath, filePath)` 校验（复用 `diffCommand` 里的逻辑，抽成共用函数），越界抛错。

### discardAll 的实现

```js
git restore --staged .  // 清空暂存区
git restore -- .        // 丢弃所有已跟踪文件的工作区改动
// 再删除所有未跟踪文件（由渲染侧传入列表）
```

顺序不能反：先取消暂存再 restore，否则已暂存的新增文件在 restore 后仍留在暂存区。

### branches 的实现

```js
git for-each-ref --format=%(refname:short) refs/heads
```

返回顺序：当前分支置顶，其余按字母序。无提交的空仓库返回空数组。

### merge 的实现

```js
const result = await runGit(projectPath, ['merge', branch]);
if (!result.ok) {
  const conflicts = parseConflicts(result.stdout);   // "CONFLICT (content): Merge conflict in <path>"
  if (conflicts.length > 0) return { ok: true, conflicted: conflicts };
  throw new Error(cleanError(result.error, result.stderr));
}
return { ok: true, conflicted: [] };
```

冲突时 `git merge` 退出码非零，但仓库停在合并中状态。函数**不抛错**，返回冲突列表让界面提示；用户去终端执行 `git merge --abort` 或解决冲突后自行 `git commit`。

### commit 行为变更

移除内部的 `git add -A`，改由用户显式暂存：

```js
const result = await runGit(projectPath, ['commit', '-m', text]);
```

无暂存内容时 git 返回错误，转成「没有已暂存的内容可提交」。

### IPC 通道

| 通道 | 参数 | 返回 |
|---|---|---|
| `git:stage` | `projectPath, paths` | `{ ok: true }` |
| `git:unstage` | `projectPath, paths` | `{ ok: true }` |
| `git:discard` | `projectPath, { tracked, untracked }` | `{ ok: true }` |
| `git:stage-all` | `projectPath` | `{ ok: true }` |
| `git:discard-all` | `projectPath` | `{ ok: true }` |
| `git:branches` | `projectPath` | `{ current, list }` |
| `git:checkout` | `projectPath, branch` | `{ ok: true }` |
| `git:create-branch` | `projectPath, name, startPoint` | `{ ok: true }` |
| `git:merge` | `projectPath, branch` | `{ ok: true, conflicted: string[] }` |

全部经现有 `assertProjectPath` 白名单校验。

## 交互设计

### 列表结构

```
▾ 已暂存                          3   [全部取消暂存]
    M  config.json        悬停: [目录] [取消暂存]
    A  new-file.ts        悬停: [目录] [取消暂存]

▾ 更改                            2   [全部放弃] [全部暂存]
    M  index.php          悬停: [目录] [放弃] [暂存]
    ?  草稿.md             悬停: [目录] [放弃] [暂存]
```

- 点击行主体 → 在终端页签查看该文件 diff（现有行为）
- 点击「目录」图标 → 在系统文件管理器中定位该文件
- 图标仅悬停时显示，减少视觉噪音

### 提交按钮

可用条件由 `hasChanges` 改为 `stagedCount > 0`。两段式（提交→推送）状态机不变。

未暂存但有改动时，按钮禁用并提示「先暂存要提交的文件」。

### 放弃的二次确认

复用现有 `ConfirmDialog`，文案按类型区分：

| 场景 | 文案 |
|---|---|
| 放弃已跟踪文件 | 「放弃对 `{path}` 的修改？此操作无法撤销。」 |
| 放弃未跟踪文件 | 「删除未跟踪文件 `{path}`？此操作无法撤销。」 |
| 放弃全部更改 | 「放弃全部 {n} 项修改？其中 {m} 个未跟踪文件将被删除。此操作无法撤销。」 |

已暂存分组的「全部取消暂存」**不弹确认**——它不丢数据。

### 分支切换

分支栏从纯文本变为按钮，点击弹出 `PopupMenu`：

```
develop            ✓
main                       悬停: [合并到当前分支]
feature/login              悬停: [合并到当前分支]
────────────────
＋ 新建分支…
```

- 列表来自 `git:branches`
- 点击非当前分支 → `git checkout`
- 点击「新建分支…」→ 弹 `Modal` 输入名称，确认后创建
- 当前分支在菜单中打勾且不可点
- 悬停任意非当前分支，出现「合并到当前分支」图标

**新建分支弹窗**包含两项：

1. 分支名称输入框
2. 起点分支下拉，选项为全部本地分支，默认当前分支

确认后执行 `git checkout -b <name> <startPoint>`，创建并立即切换。

**脏工作区阻止**：`stagedCount + unstagedCount > 0` 时，点切换或新建分支直接 toast「有未提交的改动，请先提交或放弃后再切换分支」，不发请求。

**合并**：`git merge <branch>`。

- 成功（fast-forward 或正常合并）→ toast「已合并 `<branch>`」，刷新状态
- 冲突 → 不自动解决、不自动回退，toast「合并 `<branch>` 时发生冲突，请到终端处理」，刷新状态（冲突文件会以 `!` 显示在更改组）
- 合并**不**受脏工作区限制，由 git 自己判断（git merge 在有未提交改动时通常会自行拒绝）

git 自身的保护作为兜底：若状态过期导致 git 拒绝，把 stderr 转成 toast。

**分支名校验**：非空、≤ 100 字符、不含空格与 `~^:?*[\`、不以 `/` 开头结尾、不含 `..`。重名时由 git 返回错误并提示。

## 状态与并发

- 每个操作独立 busy：`busyPaths: Set<string>` 记录处理中的文件路径，对应行图标禁用
- 分组级操作有各自的 `groupBusy` 状态，期间该组按钮禁用
- 同一文件同一时刻只允许一个操作，不同文件可并行
- 任何操作完成后调用 `refresh()` 重新拉取状态

## 涉及文件

| 文件 | 变更 |
|---|---|
| `desktop/git.js` | 新增 8 个函数；`commit` 移除自动 add；抽取 `resolveWithin` |
| `desktop/main.js` | 注册 8 个 IPC |
| `desktop/preload.js` | 暴露新 API |
| `src/types.ts` | `GitChange` 改为双状态；`GitStatus` 加计数 |
| `src/global.d.ts` | 补类型 |
| `src/components/GitPanel.tsx` | 分组列表、行内图标、分支菜单、新建分支弹窗、放弃确认 |
| `src/components/BranchMenu.tsx` | 新增，分支列表菜单（切换 / 新建 / 合并） |
| `src/components/NewBranchModal.tsx` | 新增，分支名 + 起点分支选择 |
| `src/App.tsx` | 注入新回调 |
| `src/styles.css` | 分组、行内图标、分支按钮样式 |
| `tests/git-core.mjs` | 新增暂存/放弃/分支的单元级测试 |
| `tests/git-panel.mjs` | 新增交互的端到端测试 |

## 测试

### git-core 新增场景

- 暂存单个文件后 `stagedCount` 增加、`unstagedCount` 减少
- 同一个文件既暂存又修改时，两处计数都包含它
- 取消暂存后状态回退
- 放弃已跟踪文件后内容恢复
- 放弃未跟踪文件后文件消失
- 越界路径在 stage / discard 中被拒绝
- 分支列表包含当前分支且置顶
- 新建分支后可指定起点，`current` 变为新分支
- 脏工作区下 `checkout` 被 git 拒绝
- 合并无冲突分支成功，当前分支包含对方提交
- 合并冲突时返回 `conflicted` 非空且不抛错

### git-panel 新增场景

- 两组分别显示正确文件
- 点行内「暂存」后文件移动到已暂存组
- 点「取消暂存」后移回更改组
- 点「放弃」弹确认框，取消则不改变文件
- 点「放弃」确认后文件恢复原内容
- 未暂存时提交按钮禁用
- 点分支栏弹出列表，切换后分支名更新
- 新建分支时可选择起点分支，创建后分支名更新
- 有改动时切换分支弹出提示且分支不变
- 悬停分支出现合并图标，合并后变更列表更新

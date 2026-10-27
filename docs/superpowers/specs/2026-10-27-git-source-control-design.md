# Git 源代码管理面板设计

日期：2026-10-27
状态：待实施

## 背景

Cmd Toolbox 目前只能通过终端操作 Git。用户需要在项目之间切换时频繁敲 `git status`、`git add`、`git commit` 来确认改动，打断工作流。目标是在侧边栏提供一个常驻的轻量 Git 面板，覆盖「看一眼改了什么 → 写一句提交信息 → 提交 → 推送」这条最高频的路径。

不做完整的 Git GUI：分支管理、合并、rebase、冲突解决等仍交给终端。

## 需求

### 功能范围

1. 显示当前项目的 Git 状态：分支、上游、ahead/behind、变更文件列表
2. 输入提交信息并提交全部变更
3. 提交后，同一个按钮变为「推送」，再点一次执行推送
4. 点击变更文件，在新终端页签里查看该文件的 diff
5. 非 Git 目录显示提示并提供「初始化仓库」按钮
6. 事件驱动刷新，不轮询

### 明确不做

- 暂存区管理（不做分文件 stage/unstage）
- 分支切换、合并、rebase、cherry-pick
- 冲突解决界面
- 自动推送（推送必须显式点击）
- 自动 `git push -u`（无上游时只提示，不替用户决定）
- Git 未安装时的自助安装引导

## 技术方案

### 选择：调用本机 git 命令

主进程通过 `child_process.execFile('git', args)` 执行。

理由：

- 复用用户已有的 git 配置：credential helper、hooks、LFS、`.gitattributes`、`core.autocrlf` 全部原生生效
- 无新增依赖。`package.json` 设置了 `npmRebuild: false`，引入 nodegit 这类原生模块会显著增加构建复杂度
- isomorphic-git 不支持 hooks 和 credential helper，推送需自行处理认证，大仓库 status 也明显更慢

前提是系统已安装 Git。项目本身已把 Git Bash 作为可选 shell，这个前提成立。未安装时返回明确提示。

### 架构

```
Renderer                          Main
─────────────────────────────     ──────────────────────────
App.tsx
  ├── gitStatusByGroup 状态
  ├── 刷新触发（切换/聚焦/终端回车/操作后）
  └── Sidebar
        └── GitPanel               desktop/git.js
              ↓ window.api.git         ├── status()
              └──────── IPC ────────▶  ├── commit()
                                       ├── push()
                                       ├── init()
                                       └── diffCommand()
```

`GitPanel` 只做展示和交互，不直接调用 `window.api`；回调由 `App.tsx` 注入。这样组件可以脱离 App 单独渲染测试。

## 数据模型

```ts
type GitChangeStatus =
  | 'modified' | 'added' | 'deleted'
  | 'renamed' | 'untracked' | 'conflicted';

type GitChange = {
  path: string;
  origPath?: string;        // 仅 renamed
  status: GitChangeStatus;
};

type GitStatus =
  | { ok: false; reason: 'no-git' | 'not-repo' | 'missing-dir'; message: string }
  | {
      ok: true;
      branch: string;
      upstream: string;     // 空字符串表示无上游
      ahead: number;
      behind: number;
      changes: GitChange[];
      hasChanges: boolean;
    };
```

## 主进程接口

### desktop/git.js

唯一执行 git 的模块，不含 UI 逻辑。

```js
runGit(cwd, args, { timeout })   // execFile，不拼 shell 字符串
status(projectPath)              // → GitStatus
commit(projectPath, message)     // → { commit, summary }
push(projectPath)                // → { upstream }
init(projectPath)                // → { ok: true }
diffCommand(projectPath, filePath, status)  // → { command }  完整命令行，供终端执行
```

- `execFile('git', args, { cwd, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 })`
- 提交信息作为独立参数传入，不经过 shell，杜绝注入
- `status` 使用 `git -c core.quotepath=false status --porcelain=v2 --branch -z`
- `-z` 以 NUL 分隔，中文和空格路径不被转义
- 超时：`status` / `commit` / `init` 为 15 秒，`push` 为 120 秒

### porcelain=v2 解析

| 首字符 | 含义 | 映射 |
|---|---|---|
| `1` | 普通变更 | 按 XY 两位判定 |
| `2` | 重命名 | `R old → new` |
| `?` | 未跟踪 | untracked |
| `u` | 未合并/冲突 | conflicted |

`2` 类型条目带两个路径（新路径在前，NUL 后为原路径）。`# branch.upstream` 与 `# branch.ab` 提供上游及 ahead/behind。

### IPC 通道

| 通道 | 参数 | 返回 |
|---|---|---|
| `git:status` | `projectPath` | `GitStatus` |
| `git:commit` | `projectPath, message` | `{ commit, summary }` |
| `git:push` | `projectPath` | `{ upstream }` |
| `git:init` | `projectPath` | `{ ok: true }` |
| `git:diff` | `projectPath, filePath, status` | `{ command }` |

`preload.js` 暴露为 `window.api.git.{status,commit,push,init,diff}`。

### 安全边界

所有 handler 校验 `projectPath` 必须是已保存项目的路径（与 `store.list()` 比对，Windows 下忽略大小写）。渲染进程无法对任意目录执行 git。

## 交互设计

### 面板位置

位于侧边栏 `sidebar-scroll` 内部底部，跟随滚动。侧栏收起时随内容一起隐藏。

### 两段式按钮状态机

```
idle ──输入提交信息──▶ ready
  ▲                     │ 点击「提交」
  │                     ▼
  │                 committing ──失败──▶ idle（toast 报错，保留输入）
  │                     │ 成功
  │                     ▼
  └──────committed◀─────┘
          │ 点击「推送」
          ▼
       pushing ──失败──▶ committed（toast 报错）
          │ 成功
          ▼
        idle
```

| 状态 | 按钮文案 | 可用条件 |
|---|---|---|
| `idle` / `ready` | `✓ 提交` + `Ctrl+Enter` | 输入非空且 `hasChanges` |
| `committing` | `提交中…` | 禁用 |
| `committed` | `↑ 推送` | 始终可用 |
| `pushing` | `推送中…` | 禁用 |

规则：

1. `committed` 是粘滞状态。提交成功后即使文件又变，按钮仍为「推送」
2. 提交成功后自动清空输入框
3. `committed` 状态下输入框只读，显示「已提交：`<message>`」
4. `committed` 状态下显示「继续编辑」文字按钮，点击回到 `idle`（清空已提交信息，输入框恢复可编辑）
5. `Ctrl+Enter` 在 `ready` 触发提交，在 `committed` 触发推送
6. 推送失败不回退到 `idle`，保持 `committed` 可直接重试
7. 切换项目时状态重置为 `idle`
8. 无上游时推送失败，提示「当前分支没有上游，请先在终端执行 `git push -u origin <branch>`」

### 变更列表

- 每行：状态字母（着色）+ 文件路径（相对项目根）
- 配色：`M` 橙、`A` 绿、`D` 红、`?` 灰、`U` 红、`R` 蓝
- 重命名显示为 `R  old → new`
- 超过 6 条时列表内部滚动（`max-height` + `overflow-y: auto`），复用全局滚动条样式
- 点击行：新建一个终端页签，写入 `command` 并回车

`git:diff` 返回的 `command` 已按平台拼好：

- 已跟踪文件：`git --no-pager diff -- "<path>"`
- 未跟踪文件：`git --no-pager diff --no-index -- <null> "<path>"`，其中 `<null>` 在 Windows 上是 `NUL`，其他平台是 `/dev/null`
- 路径用双引号包裹，兼容 cmd、PowerShell、Git Bash 三种 shell 的空格处理
- 路径含 `"` 或换行时拒绝并提示（Windows 文件名不允许 `"`，实际不会触发）

渲染侧只负责 `pty.write(sessionId, command + '\r')`，不在渲染进程拼命令行。

### 非 Git / 无 Git 状态

| 状态 | 面板内容 |
|---|---|
| `no-git` | 「未检测到 Git，请先安装 Git for Windows」，无操作按钮 |
| `not-repo` | 「当前项目不是 Git 仓库」+「初始化仓库」按钮 |
| `missing-dir` | 「项目目录不存在」，无操作按钮 |

## 刷新机制

事件驱动，不轮询。

| 触发 | 位置 |
|---|---|
| 切换项目 | `selectGroup` |
| 窗口获得焦点 | `window` 的 `focus` 事件 |
| 终端回车后 | `subscribeAllData`，输出含 `\r`/`\n` 时开始 800ms 防抖 |
| 提交/推送/初始化成功 | 对应回调内立即刷新 |
| 手动 | 面板标题栏刷新按钮 |

防抖只对「含换行的输出」计时，持续输出但不换行的进程不会触发刷新。同一项目 800ms 内最多刷新一次。

## 错误处理

| 场景 | 表现 |
|---|---|
| git 未安装 | 面板显示安装提示 |
| 不是 Git 仓库 | 提示 + 初始化按钮 |
| 目录不存在 | 沿用现有无效项目样式 |
| 提交信息为空 | 按钮禁用 |
| 提交失败（hook 拒绝等） | toast 显示 git stderr（截断 300 字符），输入框保留内容 |
| 推送失败（无上游等） | toast 提示，按钮保持「推送」可重试 |
| 并发操作 | `committing`/`pushing` 期间按钮禁用；git 调用有超时 |

## 测试

新增 `tests/git-panel.mjs`，沿用 `smoke.mjs` 的 Playwright + Electron 隔离实例模式。使用 `fs.mkdtemp` 创建临时仓库作为测试项目。

| 场景 | 断言 |
|---|---|
| 非 Git 目录 | 显示「初始化仓库」，点击后出现变更列表 |
| 干净仓库 | 不显示提交框，显示「没有变更」 |
| 有变更 | 文件数与 `git status --porcelain` 一致，状态字母正确 |
| 提交 | `git log -1 --pretty=%s` 等于输入内容 |
| 两段按钮 | 提交后按钮变「推送」，输入框只读 |
| 继续编辑 | 点击后回到「提交」，输入框可编辑 |
| 推送无上游 | toast 含「上游」，按钮仍是「推送」 |
| 中文/空格路径 | 列表正确显示，提交成功 |

不为 `desktop/git.js` 的解析函数单独写单元测试：porcelain 输出格式的问题只有在真实 git 上才暴露，构造字符串样本测的是对格式的假设而非 git 的实际行为。

手动验证清单：

- 浅色/深色主题下终端与面板滚动条均为一条
- 侧栏收起后无残影
- 项目较多时 Git 面板可滚动到
- 终端中执行 `git commit` 后列表自动更新
- 推送大文件时按钮不会提前恢复可用

## 涉及文件

| 文件 | 变更 |
|---|---|
| `desktop/git.js` | 新增 |
| `desktop/main.js` | 注册 5 个 IPC handler + 路径校验 |
| `desktop/preload.js` | 暴露 `window.api.git` |
| `src/global.d.ts` | 补 `window.api.git` 类型 |
| `src/types.ts` | 新增 `GitChange` / `GitStatus` |
| `src/gitStatus.ts` | 新增，刷新调度与缓存 |
| `src/components/GitPanel.tsx` | 新增 |
| `src/components/Sidebar.tsx` | 插入 GitPanel |
| `src/App.tsx` | 持有状态、注入回调、注册刷新触发 |
| `src/styles.css` | 面板样式 |
| `tests/git-panel.mjs` | 新增 |

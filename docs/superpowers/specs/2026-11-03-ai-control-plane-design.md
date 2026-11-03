# AI 控制面（AI Control Plane）设计

## 问题

应用里已经有 MCP 服务（`desktop/pane-api.js`，`127.0.0.1:17382`，带 token，已写入各 CLI 的
MCP 配置），但当前工具只能**读**已有窗格：`list_panes`、`get_pane_content`、
`browser_navigate/click/type/screenshot`。两类能力缺失：

1. AI 无法**新建**终端或浏览器页签，只能操作用户已经开好的。
2. AI 无法**在终端里执行命令并取回输出**。`pty:write` 只存在于渲染进程的 IPC，MCP 侧够不着。

结果是 AI 想自己跑一条命令、看一眼结果，仍得绕到自己的终端里另开一个 shell，与应用里的
窗格完全脱节。本设计把 MCP 从「观察者」扩展成「操作面」。

## 目标

- AI 能开可见的终端/浏览器页签，并在终端里执行命令、拿回干净的输出与退出码。
- 长任务的输出可以增量轮询，不必每次重发全部内容。
- AI 能操作已有终端（发按键、等某段输出出现）。
- 顺带把文件读写、Git 查询、编辑器联动一并暴露，减少 AI 自己拼命令和解析输出的需求。
- 不新增监听端口，沿用现有 token 鉴权，不弹确认拦截。

## 非目标

- 不做与用户页签隔离的「AI 任务专区」。
- 不做跨重启续跑的任务队列。
- 不改现有 CLI 页签的状态灯、未读判定等逻辑。

## 架构

### 新增 `desktop/ai-bridge.js`

现状问题：主进程发往渲染进程的通道都是单向的（`panes:sync`、`browser:open-url` 用 `send`）。
AI 需要「建好页签后把 tabId 告诉我」这种带返回值的调用，因此补一个请求/应答通道。

| 方向 | 通道 | 载荷 |
|---|---|---|
| 主 → 渲染 | `bridge:request` | `{ requestId, op, payload }` |
| 渲染 → 主 | `bridge:reply` | `{ requestId, ok, result?, message? }` |

- `aiBridge.request(op, payload, timeoutMs)` 返回 Promise；超时 reject 并清理挂起项。
- `mainWindow` 尚未加载完成时立即 reject（`ui-unavailable`），**不排队**。
- 渲染进程侧在 `preload.js` 暴露 `onBridgeRequest(handler)`，`App.tsx` 里集中注册一次，
  按 `op` 分派到已有的建页签逻辑。

`op` 列表（首版）。**注意两层命名不同**：`op` 是内部桥接动作（kebab-case），
MCP 工具名是对 AI 暴露的（snake_case），不要混用：

| op（内部） | 对应 MCP 工具 | 由谁处理 | 说明 |
|---|---|---|---|
| `create-terminal` | `open_terminal` | 渲染进程 | 调现有 `createTerminal`，返回 `{ tabId, paneNo, sessionId }` |
| `create-browser` | `open_browser` | 渲染进程 | 调现有 `createBrowser`，返回 `{ tabId, paneNo }` |
| `close-pane` | `close_pane` | 渲染进程 | 关闭指定页签，返回 `{ ok, closed }` |
| `open-file` | `open_file_in_editor` | 渲染进程 | 在编辑器里打开文件并聚焦对应页签 |
| `editor-content` | `read_editor_content` | 渲染进程 | 返回当前激活编辑器的内容与选中范围 |

**`pane` 引用格式**：所有工具里的 `pane` 参数与现有 `find_pane` 一致——支持 `tabId`、
`#<编号>`、`<项目名>#<编号>`。`open_terminal` / `open_browser` 返回的 `pane` 字段就是可直接
回传的 `#<编号>` 形式，同时附 `tabId` 与 `sessionId`。

### `pane-api.js` 退回成传输层

只保留：HTTP 路由、token 校验、JSON-RPC 编解码、`tools/list` 汇总各模块的工具定义。
业务实现分到四个模块，各自只依赖已有的后端能力：

| 模块 | 职责 | 依赖 |
|---|---|---|
| `desktop/ai-tools/panes.js` | 建/列/读/关窗格 | `aiBridge` |
| `desktop/ai-tools/jobs.js` | 执行命令、等待安静、任务句柄 | `ptyHost` |
| `desktop/ai-tools/files.js` | 读/写/列目录/搜索 | `file-api` |
| `desktop/ai-tools/repo.js` | Git 状态、diff、日志、符号查询 | `git.js`、`symbols.js` |

纯读操作（`read_file`、`git_status`）在主进程直接完成，不打扰渲染进程；只有产生可见界面
变化的操作才走 `aiBridge`。

## 终端执行

### `terminal_run`

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `command` | 必填 | 写入 pty 的命令，末尾自动补 `\r` |
| `pane` | 空 | 指定已有终端；不传则复用 AI 终端页签，没有就新建 |
| `quietMs` | 1200 | 连续多久无输出算「这一轮结束」 |
| `timeoutMs` | 60000 | 总超时，上限 10 分钟 |

流程：

1. 解析目标 pane。不传 `pane` 时，在**当前项目**里优先复用「AI 创建的、空闲、无正在跑的命令」
   的终端页签；没有才新建。AI 创建的页签带 `aiOwned` 标记，界面上可辨识。
2. 写入命令。
3. 监听该 session 输出，满足任一条件即返回：
   - **进程退出**（`pty:exit`）
   - **连续 `quietMs` 无新输出**（交互式命令不会退出，停下即代表本轮结束）
   - **总超时 `timeoutMs`**
4. 返回：

| 情况 | 返回 |
|---|---|
| 进程退出 | `{ status: 'done', exitCode, output, pane, jobId, cursor }` |
| 安静但仍在跑 | `{ status: 'idle', output, pane, jobId, cursor }` |
| 超时 | `{ status: 'running', output, pane, jobId, cursor }` |

`jobId` 始终返回；`cursor` 是本次已消费到的输出位置，供增量读取。

### 输出清理

pty 输出里满是 ANSI 控制序列与回车重绘（进度条会反复覆盖同一行）。返回前必须：

- 剥掉 CSI / OSC 序列
- 按 `\r` 处理行覆盖（保留最后一次覆盖的结果）
- 去掉行尾空白与连续空行

清理函数独立于 `ptyHost.getLastOutput` 的原始缓冲，不改动现有行为（`get_pane_content`
继续返回原始输出）。

### 增量读取

`job_output({ jobId, cursor })` 返回 `{ output, cursor }`，`output` 只包含自 `cursor`
以来的新增内容。cursor 以**已读字符数**计，不用行号——避免尾部半行被重复或丢弃。

### 任务句柄

job 常驻内存，绑定 `sessionId`；session 关闭或应用退出即丢弃，不落盘。

### 驱动已有终端

| 工具 | 说明 |
|---|---|
| `terminal_send` | `{ pane, text, submit }`。`submit` 默认 true 补 `\r`；false 用于交互式 CLI 逐键输入 |
| `terminal_wait` | `{ pane, pattern, timeoutMs }`。等到输出匹配正则即返回匹配片段与 `output`；超时返回 `status: 'timeout'` |

### AI 页签的界面表现

AI 创建的页签与普通页签**行为完全一致**（可点击、可手敲、可关闭、参与标签组与分屏、
随会话恢复），只在视觉上做最小区分：

| 项 | 取值 |
|---|---|
| 终端页签标题 | 固定 `AI 终端`，**不随命令变化**（避免连续执行命令时标题反复跳动） |
| 浏览器页签标题 | 用网页真实标题，不改写 |
| 图标 | 页签左侧一个 `Sparkles`（`lucide-react`）小图标 |
| 底色 | 淡紫或淡青的低饱和底条，与现有灰色调区分但不抢眼 |
| hover 提示 | 当前/last 命令全文 |
| 聚焦行为 | **不抢焦点**。AI 在后台执行时用户正在看的页签不变 |

落地为 `Tab` 类型新增 `aiOwned?: boolean`，`TabStrip` 据此渲染图标与底色；
`desktop/session.js` 需放行该字段以便重启后恢复。

### 页签回收

AI 不传 `pane` 时复用「AI 创建的、空闲、无正在跑的命令」的终端页签，没有才新建。
AI 创建的页签带 `aiOwned` 标记，重启会话后随普通页签一起恢复。

## 文件 / Git / 编辑器

### 文件（`ai-tools/files.js`）

| 工具 | 说明 |
|---|---|
| `read_file` | `{ project, path }`，返回文本内容与 mtime |
| `write_file` | `{ project, path, content, mtime? }`。带 `mtime` 时校验冲突，不一致返回 `file-changed` |
| `list_dir` | `{ project, path }` |
| `search_text` | `{ project, query, glob? }`，复用 `file-api.search` |

所有路径参数都过 `resolveWithin`（与文件树写入同一套校验：`..` 词法越界 + 符号链接逃逸）。

### Git（`ai-tools/repo.js`）

复用 `desktop/git.js` 的现成实现，不做新的 git 命令拼装：

| 工具 | 说明 |
|---|---|
| `git_status` | 分支、上游、ahead/behind、变更列表 |
| `git_diff` | `{ project, path?, base? }`，`base` 为 `'HEAD'` 时比工作区与 HEAD |
| `git_log` | `{ project, limit? }` |
| `find_symbol` | `{ project, name }`，复用 `symbols` 索引 |

### 编辑器（走 `aiBridge`）

| 工具 | 说明 |
|---|---|
| `open_file_in_editor` | `{ project, path }`，在编辑器页签打开并聚焦 |
| `read_editor_content` | 返回当前激活编辑器的相对路径、内容、是否有未保存修改 |

`read_editor_content` 有未保存修改时返回**内存内容**而不是磁盘内容，并在结果里标注
`dirty: true`。

## 安全

- **鉴权**：沿用现有 token（`mcp-token.txt`），所有新工具走同一个端点，不新增监听端口。
- **路径边界**：所有文件路径过 `resolveWithin`，AI 只能操作项目目录内。
- **cwd 绑定**：`terminal_run` 的起点固定为项目根，不接受任意 cwd。
- **监听地址**：保持 `127.0.0.1`。
- **不弹确认拦截**：与 CLI 自身在本终端执行命令等价；已有的 token 隔离是边界。

## 错误码

AI 侧需要稳定可解析的错误，不能只有一句中文：

| code | 触发条件 |
|---|---|
| `no-project` | 项目不存在、未打开，或当前没有激活项目 |
| `pane-not-found` | 找不到指定 pane |
| `pane-busy` | 该 pane 上已有 `terminal_run` 在跑（附 `jobId`） |
| `ui-unavailable` | 窗口未就绪或渲染进程未在超时内响应，**不重试** |
| `path-outside-project` | 路径越界 |
| `file-changed` | `write_file` 的 `mtime` 与磁盘不一致 |
| `bad-request` | 参数缺失或 `timeoutMs` 超过 10 分钟 |

命令超时**不是错误**，返回 `status: 'running'` + `jobId`。

## 并发

- 同一个 pane 不允许并发的 `terminal_run`；后到的返回 `pane-busy` 并带上正在跑的 `jobId`，
  否则两条命令的输出会交错，谁都读不准。
- 不同 pane 之间互不影响。

## 测试

### 离线 `tests/ai-tools.mjs`

用假 pty 与假 bridge，不启 GUI：

- 输出清理：ANSI 剥离、`\r` 覆盖保留最后一次、尾部空行裁剪
- 安静判定：`quietMs` 内无输出即返回 `idle`；有持续输出则不返回
- 进程退出优先于安静判定
- 增量 cursor：两次 `job_output` 不重复、不丢字符
- 并发：同 pane 第二次 `terminal_run` 返回 `pane-busy`
- 路径越界返回 `path-outside-project`
- 各错误码在最简输入下的返回形状

### 端到端 `tests/ai-bridge.mjs`

启动真实 Electron，用带 token 的 HTTP 请求直接打 MCP：

- `open_terminal` 后页签数量 +1，返回的 `pane` 可用于 `terminal_run`
- `terminal_run('echo hello')` 返回 `status: 'done'`、`output` 含 `hello`、`exitCode` 为 0
- 同一项目再调一次不传 pane，复用的是同一个 AI 终端页签（页签数不增）
- `open_browser` 后 `get_pane_content` 能读到页面文字
- 应用关闭后请求返回 `ui-unavailable`

测试启动时设 `CMDTOOLBOX_NO_UPDATE=1`，并独占 17382 端口。

## 分阶段

| 阶段 | 内容 | 独立可用 |
|---|---|---|
| 1 | `ai-bridge` + `open_terminal` / `open_browser` / `close_pane` | 是 |
| 2 | `jobs`：`terminal_run` / `job_output` / `terminal_send` / `terminal_wait`，含 AI 页签复用 | 是 |
| 3 | `files` + `repo` | 是 |
| 4 | 编辑器联动 | 是 |

每个阶段各自可验证、可发布，后续阶段不依赖前一个阶段未完成的部分。
**AI 页签复用属于阶段 2**——它是 `terminal_run` 不传 `pane` 时的行为，不是收尾工作。

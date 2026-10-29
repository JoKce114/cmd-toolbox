# Cmd Toolbox — 项目规则

Electron + React + TypeScript 的本地项目终端工作台，只面向 Windows。
本文件记录**不能从代码直接推断**的约定和踩过的坑。写代码前先读完。

## 版本与发版

- **唯一的版本号源头是 `package.json` 的 `version`**。改完必须同步 `package-lock.json`
  （`npm install --package-lock-only`），否则 `electron-builder` 会读到旧版本。
- 更新说明的唯一源头是 `CHANGELOG.md`，按 `## [x.y.z] - YYYY-MM-DD` 分节。
  `npm run dist` 会自动抽取当前版本那节生成 `release/更新说明-v<version>.md`。
- 应用内的更新公告正文**直接取自 GitHub Release 的 body**，不是这些 md 文件本身。

### 发版四步

1. 改 `package.json` 的 `version`
2. `CHANGELOG.md` 顶部补对应版本小节
3. `npm run dist`
4. GitHub 建 Release：tag 用 `v<version>`，把 `release/upload/` 里**三个文件全上传**，
   说明栏粘贴 `release/更新说明-v<version>.md` 的内容，Release label 选 **Latest**

### GitHub 网页操作（逐项对照）

`release/upload/` 里**固定是三个文件**，缺一不可：

| 文件 | 作用 |
|---|---|
| `CmdToolbox-<version>-setup.exe` | 安装包本体（约 81 MB） |
| `CmdToolbox-<version>-setup.exe.blockmap` | 差分更新校验 |
| `latest.yml` | 自动更新的版本索引（只有 348 字节，显示 "0.00 MB" 是正常的） |

新建 Release 页面要填的字段：

| 字段 | 填什么 |
|---|---|
| **Choose a tag** | 输入 `v1.0.1` → 点出现的 **Create new tag: v1.0.1 on publish** |
| **Target** | `main` |
| **Release title** | `v<version>` |
| **Release notes** | 粘贴 `release/更新说明-v<version>.md` |
| **Attach binaries** | `release/upload/` 全选拖入 |
| **Release label** | **Latest**（`None` 也能用；**绝不能选 Pre-release**） |

常见报错与原因：

- `tag name can't be blank` / `tag name is not well-formed` /
  `published releases must have a valid tag` —— 三句话说的是同一件事：
  **Tag 下拉框没填**。在框里打字 `v1.0.1` 即可，不必从列表里选。
- 顶部黄条 `This is a draft and won't be seen by the public unless it is published` ——
  之前发布失败存成了草稿，填好 tag 后按钮叫 **Update release**，不是 Publish release。
- 附件列表里只有 `.blockmap` 和 `latest.yml`、没有 setup.exe —— 主文件还在传，
  等 "Uploading your file now..." 结束；仍没有就重新拖一次。

发布后用 `https://api.github.com/repos/JoKce114/cmd-toolbox/releases/latest` 核对：
`tag_name` 正确、`draft=false`、`prerelease=false`、`assets` 里三个文件都是 `uploaded`。

### 发版铁律

- **`latest.yml` 必须上传**。漏了自动更新静默失效，只剩「前往下载」。
- **不能勾 Pre-release**。勾了 `releases/latest` 会跳过它，客户端收不到更新。
- **tag 必须带 `v` 前缀**（`v1.0.1`）。应用拿 `tag_name` 和本地版本比对。
- **`version` 必须比线上高**，否则装了新版也收不到提示。
- 应用的 Release 解析在 `desktop/updates.js`，只取 `tag_name` / `html_url` / `body`。

## 打包

- `npm run dist` → NSIS 安装包（`oneClick: false`，用户可自选安装目录）
- `npm run dist:portable` → 单文件便携版
- `npm run dist:dir` → 只解包，排查用
- `npm run notes` → 只重新生成更新说明和 `release/upload/`，不重新打包

### 构建失败：`UNKNOWN: unknown error, open ...CmdToolbox.exe`

**这不是代码问题，重试即可。** 本机装着 360 安全卫士（Windows Defender 实时保护是关的），
会扫描刚落地的 188MB exe，短暂锁住文件，`electron-builder` 写 asar 完整性信息时失败。

处理方式：直接重试打包，或把 `release/` 加进 360 白名单。不要为此改打包配置。

同类现象：`EPERM: operation not permitted, unlink` 也是 360 占用，等几秒重试。

### 依赖必须放对位置

`electron-builder` 会剥掉 `devDependencies`。**主进程运行时用到的包必须在 `dependencies`**：

- `electron-updater`
- `iconv-lite`（`desktop/file-api.js` 用）
- `node-pty`

放进 devDependencies 的后果是打包后启动即崩，报 `Cannot find module 'xxx'`。

`npmRebuild: false`，不要打开——node-pty 在 CI 上预编译有风险。

## 自动更新

两层是分开的，不要混：

| 模块 | 职责 |
|---|---|
| `desktop/updates.js` | 查 GitHub API：有没有新版本、版本号、更新说明、是否该弹公告。5 分钟缓存 |
| `desktop/updater.js` | 包着 `electron-updater`：下载安装包、重启安装 |

- 只有 `app.isPackaged` 时自动更新才可用，开发模式返回 `{ ok: false, message: '开发模式下不支持自动更新' }`
- `autoDownload = true`、`autoInstallOnAppQuit = false`：自动下载，但何时重启由用户点按钮
- 检查更新有三种模式（`App.tsx` 的 `runUpdateCheck`）：

  | 模式 | 弹公告 | 红点 | 显示「检查中…」 |
  |---|---|---|---|
  | `startup` | 是（每版本一次） | 是 | 是 |
  | `background`（每 30 分钟） | 否 | 是 | 否 |
  | `manual` | 否 | 是 | 是 |

- 后台轮询失败时**保留上一次结果**，否则网络抖动会让红点莫名消失
- 「上次看过哪个版本」存在 localStorage 的 `cmd-toolbox.seen-update`，
  首次为 null 时静默写入当前版本、不打扰用户

## 测试

### 离线可跑（不需要 GUI）

```bash
node tests/updates.mjs       # 版本比较、Release 解析、公告判定
node tests/git-core.mjs      # Git 后端逻辑
node tests/git-pull.mjs      # 拉取/推送/上游修复
```

### UI 测试（Playwright 驱动真实 Electron）

```bash
node tests/settings.mjs
node tests/git-panel.mjs
node tests/update-notify.mjs
node tests/smoke.mjs
```

- **UI 测试必须独占，先关掉正在运行的 Cmd Toolbox。** `desktop/pane-api.js` 写死了
  `DEFAULT_PORT = 17382`，端口被占时 `paneApi.start()` 直接 reject，窗口不会创建，
  表现为 `firstWindow: Timeout 30000ms exceeded`。这不是测试的问题，是端口冲突。
- 测试启动时应设 `CMDTOOLBOX_NO_UPDATE=1`，否则会真的打 GitHub。
  `tests/update-notify.mjs` 是例外：它用本地假服务器 + `CMDTOOLBOX_UPDATE_API` 覆盖接口地址。
- `tests/smoke.mjs` 依赖 `D:/project-demo` 下的固定样例目录，且断言里写死了
  `Users\Administrator>`。**本机（用户名 `10714`）跑不完，这是已知问题，不要误判为回归。**

### 测试改动 UI 文案时要同步

设置面板、公告弹窗的断言大量依赖中文文案。改文案前先 grep 一下 `tests/`。
「关于」页签必须排在设置面板第一位，`tests/update-notify.mjs` 有断言。
设置项按页签分组（关于 / 终端 / 编辑器 / 快捷键），新增设置项放进对应页签，
不要恢复成单页长列表。

## 已知的坑

- **设置面板滚动**：`.settings-body` 必须同时有 `flex: 1`、`min-height: 0`、
  `overflow-y: auto`。少了 `min-height: 0` 不会滚动——flex 子项默认不肯收缩。
- **删掉了本地启动器**：以前的 `scripts/build-launcher.ps1` + `native/Launcher.cs`
  会编译一个 40KB 的 exe 去拉起源码目录里的 Electron。**已整体删除，不要恢复。**
  现在的分发形态只有安装包和便携版。
- **GitHub 直连会被 reset**：本机 `github.com:443` 不通，SSH 走
  `~/.ssh/config` 里的 `ssh.github.com:443`。`electron-updater` 走 Chromium 网络栈，
  会尊重系统代理。
- **electron-builder 不读 Windows 系统代理**：只认 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量。
  下载 Electron 慢时先导出这两个变量。
- **winCodeSign 解压失败**（`Cannot create symbolic link ... darwin\...`）：
  是 macOS 符号链接需要管理员权限。用 `7za` 解包时排除 `darwin` 目录即可。

## 界面约定

- 标题栏底色是 `--surface: #ffffff`，红点（`.titlebar-update-dot`）用
  `box-shadow: 0 0 0 2px #fff` 贴合
- 滚动条样式是全局的 `::-webkit-scrollbar`（10px）和 `::-webkit-scrollbar-thumb`
  （圆角、`#d7d8de`），新面板直接复用，不要另写
- 弹窗统一用 `src/components/Modal.tsx`。注意设置面板本身也是 `.modal-card`，
  Playwright 里定位公告弹窗要加 `.announcement-actions` 过滤
- 侧栏折叠区统一用 `src/useCollapsedSection.ts`，状态存
  `cmd-toolbox.sidebar.collapsed.<id>`（`projects` / `git` / `git-history`）。
  折叠区标题都是 `<button>`，带 `aria-expanded` 和 `.section-caret.is-open` 箭头
- 侧栏项目行只显示项目名，完整路径放在 `title` 里。不要再加回第二行路径——
  它是左栏变拥挤的主要原因

## IPC 约定

`ipcMain.handle` → `desktop/preload.js` 的 `invoke()` 包装（带 `cleanError`）→
`window.api.*` → `src/global.d.ts` 类型声明。四处都要改，缺一个就是运行时错误或类型报错。

新增通道命名沿用 `<模块>:<动作>`，例如 `updates:check`、`updater:download`。

## 不要做的事

- 不要恢复已删除的本地启动器
- 不要把 `electron-updater` / `iconv-lite` / `node-pty` 挪进 devDependencies
- 不要打开 `npmRebuild`
- 不要在 `dist` 脚本里去掉 `--publish never`（防止环境里有 `GH_TOKEN` 时误上传）
- 不要为了绕过 360 的文件锁去改打包配置或加 `--no-verify` 之类的开关
- 不要把构建调试产物（`builder-debug.yml`）当成 Release 附件

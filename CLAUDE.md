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
- **更新说明按 Markdown 渲染**：公告弹窗用 `src/releaseNotes.ts` 解析
  `###` / `####` / `-` / `**加粗**` / `` `代码` `` 这几种子集，其余语法不会生效。
  写 `CHANGELOG.md` 时用这几种就够，别用表格、图片或链接语法——它们在弹窗里会变成纯文本。
- **说明长度上限 2400 字符**（`updates.js` 的 `NOTES_LIMIT`）。超过会被截断并加省略号，
  所以详细说明要控制在这个长度内。

## 打包

- `npm run dist` → NSIS 安装包（`oneClick: false`，用户可自选安装目录）
- `npm run dist:portable` → 单文件便携版
- `npm run dist:dir` → 只解包，排查用
- `npm run notes` → 只重新生成更新说明和 `release/upload/`，不重新打包

### 构建失败：`UNKNOWN: unknown error, open ...CmdToolbox.exe`

**这不是代码问题，重试即可。** 原因是 **Windows 搜索索引器（SearchIndexer.exe）**
在扫描刚落地的 188MB exe 以提取元数据，短暂锁住文件，
`electron-builder` 在 `addWinAsarIntegrity` 写 asar 完整性信息时失败。

实测确认（2026-10-29）：本机**没有装 360 / 火绒 / 金山 / 腾讯管家**，
Windows Defender 实时保护也是关闭的（`RealTimeProtectionEnabled: False`），
唯一相关的常驻进程是 `SearchIndexer.exe`（自动启动）。不要再去查杀软白名单。

处理方式：直接重试打包。想根治可以把 `release/` 从 Windows 搜索索引里排除
（设置 → 搜索 → 搜索索引器 → 排除该目录），不要为此改打包配置。

同类现象：`EPERM: operation not permitted, unlink` 也是索引器占用，等几秒重试。

### 依赖必须放对位置

`electron-builder` 会剥掉 `devDependencies`。**主进程运行时用到的包必须在 `dependencies`**：

- `electron-updater`
- `iconv-lite`（`desktop/file-api.js` 用）
- `node-pty`
- `php-parser` / `acorn` / `acorn-jsx`（`desktop/symbols.js` 用）

放进 devDependencies 的后果分三类：

- **启动即崩**：`iconv-lite` 在模块顶部 `require`（`desktop/file-api.js` 第 4 行，
  又被 `desktop/main.js` 启动时同步加载），打包后报 `Cannot find module 'iconv-lite'`。
- **可见降级**：`node-pty` 加载失败会退回管道模式，并在终端打印黄色提示
  （`desktop/pty-host.js` 的 `createPipeSession` 分支）；`electron-updater`
  加载失败时更新面板显示 unsupported 文案（`desktop/updater.js` 的 `loadUpdater`）。
- **静默返回空（JS）/ 查询失败（PHP）**：`php-parser` / `acorn` / `acorn-jsx`
  在 `desktop/symbols.js` 里懒 `require`（`loadPhpEngine()` / `parseJsSymbols()`），
  **第一次点击符号时**才出错。PHP 路径的 `require` 在 `try` 外，这次查询直接失败
  （卡片提示「暂时无法查询定义」）；JS 路径被 `catch` 吞成空结果，表现成
  「没有找到定义」，更难发现。

`npmRebuild: false`，不要打开——node-pty 在 CI 上预编译有风险。
node-pty 1.1.0 用的是 node-addon-api（Node-API，ABI 稳定），已在 Electron 45
（Node 24.22 / NAPI 10）上实测能加载并跑起 `cmd.exe`，所以升 Electron 不需要重建它。

## 自动更新

两层是分开的，不要混：

| 模块 | 职责 |
|---|---|
| `desktop/updates.js` | 查 GitHub API：有没有新版本、版本号、更新说明、是否该弹公告。5 分钟缓存 |
| `desktop/updater.js` | 包着 `electron-updater`：下载安装包、重启安装 |

- **判断「有没有新版」用 `latest.yml`，不是 GitHub API。** 未认证 REST API 只有
  **60 次/小时，且按出口 IP 计**（代理/VPN 常是共享 IP），所以旧实现经常弹
  「GitHub 接口请求过于频繁」。现在先取
  `https://github.com/<repo>/releases/latest/download/latest.yml`
  （Release 静态附件，走 CDN，**不占 API 配额**）：

  | 场景 | 是否请求 `/releases` |
  |---|---|
  | latest.yml 版本 ≤ 当前版本 | 否，一次都不打 |
  | 有新版本 → 要展示说明 | 是 |
  | 刚升级完 → 「已更新到」公告要列本次改动 | 是 |
  | latest.yml 404（还没传这个附件） | 是，退回旧逻辑 |

  不要改回「每次检查都打 API」。带 `If-None-Match` 的 304 **仍然扣配额**（实测），
  靠条件请求省不下来。
- **API 结果落盘**到 `userData/update-cache.json`，由 `main.js` 在 `whenReady` 里
  `updates.configure({ cacheFile })` 指定。重启应用后 5 分钟内直接用缓存，
  开发时反复重启不会打爆配额。
- **被限流时退避到 `X-RateLimit-Reset`**（没有这个头就退避 15 分钟），期间不再
  请求 API。有旧缓存就返回旧数据并带 `warning`，设置面板显示为
  「已是最新版本（…）（GitHub 接口请求过于频繁，约 N 分钟后自动恢复）」。
  这种情况下 latest.yml 仍然能回答「有没有新版」，只是公告里没有正文。
- 测试用 `CMDTOOLBOX_UPDATE_API` / `CMDTOOLBOX_UPDATE_YML` 覆盖两个地址。
  **假服务器必须同时提供 `latest.yml`**，只提供 `/releases` 会让检查停在 yml 分支。

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
node tests/updates.mjs       # 版本比较、Release 解析、公告判定、yml 主源、限流退避、落盘缓存
node tests/git-core.mjs      # Git 后端逻辑
node tests/git-pull.mjs      # 拉取/推送/上游修复
node tests/commit-diff.mjs   # 提交 patch 切分
node tests/login-item.mjs     # 开机自启动（假 app，不碰注册表）
node tests/status.mjs         # AI 状态分类、未读状态迁移
node tests/symbols.mjs        # 符号提取、项目查询、排序（离线）
node tests/file-ops.mjs       # 新建/复制/移动/删除到回收站（临时目录，不碰真实回收站）
node tests/diff-from-text.mjs # 文本差异生成 unified diff
node tests/untitled-path.mjs  # 虚拟路径判断与编号分配（离线）
```

- `tests/login-item.mjs` 用假 `app` 对象，**不会**读写真实注册表。
  开机启动在开发模式（`app.isPackaged === false`）下永久不可用，
  所以 UI 测试只能断言开关置灰与原因文案。

### 改了 `src/` 之后先重建再跑 GUI 测试

- UI 测试加载的是 `dist/index.html`，而 `dist/` 在 `.gitignore` 里。**改了 `src/` 之后必须先重建再跑测试**，否则测的是上一次构建的旧代码，表现为「测试全绿但功能没生效」或「先跑测试确认失败」这一步莫名通过。
- 重建用 `npx tsc --noEmit && npx vite build`。**不要用 `npm run build`** —— 它还会跑 `scripts/build-coninject.ps1`，把被跟踪的 `build/coninject.exe` 改脏，混进功能提交里。

### UI 测试（Playwright 驱动真实 Electron）

```bash
node tests/settings.mjs
node tests/editor-appearance.mjs
node tests/prefs-migration.mjs
node tests/git-panel.mjs
node tests/update-notify.mjs
node tests/smoke.mjs
node tests/browser-device.mjs    # F5 刷新与移动端模拟
node tests/browser-popup.mjs     # 内置浏览器 target="_blank" / window.open 开新页签
node tests/tab-status.mjs        # AI 页签状态灯与未读
node tests/tab-groups.mjs        # 标签组：建组/改名/改色/折叠/拖拽/重启恢复
node tests/editor-modules.mjs    # 压缩、语法诊断、外部改动自动重载
node tests/editor-goto-def.mjs   # Ctrl+点击弹卡片与跳转
node tests/editor-file-tree.mjs  # 文件树工具栏、右键操作、侧栏拖拽与对比
node tests/editor-untitled.mjs   # 空白窗口新建、另存为、编号复用、对比置灰与重启恢复
node tests/module-catalog.mjs    # 模块清单与默认开关（离线）
node tests/clipboard-image.mjs   # 剪贴板图片识别（会占用系统剪贴板）
node tests/device-emulation-probe.mjs
```

- **UI 测试必须独占，先关掉正在运行的 Cmd Toolbox。** `desktop/pane-api.js` 写死了
  `DEFAULT_PORT = 17382`，端口被占时 `paneApi.start()` 直接 reject，窗口不会创建，
  表现为 `firstWindow: Timeout 30000ms exceeded`。这不是测试的问题，是端口冲突。
- **测试崩溃后残留的 electron 进程会污染后续运行**。一次失败会留下 4 个 electron
  占着 17382，下一次直接起不来，看起来像「代码坏了」但其实是环境问题。跑测试前
  固定先清理：

  ```bash
  powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force"
  sleep 3
  netstat -ano | grep LISTENING | grep 17382 || echo PORT_FREE
  ```

  判断依据：如果失败位置在每次运行时都不一样，多半是端口争用而不是代码缺陷。
- 测试启动时应设 `CMDTOOLBOX_NO_UPDATE=1`，否则会真的打 GitHub。
  `tests/update-notify.mjs` 是例外：它用本地假服务器 + `CMDTOOLBOX_UPDATE_API` 覆盖接口地址。
- `tests/smoke.mjs` 依赖 `D:/project-demo` 下的固定样例目录，且断言里写死了
  `Users\Administrator>`。**本机（用户名 `10714`）跑不完，这是已知问题，不要误判为回归。**

### 测试改动 UI 文案时要同步

设置面板、公告弹窗的断言大量依赖中文文案。改文案前先 grep 一下 `tests/`。
「关于」页签必须排在设置面板第一位，`tests/update-notify.mjs` 有断言。
设置项按页签分组（关于 / 常规 / 终端 / 编辑器 / 模块 / 快捷键），新增设置项放进对应页签，
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
- **打包前必须先导出镜像**：electron-builder 也不读 `~/.npmrc` 的 registry，
  直连 GitHub 会卡到 `Timeout awaiting 'request' for 600000ms`。本机是 npm 走
  npmmirror 但打包直连，所以每次升 Electron 或第一次跑 `dist` 都要带上：

  ```bash
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
  ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
  npm run dist
  ```

  `node_modules/electron/dist` 存在**不代表**打包能拿到二进制——那是 npm 装依赖时
  下的，electron-builder 只认自己的 `%LOCALAPPDATA%\electron\Cache`。
- **打包报 `directory rename failed ... code=EPERM`**：索引器占着上次的
  `release/win-unpacked`，builder 会自己重试并最终成功，不用干预。
- **winCodeSign 解压失败**（`Cannot create symbolic link ... darwin\...`）：
  是 macOS 符号链接需要管理员权限。用 `7za` 解包时排除 `darwin` 目录即可。
- **编辑器字号/行高/字体只能由主题扩展设置**：`src/editorTheme.ts` 的
  `editorAppearanceExtension()` 负责，`src/styles.css` 不得再给 `.cm-editor`
  写 `font-size`、给 `.cm-scroller` 写 `font-family` / `line-height`。
  静态 CSS 优先级更高，写了会静默盖掉设置，表现为「改了没反应」且无报错。
- **行距是 0.05 步长的浮点**：写盘和读取都要 `Math.round(v * 100) / 100`，
  否则会存进 `1.2000000000000002` 这种值，设置里显示成一长串小数。
- **便携版的开机启动必须用 `PORTABLE_EXECUTABLE_FILE`**，不能用
  `process.execPath`——后者在便携版里指向解包后的临时目录，写进注册表后随即失效。
- **卸载要清开机启动项**：`build/installer.nsh` 的 `customUnInstall` 宏删掉
  HKCU Run 下的 `Cmd Toolbox` 值。值名与 `desktop/login-item.js` 的
  `LOGIN_VALUE_NAME` 是同一个字符串，**改名时两处必须同改**，
  否则卸载会留下一条指向已删除 exe 的死条目，每次开机弹错误。

## 终端

- **图片粘贴靠「模拟按键 + CLI 自己读剪贴板」**，应用不搬运图片。
  `Ctrl+V` → `clipboard:has-image` 判定 → `pty:alt-v` → `coninject.exe` 往
  `CONIN$` 写一组 Alt+V 的 INPUT_RECORD。Claude / Grok 绑 Alt+V，**opencode 绑 Ctrl+V**，
  所以 opencode 直接写 `0x16` 到 pty、不走注入器。
- **Electron 45 删掉了同步的 `clipboard.readImage()` / `writeImage()`**，只剩异步的
  `read()` / `write()` + `ClipboardItem`（`ClipboardItem.types`、
  `await item.getType(type)` 拿 Blob）。`hasImage` 必须写成
  `(await clipboard.read()).some(it => it.types.some(t => t.startsWith('image/')))`。
  用旧 API 会抛 TypeError 被 catch 吞成 `false`，**表现是「剪贴板里有图也贴不进去」，
  没有任何报错**——v1.3.1 升 Electron 45 时就是这么悄悄坏的。
  `tests/clipboard-image.mjs` 锁这个行为。

## 内置浏览器

- **`webContents.enableDeviceEmulation` 不能用在 `<webview>` 上**。实测请求
  375×667 时 `screen` 是对的，但视口被缩放成 `innerWidth=981 / innerHeight=1744`，
  媒体查询全错。移动端模拟只能靠前端：把 `<webview>` 元素本身设成设备尺寸，
  UA 用元素自带的 `setUserAgent()`（传空串还原）。见
  `src/deviceProfiles.ts` 与 `tests/device-emulation-probe.mjs`。
- **刷新快捷键要在主进程接管**。焦点在网页里时按键只会在 guest 渲染进程，
  应用层收不到。绑定放在 `app.on('web-contents-created')` 里按
  `getType() === 'webview'` 判断，**不要**依赖渲染进程的 `did-attach` →
  `panes:attach-browser` 时序（实测经常抢不到，导致监听挂不上）。
- **网页里的 `target="_blank"` / `window.open` 靠 `allowpopups` 属性 + 主进程拦截**：
  `BrowserPane` 的 `<webview>` 必须带 `allowpopups`，否则请求被 Electron 静默丢弃。
  React 会把布尔值从自定义元素上丢掉（属性根本不进 DOM），所以只能写
  `allowpopups={'true' as unknown as boolean}`——类型声明只认布尔值。
  真正弹不弹由 `pane-api.js` 的 `bindBrowserKeys()` 里 `setWindowOpenHandler` 决定：
  一律 `deny`，再按 webContentsId 反查 tabId 通知主进程，由 `App.tsx` 在**同一个项目**
  里开新浏览器页签。`main.js` 只放行 http/https，`mailto:` 交给系统。
- **`getWebContentsId()` 必须等到 `dom-ready`**。`did-attach` 时调用会抛
  「WebView must be attached to the DOM and the dom-ready event emitted」，异常被
  吞掉后主进程的 `guests` 映射永远是空的——表现为新窗口打不开，且没有任何报错。
  这也是 `panes:attach-browser` 曾经形同虚设的原因。
- 设备模拟与 `setZoomFactor` 互斥：进入模拟会把缩放归零，退出时还原。

## 标签组

对标 Chrome 标签分组。**组本身不存位置**，边界由「连续且 `tabGroupId` 相同的页签」
派生（`src/tabGroups.ts` 的 `groupRuns`）。由此推出几条必须守住的规则：

- **拖拽有两种载荷**：页签是 `TAB_DRAG_TYPE`，整组是 `TAB_GROUP_DRAG_TYPE`。
  整组拖动靠拖组标题——组内页签自己可拖，会先一步截获拖拽，所以标题元素
  必须 `draggable`，**里面的按钮绝不能加 `draggable={false}`**：Chrome 会因此
  把整个祖先节点的拖拽一起禁掉，表现为「组标题拖不动」，而且时灵时不灵
  （取决于 mousedown 落在按钮还是标题留白上）。
- **视觉上靠三件事区分组成员**：彩色药丸组名、组容器浅底色、容器底部通栏色条。
  组标题必须用**实心**彩色，不能用浅色底——浅底会被误读成「被选中的页签」。
  组内选中页签浮白 + 彩色描边 + 项目名用组色，和组外页签的选中观感保持一致。
- **折叠靠 `grid-template-columns: 1fr → 0fr` 过渡**，组内页签**不能卸载**
  （早先是 `collapsed ? null : tabs.map(...)`，那样没有动画可播）。内层要
  `min-width: 0` + `overflow: hidden`，外层的 `data-*`/`aria-hidden` 按折叠态给。
  `max-width` 方案不行——内容宽度是动态的，得写死数值才过渡得了。
- **页签文字的行盒要容得下中文**：`.tab-title` 的 `line-height` 不能是 `1`。
  12px 字号在 `line-height: 1` 下行盒只有 12px，中日韩字形实际要 14px，
  多出来的部分被祖先的 `overflow: hidden` 切掉，表现为「文字上下被削」。用 1.35。
- **组内页签必须显式撑满**：`.tab-group-tabs` 是 grid、内层是 flex，
  不写 `height: 100%` + `align-items: stretch` 时页签会塌到内容高度（实测 20px，
  组外是 42px），同样表现为文字被切。
- **拖拽态必须在落点处理函数里清**。拖进/拖出标签组会换父容器，React 卸载旧节点，
  挂在页签上的 `onDragEnd` 收不到，`draggingId` 会永远停在那个页签上，表现为它一直
  是 `opacity: 0.4` 的半透明灰。三个落点（页签 / 组标题 / 空白处）各自清一次；
  `window` 上再挂一个**捕获阶段**的 `dragend` 兜住拖到窗口外松手的情况——冒泡阶段
  不管用，处理函数里的 `stopPropagation()` 会挡掉。
- **组内必须连续**。任何改变顺序的操作都要维持它：新页签用 `insertTabIntoList()`
  插到组末尾，加入已有组用 `moveById()` 贴到组尾。直接把页签 append 到数组末尾
  会把一个组拆成两段，界面上出现两个同名组标题。
- **组只存在于左栏**。`placeTab` 的 `half === 'right'` 会清掉 `tabGroupId`；
  恢复会话时右栏页签也一律清组。分屏时右栏的 `TabStrip` 因而永远不会渲染出组。
- **空组由 `applyTabs()` 统一回收**（`pruneTabGroups`）。关闭页签、移出组、
  取消分组都走这条路，不要在别处再删组。
- **折叠组的激活页签自动展开**（`App.tsx` 里的 effect）。折叠动作本身会把激活
  页签移到组外；组外一个可见页签都没有时把选中项置空，由 `EmptyState` 接管画面。
  选下一个可见页签时必须把**其他已折叠的组**一起排除，否则会挑中隐藏页签，
  自动展开效应立刻把那个组弹开，两个组来回打架（表现为「第三个组怎么也折不上」）。
- **非分屏的 `TabStrip` 也要传 `onPlaceTab`**。只在分屏时传的话，拖到页签栏空白处
  会被 `handleStripDrop` 直接忽略，组里的页签就退不出来——只能精确落到某个组外
  页签上，而组后面往往是一大片空白。
- **落盘形状统一走 `buildSessionSnapshot()`**。三处保存（分屏比例防抖、
  `saveSync` 关窗、200ms 防抖）共用它，加字段只改这一处——之前三份拷贝里
  有两份漏了 `device`。
- **`desktop/session.js` 按项目校验组**：没有页签引用、跨项目引用、id 重复的组
  全部丢弃；指向不存在组的 `tabGroupId` 置空。名字截断到 30 字符，颜色必须在
  枚举内（`TAB_GROUP_COLORS`），主进程和渲染进程各有一份，改的时候两处同改。

## 编辑器模块

模块是「能力」的容器：格式化已整体移除，现在是 **JS 压缩**（不需要开关，
保存时自动执行）、**JS / PHP 语法诊断** 和 **Ctrl+点击符号跳转**
（后两者在设置里各有开关，点保存才生效）。

- **压缩配置必须与 VS Code 的 Nu-Minify 扩展一致**，`src/modules/minify.ts` 的
  `MINIFY_OPTIONS` 是从它的 `package.json` 默认值照搬的。实测用同一份配置能
  **逐字节复现**项目里存量的 `.min.js`。terser 的默认值不同（多开
  `collapse_vars`/`reduce_vars`、少开 `hoist_funs`、不折行），换回默认会让
  同一个源文件压出差异很大的结果，交叉压缩时产生无意义的巨量 diff。
- **顶层名绝不能缩写**。terser 的 `toplevel` 默认就是 false，别打开：
  `global_obj` 被 293 个 PHP 模板和其他脚本引用、`methods` 339 个、`meta` 368 个，
  改名会让它们全部 `ReferenceError`。Nu-Minify 本身也没做这件事。
- **压缩的触发条件是「同名 `.min.js` 是否存在」**，不是设置开关。不存在就绝不
  创建；存在才在每次保存时覆盖（哪怕源文件没改）。钩子挂在
  `useEditorFiles.save()` 里 `if (!current.dirty) return false;` **之前**。
- **压缩失败不能导致保存失败**（terser 报错只推 toast）。
- **`.min.js` 只能由文件树右键「生成 xxx.min.js」创建**，编辑器右键菜单已移除。
- **`files.write()` 不能创建新文件**（第一行 `fsp.stat` 会抛），新建产物走
  `files:write-minified`。
- **php-parser 需要 `process` shim**：它的 `src/lexer/numbers.js` 在模块加载时读
  `process.arch`，渲染进程没有这个全局会 `ReferenceError` 把整个页面带崩（表现
  为 PHP 诊断永远没有标记）。`diagnose-php.ts` 的 `installProcessShim()` 只在
  import 期间临时挂 `{ arch }`，`finally` 里还原。**不要改用 vite `define`**——
  它会全局文本替换所有依赖里的 `process.*`，影响 xterm 之类按平台分支的库。
- **`ts`/`tsx` 不挂诊断**：acorn 不认识类型注解，挂上会满屏误报。设置项因此叫
  「JS / JSX 语法检查」而不是「JS / TS」。
- **模块依赖按使用方分开放**：只被前端 `import` 的放 `devDependencies`（vite 打进
  bundle，运行时不从 node_modules 读），主进程也 `require` 的必须放 `dependencies`；
  后果见「打包 → 依赖必须放对位置」。

### 编辑器自动重新加载

- **激活页签的外部改动会自动重新载入，静默不提示**（2 秒一轮，`reloadFromDisk`）。
  这是为了对齐 VS Code：压缩更新了开着的 `.min.js`、git 切分支、外部工具改文件，
  用户切回来都该看到磁盘上的真实内容。
- **有未保存修改时一律跳过**，绝不覆盖用户手上的内容。
- **压缩完成后必须主动调 `reloadFromDisk(target)`**，不能只靠轮询：轮询只盯激活
  页签，而保存 `global.js` 时激活的是源文件，`.min.js` 永远轮不到。

### 符号跳转与简介（Ctrl+点击）

- **解析在主进程**（`desktop/symbols.js`），不在渲染进程。要遍历文件系统，
  且全量解析会卡住编辑器输入。
- **用持久化索引，不要退回「每次点击现搜 + 预算截断」**。早期实现是点击时遍历
  项目、按文件数/条目数/解析数三重预算截断，在真实项目上直接失效：
  `develop-6.0` 有 79600 个目录项、4499 个 PHP 文件，任何预算都会漏掉后半部分，
  表现为「明明有定义却提示找不到」。现在改为：打开项目时全量扫描一次建索引
  （逐行正则，实测 5540 文件约 2.3 秒），落盘到 `userData/symbol-index/<hash>.json`
  （约 1.5MB），之后查询只读索引（毫秒级），**没有任何截断**。
- **索引只用正则取名字和行号，签名和 docblock 命中后再由 AST 补**。
  全量跑 AST 太慢（`php-parser` 约 22ms/文件），而命中的通常只有 1-3 个文件，
  读那几个文件解析即可。索引条目的 key 统一用小写（PHP 标识符不区分大小写），
  条目里保留原始写法。
- **扫描时不能用 `^` 锚定行首**：PHP 文件首行常是 `<?php function foo()`，
  名字前面还有 `<?php ` 前缀，锚定行首会漏掉第一行声明。用「非标识符字符」作左边界。
- **索引失效有两条路**：应用内保存（`fs:write` / `fs:write-minified`）后主进程调用
  `symbols.invalidate(projectPath)` 立刻丢内存索引，下次查询同步重建；
  外部改动（git 切分支等）靠 10 分钟 TTL 后台重建，期间继续用旧索引。
  **磁盘索引只是缓存**，删掉只会让下次重建。其余改盘通道（`fs:create-file` /
  `fs:create-dir` / `fs:copy` / `fs:move` / `fs:trash`）见「文件树与对比」小节。
- **`currentPath` 来自渲染进程，必须过 `resolveWithin`**：除了 `..` 词法越界，
  还要挡「项目内的符号链接指向项目外」，否则读它等于读项目外的文件。
- **`self::` / `static::` / `$this->` 的接收者不是类名**，要按光标行号找出所在类
  （`enclosingClassName`）再比较；所以渲染侧必须把光标行号一起传下来。
- **PHP 变量只在当前文件里找**：赋值行（`$x = …`）和函数参数声明
  （`function foo($x, …)`）都算。**不要跨文件搜变量**——同名局部变量到处都是，
  全项目搜索只会列一堆无关候选。
- **`php-parser` 的 `name` 是 Identifier 对象**（`{ name: 'foo' }`），不是字符串；
  类的 docblock 挂在类节点的 `leadingComments`，方法的挂在自己节点上，要分开取。
- **签名用源码切片，PHP 和 JS 的截断规则不同**：PHP 切到第一个 `{` 或 `;`
  （`sourceSignature(..., ['{', ';'])`）；JS 按括号配对找到参数列表的 `)`
  （`jsSignature`），箭头函数没有参数括号时退到 `=>`。不要用 AST 重拼参数——
  重拼会丢默认值写法和类型原样；也**不要对 JS 用 `{` 截断**，解构参数和默认值里的
  `{` 在括号内部，按第一个 `{` 切会把签名切坏。
- **卡片用 CodeMirror 的 `showTooltip` facet 承载 React 节点**，`create(view)`
  拿到的 view 用来关闭卡片。
- **`onGotoLineApplied` 是 `CodeMirrorHost` 的必填 prop**：定位完成后调用它，
  上层必须据此把 `gotoLine` 复位成 `null`。漏传会让 `prevGotoLineRef` 一直停在
  上一次的值，从第二次跳转起全部静默失效。
- **跨文件跳转要等内容就绪**：`open()` 是异步的，loading 阶段挂的是空文档，
  此时设置 `gotoLine` 会被 clamp 到第 1 行且不会重跑。必须等目标文件
  `loading` 变 `false` 后再设置 `gotoLine`。
- 模块关闭时 Ctrl+点击**不拦截**，保持 CodeMirror 原生多光标行为。

### 空白窗口（Untitled）

- **空白窗口用虚拟路径 `untitled://N` 当 `files` 的键**，对上层完全透明：
  `activePath`、对比、打开的编辑器列表都当普通 `relPath` 用。判断只有一处
  `src/untitledPath.ts` 的 `isUntitledPath()`，**所有碰磁盘或 mtime 的地方必须先过它**
  （`open` / `save` / `reloadFromDisk` / 2 秒轮询 / 自动压缩）。不要在调用方各自
  `startsWith`——漏一处就会拿伪路径去读磁盘，表现是每 2 秒报一次错。
- **新建入口只有两个**：页签栏右侧的 ＋（`.editor-tab-add`）和页签右键菜单
  「新建空白文件」。页签标题、顶部路径和「打开的编辑器」都走
  `displayNameFor()`，虚拟路径显示成 `Untitled-N`；顶部路径**只展示文件名**，
  完整相对路径放在 `.pane-path` 的 `title` 属性里（测试靠它区分同名文件，
  `editor-goto-def.mjs` 的 `openFile()` 用的就是 `title`）。
- **保存 = 另存为**：`save()` 对虚拟路径直接返回 `'unchanged'`，拦截在 `handleSave` 里。
  `saveUntitledAs` 必须**先 `createFile` 写盘成功、再原子换键**；反过来一旦写盘失败
  会留下指向不存在文件的页签。
- **换路径后不能重新 `open()`**：`EditorPane` 要先改 `appliedPathRef.current` 再调
  `onFilePathChange`，否则上层 `tab.filePath` 变化会触发重新读盘，撤销栈全丢。
  `CodeMirrorHost` 会识别 `untitled://N → 真实路径` 并保留同一个 `EditorView`。
- **`readOnly` 走 CodeMirror 的 Compartment，不参与 `EditorView` 重建**。
  不要把它加回重建依赖：另存为换路径时重建实例会丢掉撤销栈和光标。
- **编号复用最小可用值**：关掉 `Untitled-1` 再新建拿到的还是 `Untitled-1`。
- **空白窗口不能与磁盘版本或 Git HEAD 比较**（没有对应版本），菜单置灰 + 函数内兜底。
  两个空白窗口互比允许。
- **内容要进会话**：空白窗口没有磁盘文件可读，`session.json` 的 `untitledContents`
  按 `groupKey|untitled://N` 存内容，单窗口 256K 字符、总计 2M 字符上限
  （`desktop/session.js` 按字符数计，不是字节）。超限条目丢弃并记进 `untitledDropped`，
  恢复成空窗口但保留编号；会话文件不是存大文件的地方。
- **恢复出来的窗口带 `sessionOnly` 标记**：它不算 dirty，但内容只存在于会话里，
  关闭时必须确认（`losesSessionContent()`）。另存为落盘后清掉这个标记；恢复后又
  编辑过时 `dirty` 与 `sessionOnly` 同时成立，关闭文案要把两种后果都说清楚。
- **另存为用 `SaveAsModal`，不要用 `window.prompt`**——Electron 渲染进程里它直接抛错。

### 文件树与对比

- **所有文件操作都经 `resolveWithin`**（`desktop/file-api.js`）。`createFile` 用
  `fsp.open(..., 'wx')`、`createDir` 对目标目录**不带** `recursive`、**`copy` 总是、
  `move` 仅在非纯大小写重命名时**先 `lstat` 目标——除「仅改大小写」的重命名外，
  **目标已存在一律报错，设计上绝不覆盖**。
  父目录可以用 `recursive: true` 创建，这不算覆盖。
- **`move` 必须放行纯大小写重命名**：Windows 文件系统不区分大小写，`lstat(to)`
  命中的就是源文件本身，不能据此判冲突（否则 `a.txt → A.txt` 永远失败）。实现是先
  改到临时名再改到目标名，第二步失败要改回原名。`lstat` 与 `rename` 之间的 TOCTOU
  是有意保留的，别改成 `COPYFILE_EXCL`——会丢目录属性、拖慢大文件。
- **`copy` 是真复制，不能实现成移动**：设计稿要求「剪切粘贴 = 移动」「复制粘贴 =
  真复制」。用 `fsp.cp({ recursive: true, errorOnExist: true, force: false })`，
  不要用 read+write——那样拷不了目录、也会破坏二进制。失败时删掉目标半成品，且只
  清理本次新建的祖先目录，用户原有目录不能碰。
- **删除走 `shell.trashItem`**（系统回收站），不用 `unlink`；单测通过注入 shell
  验证，不碰真实回收站。**必须先等 trash 成功再关页签**（`EditorPane.confirmDelete`），
  失败时页签原样保留——反了会留下指向不存在文件的编辑器。有未保存修改时确认框要点明
  「不可恢复」；删目录时按 `relPath + '/'` 前缀收集其下 dirty 页签并报数量，
  目录路径本身不在 `files` 里。
- **所有改盘 IPC 成功后都调 `symbols.invalidate(projectPath)`**：`main.js` 的
  `fs:write`、`fs:write-minified`、`fs:create-file`、`fs:create-dir`、`fs:copy`、
  `fs:move`、`fs:trash` 都要调，文件树的「刷新」也会先失效一次。漏了会表现为新建的
  文件 Ctrl+点击查不到定义。不要只在保存时清。
- **文件剪贴板是应用内的**（`src/fileClipboard.ts`），不碰系统剪贴板。比较项目路径前
  必须归一：反斜杠转 `/`、去尾斜杠与结尾 `/.`、转小写；空项目路径要 fail-closed
  拒绝，不能当成同一项目。复制粘贴后**保留**剪贴板（可连续粘到多个目录），
  剪切粘贴后**清空**。
- **新建 / 重命名用 `Modal`（`NamePromptModal`），不要用 `window.prompt`**——Electron
  渲染进程没有实现它，调用会直接抛错。名字校验：非空、不能是 `.` / `..`、
  不能含 `/ \ < > : " | ? *`。
- **新建落点没有「选中目录」这回事**：文件树没有选中态。工具栏两个按钮统一落在
  **当前打开文件所在目录**，没打开文件时落在项目根；右键菜单落在被点那行的目录
  （文件取父目录，目录取自身）。不要照需求稿写成「选中项若是目录就用它」。
- **侧栏宽度可拖拽**：默认 220、最小 160、上限为容器宽度的一半，持久化在
  `cmd-toolbox.editor.sidebar-width`，**只在松手时写盘**。多个编辑器实例通过自定义
  事件 `editor-sidebar-width-change` 同步（`storage` 事件兜跨窗口）。**隐藏页签实测
  宽度为 0 时，上限应视为无穷**（此时不能取最小宽度），否则同步来的宽度会被夹成 160。
- **左栏两个折叠区用 `useCollapsedSection`**，id 是 `editor-open-editors` 与
  `editor-file-tree`，状态存 `cmd-toolbox.sidebar.collapsed.<id>`。文件区是 `is-grow`
  （吃掉剩余高度并自己滚动）。
- **对比的三种编辑器模式共用 `DiffPane` 的 `text` 变体**：与磁盘版本、两文件互比、
  与 Git HEAD 都由 `buildTextPatch`（`src/diffFromText.ts`）在渲染进程算 unified diff，
  `text` 变体不读磁盘也不读 git。**不要写成「复用 git 的 patch」**：HEAD 模式只用
  `git.fileDiff(..., 'HEAD')` 取 `baseContent`，patch 仍在渲染侧生成；`DiffPane` 的
  `change` / `commit` 变体才直接消费 git patch。
- **`git.fileDiff` 的 `base` 是可选的**：不传是「暂存区 vs 工作区」（普通 `git diff`），
  传 `'HEAD'` 才是「HEAD vs 工作区」。带 base 且文件未跟踪时 git 没有可比版本，
  后端直接拼「全部新增」的 patch；Windows 下 `--no-index NUL` 会 ENOENT，不要改回去。
- **对比打开期间编辑器仍可编辑，patch 必须跟内存内容实时重算（300ms 防抖）**。
  基准文本在打开对比时就取好存进 `DiffSource`，重算只依赖两个 content 字符串；
  不要每次按键都重读磁盘 / git，也不要不防抖。
- **开关对比不能卸载编辑器**：`CodeMirrorHost` 始终挂在同一位置，对比只改父容器
  `.editor-diff-split` 的 flex。撤销栈、光标和滚动位置才能保留；不要写成
  `diffTarget ? 对比 : 编辑器` 的条件渲染。
- **不做文件快捷键、不做树内拖拽移动**：需求明确不要快捷键；拖拽移动要处理树内拖放、
  跨目录与视觉反馈，工作量远大于本次其它功能。侧栏拖拽只调宽度，不移动文件。

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
- **空仓库（还没有任何提交）返回 `reason: 'no-commit'`**：发布前先
  `rev-parse --verify --quiet HEAD` 确认有提交，不要等 `git push` 输出 refspec 错误再猜。
- **只有真正的非快进 / 分叉才补写上游配置并返回 `reason: 'rejected'`**：远端已有同名分叉分支时
  `push -u` 被拒且不会写上游，后端会紧接着串行执行
  `git config branch.<branch>.remote <remote>` 与
  `git config branch.<branch>.merge refs/heads/<branch>`（必须串行，否则争用
  `.git/config.lock`），再返回被拒结果。漏掉这步，后续「拉取合并 / 拉取变基」
  会立刻撞上 `no-upstream`，只剩强制推送一条路。
- **判定分叉只认 `non-fast-forward` / `fetch first` / `stale info`，不要用裸 `rejected`**：
  `[remote rejected] ... (pre-receive hook declined)` 这类 hook / 保护分支拒绝里远端
  根本没有该分支，按分叉处理会补写出指向不存在远端分支的上游配置，之后 `git status`
  报 upstream 但分支栏的「发布」入口已经消失。这类拒绝应直接抛错，并带出服务端给出的拒绝原因。
- **不要在 `no-upstream` 时提示用户去终端执行 `git push -u`**——那正是这条路径原本不可用的原因。
- `tests/git-pull.mjs` 覆盖发布、远端优先级、空仓库与游离 HEAD；`tests/git-panel.mjs` 的 5e 覆盖界面。

## 界面约定
- 标题栏底色是 `--surface: #ffffff`，红点（`.titlebar-update-dot`）用
  `box-shadow: 0 0 0 2px #fff` 贴合
- 滚动条样式是全局的 `::-webkit-scrollbar`（10px）和 `::-webkit-scrollbar-thumb`
  （圆角、`#d7d8de`），新面板直接复用，不要另写
- 弹窗统一用 `src/components/Modal.tsx`。注意设置面板本身也是 `.modal-card`，
  Playwright 里定位公告弹窗要加 `.announcement-actions` 过滤
- 侧栏折叠区统一用 `src/useCollapsedSection.ts`，状态存
  `cmd-toolbox.sidebar.collapsed.<id>`（`projects` / `git` / `git-history` / `git-stash`）。
  折叠区标题都是 `<button>`，带 `aria-expanded` 和 `.section-caret.is-open` 箭头
- 侧栏项目行只显示项目名，完整路径放在 `title` 里。不要再加回第二行路径——
  它是左栏变拥挤的主要原因
- 设置页签顺序固定为 **关于 / 常规 / 终端 / 编辑器 / 模块 / 快捷键**，「关于」必须第一位
  （`tests/update-notify.mjs` 有断言）。编辑器页签内部按 字体 / 显示 / 缩进 三组排列，
  组标题是 `.settings-group-title`
- 设置面板里凡是需要写系统状态的操作（如开机启动），一律在点「保存」时执行，
  不能切开关就立即生效，否则「取消」会名不副实
- **AI 页签状态灯只给 AI 页签**（`isCliTool(tab.shellId)` 为真）。普通终端退出时
  也会触发 `subscribeExit`，不加判断会给 cmd 页签也挂上灯。传给 `TabStrip` 的
  `modelStatusBySession` / `unreadBySession` 已在 `App.tsx` 里按 AI 页签过滤。
- **未读判定要按左右分栏算**：分栏时两侧页签同时可见，只比单个 `activeTabId`
  会把用户正在看的页签误标未读（用 `activeTabByGroupRef` + `rightActiveByGroupRef`）
- **空闲阈值是 `IDLE_RESET_MS = 15000`**。AI 等慢命令时可能十几秒不出字节，
  调短会误判「已完成」并制造假的未读提示
- **收尾标记能把「跑完」的判定从 15 秒缩到 3 秒**（`TURN_DONE_IDLE_MS`）。
  Grok 打 `Worked for 42s`、Claude Code 打 `✻ Baked for 1s · done 11:41`
  （动词每次不同，所以按 `· done` 认，不按动词）。`endsWithTurnDone()` 会往回看
  3 行，因为标记和提示符之间夹着一条分隔线。**不要认 `Thought for …s`**——
  那是思考中的计时，认了会在思考阶段误判结束
- **实测（2026-10-30）：AI 停在输入框时 pty 完全静默**，60 秒零字节，光标闪烁是
  xterm 自己画的、不产生 pty 输出。所以别把「灯不落绿」归咎于重绘帧——先把
  收尾标记对上。`visibleSignature()` 只拿来滤掉纯控制序列与耗时计数这类噪声，
  不是判定依据
- 别再为状态灯去读 xterm 缓冲区：`subscribeAllData` 的回调早于 TerminalPane 的
  `term.write()`（`ptyBus` 先跑全局处理器再跑会话处理器），加上 write 本身是异步的，
  读到的永远是上一帧甚至更早，表现为「快速回答全程不亮蓝」

## AI 控制面（MCP）

`desktop/pane-api.js` 是传输层（HTTP 路由 + token + JSON-RPC），工具实现分在
`desktop/ai-tools/` 下，**不要把它重新写成一个什么都装的大文件**。

- **主进程要渲染进程做事必须走 `desktop/ai-bridge.js`**。现有通道（`panes:sync`、
  `browser:open-url`）都是单向 `send`，拿不到返回值；建页签的代码在渲染进程
  （`App.tsx` 的 `createTerminal` / `createBrowser`），主进程只能委托。
- **桥接 op 与 MCP 工具名是两套命名**：op 用 kebab-case（`create-terminal`），
  MCP 工具名用 snake_case（`open_terminal`）。改名字时两处都要改。
- **窗口未就绪时 `aiBridge.request` 立即 reject（`ui-unavailable`），不排队**。
  排队会让 AI 以为操作已被接受。渲染进程超时未回包同样按 `ui-unavailable` 处理。
- **`terminal_run` 的结束条件有三个**：进程退出、连续 `quietMs`（默认 1200ms，
  上限 60000ms）无输出、总超时（默认 60s，上限 10 分钟）。交互式命令不会退出，
  靠「安静」判定这一轮结束。三个条件缺一不可。
- **总超时返回 `running` 后不释放终端占用**：job 已回包但命令可能还在跑，
  `activeBySession` 继续占着该 session，直到输出安静或进程退出才释放。
  这条不能省——提前释放会让下一条命令写进同一个 pty，两条输出交错，
  前后两个 job 的 cursor 都会被污染。期间其它 `terminal_run` / `terminal_send`
  返回 `pane-busy` 并带上正在跑的 jobId。
- **持续输出且不会安静的命令必须有退出路径**：`ping -t` 这类命令 quiet 永不触发，
  总超时只回 `running`、占用一直保留。因此提供 `terminal_interrupt`（向 pty 写
  `\x03`），它**绕过 `activeBySession` 检查**，任务运行期间也允许。不要改成放行
  任意 `terminal_send`：那些输入会进入正在跑的命令的 stdin（或留在 shell 待执行
  缓冲里），其输出仍会被算进旧 job，AI 分不清哪些是新命令。
- **显式传入的 project 未命中时返回 `no-project`，不能回退到当前激活项目**
  （`App.tsx` 的 `findGroup`）：静默回退会让 AI 以为在项目 A 执行，实际写进项目 B，
  输出也会被归错项目。只有 project 为空/未传时才用当前激活项目。
  `create-terminal` 与 `create-browser` 两个 op 都要遵守。
- **输出 cursor 用绝对字符偏移，不能用 `getLastOutput().length` 当基线**。
  `pty-host.js` 的缓冲按尾部截断到 32000 字符，旧内容会前移，用相对长度做
  `baseOffset` 会在缓冲填满后永远切不到新内容（`job_output` 直接读到空串）。
  现在 `pty-host.js` 用单调递增的 `totalLength` 记录绝对偏移，并提供
  `getOutputSlice(id, fromOffset)`。`jobs.js` 的 cursor 取 `normalizeSlice` 里的
  `Math.max(endOffset, fromOffset)`——**单调不减**，不是纯 `endOffset`。
  请求的偏移早于缓冲区起点时返回 `truncated: true`。
- **返回给 AI 的输出必须过 `cleanOutput`**（`ai-tools/ansi.js`）：pty 里全是 CSI/OSC
  序列与 `\r` 重绘，不清理等于给 AI 一堆乱码。注意**不要**改
  `ptyHost.getOutputSlice` / `getLastOutput` 的原始缓冲——`get_pane_content`
  仍需要原始输出。
- **job 只存在内存里**，绑定 sessionId。命令安静结束或进程退出时**释放占用**，
  但 job 记录不删除：`job_output` 仍可继续读取该 session 的输出（进程退出时读的是
  `finalOutput` 快照，安静结束时读的是 pty 缓冲）。记录在下次 `terminal_run` 时被
  惰性清理（超过 30 分钟的丢弃），没有定时器，长期无新命令会一直留着。
- **终端已关闭后不能再往里发命令**：显式把该 pane 传给 `terminal_run` 会返回
  `pane-not-found`，需要重新 `open_terminal`；不传 `pane` 时复用逻辑会跳过已退出的页签，
  自动新建一个。
- **`terminal_run` 不传 pane 时按项目（groupKey）复用 AI 终端**，不是全局复用：
  同项目内 `aiOwned && !exited && isOpen(sessionId) && 无正在跑的任务`，
  没有才新建。项目取 `args.project`（项目名或 groupKey）、最近一次建终端的项目，
  再退回任意 AI 页签的项目。新建的 AI 页签默认标题「AI 终端」、不随命令变化，
  避免连续执行时标题反复跳。
- **AI 页签识别只能靠 `aiOwned`**：`panes:sync` 载荷已补上该字段。
  **不要**再用「标题是 AI 终端」之类的兜底——用户手动改名后就会误判，
  把普通终端当成可复用目标。
- **`aiOwned` 要能跨重启存活，四处缺一不可**：写端 `App.tsx` 的 `toSessionTab`、
  读端 `desktop/session.js` 的 `normalizeTab`、渲染侧重建设四处
  （`App.tsx` 恢复浏览器 / 差异 / 编辑器 / 终端页签，每个分支都要带
  `aiOwned: Boolean(saved.aiOwned)`）、以及 `src/global.d.ts` 的 `SessionTab`
  类型声明。漏一处，重启后标记就丢了，空页签会被别的任务误复用。
- **`terminal_wait` 只在当前缓冲内匹配**：`MAX_MATCH_CHARS = 32000`，与 pty-host
  的尾部缓冲上限一致（工具描述也写 32000，别再写 64K）。
  先扫一次已有输出再订阅新数据；同时监听退出，会话中途退出返回 `exited`
  并带回退出前的最后一帧快照（此时 pty-host 的缓冲已删除）。
  缺省超时 30 秒，上限 10 分钟。
- `tests/ai-ansi.mjs`、`tests/ai-jobs.mjs` 是离线用例；`tests/ai-bridge.mjs` 是端到端，
  必须独占 17382 端口。

## IPC 约定

`ipcMain.handle` → `desktop/preload.js` 的 `invoke()` 包装（带 `cleanError`）→
`window.api.*` → `src/global.d.ts` 类型声明。四处都要改，缺一个就是运行时错误或类型报错。

新增通道命名沿用 `<模块>:<动作>`，例如 `updates:check`、`updater:download`。

## 不要做的事

- 不要恢复已删除的本地启动器
- 不要把 `electron-updater` / `iconv-lite` / `node-pty` / `php-parser` / `acorn` /
  `acorn-jsx` 挪进 devDependencies
- 不要打开 `npmRebuild`
- 不要在 `dist` 脚本里去掉 `--publish never`（防止环境里有 `GH_TOKEN` 时误上传）
- 不要为了绕过索引器的文件锁去改打包配置或加 `--no-verify` 之类的开关
- 不要把构建调试产物（`builder-debug.yml`）当成 Release 附件
- **不要在提交信息里加任何 AI 署名**（`Co-Authored-By: Claude ...`、`Generated with ...`
  之类一律不加）。提交信息只写改动本身和原因。

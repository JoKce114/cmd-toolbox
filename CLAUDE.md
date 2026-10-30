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

放进 devDependencies 的后果是打包后启动即崩，报 `Cannot find module 'xxx'`。

`npmRebuild: false`，不要打开——node-pty 在 CI 上预编译有风险。
node-pty 1.1.0 用的是 node-addon-api（Node-API，ABI 稳定），已在 Electron 45
（Node 24.22 / NAPI 10）上实测能加载并跑起 `cmd.exe`，所以升 Electron 不需要重建它。

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
node tests/commit-diff.mjs   # 提交 patch 切分
node tests/login-item.mjs     # 开机自启动（假 app，不碰注册表）
node tests/status.mjs         # AI 状态分类、未读状态迁移
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
node tests/tab-status.mjs        # AI 页签状态灯与未读
node tests/tab-groups.mjs        # 标签组：建组/改名/改色/折叠/拖拽/重启恢复
node tests/clipboard-image.mjs   # 剪贴板图片识别（会占用系统剪贴板）
node tests/device-emulation-probe.mjs
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
设置项按页签分组（关于 / 常规 / 终端 / 编辑器 / 快捷键），新增设置项放进对应页签，
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
- **组内必须连续**。任何改变顺序的操作都要维持它：新页签用 `insertTabIntoList()`
  插到组末尾，加入已有组用 `moveById()` 贴到组尾。直接把页签 append 到数组末尾
  会把一个组拆成两段，界面上出现两个同名组标题。
- **组只存在于左栏**。`placeTab` 的 `half === 'right'` 会清掉 `tabGroupId`；
  恢复会话时右栏页签也一律清组。分屏时右栏的 `TabStrip` 因而永远不会渲染出组。
- **空组由 `applyTabs()` 统一回收**（`pruneTabGroups`）。关闭页签、移出组、
  取消分组都走这条路，不要在别处再删组。
- **折叠组的激活页签自动展开**（`App.tsx` 里的 effect）。折叠动作本身会把激活
  页签移到组外，组外没有别的页签时不允许折叠，否则留下一块空白。
- **落盘形状统一走 `buildSessionSnapshot()`**。三处保存（分屏比例防抖、
  `saveSync` 关窗、200ms 防抖）共用它，加字段只改这一处——之前三份拷贝里
  有两份漏了 `device`。
- **`desktop/session.js` 按项目校验组**：没有页签引用、跨项目引用、id 重复的组
  全部丢弃；指向不存在组的 `tabGroupId` 置空。名字截断到 30 字符，颜色必须在
  枚举内（`TAB_GROUP_COLORS`），主进程和渲染进程各有一份，改的时候两处同改。

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
- 设置页签顺序固定为 **关于 / 常规 / 终端 / 编辑器 / 快捷键**，「关于」必须第一位
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

## IPC 约定

`ipcMain.handle` → `desktop/preload.js` 的 `invoke()` 包装（带 `cleanError`）→
`window.api.*` → `src/global.d.ts` 类型声明。四处都要改，缺一个就是运行时错误或类型报错。

新增通道命名沿用 `<模块>:<动作>`，例如 `updates:check`、`updater:download`。

## 不要做的事

- 不要恢复已删除的本地启动器
- 不要把 `electron-updater` / `iconv-lite` / `node-pty` 挪进 devDependencies
- 不要打开 `npmRebuild`
- 不要在 `dist` 脚本里去掉 `--publish never`（防止环境里有 `GH_TOKEN` 时误上传）
- 不要为了绕过索引器的文件锁去改打包配置或加 `--no-verify` 之类的开关
- 不要把构建调试产物（`builder-debug.yml`）当成 Release 附件
- **不要在提交信息里加任何 AI 署名**（`Co-Authored-By: Claude ...`、`Generated with ...`
  之类一律不加）。提交信息只写改动本身和原因。

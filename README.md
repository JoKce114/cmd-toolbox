# Cmd Toolbox

本地项目终端工作台：把多个项目的终端、编辑器和 Git 操作收在一个窗口里，基于 Electron + React 构建。

## 功能

- **多项目终端**：每个项目独立分组，标签页支持 PowerShell / Git Bash / CMD 等 shell，会话退出后自动重启
- **编辑器**：CodeMirror 6，支持 PHP / HTML / JS / CSS / JSON / Markdown 高亮，可配置快捷键与缩进
- **Git 面板**：分支切换与合并、暂存/放弃、提交与推送、变更 diff、拉取冲突提示，推送被拒时可直接选择合并/变基/强制推送
- **文件树与搜索**：项目内按文件名/内容搜索，点击即打开
- **内置浏览器**：终端旁边开一个网页标签，方便查文档
- **主题**：终端浅色/深色切换，编辑器快捷键可自定义

## 开发

```bash
npm install
npm run dev      # vite + electron，热更新
```

需要 Node.js 20+ 和 Windows（终端注入依赖 `build/coninject.exe`，Windows 专用）。

只做类型检查：

```bash
npm run typecheck
```

## 构建

```bash
npm run build            # tsc + vite + 编译 coninject.exe
npm run dist             # 打包 Windows 安装包 release/CmdToolbox-<version>-setup.exe
npm run dist:portable    # 打包便携版 release/CmdToolbox-portable-<version>.exe
npm run dist:dir         # 只解包到 release/win-unpacked，方便排查
```

`npm run build` 会用系统自带的 .NET Framework 编译器（`csc.exe`）编译 `native/` 下的 C# 辅助程序，需要 Windows 自带的 .NET Framework 4.x。

安装包装到 `%LOCALAPPDATA%\Programs\cmd-toolbox`，不需要管理员权限。卸载不会删除 `%APPDATA%\Cmd Toolbox` 里的项目列表和会话。

## 测试

大部分测试是纯 Node 脚本，直接运行即可：

```bash
node tests/git-core.mjs      # Git 后端逻辑
node tests/git-pull.mjs      # 拉取/推送/上游修复
node tests/updates.mjs       # 版本比较与更新检查
```

UI 测试使用 Playwright 驱动 Electron：

```bash
node tests/git-panel.mjs     # Git 面板
node tests/settings.mjs      # 设置面板
node tests/smoke.mjs         # 冒烟
```

UI 测试会启动真实的 Electron 实例并占用固定端口 17382，运行前需先关闭正在运行的 Cmd Toolbox。

## 发版

更新说明写在仓库根目录的 `CHANGELOG.md`，按 `## [版本号] - 日期` 分节。
`npm run dist` 会把当前版本那一节抽成 `release/更新说明-v<版本>.md`，
直接粘到 GitHub Release 说明里即可（应用内的更新公告就是这段文字）。

1. 修改 `package.json` 的 `version`
2. 在 `CHANGELOG.md` 顶部补上对应版本的小节
3. `npm run dist`，产物在 `release/`：
   - `upload/` —— **要上传的附件都在这里，打开后全选直接拖进 GitHub 的 Attach binaries**
   - `CmdToolbox-<version>-setup.exe` 安装包
   - `latest.yml` 自动更新的版本清单
   - `CmdToolbox-<version>-setup.exe.blockmap` 差分更新用的校验文件
   - `更新说明-v<version>.md` 本次更新内容，粘到 Release 说明栏
4. 在 GitHub 上创建 Release，tag 用 `v<version>`（例如 `v1.1.0`），
   把 `release/upload/` 里的文件全部拖到附件区，说明栏粘贴更新说明

只改说明不重新打包时，运行 `npm run notes` 重新生成并整理。

`latest.yml` 是自动更新的入口：漏传它，应用只能退化成「前往下载」手动安装。
`version` 必须比线上版本高，否则装了新版也收不到更新提示。

应用启动时会读取仓库最新的 Release 与本地版本比较：有新版本时弹一次公告，
之后每 30 分钟在后台刷新设置按钮旁的红点；设置页里也可以手动检查更新。
公告正文直接取自 Release 说明。

## 目录

```
CHANGELOG.md 按版本记录的更新说明，发版时抽成 Release 说明
desktop/     Electron 主进程、preload、Git/文件/PTY/更新等本地能力
src/         React 渲染层
native/      终端输入注入的 C# 源码
scripts/     构建、图标、打包辅助脚本
tests/       自动化测试
```

## 许可

MIT

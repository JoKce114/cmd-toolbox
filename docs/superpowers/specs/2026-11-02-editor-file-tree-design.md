# 编辑器文件树升级 — 设计

日期：2026-11-02
状态：已确认，待实现

## 目标

把编辑器左侧栏从「只读文件树」升级为可操作的文件管理器，并给它加上对比能力。
不引入第三方文件树 / diff 库，全部扩展现有模块。

## 交互

### 左栏结构

```
┌──────────────────────────────┐
│ ＋夹  ＋件  ⟳  ⤢              │  ← 工具栏
├──────────────────────────────┤
│ ▾ 打开的编辑器                │  ← 本次新增，可折叠
│     money.php                │
│     HelpsCart.php            │
├──────────────────────────────┤
│ ▾ 文件                        │  ← 现有 FileTree，可折叠
│     common/                  │
│       helps/                 │
└──────────────────────────────┘
```

两个区各自用 `useCollapsedSection` 记忆折叠状态，id 分别是
`editor-open-editors` 和 `editor-file-tree`。

「打开的编辑器」列出 `useEditorFiles` 的 `openPaths`，与文件树的行共享
`.file-row` 样式；点条目切到该文件，已激活的条目高亮。

### 工具栏（不需要快捷键）

| 按钮 | 行为 |
|---|---|
| 新建文件夹 | 在「当前打开文件所在的目录」里新建；没有打开文件则建在项目根 |
| 新建文件 | 同上，创建后立即打开 |
| 刷新 | 重新列当前已展开的目录，并清掉符号索引缓存 |
| 全部折叠 | 只保留根目录展开 |

新建 / 重命名统一用 `Modal`（`NamePromptModal`）输入名字，不使用 `window.prompt`
（Electron 渲染进程没有实现它，调用会直接抛错）。名字不能为空、不能是 `.` / `..`、
不能含 `/ \ < > : " | ? *`，目标已存在时由后端报错且不覆盖。

### 右键菜单

| 目标 | 菜单项 |
|---|---|
| 文件 / 文件夹 | 新建文件、新建文件夹、复制、剪切、粘贴、重命名、复制路径、复制相对路径、删除 |
| 空白处 | 新建文件、新建文件夹、粘贴、刷新、全部折叠 |
| 「打开的编辑器」条目 | 与已保存文件比较、选择以进行比较、与 Git HEAD 比较 |

菜单项按可用性置灰：例如剪贴板为空时「粘贴」置灰；先对文件 A 点
「选择以进行比较」，再对文件 B 点「与 A 比较」即进入两文件对比（文件树没有多选）。
现有「生成 xxx.min.js」项保留在文件菜单末尾。

### 复制 / 剪切 / 粘贴语义

- 应用内剪贴板，存 `{ kind: 'copy' | 'cut', relPath: string, projectPath: string }`，
  保存在 React state 中，不进系统剪贴板、不跨应用
- 粘贴到文件所在目录（或右键的目录）里；同名冲突时提示「目标已存在」，不覆盖
- 剪切粘贴 = 移动：成功后清空剪贴板
- **跨项目粘贴一律拒绝**，提示「不能跨项目粘贴文件」

### 对比

三种模式，全部复用 `DiffPane` 的渲染：

| 模式 | 旧侧（左） | 新侧（右） |
|---|---|---|
| 与已保存文件比较 | 磁盘内容 `files.read()` | 编辑器内存内容 |
| 两个已打开文件互比 | 文件 A 的内存内容 | 文件 B 的内存内容 |
| 与 Git HEAD 比较 | `git.fileDiff(..., 'HEAD')` 返回的 `baseContent` | 编辑器内存内容 |

三种模式都在渲染进程用 `buildTextPatch` 生成 unified diff：HEAD 模式只从 git 取
基准文本，不直接复用 git 的 patch。

前两种需要把两段文本变成 patch，交给 `diffParser` 已经解析的格式。
新增 `src/diffFromText.ts` 提供一个最小 LCS 行差异算法，输出标准 unified diff
文本，直接喂给 `DiffPane` 已用的 `parsePatch`。**不引入新依赖**。

布局：对比打开后编辑区一分为二，左侧编辑器、右侧 DiffPane，中间是可拖拽分界线
（复用现有分屏的拖拽实现）。关掉对比回到单编辑器。文件树不受影响。

## 架构

```
desktop/file-api.js          ← 新增 createFile / createDir / copy / move / trash
desktop/main.js              ← 新增 5 个 IPC，四个接入点齐全
desktop/preload.js
src/global.d.ts

src/components/FileTree.tsx  ← 加工具栏、右键菜单、Modal 重命名、外部刷新信号
src/components/OpenEditors.tsx  ← 新建：「打开的编辑器」列表
src/components/EditorSidebar.tsx ← 新建：包住上述两个可折叠区
src/components/DiffPane.tsx  ← 扩展 DiffTarget，支持「两段文本」
src/diffFromText.ts          ← 新建：文本 → unified diff
src/fileClipboard.ts         ← 新建：应用内剪贴板状态与粘贴校验
src/components/EditorPane.tsx ← 挂载 EditorSidebar、对比布局
```

### 文件操作层

五个函数全部经 `resolveWithin` 校验，杜绝路径逃逸：

| 函数 | 关键约束 |
|---|---|
| `createFile(projectPath, relPath, content)` | 用 `fs.open(..., 'wx')`，目标已存在直接报错，**绝不覆盖** |
| `createDir(projectPath, relPath)` | `mkdir` 不带 `recursive`，重名报错 |
| `copy(projectPath, fromRel, toRel)` | 真复制（`fsp.cp`，目录也可复制），目标已存在报错 |
| `move(projectPath, fromRel, toRel)` | 目标已存在报错；纯大小写重命名放行；跨目录移动用 `fsp.rename` |
| `trash(projectPath, relPath)` | 调 Electron 的 `shell.trashItem`，进系统回收站 |

`copy` 是复制、`move` 是移动：剪切粘贴走 `move`，复制粘贴走 `copy`。

**每次写操作成功后调用 `symbols.invalidate(projectPath)`**，否则刚建的文件在
符号索引里不存在，Ctrl+点击会漏。

### 对比区块

`DiffPane` 的 `DiffTarget` 增加一个变体：

```ts
| { kind: 'text'; title: string; patch: string }
```

`kind === 'text'` 时直接渲染传入的 patch，不再走网络/磁盘读取。其余路径不变。

## 错误与边界

| 情况 | 表现 |
|---|---|
| 新建时目标已存在 | toast「同名文件已存在」，不覆盖 |
| 粘贴时目标已存在 | toast「目标位置已有同名项」，不覆盖 |
| 跨项目粘贴 | toast「不能跨项目粘贴文件」 |
| 删除已打开的文件 | 二次确认后**先移入回收站，成功后才关闭对应编辑器页签**；失败时页签原样保留 |
| 删除有未保存修改的文件 | 确认弹窗额外提示「该文件有未保存修改，删除后不可恢复」 |
| 同一项目再次打开编辑器 | 切到已有的编辑器页签，不新建第二个（第二个实例的状态无法与第一个互通） |
| 项目里目录被外部删除 | 刷新后该目录从树里消失，不报错 |
| 对比的两个文件相同 | DiffPane 显示「两处内容一致」 |
| 文件不是文本（二进制/过大） | 沿用 `file-api.read` 的 readOnly 判定，三个对比入口置灰；对比函数内部再兜底拒绝并 toast |

## 测试

### 离线（`node tests/file-ops.mjs`，新建）

- `createFile`：新建成功；同名时抛错且**原文件内容不变**
- `createDir`：新建成功；同名时抛错
- `move`：重命名成功；目标存在时抛错；`../` 与符号链接逃逸被拒
- `trash`：删除后文件消失（用临时目录，不碰真实回收站——通过注入假 `shell` 验证调用参数）
- `src/diffFromText.ts`：完全相同返回空 patch；新增行/删除行/修改行各生成正确的
  `@@` 块；空文件对非空文件

### UI（`node tests/editor-file-tree.mjs`，新建）

- 工具栏新建文件夹 / 新建文件后出现在树里
- 刷新后能看见外部新建的文件
- 全部折叠后只剩根目录
- 右键复制 → 到另一目录粘贴 → 文件存在
- 右键剪切 → 粘贴 → 原位置消失、新位置存在
- 跨项目粘贴被拒绝
- 删除弹确认 → 确认后文件消失、树行立即消失、对应页签关闭
- 删除有未保存修改的已打开文件时，确认框点名「未保存」
- 重命名已打开的文件后，页签标题跟着变
- 只读 / 超大文件的三个对比入口全部置灰
- 同一项目再次打开编辑器时切到已有页签，不会出现第二个
- 「打开的编辑器」区随打开文件增减，点击切文件
- 三种对比模式各自能打开 DiffPane 并显示差异

## 涉及文件

| 文件 | 改动 |
|---|---|
| `desktop/file-api.js` | 新增 `createFile` / `createDir` / `copy` / `move` / `trash` |
| `desktop/main.js` | 新增 `fs:create-file` / `fs:create-dir` / `fs:copy` / `fs:move` / `fs:trash`，写后 invalidate 符号索引 |
| `desktop/preload.js` | 暴露上述四个方法 |
| `src/global.d.ts` | 类型声明 |
| `src/components/EditorSidebar.tsx` | 新建：两个可折叠区的容器 |
| `src/components/OpenEditors.tsx` | 新建：打开的编辑器列表 |
| `src/components/FileTree.tsx` | 工具栏、右键菜单、Modal 重命名、外部刷新信号 |
| `src/components/DiffPane.tsx` | `DiffTarget` 增加 `text` 变体 |
| `src/diffFromText.ts` | 新建：文本差异 → unified diff |
| `src/fileClipboard.ts` | 新建：应用内剪贴板 |
| `src/components/EditorPane.tsx` | 挂载侧栏与对比布局 |
| `src/styles.css` | 工具栏、内联重命名、对比分栏样式 |
| `tests/file-ops.mjs` | 新建：离线测试 |
| `tests/editor-file-tree.mjs` | 新建：UI 测试 |
| `CLAUDE.md` | 记录文件操作约束与对比实现 |

## 不做的事

- 不做拖拽移动文件（后续可加，本次只做剪切粘贴）
- 不做系统剪贴板集成
- 不做多选批量删除
- 不引入第三方文件树 / diff 库
- 不做快捷键（按要求）

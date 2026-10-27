# 编辑器页签

日期：2026-10-27
状态：待实施
前置：`2026-10-27-git-source-control-design.md`

## 背景

Cmd Toolbox 目前只有终端页签和浏览器页签。查看或小改项目文件必须切到终端敲命令，或离开应用用外部编辑器。本设计新增「编辑器」页签：左侧文件树、右侧可编辑内容，作为冲突解决功能（见 `2026-10-27-git-conflict-editor-design.md`）的基础。

## 需求范围

### 做

- 新增 `editor` 页签类型，与 `terminal` / `browser` 并列
- 左侧文件树，按需加载，可展开折叠
- 右侧 CodeMirror 编辑器，语法高亮、行号、搜索
- 手动保存（Ctrl+S），未保存标记与关闭确认
- 编码识别：UTF-8 / UTF-8 BOM / UTF-16 / GBK，保存时按原编码写回
- 大文件与二进制文件只读打开

### 不做

- 多文件同时编辑（一个页签一个文件）
- 文件重命名、新建、删除
- 全局搜索、替换跨文件
- 代码补全、跳转定义、LSP
- 冲突解决（见阶段二规格）

## 技术选型

| 依赖 | 版本 | 理由 |
|---|---|---|
| `codemirror` | ^6 | 编辑器核心，按需引入语言包 |
| `@codemirror/lang-php` | ^6 | 主要使用场景 |
| `@codemirror/lang-html` | ^6 | |
| `@codemirror/lang-css` | ^6 | |
| `@codemirror/lang-javascript` | ^6 | |
| `@codemirror/lang-json` | ^6 | |
| `@codemirror/lang-markdown` | ^6 | |
| `@codemirror/search` | ^6 | 文件内查找 |
| `iconv-lite` | ^0.6 | GBK / GB18030 编解码 |

`iconv-lite` 是必需的：Node 的 `TextDecoder` 能解 GBK，`TextEncoder` 却只能编码 UTF-8。缺了它，打开 GBK 文件再保存会把整个文件转成 UTF-8，对老项目是破坏性改动。

## 编码策略

### 读取

按顺序判断：

1. 前 3 字节为 `EF BB BF` → UTF-8 BOM，去 BOM 后按 UTF-8 解
2. 前 2 字节为 `FF FE` → UTF-16LE
3. 前 2 字节为 `FE FF` → UTF-16BE
4. 严格 UTF-8 解码（`TextDecoder('utf-8', { fatal: true })`）成功 → UTF-8
5. 以上都失败 → GBK（用 iconv-lite）

识别结果与是否带 BOM 一起记在文件对象上。

### 写入

按打开时识别到的编码写回，BOM 状态保持不变。编码信息对用户可见地显示在工具栏（如 `UTF-8`、`GBK`），但不提供手动切换——避免用户在不理解后果时改动。

## 主进程接口

新增 `desktop/file-api.js`：

```js
list(projectPath, relDir)                     // → { entries }
read(projectPath, relPath)                    // → { content, encoding, size, readOnly, mtime }
write(projectPath, relPath, content, encoding, mtime)  // → { ok: true }
```

### list

```js
fs.readdir(dir, { withFileTypes: true })
```

- 目录在前、文件在后，各自按名称排序（忽略大小写）
- 忽略 `.git`、`node_modules`、`dist`、`release`、`release-build*`
- 符号链接不跟随（`withFileTypes` 的 `isSymbolicLink()` 为真时标为 `isSymlink: true` 并禁用点击）

### read

- 上限 2MB，超出返回 `readOnly: true` 且不返回内容
- 含 NUL 字节判定为二进制 → `readOnly: true`，`content` 为空
- 返回 `mtime`（毫秒）供写入时比对

### write

- 先 `fs.stat` 比对 `mtime`，不一致则抛错「文件已在外部修改，请重新打开」
- 按传入 `encoding` 编码：UTF-8 家族用 `Buffer.from(content, 'utf8')`，UTF-8 BOM 手动前置 `EF BB BF`，UTF-16 与 GBK 用 `iconv-lite`
- 先写临时文件再 `rename`，避免写入中途失败损坏原文件

### 路径安全

`resolveWithin(projectPath, relPath)` 从 `desktop/git.js` 抽出为共用模块：

1. `path.resolve` 后与项目根做 `path.relative`，拒绝 `..` 开头或绝对路径
2. 对已存在的路径再 `fs.realpath` 校验，防止符号链接逃逸
3. 拒绝含 `\0` 的路径

### IPC 通道

| 通道 | 参数 |
|---|---|
| `fs:list` | `projectPath, relDir` |
| `fs:read` | `projectPath, relPath` |
| `fs:write` | `projectPath, relPath, content, encoding, mtime` |

全部经 `assertProjectPath` 白名单校验。

## 渲染侧结构

### 页签类型

`Tab.shellId` 复用为 `'editor'`，与 `'browser'` 同一模式。`Tab` 增加：

```ts
filePath?: string;   // 相对项目根的路径
```

`isBrowserTab` 旁增加 `isEditorTab`。

### 组件

```
src/components/EditorPane.tsx      页签容器：工具栏 + 文件树 + 编辑区
src/components/FileTree.tsx        文件树，按需加载
src/components/CodeMirrorHost.tsx  CodeMirror 实例的挂载与生命周期
src/editorLanguage.ts              按扩展名选语言包
```

`EditorPane` 持有当前打开文件的 state：

```ts
type OpenFile = {
  relPath: string;
  content: string;
  savedContent: string;   // 用于判断 dirty
  encoding: string;
  mtime: number;
  readOnly: boolean;
};
```

`dirty = content !== savedContent`。

### 打开入口

1. 侧栏项目行右键菜单 →「打开编辑器」（打开该项目的空编辑器页签）
2. Git 变更列表行悬停图标 →「用编辑器打开该文件」（替换现有的「打开目录」图标）
3. 编辑器页签内点击文件树中的文件

### 快捷键与关闭

- `Ctrl+S` 保存；只读文件时忽略并 toast 提示
- 关闭有未保存修改的页签 → `ConfirmDialog`「`{file}` 有未保存的修改，关闭将丢失。是否继续？」
- 切换文件树中的另一个文件时若有未保存修改 → 同样的确认

## 状态与并发

- 保存期间工具栏按钮禁用并显示「保存中…」
- 外部修改冲突（mtime 不匹配）→ toast 提示，提供「重新加载」按钮（丢弃内存改动，从磁盘重读）
- 编码识别失败（既不是合法 UTF-8 也无法按 GBK 解码）→ 只读打开并提示

## 涉及文件

| 文件 | 变更 |
|---|---|
| `package.json` | 新增 9 个依赖 |
| `desktop/file-api.js` | 新增 |
| `desktop/path-guard.js` | 新增，从 git.js 抽出的 `resolveWithin` |
| `desktop/main.js` | 注册 3 个 IPC |
| `desktop/preload.js` | 暴露 `window.api.files` |
| `src/types.ts` | `Tab` 加 `filePath`；新增 `isEditorTab` |
| `src/global.d.ts` | 补类型 |
| `src/components/EditorPane.tsx` | 新增 |
| `src/components/FileTree.tsx` | 新增 |
| `src/components/CodeMirrorHost.tsx` | 新增 |
| `src/editorLanguage.ts` | 新增 |
| `src/App.tsx` | 页签类型分支、打开入口、快捷键 |
| `src/components/Sidebar.tsx` | 项目右键菜单项 |
| `src/components/GitPanel.tsx` | 图标改为「用编辑器打开」 |
| `src/styles.css` | 编辑器与文件树样式 |
| `tests/editor.mjs` | 新增端到端测试 |

## 测试

### 端到端（`tests/editor.mjs`）

准备临时项目目录，含 UTF-8、GBK、大文件、二进制文件各一个。

| 场景 | 断言 |
|---|---|
| 项目右键打开编辑器 | 出现 editor 页签，文件树列出顶层条目 |
| 展开子目录 | 懒加载出子项 |
| 点击文件 | 编辑器显示内容，工具栏显示编码 |
| 修改后 Ctrl+S | 磁盘内容更新，dirty 标记消失 |
| 未保存关闭 | 弹确认框，取消则页签保留 |
| 打开 GBK 文件并保存 | 磁盘文件仍为 GBK，中文未乱码 |
| 打开二进制文件 | 只读，保存按钮禁用 |
| 打开超过 2MB 的文件 | 只读并提示 |
| 路径越界 | `fs:read` 请求被拒绝 |

## 风险

- **CodeMirror 体积**：核心加语言包约 500KB，`vite build` 后主 bundle 会明显增大。可接受，但需在构建输出里确认没有把全部语言包一次性打进主 chunk——必要时对语言包做动态导入。
- **文件树大目录**：`node_modules` 等已忽略，但项目内若有大量文件的目录，`readdir` 仍可能慢。首次只列一层，够用。

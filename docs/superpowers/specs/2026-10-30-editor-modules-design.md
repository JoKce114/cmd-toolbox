# 编辑器模块系统设计

日期：2026-10-30
状态：待审阅

## 背景与目标

用户希望 Cmd Toolbox 能像 VS Code 那样"装扩展"获得额外能力。截图里列出的是
VS Code 扩展市场的一批插件：Prettier、Format HTML in PHP、PHP Intelephense、
Nu-Minify、Codex、GitHub Copilot 等。

**明确不做的**：直接加载 `.vsix` 文件。VS Code 扩展依赖 `vscode` 这个私有 API
模块，只有 VS Code 自己的扩展宿主能提供；本项目编辑器是 CodeMirror 6，不是
Monaco，两者不兼容。要真跑扩展只能嵌入完整的 code-server，代价是安装包 +200MB
且与现有终端/标签组割裂，不值得。

**实际要做的**：把这批扩展里真正有价值的能力，用等价的实现做成本应用的模块。
首版锁定三类：格式化、压缩、语法诊断。

## 范围

首版包含 4 个模块，全部内嵌在安装包里，不走远端下载。

| 模块 | kind | 语言 | 实现 | 许可 |
|---|---|---|---|---|
| 代码格式化 | format | js/ts/jsx/tsx/json/html/css/md | prettier standalone | MIT |
| 代码压缩 | minify | js | terser | BSD-2 |
| JS/TS 语法检查 | diagnostics | js/ts/jsx/tsx | acorn | MIT |
| PHP 语法检查 | diagnostics | php | php-parser | BSD-3 |

不做的：

- **补全、跳转定义、重命名**：需要真正的 LSP 服务器，首版不碰
- **JS/TS 类型检查**：需要 tsconfig 上下文，缺上下文时误报过多
- **Python**：诊断依赖 pyright，首版不做。`EditorModule.requires` 字段为它预留
- **HTML/CSS 压缩**：用户明确只要 JS。Nu-Minify 本身也只压 JS

## 数据模型

```ts
// src/modules/catalog.ts —— 清单写死在代码里，不从网络拉
type EditorModule = {
  id: string;
  name: string;
  description: string;
  kind: 'format' | 'minify' | 'diagnostics';
  languages: string[];
  requires?: 'download';   // 首版未使用，为将来的 Python 预留
};
```

用户开关状态存进现有的 `AppPrefs`，跟其他偏好一起走 `readPrefs` / `writePrefs`：

```ts
type AppPrefs = {
  // ...现有字段
  enabledModules: string[];   // ['format', 'minify', 'diag-php']
};
```

缺省值：`['format', 'minify', 'diag-php']`——诊断默认关闭，避免一打开编辑器
就满屏波浪线。**未知模块 id 在读取时丢弃**，防止降级后残留脏数据。

## 模块接口

所有模块统一成三个动作，按需实现：

```ts
type ModuleApi = {
  format?(text: string, lang: string): Promise<string>;
  minify?(text: string, lang: string): Promise<string>;
  diagnose?(text: string, lang: string): Promise<Diagnostic[]>;
};

type Diagnostic = {
  from: number;      // 文档内字符偏移
  to: number;
  severity: 'error' | 'warning';
  message: string;
};
```

**执行位置**：渲染进程，按需动态 `import()`。每个模块的依赖各打成一个 chunk，
用户第一次在对应语言上触发时才加载，不占启动时间。

不上 worker：这些库都是纯计算且快（10KB 文件格式化 < 100ms），worker 的
序列化开销和生命周期管理不值得。

不放主进程：主进程只做文件 IO 和 pty。纯文本处理放渲染进程省一次 IPC 序列化，
也避免大文件阻塞主进程。

## 功能一：格式化

### 入口

**只有右键菜单，不绑定任何快捷键。**

| 入口 | 操作 |
|---|---|
| 右键菜单 | 编辑器内右键 →「格式化文档」 |
| 右键菜单 | 编辑器内右键 →「格式化选区」（有选区时可点） |

用户明确要求不占快捷键。`Shift+Alt+F` 虽然 VS Code 在用、且本项目当前未被占用，
但首版不接；`Ctrl+K Ctrl+F` 这种两段式组合键还需要改 `editorKeymap.ts` 的底层
匹配逻辑，成本更高，一概不做。`src/editorKeymap.ts` 保持原样。

有选区时点「格式化选区」只整理选区，点「格式化文档」则整篇。

### 行为

结果通过 `view.dispatch` 替换文档，自动进入 undo 栈，`Ctrl+Z` 可撤销。
格式化只改空白与换行，不改任何语义内容。

### 前置条件

**编辑器目前没有右键菜单。** `EditorPane.tsx` 里没有任何 `onContextMenu`
绑定（终端、页签、侧栏都有，唯独编辑器没有）。需要新加一个，复用现有的
`src/components/PopupMenu.tsx`。

## 功能二：压缩

### 只针对 JS

`*.js` 参与压缩。`*.ts`、`*.tsx` 不参与——用户原话是"压缩仅针对js"。

### 手动触发

右键菜单「压缩为 app.min.js」。这是**创建** `.min.js` 的方式——菜单可以创建
新文件，自动保存钩子只更新已存在的文件。

压缩后在**新标签页打开**结果，方便核对。

文件名规则：把 `.min` 插在最后一个点之前。`app.js` → `app.min.js`，
`app.test.js` → `app.test.min.js`。

### 自动触发

**每次保存 `.js` 文件时自动压缩，但仅当对应的 `.min.js` 已经存在。**

这条是核心约束：开关的判定依据是**文件是否存在**，不是设置里的开关。

| 目录里有没有 `app.min.js` | 保存 `app.js` 时的行为 |
|---|---|
| 没有 | **什么都不做**，不创建 |
| 有 | 重新压缩并覆盖它 |

这样设计的理由：不在用户目录里凭空生成文件。用户想要自动压缩，就手动创建一次
`.min.js`（右键菜单或自己在文件树里新建），之后它自动跟着源文件走；不想的话
就永远不会有这个文件。

与现有 `useEditorFiles.save()` 的冲突需要注意：

```ts
// src/useEditorFiles.ts:157
if (!current.dirty) return false;   // 内容没变就直接返回了
```

用户要求「**不管有没有修改**都执行一次」，所以压缩钩子必须挂在这个早退**之前**。
也就是说：即使内容没变、`save()` 本身没有写盘，只要 `app.min.js` 存在，
压缩仍然执行。

自动压缩是**静默**的：不打开新标签页，不弹窗，成功时无提示。

### 不触发自动压缩的情况

- 当前文件是 `*.min.js`（避免自己压自己）
- 文件尚未保存过（没有路径）
- 文件不是 `.js`
- **同目录下没有对应的 `.min.js`**（见上）

### 失败处理

`terser` 解析失败时：不写文件、不弹模态框、保存本身照常成功。只推一条
toast 提示。**压缩失败绝不能导致保存失败。**

### 已存在 .min.js 时

直接覆盖，不弹确认——这个文件本来就是产物。菜单文案按状态区分：

| 情况 | 菜单项 |
|---|---|
| 不存在 | 压缩为 app.min.js |
| 存在，且不旧于源文件 | 压缩为 app.min.js（覆盖） |
| 存在，但比源文件旧 | 压缩为 app.min.js（已过期） |

**不做自动同步提醒**：不监听源文件变化去标记 .min.js 过期。只在打开菜单时
现算一次 mtime 对比。

## 功能三：语法诊断

### 入口

没有菜单入口。这是"状态类"功能——设置里打开开关后，编辑器里的语法错误
自动出现波浪线。

### 实现

用 `@codemirror/lint` 的 `linter()` 包装模块的 `diagnose()`，防抖 500ms。
开关关闭时往 `Compartment` 里重新配置空数组。

编辑器已有 7 个 `Compartment`（`languageRef` / `themeRef` / `wrapRef` /
`indentRef` / `keysRef` / `appearanceRef` / `displayRef`），新增
`diagnosticsRef` 沿用同一模式。

### 各语言的诊断深度

- **JS/TS**：`acorn` 只做**语法**检查，不做类型检查
- **PHP**：`php-parser` 做语法检查，纯 JS 实现，不需要用户装 PHP
- **HTML/CSS/JSON/MD**：不做诊断（CodeMirror 的语言包本身会在输入时提示明显错误，够用）

## 设置界面

设置面板新增第 6 个页签「模块」，排在「编辑器」之后：

```
关于 | 常规 | 终端 | 编辑器 | 模块 | 快捷键
```

**注意**：CLAUDE.md 规定页签顺序为「关于 / 常规 / 终端 / 编辑器 / 快捷键」，
且「关于」必须第一位（`tests/update-notify.mjs` 有断言）。把「模块」插在
「编辑器」之后、「快捷键」之前不破坏这条规则，但要同步更新 CLAUDE.md 里
那段注释，并确认测试断言仍然通过。

列表项复用现有 `.settings-item` 样式：

```
模块                                    3 / 4 已启用
────────────────────────────────────────────────
[✓] 代码格式化                                       内置
    支持 JS / TS / HTML / CSS / JSON / Markdown
────────────────────────────────────────────────
[✓] 代码压缩                                         内置
    支持 JS；已有 .min.js 时保存自动更新
────────────────────────────────────────────────
[ ] JS / TS 语法检查                                 内置
    在编辑器里用波浪线标出语法错误
────────────────────────────────────────────────
[✓] PHP 语法检查                                     内置
    基于纯 JS 解析器，不需要安装 PHP
```

上图与默认值 `['format', 'minify', 'diag-php']` 一致：格式化、压缩、PHP 诊断
默认开，JS 诊断默认关。

开关**点「保存」后才生效**，和这个面板里其他设置一致——点开关键盘只改本地状态，
不写 localStorage，「取消」能把它们一起撤销。

## 新增 IPC

现有 `files` 接口只有 `list` / `read` / `write` / `search`，缺两样东西。

### 1. `files:stat` — 判断文件是否存在

自动压缩要靠「同目录下有没有 `app.min.js`」来决定是否执行，菜单文案也要靠
mtime 对比区分「覆盖」和「已过期」。现在没有便宜的办法拿到这个信息：

- `files.read` 能试出来，但要整读文件，`.min.js` 再小也不该为了一次 stat 去读
- `files.list` 只列一层目录，拿不到 mtime 比较

所以新增：

```ts
// src/global.d.ts
stat: (projectPath: string, relPath: string) => Promise<{ exists: boolean; mtime: number }>;
```

文件不存在时返回 `{ exists: false, mtime: 0 }`，**不抛错**——「不存在」是正常
结果，不是异常。

### 2. `files:write-minified` — 允许创建新文件

`desktop/file-api.js` 的 `write()` 第一行就 `fsp.stat(target)`，文件不存在会
直接抛错。因此**无法用现有 API 新建 `.min.js`**：

```js
// desktop/file-api.js:140
const stat = await fsp.stat(target);   // 新文件在这里就炸了
```

右键菜单的「压缩为 app.min.js」需要创建文件，所以新增一个不做 mtime 校验的写入
（产物文件没有并发编辑的顾虑）：

```js
async function writeMinified(projectPath, relPath, content) { ... }
```

注意自动保存路径**只用它更新已存在的文件**，不负责创建——创建是菜单的职责。

按 CLAUDE.md 的 IPC 约定，这两条通道四处都要改：`ipcMain.handle`、`preload.js`
的 `invoke()` 包装、`src/global.d.ts` 类型声明、以及调用方。

## 依赖

新增到 **`devDependencies`**（都会被 vite 打进前端 bundle，运行时不从
node_modules 读取）：

| 包 | 用途 | 体积 |
|---|---|---|
| `prettier` + 语言插件 | 格式化 | ~1.5MB（按需 chunk） |
| `terser` | JS 压缩 | ~600KB |
| `acorn` | JS 语法检查 | ~130KB |
| `php-parser` | PHP 语法检查 | ~850KB |
| `@codemirror/lint` | 诊断 UI | ~50KB |

合计约 3MB。

**注意 CLAUDE.md 的约定**：主进程运行时用到的包必须在 `dependencies`。
这些全部是渲染进程依赖、会被打包进前端 chunk，所以放 `devDependencies`
是正确的。vite 打包时会被剥离。

## 错误处理

| 场景 | 处理 |
|---|---|
| 模块 chunk 加载失败 | toast「模块加载失败，请重试」，不影响编辑器 |
| 格式化/压缩抛错 | toast 显示原始错误信息，文档内容不变 |
| 压缩时文件未保存过 | 菜单项置灰，title 提示「请先保存文件」 |
| `files:stat` 失败 | 当作「.min.js 不存在」处理，不压缩、不报错 |
| `terser` 语法错误 | 保存成功，toast 提示压缩失败 |
| 诊断超时（>3s） | 放弃本次诊断，不显示旧结果 |
| 开关关闭后仍在跑的任务 | 检查开关状态，结果直接丢弃 |

## 测试

新增 `tests/editor-modules.mjs`（Playwright，需独占 17382 端口）：

1. 设置面板出现「模块」页签，排在「编辑器」之后
2. 关闭开关后对应菜单项消失，打开后恢复
3. 格式化：造一个乱排版的 js 文件，右键格式化，断言内容被整理且 `Ctrl+Z` 能撤销
4. 格式化选区：只选中一部分，断言选区外内容不变
5. 压缩：右键压缩后同目录出现 `app.min.js`，内容比源文件短
6. **压缩不自动创建**：只有 `app.js` 没有 `.min.js` 时保存，断言 `.min.js` 仍不存在
7. **压缩自动更新**：`app.min.js` 存在时保存 `app.js`，断言 `.min.js` 内容被更新
8. **无改动也执行**：不修改内容直接 `Ctrl+S`，断言 `.min.js` 的 mtime 更新
9. 压缩失败：写入语法错误的 js，保存应成功且出现错误 toast
10. 诊断：开启 JS 诊断后输入语法错误，断言出现 `.cm-lint-marker`
11. 关闭诊断后波浪线消失

离线测试新增 `tests/module-catalog.mjs`：
- 目录清单里每个模块的 `kind` 合法、`languages` 非空
- `enabledModules` 里未知 id 被丢弃
- 默认值不包含诊断模块

## 实施顺序

1. **基础设施**：`catalog.ts`、`AppPrefs.enabledModules`、设置页签
2. **格式化**：编辑器右键菜单（全新）+ prettier 接入
3. **压缩**：`files:write-minified` IPC + 菜单项 + 保存钩子
4. **诊断**：`@codemirror/lint` + acorn + php-parser
5. **测试与文档**：两个测试文件 + CLAUDE.md 更新

每步可独立发布，不必一次性做完。

## 风险

- **编辑器右键菜单是全新功能**，可能与现有键盘焦点处理冲突，需实测
- **保存钩子插入 `useEditorFiles.save()`** 会触及所有编辑器的保存路径，
  改动风险高于其他部分。建议先写测试再改
- **每次保存都要先 `files:stat` 一次**，多一次 IPC 往返。10KB 级别文件
  无感知，但如果用户项目里有超大文本文件，需确认不会拖慢保存
- **prettier 打进来后 bundle 会变大**，需要确认 chunk 拆分生效，
  否则首屏加载变慢

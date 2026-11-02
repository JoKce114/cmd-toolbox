# 编辑器符号跳转与简介（Ctrl+点击）— 设计

日期：2026-11-02
状态：已确认，待实现

## 目标

在编辑器里按住 Ctrl 点击函数或类名，先弹出一个简介卡片（签名 + 文档注释），
卡片里可以再跳到定义所在文件与行。对标 PHP Intelephense 的悬停体验，
但只覆盖本项目需要的子集。

不做的：类型推断、`$obj->method()` 这类动态调用解析、PHP 内置函数、跨项目搜索。

## 交互

| 动作 | 结果 |
|---|---|
| Ctrl + 悬停在标识符上 | 指针变手型，提示「Ctrl+点击查看定义」 |
| Ctrl + 点击标识符 | 弹出简介卡片 |
| 卡片里点候选 / 「跳到定义」 | 打开目标文件并把光标定位到声明行 |
| 光标不在标识符上 | 不响应，保持原生多光标行为 |
| 对应模块关闭 | 完全不拦截，恢复原生行为 |

唯一触发方式是 Ctrl+点击（含 Cmd+点击），不做 F12。

## 架构

```
CodeMirrorHost（渲染进程）
  Ctrl+点击 → state.wordAt(pos) 取词 → 回调上层
        ↓
EditorPane
  window.api.symbols.lookup(projectPath, name)      [新 IPC]
        ↓
desktop/symbols.js（主进程）
  遍历文件 → 文本预筛 → 只解析命中文件 → 按规则排序
        ↓
渲染进程
  简介卡片（CodeMirror tooltip，锚在点击处）→ 选择 → open(relPath) + 定位行
```

解析放在主进程，理由有二：要遍历文件系统；批量解析会占用几十毫秒到数秒，
放在渲染进程会卡住编辑器输入。

## 模块化

`src/modules/catalog.ts` 的 `ModuleKind` 从 `'diagnostics'` 扩展为
`'diagnostics' | 'reference'`，新增两个模块：

| id | 名称 | 语言 | 默认 |
|---|---|---|---|
| `ref-php` | PHP 跳转与简介 | php | 开 |
| `ref-js` | JS 跳转与简介 | js / mjs / cjs / jsx | 开 |

设置「模块」页签按 kind 分成两组显示：语法检查、跳转与简介。
沿用现有 `enabledModules` 存储，不需要迁移。

## 索引策略

不建常驻索引，不在启动时扫描，点击时才查。

1. **遍历**：从项目根递归，跳过 `vendor`、`node_modules`、`.git`、`dist`、
   `release`、符号链接。单文件超过 1MB 跳过。最多扫描 4000 个文件。
2. **文本预筛**：用 `function\s+<name>\b` / `class\s+<name>\b`（大小写不敏感）
   筛出真正包含该名字的文件。这一步只需读文件、不做语法分析。
3. **精确解析**：只对命中文件跑 `php-parser` 或 `acorn`，从 AST 取真实声明，
   顺带拿到 `leadingComments`（docblock）。这样能排除注释和字符串里的同名干扰。
4. **缓存**：主进程按 `relPath` 缓存「该文件的声明列表 + mtime」，只在查询时
   惰性填充。文件改动后 mtime 变化即失效。这不是项目级索引——没有预先扫描，
   没有全量符号表，缓存里只有被实际解析过的少数文件。
   查询词本身不缓存。

实测：`php-parser` 全量解析约 22ms/文件，千文件项目要 20 秒，所以预筛是必需的；
预筛后通常只解析 1–3 个文件，总耗时在几十毫秒量级。

## 声明提取

### PHP（`php-parser`）

`Engine` 配 `parser.extractDoc: true`、`ast.withPositions: true`。遍历 AST 取：

- `kind === 'class'` → 类名、`namespace`、`leadingComments`（类的 docblock）
- `kind === 'method'` → 方法名、`isStatic`、`visibility`、`leadingComments`、
  参数列表（用于拼签名）
- `kind === 'function'` → 函数名、`leadingComments`、参数列表

命名空间要拼上：`App\Helps\HelpsVisualV2::echoListHTags`。

注意 `php-parser` 的 `name` 字段是 Identifier 对象（`{ name: 'foo' }`），
不是字符串；类节点上 docblock 挂在类的 `leadingComments`，方法自己的 docblock
挂在方法节点上，两者要分开取。

### JS（`acorn` / `acorn-jsx`）

复用 `diagnose-js.ts` 里已有的 `acorn` + `acorn-jsx` 加载方式（含 CJS 互操作兜底）。
遍历 AST 取 `FunctionDeclaration`、`ClassDeclaration`、`VariableDeclarator`
（初始化器是箭头函数或函数表达式时才算声明）。JSDoc 从节点 `start` 往前
回溯连续的 `/** ... */` 块。

TS / TSX 不接：`acorn` 不认类型注解，与会话中既有的诊断模块保持一致。

## 排序规则

同名多候选时，按以下顺序排序后再交给界面：

1. 当前文件里的声明
2. PHP：接收者类名与声明所属类同名（`Foo::bar()` 命中 `class Foo` 里的 `bar`）
3. PHP：同命名空间
4. 路径层级浅的
5. 其余按路径字典序

前四条都拿不到区分度时，**全部列出让用户选**，不擅自取第一个。

## 简介卡片内容

单候选：签名（带 `public` / `static` 修饰符）+ 完整类名/命名空间 +
PHPDoc 原文（保留 `@param`、`@return`，与截图一致）+ 「跳到定义」按钮。

多候选：列表，每项显示 `文件名:行号` 与签名，点击即跳转。

跳转前如果目标文件已在编辑器中打开，直接切过去并定位；未打开则先 `open()`，
文件加载完成后再定位（`useEditorFiles` 的 `open` 是异步的）。

## 错误与边界

| 情况 | 表现 |
|---|---|
| 没有找到定义 | toast「没有找到 `xxx` 的定义」 |
| 单个文件解析失败 | 跳过该文件，其余结果照常返回 |
| 触发 4000 文件上限 | 卡片底部提示「已扫描前 4000 个文件，结果可能不完整」 |
| 项目路径不存在 | 直接返回空，不报错 |
| 查询名过短（<2 字符） | 不发起查询 |
| 模块关闭 | Ctrl+点击不拦截 |

## 打包影响

`php-parser`、`acorn`、`acorn-jsx` 目前都在 `devDependencies`（只被 vite 打进
渲染进程 bundle）。本功能在主进程里 `require` 它们，**必须移到 `dependencies`**，
否则打包后启动即崩 `Cannot find module 'php-parser'`。

这与会话中既有约定一致：「主进程运行时用到的包必须在 dependencies」。
安装包体积预计增加约 2MB。

## 测试

### 离线（`node tests/symbols.mjs`）

- PHP：类、方法（含 `static` / 可见性）、全局函数、docblock 提取
- PHP：命名空间拼接正确
- JS：函数声明、类、箭头函数赋值的变量声明、JSDoc 提取
- 注释里和字符串里出现的同名标识符**不**被当成声明
- 排序：同文件优先、同类优先、同命名空间优先
- 忽略目录（`vendor` / `node_modules`）不参与扫描
- 超过 1MB 的文件被跳过

### UI（`node tests/editor-goto-def.mjs`）

- Ctrl+点击方法名弹出卡片，卡片里的签名与 docblock 正确
- 点「跳到定义」打开目标文件并定位到声明行
- 同名多候选时列出全部，点第二项跳到第二个文件
- 关闭 `ref-php` 模块后 Ctrl+点击不弹卡片
- 光标不在标识符上时不弹

测试需要独占 17382 端口，跑之前先关掉运行中的 Cmd Toolbox。

## 涉及文件

| 文件 | 改动 |
|---|---|
| `desktop/symbols.js` | 新增：遍历、预筛、解析、排序、缓存 |
| `desktop/main.js` | 新增 `symbols:lookup` handler，注入项目路径校验 |
| `desktop/preload.js` | 新增 `api.symbols.lookup` |
| `src/global.d.ts` | 新增类型声明 |
| `src/modules/catalog.ts` | `ModuleKind` 扩展，新增 `ref-php` / `ref-js` |
| `src/symbolLookup.ts` | 新增：渲染侧取词、调用、结果归一化 |
| `src/components/CodeMirrorHost.tsx` | Ctrl+点击拦截、手型光标、卡片渲染 |
| `src/components/EditorPane.tsx` | 计算 `referenceModule` 并下传，处理跳转 |
| `src/useEditorFiles.ts` | 暴露「打开后定位到行」的能力 |
| `src/styles.css` | 卡片样式 |
| `package.json` | 三个解析器移到 `dependencies` |
| `tests/symbols.mjs` | 新增离线测试 |
| `tests/editor-goto-def.mjs` | 新增 UI 测试 |
| `CLAUDE.md` | 记录模块划分、依赖位置、缓存失效规则 |

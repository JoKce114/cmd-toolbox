# 编辑器 Git 变更行标记 — 设计

日期：2026-11-04
状态：已确认，待实现

## 目标

编辑器打开文件时，自动把「当前内容」与 **Git HEAD** 做行级对比，在行号旁常驻显示：

- **新增行**：行号右侧一条蓝色波浪竖条
- **修改行**：行号右侧一条琥珀色实心竖条
- **删除处**：行号右侧一个小红色三角 ▶，悬停显示被删掉的原文
- **概览标尺**：编辑器右缘一条极窄的色带，按行号比例标出全文件的增删分布

对标 VS Code 的 Git gutter 体验。**不给行加背景色**——正文保持干净，只靠左侧标记与标尺表达。

不做的：行内字符级 diff、点击展开被删内容块、accept/reject 变更块、对比暂存区。

## 现状与边界

- 编辑器是 CodeMirror 6，`CodeMirrorHost.tsx` 现在只有**冲突标记**和**语法诊断波浪线**，
  没有任何 Git 变更装饰。
- `DiffPane` 是独立的整篇 diff 视图（Git 面板、编辑器的左右分栏对比），本次不动它。
- `src/diffFromText.ts` 已有完整的 Myers 线性空间差分（`buildTextPatch` 的底座），
  但 `diffLines` 是私有的，需要导出复用。
- `desktop/git.js` 的 `fileDiff(projectPath, filePath, status, 'HEAD')` 已经会返回
  `baseContent`（HEAD 版本全文）；未跟踪文件返回空串 + `untracked: true`。

## 架构

```
EditorPane
  打开文件 / 窗口获得焦点 / Git 变更条目变化
        ↓
  window.api.git.fileDiff(path, relPath, 'modified', 'HEAD')   [现成 IPC]
        ↓  baseContent
  computeLineChanges(baseContent, file.content)                [纯函数，新文件]
        ↓  LineChanges
CodeMirrorHost                                                   [加一个 gutter]
  gutter marker：色条 + 红三角
EditorOverviewRuler                                              [新组件，纯 React]
  按行号比例画色带
```

差异计算全在渲染进程，不新增 IPC。

## 1. 差异计算（`src/lineChanges.ts`）

```ts
export type LineChangeKind = 'added' | 'modified';

export type ChangeChunk = {
  startLine: number;   // 1-based，当前文档行号
  endLine: number;     // 含
  kind: LineChangeKind;
};

export type DeleteAnchor = {
  line: number;        // 1-based，三角渲染在这一行的 gutter 上
  texts: string[];     // 被删掉的原文
};

export type LineChanges = {
  chunks: ChangeChunk[];
  addedLines: number[];
  modifiedLines: number[];
  deletes: DeleteAnchor[];
  totalLines: number;
};

export function computeLineChanges(oldText: string, newText: string): LineChanges;
```

实现复用 `diffFromText.ts`：把私有的 `diffLines` 导出（顺带导出 `DiffOp` 类型），
不要另写一份差分。

行号切分逻辑（去掉末尾换行切出的空串）目前内联在 `buildTextPatch` 里，
一并抽成导出的 `splitLinesForDiff(text)`，两处共用，避免两套口径。

### 判定规则

按 ops 顺序扫描，维护当前文档行号 `newLine`（1-based）。把连续的
`insert` / `delete` 聚成一个**变更块**：

| 块内情况 | 结果 |
|---|---|
| 只有 insert（i 行） | `[newLine, newLine+i-1]` 记为 added |
| 有 delete，且 i > 0 | 前 `min(d,i)` 行记为 modified，多出来的 `i-d` 行记为 added |
| 有 delete（无论 i 是否为 0） | 在块首行加一个 DeleteAnchor，`texts` 是块内全部被删原文 |

**红三角的位置**：块产生了新行就锚在块首行（`startLine`）；块没产生新行
（纯删除）就锚在 `newLine`（即删除位置之后的那一行）。删除发生在文件末尾时
行号会超出文档，钳到 `totalLines`。

一条 1 改 1 的替换会同时得到「modified 一行 + 红三角一个」——与 VS Code 一致：
三角表示这里吞掉了原文，色条表示这一行变了。

### 性能

- 复用 `buildTextPatch` 现有的两道上限：剥完公共前后缀后无交集就直接全删全增；
  两侧都超过 20000 行时不做细粒度差分。
- 调用方 300ms 防抖，与现有对比视图的节奏一致。
- 两侧合计超过 20000 行时直接返回空 `LineChanges`，不挂标记（标记是辅助信息，
  不值得为超大文件付出重建成本）。

## 2. 基准内容（`EditorPane`）

打开文件时取一次 HEAD 全文：

```ts
const result = await window.api.git.fileDiff(group.path, relPath, 'modified', 'HEAD');
// result.baseContent 就是 HEAD 全文；未跟踪文件是空串（整篇算新增）
```

按 `relPath` 缓存在 ref 里，TTL 60 秒。**触发重新拉取的条件**：

1. `activePath` 变化（换文件）
2. `window` 的 `focus` 事件（提交完回到窗口时标记自动消失）
3. 新 prop `gitStateKey` 变化——`App.tsx` 用 `useMemo` 把
   `gitStatus.changes` 拼成 `path:indexStatus:worktreeStatus` 的字符串传进来，
   提交、暂存、放弃、切分支后条目会变，标记随之刷新

拉取失败（非 Git 项目、git 不可用）静默清空标记，不弹 toast。

**不计算标记的情况**：`untitled://N`、只读文件（二进制 / 超大 / 解码失败）、
拉取未返回前（用上一份缓存，没有缓存就不画）。

## 3. 编辑器渲染（`CodeMirrorHost`）

新增 props：

```ts
changeMarkers?: LineChanges | null;
```

用 `StateEffect` + `StateField` 注入，**不重建 `EditorView`**——撤销栈、光标、
滚动位置都必须保住（同 `readOnly` 走 Compartment 的理由）。effect 只在
`changeMarkers` 引用变化时 dispatch。

### Gutter

新增 `gutter({ class: 'cm-change-gutter', lineMarker, initialSpacer })`，
**排在 `lineNumbers` 之后**，即行号与正文之间——与参考截图一致。

`lineMarker(view, block)` 取 `view.state.doc.lineAt(block.from).number`，查表：

- 该行是 added → `<div class="cm-change-bar is-added">`
- 该行是 modified → `<div class="cm-change-bar is-modified">`
- 该行是删除锚点 → 额外加 `<div class="cm-change-triangle" title="...">`

一个格子可以同时有色条和三角（改 1 行删 1 行的情况），所以 marker 的 DOM
是一个容器，内部两个绝对定位的子元素。

gutter 宽度 14px。**开关只影响行号**：关掉「显示行号」时变更标记照常显示
（它是独立 gutter，不进 `displayExtensions` 的 Compartment）。

### 样式（`src/editorTheme.ts`，两套主题各一份）

项目规则要求字号/行高/字体只能由主题扩展设置；变色条颜色同样放主题里，
`styles.css` 只写不涉及主题变量的结构样式。

| 元素 | 浅色 | 深色 |
|---|---|---|
| 新增色条 | `#1e88e5` | `#4fa3ff` |
| 修改色条 | `#e8a33d` | `#e2b436` |
| 删除三角 | `#e5484d` | `#f14c4c` |

波浪竖条用内联 SVG data URI 作为 `background-image`，`repeat-y` 平铺；
修改色条用 `border-left: 3px solid`。三角用 CSS 边框画（向右的等腰三角），
绝对定位在该行格子的顶部。

## 4. 概览标尺（`src/components/EditorOverviewRuler.tsx`）

纯展示组件：

```tsx
<EditorOverviewRuler changes={changeMarkers} />
```

- 绝对定位在 `.editor-diff-pane` 内（父容器已有 `position: relative`），
  贴右缘、避开 10px 系统滚动条，宽 8px。
- 每个 `ChangeChunk` 渲染一个色块：`top = (startLine-1)/totalLines * 100%`，
  `height = max(3px, (endLine-startLine+1)/totalLines * 100%)`。
  added 用蓝、modified 用琥珀。
- 删除锚点渲染成 3px 高的红色色块，`top` 用锚点行号算。
- `pointer-events: none`，不抢滚动条和文本交互；`aria-hidden`。
- 没有标记时整条不渲染（返回 `null`）。

标尺不随滚动移动——它在 `.cm-scroller` 外面，因此不需要监听滚动。

## 5. 测试

### 离线：`tests/line-changes.mjs`

- 纯新增、纯删除、1 改 1、多改多、改加删混合
- 文件开头删除（锚点钳到第 1 行）、文件末尾删除
- 空文件 ↔ 有内容、两边相同（全部为空结果）
- 超过 20000 行返回空结果
- `splitLinesForDiff` 不把末尾换行算成一行

### GUI：`tests/editor-change-markers.mjs`

在临时 Git 仓库里改一行、加一行、删一行，打开文件后断言：

- `.cm-change-bar.is-added` / `.is-modified` 出现在预期行号格子
- `.cm-change-triangle` 出现在删除位置
- 概览标尺 `.editor-overview-ruler` 有子元素
- 切到未修改的文件后三类标记全部消失
- 关掉「显示行号」后色条仍在

沿用 `tests/editor-file-tree.mjs` 的临时仓库搭建方式。

## 影响面

| 文件 | 改动 |
|---|---|
| `src/lineChanges.ts` | 新增 |
| `src/components/EditorOverviewRuler.tsx` | 新增 |
| `src/diffFromText.ts` | 导出 `diffLines` / `DiffOp` / `splitLinesForDiff` |
| `src/components/CodeMirrorHost.tsx` | 新增 gutter + StateField + props |
| `src/components/EditorPane.tsx` | 拉取基准、防抖重算、挂标尺 |
| `src/App.tsx` | 传 `gitStateKey` |
| `src/editorTheme.ts` | 两套主题的标记配色 |
| `src/styles.css` | gutter 与标尺的结构样式 |
| `tests/line-changes.mjs` | 新增 |
| `tests/editor-change-markers.mjs` | 新增 |
| `CLAUDE.md` | 补一节「编辑器变更标记」的约定与坑 |

## 不做的事

- 不加设置开关（已确认：一直显示）
- 不加行背景色
- 不做点击展开被删内容（只做悬停 title）
- 不引入 `@codemirror/merge`
- 不改 `DiffPane`（左右分栏对比维持现状）

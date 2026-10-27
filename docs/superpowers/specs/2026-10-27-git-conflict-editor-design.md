# 冲突解决

日期：2026-10-27
状态：待实施
前置：`2026-10-27-git-editor-design.md`（必须先完成编辑器页签）

## 背景

合并分支时若有冲突，Git 会在文件里写入冲突标记并把仓库停在「合并中」状态。目前面板只能提示用户去终端处理。本设计让用户在编辑器页签里逐块解决冲突。

## 需求范围

### 做

- 识别文件中的冲突标记块
- 每个冲突块上方浮出操作条：采用当前 / 采用传入 / 两者都保留
- 处理完所有块后提示用户可以保存并暂存

### 不做

- 三栏对比视图（当前 / 结果 / 传入）
- 逐行选择
- 自动执行 `git merge --abort`
- 保存后自动 `git add`
- `git rebase` / `git cherry-pick` 产生的冲突（标记格式相同，理论上可用，但不专门测试）

## 冲突标记格式

标准冲突标记：

```
<<<<<<< HEAD
当前分支的内容
=======
传入分支的内容
>>>>>>> feature/login
```

个别配置下 `=======` 前会有 `|||||||` 基线段（`merge.conflictStyle=diff3`）：

```
<<<<<<< HEAD
当前
||||||| base
基线
=======
传入
>>>>>>> feature/login
```

解析必须兼容两种形式。

## 解析

新增 `src/conflictParser.ts`：

```ts
type ConflictBlock = {
  startLine: number;      // <<<<<<< 所在行（0 基）
  separatorLine: number;  // ======= 所在行
  endLine: number;        // >>>>>>> 所在行
  baseLine: number | null; // ||||||| 所在行，无则 null
  oursLabel: string;      // <<<<<<< 之后的内容，如 "HEAD"
  theirsLabel: string;    // >>>>>>> 之后的内容，如 "feature/login"
};

function parseConflicts(text: string): ConflictBlock[]
```

逐行扫描，遇到以 `<<<<<<<` 开头的行开始一个块，按顺序寻找 `|||||||`（可选）、`=======`、`>>>>>>>`。缺少任何一个结束标记则视为不完整，该块忽略并整体返回空数组——宁可不高亮，也不要错误地改写内容。

## 交互

### 展示

CodeMirror 用 `Decoration.mark` 给三段着色：

| 区段 | 背景 |
|---|---|
| `<<<<<<<` 到 `=======` 之间（当前） | 淡蓝 |
| `=======` 到 `>>>>>>>` 之间（传入） | 淡绿 |
| 三行标记本身 | 淡灰，字色更淡 |

每个块的 `<<<<<<<` 行上方用 `Decoration.widget` 插入操作条：

```
[ 采用当前 ] [ 采用传入 ] [ 两者都保留 ]
```

### 操作语义

设块内容为三部分：`ours`（当前）、`base`（可能为空）、`theirs`（传入）。

| 按钮 | 结果 |
|---|---|
| 采用当前 | 用 `ours` 的行替换 `<<<<<<<` 到 `>>>>>>>` 整段（含标记行） |
| 采用传入 | 用 `theirs` 替换 |
| 两者都保留 | 用 `ours` + `theirs` 顺序拼接替换 |

替换通过 CodeMirror 的 `dispatch({ changes })` 完成，落在撤销栈里，Ctrl+Z 可恢复。

### 全部处理完

所有冲突块消失后（`parseConflicts` 返回空且文档中不含 `<<<<<<<`），状态条显示：

> 冲突已全部处理。按 Ctrl+S 保存，然后点「暂存」标记为已解决。

**不自动保存，不自动暂存**——与 Git 语义一致，由用户显式操作。

### 未处理完就保存

允许保存。文件里仍带冲突标记，`git status` 会继续把它标为冲突（`!`）。不阻止用户保存部分进展。

## 状态

`EditorPane` 在打开文件时检测冲突：

```ts
const conflicts = parseConflicts(content);
const hasConflicts = conflicts.length > 0 || /^<{7}/m.test(content);
```

工具栏显示「冲突 N 处」徽标。不做额外的 IPC——冲突信息完全由文件内容推导，保存后由下一次 `git:status` 反映。

## 涉及文件

| 文件 | 变更 |
|---|---|
| `src/conflictParser.ts` | 新增，标记解析 |
| `src/components/ConflictBar.tsx` | 新增，操作条组件 |
| `src/components/CodeMirrorHost.tsx` | 增加冲突装饰与 widget |
| `src/components/EditorPane.tsx` | 冲突徽标、全处理完提示 |
| `src/styles.css` | 冲突区块配色、操作条样式 |
| `tests/conflict-parser.mjs` | 新增，解析逻辑测试 |
| `tests/editor.mjs` | 追加冲突解决端到端场景 |

## 测试

### 解析（`tests/conflict-parser.mjs`）

纯函数测试，直接对字符串断言：

| 输入 | 期望 |
|---|---|
| 无冲突标记 | 返回空数组 |
| 标准标记两块 | 返回 2 个块，行号正确 |
| diff3 形式（含 `\|\|\|\|\|\|\|`） | 正确识别 `baseLine` |
| 缺少 `>>>>>>>` | 返回空数组（不误判） |
| 标记在字符串中间、非行首 | 不识别 |

### 端到端（追加到 `tests/editor.mjs`）

准备一个真实冲突仓库：两个分支改同一行，`git merge` 制造冲突。

| 场景 | 断言 |
|---|---|
| 打开冲突文件 | 出现 1 个冲突操作条，工具栏显示「冲突 1 处」 |
| 点「采用当前」 | 标记消失，内容等于当前分支版本 |
| Ctrl+Z | 恢复冲突标记 |
| 点「采用传入」 | 内容等于传入分支版本 |
| 点「两者都保留」 | 两段内容都在 |
| 处理完保存后 `git add` | `git status` 中该文件不再冲突 |

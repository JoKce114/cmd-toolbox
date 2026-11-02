# 空白编辑器窗口（Untitled）— 设计

日期：2026-11-02
状态：已确认，待实现

## 目标

编辑器支持「还没有对应磁盘文件」的空白窗口，行为对齐 VS Code 的 `Untitled-1`：
可以随手记一段代码、粘贴一段内容，按 Ctrl+S 时才决定存到哪。
空白窗口同样能参与对比。

## 交互

### 新建

两个入口：

- 编辑器顶部页签栏右侧的 **＋** 按钮
- 页签右键菜单里的「新建空白文件」

也可以把一个空白窗口理解为普通编辑器页签，只是标题是 `Untitled-N`。

### 标题编号

`Untitled-1`、`Untitled-2`…**复用最小可用编号**：关掉 `Untitled-1` 后再新建，
得到的仍是 `Untitled-1`。编号在同一个项目内唯一，不同项目各自独立计数。

### 保存（另存为）

空白窗口按 `Ctrl+S` 或点保存按钮，弹出输入框填写**相对项目根的路径**：

- 支持带目录：`app/service/a.php`，父目录不存在会自动创建
- 文件名必须带扩展名（决定了语法高亮和诊断）
- 校验规则与文件树的新建文件一致：不能为空、不能是 `.` / `..`、
  不能含 `/ \ < > : " | ? *`（`/` 作为目录分隔符合法）
- 目标已存在时报错，**不覆盖**，弹窗保持打开

保存成功后：

- 页签标题从 `Untitled-1` 变成文件名
- 内容写盘，该页签变成普通文件页签
- **撤销栈保留**——用户不该因为保存而丢失 Ctrl+Z 的能力
- 文件树刷新，新文件出现在树里

### 关闭

有内容的空白窗口关闭时，提示「有未保存的修改，关闭将丢失」，与普通页签一致。
空内容的空白窗口直接关，不打扰。

### 会话恢复

未保存的空白窗口会被持久化，重启应用后内容与编号一起回来。
`Untitled-N` 的编号在恢复时同样按最小可用值重新分配。

### 参与对比

在「打开的编辑器」里右键空白窗口，可以：

- 选为对比对象（「选择以进行比较」）
- 与其他文件互比
- 与磁盘版本比较——**无意义，置灰**（空白窗口没有磁盘版本）
- 与 Git HEAD 比较——**无意义，置灰**

两个空白窗口互比是允许的。

## 架构

### 核心决策：虚拟路径

`useEditorFiles` 的 `files` 以 `relPath` 为键，且整个编辑器有 65 处引用把
`relPath` 当作唯一身份（`activePath`、对比、打开的编辑器列表、文件树高亮）。
把键换成独立 id 的改法需要动这 65 处并逐一重新验证，风险远大于收益。

所以采用**虚拟路径**：空白窗口在 `files` 里的键是 `untitled://<n>`。
这个键对上层完全透明——对比、列表、页签栏都当普通 `relPath` 用。

代价是虚拟路径不能走到任何磁盘 API 上，必须在**源头**挡住，见下。

### 虚拟路径的边界

在 `src/useEditorFiles.ts` 里导出一个唯一的判断函数：

```ts
export const UNTITLED_PREFIX = 'untitled://';
export function isUntitledPath(relPath: string): boolean {
  return relPath.startsWith(UNTITLED_PREFIX);
}
```

**所有**碰磁盘或碰 mtime 的地方，必须先过这个判断并提前返回：

| 位置 | 处理 |
|---|---|
| `open()` | 虚拟路径不读盘，直接建一个空条目（`content: ''`, `savedContent: ''`, `readOnly: false`） |
| `save()` | 虚拟路径**不写盘**，改为触发「另存为」流程 |
| `reloadFromDisk()` | 虚拟路径直接 return |
| 2 秒 mtime 轮询 | 虚拟路径直接跳过，否则每 2 秒报一次错 |
| `autoMinify` / 文件改动监听 | 虚拟路径跳过 |
| `rename()` / `close()` | 正常处理（内存操作，不碰盘） |

**不要在调用方各自判断**——判断逻辑集中在这一个函数里，新增读盘入口时
只要调它就不会出事。

### 另存为的实现

新增 `saveUntitledAs(virtualPath, targetRelPath)`：

1. `window.api.files.createFile(projectPath, targetRelPath, content)`
   —— 用 `'wx'` 语义，目标存在就失败，绝不覆盖
2. 成功后在**一次** `setFiles` 里做原子替换：删掉 `untitled://N` 的条目，
   用 `targetRelPath` 作键写入同样的内容与编辑状态
3. `setActivePath(targetRelPath)`
4. 同步更新 `touchedRef` / `savedByAppRef`，避免被「顶替未改动页签」的逻辑误删
5. 通知上层刷新文件树（复用已有的 `treeRefreshToken`）

**先写盘、成功后再换键**。任何一步失败都保持原状，不做「先改键再写盘」——
那样写盘失败会留下一个指向不存在文件的页签。

### 编号分配

```ts
// 扫描现有 untitled://N，取最小未使用的 N
function nextUntitledIndex(paths: string[]): number
```

同一项目独立计数。恢复会话时也用同一个函数重新分配，
所以「关掉 Untitled-1 再重启」不会留下编号空洞。

### 与其他模块的交界

| 模块 | 改动 |
|---|---|
| `src/useEditorFiles.ts` | 虚拟路径判断、`createUntitled`、`saveUntitledAs`、所有读盘入口的守卫 |
| `src/components/EditorPane.tsx` | 另存为输入框、对比菜单按虚拟路径置灰、页签标题显示 `Untitled-N` |
| `src/components/TabStrip.tsx` 或编辑器页签栏 | 新增 ＋ 按钮、右键「新建空白文件」 |
| `src/components/EditorSidebar.tsx` | 「打开的编辑器」列表显示 `Untitled-N`（虚拟路径直接当标签显示） |
| `desktop/session.js` | `normalizeTab` 允许 `untitled://` 开头的 `filePath`；内容存进会话 |
| `src/App.tsx` | 会话快照带上空白窗口的内容 |

**会话持久化**需要特别处理：现在会话只存 `filePath`，不存内容。
空白窗口没有磁盘文件可读，必须把内容一起存进 `session.json`。
只存到会话文件里、不进任何缓存目录，且大小上限与会话文件现状保持一致。

## 错误与边界

| 情况 | 表现 |
|---|---|
| 另存为时路径已存在 | 弹窗内报错「该路径已存在文件」，不覆盖，不关窗 |
| 另存为时路径非法 | 弹窗内报错，不关窗 |
| 另存为写盘失败（磁盘满、权限） | 弹窗内报错，内容与页签原样保留 |
| 空白窗口内容超大会话文件 | 沿用会话文件现有的大小上限；超限时跳过该窗口的持久化并提示 |
| 空白窗口参与「与磁盘比较」 | 菜单置灰 |
| 空白窗口参与「与 Git HEAD 比较」 | 菜单置灰 |
| 项目被删除后恢复会话里的空白窗口 | 与其他页签一致，随项目一起丢弃 |

## 测试

### 离线

- `nextUntitledIndex`：空列表返回 1；`[1,3]` 返回 2；`[1,2,3]` 返回 4
- `isUntitledPath`：前缀匹配、大小写敏感
- `session.js` 的 `normalizeTab`：`filePath` 为 `untitled://1` 时保留而不是清空

### UI（追加到 `tests/editor-file-tree.mjs` 或新建 `tests/editor-untitled.mjs`）

- 点 ＋ 新建空白窗口，标题为 `Untitled-1`；再建一个是 `Untitled-2`
- 关掉 `Untitled-1` 后再新建，仍是 `Untitled-1`
- 在空白窗口里输入内容 → Ctrl+S → 填入 `app/new.php` → 保存后标题变成 `new.php`、
  文件出现在磁盘与文件树
- 另存为填入已存在的路径 → 弹窗报错、未关闭、原文件内容不变
- 保存后按 Ctrl+Z 能撤销保存前的编辑
- 有内容的空白窗口关闭时弹确认
- 重启应用后空白窗口与内容恢复
- 空白窗口的「与磁盘比较」「与 Git HEAD 比较」菜单置灰

## 涉及文件

| 文件 | 改动 |
|---|---|
| `src/useEditorFiles.ts` | 虚拟路径判断、新建与另存为、所有读盘入口的守卫 |
| `src/components/EditorPane.tsx` | 另存为弹窗、对比菜单置灰、标题显示 |
| `src/components/EditorPane.tsx` 的页签栏（`.editor-tabs`） | ＋ 按钮、右键菜单 |
| `src/components/OpenEditors.tsx` | 显示 `Untitled-N` 标签 |
| `src/App.tsx` | 会话快照带上空白窗口内容 |
| `desktop/session.js` | 允许虚拟路径、持久化内容 |
| `src/styles.css` | 如有需要 |
| `tests/editor-untitled.mjs` | 新建：UI 测试 |
| `tests/symbols.mjs` 或新建离线用例 | `nextUntitledIndex` / `isUntitledPath` |
| `CLAUDE.md` | 记录虚拟路径约定 |

## 不做的事

- 不做「保存副本」「另存为到项目外」——只在项目内保存，避免引入项目外文件的边界状态
- 不做空白窗口的自动备份/崩溃恢复
- 不做空白窗口的符号跳转（没有磁盘文件，索引里不存在）

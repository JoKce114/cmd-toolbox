# 源代码管理点开文件的页签复用与未保存保护 — 设计

日期：2026-11-04
状态：已确认，待实现

## 目标

点击源代码管理（Git 面板）里的文件名时，页签行为要和编辑器页签一致：

1. **文件在编辑器里已打开且有未保存修改** → 不开差异页签，直接切到那个编辑器页签
2. **连续点击多个文件** → 复用「没被触碰过」的差异页签，不攒出一排页签

不做的：不把编辑器的内存内容喂给差异页签、不做差异页签内的编辑与保存、
不改提交历史（commit）页签的去重方式。

## 现状

| 入口 | 代码 | 现行为 |
|---|---|---|
| Git 面板点文件名 | `openDiffTab`（`src/App.tsx:1862`） | 按 `diffChange.path` 去重；**不同文件各开一个新页签** |
| Git 面板点文件图标 | `openEditorFile`（`src/App.tsx:1932`） | 按 `filePath` 去重，并复用未触碰的编辑器页签 |
| 差异页签的「打开文件」 | 同上 | 已经会激活已存在的编辑器页签 |
| Git 历史点提交 | `openCommitDiffTab`（`src/App.tsx:1897`） | 按 `diffCommit.hash` 去重 |

差异页签的内容来自 `window.api.git.fileDiff(...)`，读的是**磁盘/索引**，
不包含编辑器里未保存的内容。因此文件有未保存修改时，差异页签展示的是旧内容，
这正是要拦下来的场景。

`src/App.tsx:251` 已有 `dirtyTabsRef: Map<tabId, boolean>`（由
`EditorPane` 的 `onDirtyChange` 写入）与 `touchedTabsRef: Set<tabId>`，
本设计直接复用，不新增状态容器。

## 1. 未保存文件改为切到编辑器页签

`openDiffTab` 在**最前面**（早于按路径去重）加一段判断：

```ts
const dirtyEditor = groupTabs.find(
  (item) =>
    item.shellId === 'editor' &&
    item.filePath === change.path &&
    dirtyTabsRef.current.get(item.id),
);
if (dirtyEditor) {
  activateTab(group.key, dirtyEditor);
  pushToast('文件有未保存修改，已切到编辑器页签', 'info');
  return;
}
```

- 判断放在按路径去重之前：让「有未保存修改」的规则优先于「差异页签已经存在」。
- 只查**同一个项目**的页签（`groupTabs` 本来就是 `tabsRef.current[group.key]`），
  不同项目里的同名相对路径不算。
- `activateTab` 是新抽出来的小函数，负责「设为激活项目 + 激活页签 + 页签在右栏时
  把焦点和右栏激活项一起换过去」。`openDiffTab` / `openCommitDiffTab` /
  `openEditorFile` 里现在各写了一遍同样的几行，统一改用它。
- 不做自动保存，也不切过去之后弹确认框——用户点开就想看，切过去是唯一不产生
  歧义的动作。

## 2. 复用未触碰的差异页签

### 触碰的判定

差异页签是只读的，没有 dirty 概念，所以不能沿用编辑器的 `handleDirtyChange`。
新增一个交互信号：

- 给 `DiffPane` 加可选 prop `onInteract?: () => void`。
- 在它的根 `<section className="terminal-pane diff-pane">` 上挂 `onPointerDown`
  与 `onWheel`，用 `useRef` 保证**只回调一次**。
- `App.tsx` 传 `onInteract={() => markTabTouched(tab.id)}`，内部
  `touchedTabsRef.current.add(tab.id)`。

要点：

- **仅仅是页签被激活不算触碰**。否则第一个差异页签一打开就被标脏，永远复用不了。
- 页签被复用时 React 不重建组件（`key={tab.id}` 不变），内部的一次性标记随之保留，
  之后继续算已触碰。
- `closeTabs` 已经在删页签时清 `touchedTabsRef`，不需要额外处理。

### 复用规则

先按路径去重（同一个文件永远只有一页），再找可复用的：

```ts
const reusable = groupTabs.filter(
  (item) => item.shellId === 'diff' && item.diffChange && !touchedTabsRef.current.has(item.id),
);
const activeId = activeTabByGroupRef.current[group.key];
const target = reusable.find((item) => item.id === activeId) ?? reusable[reusable.length - 1];
```

命中就地把该页签的 `diffChange` 与 `descriptor` 换成新的：

```ts
{ ...item, diffChange: change, descriptor: change.path.split('/').pop() || '差异' }
```

- 只复用**变更类**差异页签（`item.diffChange` 存在）；提交类页签不参与，
  避免点一个提交把它顶掉。
- 优先当前激活的那个，与 `openEditorFile` 的取舍顺序一致。
- `DiffPane` 的加载 effect 依赖 `changePath` / `changeStatus`，换文件后自动重新拉 patch，
  不需要额外的刷新机制。滚动位置会保留——可接受，与编辑器页签复用时的行为一致。

## 3. 顺序

`openDiffTab` 中的判断按这个顺序：

1. 项目目录不存在 → 报错返回（现状）
2. **该文件在编辑器里有未保存修改 → 切到编辑器页签**（新增）
3. 已有同路径的差异页签 → 激活它（现状）
4. 有未触碰的变更类差异页签 → 换掉它的 `diffChange`（新增）
5. 都没有 → 新建差异页签（现状）

`openCommitDiffTab` 只增加第 4 步之外的 `activateTab` 复用，行为不变。

## 4. 测试

新增 GUI 用例 `tests/scm-open-behavior.mjs`（沿用 `tests/git-panel.mjs` 的临时仓库搭建）：

- 打开 A 的编辑器页签并改一行不保存 → 点 SCM 里的 A → 激活的是编辑器页签，
  页签总数不变，出现提示文案
- 保存 A 后再点 → 开差异页签
- 不触碰差异页签，依次点 B、C → 始终只有一个差异页签，标题是 C
- 在 B 的差异页签里滚动一次，再点 C → 出现第二个差异页签
- 关掉全部差异页签后再点 → 重新复用（`touchedTabsRef` 已清理）
- 点提交历史的提交 → 不受变更页签复用影响

## 影响面

| 文件 | 改动 |
|---|---|
| `src/App.tsx` | `activateTab` 抽取；`openDiffTab` 加两道判断；传 `onInteract` |
| `src/components/DiffPane.tsx` | 新增可选 `onInteract`，根元素挂一次性监听 |
| `tests/scm-open-behavior.mjs` | 新增 |

## 不做的事

- 不让差异页签读取编辑器里未保存的内容（要读就要把 `kind: 'text'` 那套接进来，
  与「先保存再看差异」的心智模型冲突）
- 不加「预览页签」的斜体样式——复用行为已经足够，再加视觉状态是多余的
- 不改提交历史页签的去重方式

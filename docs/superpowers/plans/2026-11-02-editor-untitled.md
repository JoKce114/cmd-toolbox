# 空白编辑器窗口（Untitled）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 编辑器支持没有对应磁盘文件的空白窗口（`Untitled-1`），Ctrl+S 弹「另存为」填路径后落盘并转成普通文件页签，且能参与对比。

**Architecture:** 空白窗口在 `useEditorFiles` 的 `files` 里以虚拟路径 `untitled://N` 作键，对上层完全透明。所有碰磁盘 / mtime 的入口统一由 `isUntitledPath()` 守卫。保存走「先写盘成功、再原子换键」，避免写盘失败留下指向不存在文件的页签。

**Tech Stack:** React 19、TypeScript、CodeMirror 6、Electron 主进程（CommonJS）。

## Global Constraints

- 虚拟路径前缀固定为 `untitled://`，判断函数只有一个：`isUntitledPath(relPath)`。
- **不要在任何调用方各自判断虚拟路径**——统一调 `isUntitledPath()`，新增读盘入口时也必须先过它。
- 另存为**绝不覆盖**已存在的文件：复用 `window.api.files.createFile`（`'wx'` 语义）。
- 另存为必须**先写盘成功再换键**，任何一步失败保持原状。
- 保存后**撤销栈不能丢**：换路径时上层不能触发编辑器重新 `open()`。
- 编号复用最小可用值（关掉 `Untitled-1` 再新建仍是 `Untitled-1`）。
- 名字校验与文件树新建一致：非空、不能是 `.` / `..`、不能含 `/ \ < > : " | ? *`（`/` 作目录分隔符合法）。
- UI 测试独占 17382 端口，改完 `src/` 先 `npx tsc --noEmit && npx vite build`。
- 测试断言用中文；提交信息不含 AI 署名。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/untitledPath.ts` | 新建：虚拟路径常量、判断、编号分配、显示名 |
| `src/useEditorFiles.ts` | 虚拟路径守卫、`saveUntitledAs`、`restoreUntitled` |
| `src/components/SaveAsModal.tsx` | 新建：另存为输入框弹窗 |
| `src/components/EditorPane.tsx` | 页签标题、＋按钮、右键菜单、保存分支、对比置灰 |
| `src/components/OpenEditors.tsx` | 显示 `Untitled-N` |
| `src/App.tsx` | 页签路径更新、空白窗口内容进会话快照 |
| `desktop/session.js` | 允许并持久化空白窗口内容 |
| `tests/untitled-path.mjs` | 新建：纯函数离线测试 |
| `tests/editor-untitled.mjs` | 新建：UI 测试 |
| `CLAUDE.md` | 记录虚拟路径约定 |

---

## Task 1: 虚拟路径的纯函数

**Files:**
- Create: `src/untitledPath.ts`
- Test: `tests/untitled-path.mjs`

**Interfaces:**
- Produces: `UNTITLED_PREFIX`、`isUntitledPath(relPath): boolean`、
  `nextUntitledIndex(paths: string[]): number`、`untitledPathFor(index: number): string`、
  `displayNameFor(relPath: string): string`

- [ ] **Step 1: 写失败的测试**

创建 `tests/untitled-path.mjs`：

```js
// 空白窗口的虚拟路径：判断、编号分配、显示名。纯函数，离线可跑。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
void require;

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error('断言失败：' + message);
  passed += 1;
  console.log('  ok  ' + message);
}

const mod = await import('../src/untitledPath.ts');

console.log('1. isUntitledPath');
assert(mod.isUntitledPath('untitled://1') === true, '虚拟路径被识别');
assert(mod.isUntitledPath('untitled://42') === true, '多位数编号也识别');
assert(mod.isUntitledPath('app/a.php') === false, '普通路径不是虚拟路径');
assert(mod.isUntitledPath('') === false, '空字符串不是虚拟路径');
assert(mod.isUntitledPath('untitled:/x') === false, '少一个斜杠不算（前缀严格匹配）');

console.log('2. untitledPathFor');
assert(mod.untitledPathFor(1) === 'untitled://1', '编号 1 拼出正确路径');
assert(mod.untitledPathFor(12) === 'untitled://12', '两位数编号');

console.log('3. nextUntitledIndex 复用最小可用值');
assert(mod.nextUntitledIndex([]) === 1, '空列表返回 1');
assert(mod.nextUntitledIndex(['untitled://1']) === 2, '已有 1 返回 2');
assert(mod.nextUntitledIndex(['untitled://2']) === 1, '缺 1 时返回 1');
assert(mod.nextUntitledIndex(['untitled://1', 'untitled://3']) === 2, '复用中间空缺的 2');
assert(
  mod.nextUntitledIndex(['untitled://1', 'untitled://2', 'untitled://3']) === 4,
  '连续时返回下一个',
);
assert(
  mod.nextUntitledIndex(['app/a.php', 'untitled://2']) === 1,
  '普通路径不参与编号计算',
);

console.log('4. displayNameFor');
assert(mod.displayNameFor('untitled://1') === 'Untitled-1', '虚拟路径显示为 Untitled-1');
assert(mod.displayNameFor('untitled://12') === 'Untitled-12', '两位数编号');
assert(mod.displayNameFor('app/service/a.php') === 'a.php', '普通路径取文件名');
assert(mod.displayNameFor('') === '编辑器', '空路径给兜底名');

console.log(`\n全部通过：${passed} 项`);
```

- [ ] **Step 2: 运行确认失败**

Run: `node tests/untitled-path.mjs`
Expected: FAIL —— 找不到 `src/untitledPath.ts`

- [ ] **Step 3: 实现**

创建 `src/untitledPath.ts`：

```ts
// 空白窗口在 useEditorFiles 的 files 里用虚拟路径当键。
// 这个文件是唯一的判断来源：所有碰磁盘或 mtime 的地方都必须先过 isUntitledPath()，
// 不要在调用方各自写 startsWith 判断——漏一处就会拿伪路径去读磁盘。

export const UNTITLED_PREFIX = 'untitled://';

export function isUntitledPath(relPath: string): boolean {
  return String(relPath || '').startsWith(UNTITLED_PREFIX);
}

export function untitledPathFor(index: number): string {
  return `${UNTITLED_PREFIX}${index}`;
}

// 取最小可用编号：关掉 Untitled-1 再新建，拿到的还是 Untitled-1。
// 普通路径不参与计算，避免和真实文件名冲突。
export function nextUntitledIndex(paths: string[]): number {
  const used = new Set<number>();
  for (const relPath of paths) {
    if (!isUntitledPath(relPath)) continue;
    const index = Number(relPath.slice(UNTITLED_PREFIX.length));
    if (Number.isInteger(index) && index > 0) used.add(index);
  }
  let index = 1;
  while (used.has(index)) index += 1;
  return index;
}

// 页签标题与「打开的编辑器」列表都用它，虚拟路径显示成 Untitled-N
export function displayNameFor(relPath: string): string {
  if (!relPath) return '编辑器';
  if (isUntitledPath(relPath)) {
    return `Untitled-${relPath.slice(UNTITLED_PREFIX.length)}`;
  }
  return relPath.split('/').pop() || relPath;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node tests/untitled-path.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/untitledPath.ts tests/untitled-path.mjs
git commit -m "$(cat <<'EOF'
feat(editor): 空白窗口的虚拟路径工具

判断、编号分配（复用最小可用值）与显示名。所有读盘入口都要先过
isUntitledPath，这里是唯一判断来源。
EOF
)"
```

---

## Task 2: useEditorFiles 支持虚拟路径

**Files:**
- Modify: `src/useEditorFiles.ts`

**Interfaces:**
- Consumes: Task 1 的 `isUntitledPath` / `untitledPathFor` / `nextUntitledIndex`
- Produces: 无新增导出（空白窗口由上层改 `tab.filePath` 驱动，`open()` 已能处理虚拟路径）

- [ ] **Step 1: 加虚拟路径守卫**

在 `src/useEditorFiles.ts` 顶部导入：

```ts
import { isUntitledPath, nextUntitledIndex, untitledPathFor } from './untitledPath';
```

在 `open()` 的开头（`if (!relPath) return false;` 之后）插入：

```ts
      // 空白窗口没有磁盘文件：直接建一个空条目，不读盘。
      if (isUntitledPath(relPath)) {
        if (filesRef.current[relPath]) {
          setActivePath(relPath);
          return true;
        }
        setActivePath(relPath);
        setFiles((previous) => ({
          ...previous,
          [relPath]: { ...EMPTY, relPath, content: '', savedContent: '' },
        }));
        touchedRef.current.add(relPath);
        return true;
      }
```

在 `save()` 的开头插入（在取 `state` 之前）：

```ts
      // 空白窗口不写盘：另存为由调用方接管
      if (isUntitledPath(relPath)) return 'unchanged';
```

在 `reloadFromDisk()` 的开头插入：

```ts
    if (isUntitledPath(relPath)) return;
```

在 2 秒 mtime 轮询的 effect 里，取到 `relPath` 之后立刻插入：

```ts
      if (isUntitledPath(relPath)) return;
```

在 `autoMinify` 与 `autoMinifyIfUnchangedOnDisk` 的开头各插入：

```ts
  if (isUntitledPath(relPath)) return;
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add src/useEditorFiles.ts
git commit -m "$(cat <<'EOF'
feat(editor): useEditorFiles 支持虚拟路径的空白窗口

open/save/reload/mtime 轮询/自动压缩全部先过 isUntitledPath 守卫，
虚拟路径不碰磁盘。空白窗口由上层改 tab.filePath 驱动。
EOF
)"
```

---

## Task 3: 另存为（saveUntitledAs）

**Files:**
- Modify: `src/useEditorFiles.ts`

**Interfaces:**
- Produces: `saveUntitledAs(virtualPath: string, targetRelPath: string): Promise<{ ok: boolean; message?: string }>`

- [ ] **Step 1: 实现**

在 `open` 之后加入：

```ts
  // 空白窗口另存为：先写盘、成功后再原子换键。
  // 反过来（先换键再写盘）一旦写盘失败，就会留下指向不存在文件的页签。
  // 换键时保留 content / dirty 之外的编辑状态，撤销栈在 CodeMirror 实例里，不受影响。
  const saveUntitledAs = useCallback(
    async (
      virtualPath: string,
      targetRelPath: string,
    ): Promise<{ ok: boolean; message?: string }> => {
      const state = filesRef.current[virtualPath];
      if (!state) return { ok: false, message: '空白窗口已关闭' };
      if (!isUntitledPath(virtualPath)) {
        return { ok: false, message: '该页签不是空白窗口' };
      }
      if (isUntitledPath(targetRelPath)) {
        return { ok: false, message: '目标路径无效' };
      }
      if (filesRef.current[targetRelPath]) {
        return { ok: false, message: '该文件已在编辑器中打开' };
      }

      try {
        await window.api.files.createFile(
          groupRef.current.path,
          targetRelPath,
          state.content,
        );
      } catch (error) {
        return { ok: false, message: toErrorMessage(error) };
      }

      const next: EditorFileState = {
        ...state,
        relPath: targetRelPath,
        savedContent: state.content,
        dirty: false,
        saving: false,
        loading: false,
        mtime: 0,
        readOnly: false,
        failedPath: '',
      };

      setFiles((previous) => {
        const merged = { ...previous };
        delete merged[virtualPath];
        merged[targetRelPath] = next;
        return merged;
      });
      touchedRef.current.delete(virtualPath);
      touchedRef.current.add(targetRelPath);
      savedByAppRef.current.add(targetRelPath);
      setActivePath(targetRelPath);
      return { ok: true };
    },
    [],
  );
```

在返回对象里加上 `saveUntitledAs`。

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add src/useEditorFiles.ts
git commit -m "$(cat <<'EOF'
feat(editor): 空白窗口另存为

先 createFile 写盘成功再原子换键；已存在的目标、已打开的文件、
非法路径都在写盘前拦下，内容与页签保持原样。
EOF
)"
```

---

## Task 4: 另存为弹窗

**Files:**
- Create: `src/components/SaveAsModal.tsx`

**Interfaces:**
- Produces: `SaveAsModal` 组件
- Props: `{ suggestedName: string; onClose: () => void; onSubmit: (relPath: string) => Promise<string | null> }`
  —— `onSubmit` 返回错误文案（非空则不关窗），返回 `null` 表示成功

**为什么不用 `window.prompt`：** Electron 渲染进程里它直接抛
`prompt() is not supported.`（本项目已实测），新建文件时踩过同一个坑。

- [ ] **Step 1: 实现**

创建 `src/components/SaveAsModal.tsx`：

```tsx
import { useState } from 'react';
import { FilePlus } from 'lucide-react';
import { Modal } from './Modal';

type SaveAsModalProps = {
  suggestedName: string;
  onClose: () => void;
  // 返回错误文案；返回 null 表示保存成功，弹窗自行关闭
  onSubmit: (relPath: string) => Promise<string | null>;
};

// 与文件树新建文件同一套名字规则；区别是这里允许用 / 分级目录
function validate(relPath: string): string {
  const value = relPath.trim();
  if (!value) return '请填写文件名';
  if (value === '.' || value === '..') return '文件名无效';
  if (/[<>:"|?*]/.test(value)) return '文件名不能包含 < > : " | ? *';
  if (value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    return '目录名不能为空，也不能是 . 或 ..';
  }
  if (value.startsWith('/')) return '请填写相对项目根的路径';
  const base = value.split('/').pop() || '';
  if (!base.includes('.')) return '文件名需要带扩展名，例如 a.php';
  return '';
}

export function SaveAsModal({ suggestedName, onClose, onSubmit }: SaveAsModalProps) {
  const [value, setValue] = useState(suggestedName);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    const invalid = validate(value);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const message = await onSubmit(value.trim());
      if (message) setError(message);
      else onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="另存为"
      subtitle="填写相对项目根的路径，父目录会自动创建"
      icon={<FilePlus size={16} />}
      width={400}
      onClose={onClose}
    >
      <div className="modal-body">
        <label className="field">
          <span className="field-label">保存路径</span>
          <input
            data-autofocus
            type="text"
            value={value}
            spellCheck={false}
            placeholder="例如 app/service/helper.php"
            onChange={(event) => {
              setValue(event.target.value);
              setError('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </label>
        {error ? <p className="field-error">{error}</p> : null}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: 确认 `Modal` 与 `field-error` 可用**

Run:
```bash
grep -n "field-error" src/styles.css | head -3
grep -n "export function Modal" -A12 src/components/Modal.tsx
```
Expected: 若 `field-error` 不存在，在 `src/styles.css` 末尾补：

```css
.field-error {
  margin: 6px 0 0;
  font-size: 12px;
  color: #d1242f;
}
```

- [ ] **Step 3: 类型检查与构建**

Run: `npx tsc --noEmit && npx vite build`
Expected: 均通过

- [ ] **Step 4: 提交**

```bash
git add src/components/SaveAsModal.tsx src/styles.css
git commit -m "$(cat <<'EOF'
feat(editor): 另存为弹窗

用 Modal 而不是 window.prompt（Electron 里不可用）。支持带目录的相对路径，
校验规则与文件树新建一致，错误留在弹窗内显示。
EOF
)"
```

---

## Task 5: EditorPane 接入空白窗口

**Files:**
- Modify: `src/components/EditorPane.tsx`
- Modify: `src/components/OpenEditors.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: Task 1 的 `displayNameFor` / `isUntitledPath` / `nextUntitledIndex` / `untitledPathFor`；Task 2/3 的 `saveUntitledAs`；Task 4 的 `SaveAsModal`
- Produces: `EditorPane` 新增 prop `onFilePathChange?: (relPath: string) => void`

- [ ] **Step 1: App 增加页签路径更新**

在 `src/App.tsx` 里 `setTabDescriptor` 附近加入：

```tsx
  // 空白窗口另存为后，页签要从虚拟路径换成真实路径
  const setTabFilePath = useCallback(
    (groupKey: string, tabId: string, relPath: string) => {
      const list = tabsRef.current[groupKey] || [];
      if (!list.some((tab) => tab.id === tabId)) return;
      applyTabs({
        ...tabsRef.current,
        [groupKey]: list.map((tab) =>
          tab.id === tabId ? { ...tab, filePath: relPath } : tab,
        ),
      });
    },
    [applyTabs],
  );
```

在 `renderWorkbenchPane` 里的 `<EditorPane ...>` 上补：

```tsx
          onFilePathChange={(relPath) => setTabFilePath(tab.groupKey, tab.id, relPath)}
```

- [ ] **Step 2: EditorPane 解构新方法并接收新 prop**

在 `useEditorFiles` 的解构里补 `saveUntitledAs`（Task 7 之后还要补 `restoreUntitled`）：

```tsx
  const {
    files,
    openPaths,
    activePath,
    active: file,
    hasDirty,
    open,
    update,
    save,
    close,
    closeMany,
    rename,
    setActivePath,
    saveUntitledAs,
  } = useEditorFiles(group, onError);
```



在 `EditorPaneProps` 加：

```tsx
  onFilePathChange?: (relPath: string) => void;
```

解构里加 `onFilePathChange`，并用 ref 存最新值：

```tsx
  const onFilePathChangeRef = useRef(onFilePathChange);
  onFilePathChangeRef.current = onFilePathChange;
```

把页签标题与顶部路径显示改成用 `displayNameFor`：

```tsx
  import { displayNameFor, isUntitledPath, nextUntitledIndex, untitledPathFor } from '../untitledPath';
```

页签栏里 `{relPath.split('/').pop()}` 改成 `{displayNameFor(relPath)}`。

顶部 `pane-path` 的 `{activePath || group.name}` 改成：

```tsx
          {activePath ? displayNameFor(activePath) : group.name}
```

标题回调里：

```tsx
    const base = activePath ? displayNameFor(activePath) : '编辑器';
```

- [ ] **Step 3: 保存分支与另存为**

加状态：

```tsx
  const [saveAsPath, setSaveAsPath] = useState<string | null>(null);
```

把 `handleSave` 改成：

```tsx
  const handleSave = useCallback(async () => {
    const current = fileRef.current;
    const target = activePathRef.current;
    if (!target) return;
    // 空白窗口没有磁盘路径，保存 = 另存为
    if (isUntitledPath(target)) {
      setSaveAsPath(target);
      return;
    }
    if (current.readOnly) {
      onToast('该文件为只读，无法保存', 'error');
      return;
    }
    const outcome = await save(target);
    if (outcome === 'saved') onToast('已保存', 'success');
    else if (outcome === 'unchanged') onToast('文件没有改动', 'info');
  }, [onToast, save]);
```

保存按钮的 `disabled` 去掉 `!file.dirty`（空白窗口即使没改动也要能另存）：

```tsx
          disabled={file.saving || file.readOnly}
```

在 return 末尾（`pendingDelete` 弹窗旁）加：

```tsx
      {saveAsPath ? (
        <SaveAsModal
          suggestedName="untitled.txt"
          onClose={() => setSaveAsPath(null)}
          onSubmit={async (relPath) => {
            const result = await saveUntitledAs(saveAsPath, relPath);
            if (!result.ok) return result.message || '保存失败';
            // 先更新 appliedPathRef，避免上层 filePath 变化触发重新 open、
            // 把刚保存的内容从磁盘读一遍并清掉撤销栈
            appliedPathRef.current = relPath;
            onFilePathChangeRef.current?.(relPath);
            onToast('已保存', 'success');
            return null;
          }}
        />
      ) : null}
```

- [ ] **Step 4: ＋按钮与右键菜单**

页签栏的 `</div>` 之后（`openPaths.map` 那个 div 内）追加新建按钮：

```tsx
          <button
            type="button"
            className="editor-tab-add"
            title="新建空白文件"
            onClick={() => {
              const relPath = untitledPathFor(nextUntitledIndex(openPaths));
              appliedPathRef.current = relPath;
              onFilePathChangeRef.current?.(relPath);
            }}
          >
            <Plus size={12} />
          </button>
```

页签右键菜单：给每个 `.editor-tab` 加 `onContextMenu`，弹出含一项的菜单：

```tsx
              onContextMenu={(event) => {
                event.preventDefault();
                setTabMenu({
                  x: event.clientX,
                  y: event.clientY,
                  items: [
                    {
                      type: 'item',
                      id: 'new-untitled',
                      label: '新建空白文件',
                      onSelect: () => {
                        const relPath = untitledPathFor(nextUntitledIndex(openPaths));
                        appliedPathRef.current = relPath;
                        onFilePathChangeRef.current?.(relPath);
                      },
                    },
                  ],
                });
              }}
```

加状态与渲染（照抄项目已有的 `PopupMenu` 用法）：

```tsx
  const [tabMenu, setTabMenu] = useState<MenuState | null>(null);
```

```tsx
      {tabMenu ? <PopupMenu state={tabMenu} onClose={() => setTabMenu(null)} /> : null}
```

导入补：`import { Plus } from 'lucide-react';`、`import { PopupMenu } from './PopupMenu';`、
`import { SaveAsModal } from './SaveAsModal';`、`import type { MenuState } from '../types';`

- [ ] **Step 5: OpenEditors 显示名**

`src/components/OpenEditors.tsx` 里：

```tsx
import { displayNameFor } from '../untitledPath';
```

```tsx
        const name = displayNameFor(relPath);
```

- [ ] **Step 6: 类型检查与构建**

Run: `npx tsc --noEmit && npx vite build`
Expected: 均通过

- [ ] **Step 7: 提交**

```bash
git add src/components/EditorPane.tsx src/components/OpenEditors.tsx src/App.tsx
git commit -m "$(cat <<'EOF'
feat(editor): 空白窗口接入页签栏与另存为

页签栏加 ＋ 按钮与右键菜单；标题显示 Untitled-N；Ctrl+S 转另存为。
保存后先改 appliedPathRef 再通知上层换路径，避免重新 open 丢掉撤销栈。
EOF
)"
```

---

## Task 6: 对比菜单按虚拟路径置灰

**Files:**
- Modify: `src/components/EditorPane.tsx`

**Interfaces:**
- Consumes: Task 1 的 `isUntitledPath`

- [ ] **Step 1: 置灰三个对比入口**

在 `menuReadOnly` 的定义旁（`src/components/EditorPane.tsx` 约 625 行）加：

```tsx
  const menuUntitled = editorMenu ? isUntitledPath(editorMenu.relPath) : false;
```

把三个菜单项的 `disabled` 分别改成（保留原有条件，只加 `menuUntitled`）：

```tsx
                disabled: menuReadOnly || menuUntitled || !menuFile?.dirty,
```

```tsx
                disabled: menuReadOnly || menuUntitled || menuUntracked,
```

「选择以进行比较」**不加** `menuUntitled`——两个空白窗口互比是允许的。

- [ ] **Step 2: 函数内兜底**

在 `compareWithDisk` 与 `compareWithHead` 的开头各插入：

```tsx
      if (isUntitledPath(relPath)) {
        onToast('空白窗口没有磁盘版本，无法比较', 'error');
        return;
      }
```

- [ ] **Step 3: 类型检查与构建**

Run: `npx tsc --noEmit && npx vite build`
Expected: 均通过

- [ ] **Step 4: 提交**

```bash
git add src/components/EditorPane.tsx
git commit -m "$(cat <<'EOF'
feat(editor): 空白窗口不能与磁盘或 HEAD 比较

菜单置灰之外再在函数内兜底一次：菜单不是唯一入口。
两个空白窗口互比仍然允许。
EOF
)"
```

---

## Task 7: 会话恢复空白窗口

**Files:**
- Modify: `desktop/session.js`
- Modify: `src/App.tsx`
- Modify: `src/components/EditorPane.tsx`

**Interfaces:**
- Produces: 会话快照新增 `untitledContents: Record<string, string>`
  （键是 `groupKey|untitled://N`，值是内容）

- [ ] **Step 1: session.js 允许虚拟路径并持久化内容**

在 `normalizeSession` 返回的对象里加：

```js
    untitledContents: normalizeUntitledContents(raw.untitledContents),
```

新增函数（放在 `normalizeTab` 之前）：

```js
// 空白窗口没有磁盘文件可读，内容只能跟着会话一起存。
// 单个窗口上限 256KB，总数上限 2MB：会话文件不是用来存大文件的地方。
const UNTITLED_MAX_CHARS = 256 * 1024;
const UNTITLED_TOTAL_MAX_CHARS = 2 * 1024 * 1024;

function normalizeUntitledContents(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  let total = 0;
  for (const [key, content] of Object.entries(value)) {
    if (typeof key !== 'string' || typeof content !== 'string') continue;
    if (content.length > UNTITLED_MAX_CHARS) continue;
    if (total + content.length > UNTITLED_TOTAL_MAX_CHARS) break;
    out[key] = content;
    total += content.length;
  }
  return out;
}
```

`normalizeTab` 里 `filePath` 那行保持不变（`untitled://N` 会被当普通字符串保留，长度远小于 500）。

- [ ] **Step 2: App 收集空白窗口内容进快照**

在 `buildSessionSnapshot` 里加：

```tsx
      untitledContents: untitledContentsRef.current,
```

在 App 里加：

```tsx
  const untitledContentsRef = useRef<Record<string, string>>({});

  const setGroupUntitledContents = useCallback(
    (groupKey: string, contents: Record<string, string>) => {
      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(untitledContentsRef.current)) {
        if (!key.startsWith(`${groupKey}|`)) next[key] = value;
      }
      for (const [relPath, content] of Object.entries(contents)) {
        next[`${groupKey}|${relPath}`] = content;
      }
      untitledContentsRef.current = next;
    },
    [],
  );
```

`<EditorPane ...>` 上补：

```tsx
          onUntitledContentsChange={(contents) =>
            setGroupUntitledContents(group.groupKey, contents)
          }
```

`EditorPane` 的 props 加：

```tsx
  onUntitledContentsChange?: (contents: Record<string, string>) => void;
```

在 `EditorPane` 里加一个 effect（依赖原始值，避免每次按键都触发父组件）：

```tsx
  const untitledSnapshot = openPaths
    .filter((relPath) => isUntitledPath(relPath))
    .map((relPath) => `${relPath}\u0000${files[relPath]?.content ?? ''}`)
    .join('\u0001');

  useEffect(() => {
    const contents: Record<string, string> = {};
    for (const relPath of Object.keys(files)) {
      if (!isUntitledPath(relPath)) continue;
      contents[relPath] = files[relPath].content;
    }
    onUntitledContentsChangeRef.current?.(contents);
  }, [untitledSnapshot, files]);
```

- [ ] **Step 3: 恢复时把内容灌回去**

用 `useEditorFiles` 暴露的 `open` 只能建空条目。恢复内容需要一个新的入口，在 `useEditorFiles` 加：

```ts
  // 会话恢复用：把存下来的空白窗口内容灌回内存，不读盘
  const restoreUntitled = useCallback(
    (entries: Array<{ relPath: string; content: string }>) => {
      if (!entries.length) return;
      setFiles((previous) => {
        const next = { ...previous };
        for (const entry of entries) {
          if (!isUntitledPath(entry.relPath)) continue;
          next[entry.relPath] = {
            ...EMPTY,
            relPath: entry.relPath,
            content: entry.content,
            savedContent: entry.content,
          };
          touchedRef.current.add(entry.relPath);
        }
        return next;
      });
    },
    [],
  );
```

在返回对象里加上 `restoreUntitled`。

`EditorPane` 里加一个只跑一次的 effect，在 `appliedPathRef` 首次应用 `tab.filePath` 之前先灌内容：

```tsx
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const saved = untitledRestoreRef.current;
    if (saved && Object.keys(saved).length) {
      restoreUntitled(
        Object.entries(saved)
          .filter(([relPath]) => isUntitledPath(relPath))
          .map(([relPath, content]) => ({ relPath, content })),
      );
    }
  }, [restoreUntitled]);
```

`EditorPane` 新增 prop `untitledRestore?: Record<string, string>`，并用 ref 保存首值。

`App` 传参：从 `session.untitledContents` 里筛出本项目的键：

```tsx
          untitledRestore={pickGroupUntitled(session.untitledContents, group.groupKey)}
```

新增辅助：

```tsx
function pickGroupUntitled(
  all: Record<string, string> | undefined,
  groupKey: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!all) return out;
  for (const [key, value] of Object.entries(all)) {
    const prefix = `${groupKey}|`;
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value;
  }
  return out;
}
```

- [ ] **Step 4: 类型检查与构建**

Run: `npx tsc --noEmit && npx vite build`
Expected: 均通过

- [ ] **Step 5: 提交**

```bash
git add desktop/session.js src/App.tsx src/components/EditorPane.tsx src/useEditorFiles.ts
git commit -m "$(cat <<'EOF'
feat(editor): 会话恢复空白窗口内容

空白窗口没有磁盘文件可读，内容跟会话一起存（单窗口 256KB、总计 2MB 上限）。
恢复时先灌内容再应用路径，编号按最小可用值重新分配。
EOF
)"
```

---

## Task 8: UI 测试

**Files:**
- Create: `tests/editor-untitled.mjs`

**Interfaces:**
- Consumes: 全部实现

- [ ] **Step 1: 写测试**

创建 `tests/editor-untitled.mjs`：

```js
// 空白窗口：新建、另存为、关闭确认、对比置灰、编号复用。
// 需要独占 17382 端口，跑之前先关掉正在运行的 Cmd Toolbox。
import { _electron as electron } from 'playwright-core';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-untitled-'));
const projectDir = mkdtempSync(join(tmpdir(), 'cmdtb-untitled-proj-'));
mkdirSync(join(projectDir, 'app'), { recursive: true });

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error('断言失败：' + message);
  passed += 1;
  console.log('  ok  ' + message);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.CMDTOOLBOX_NO_UPDATE = '1';

let app;
try {
  app = await electron.launch({
    executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
    cwd: root,
    args: ['.', `--data-dir=${dataDir}`],
    env,
  });

  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.app').waitFor();
  await page.waitForTimeout(1000);
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.show();
    win?.focus();
    win?.moveTop();
  });

  await page.locator('.add-project-btn').click();
  await page.locator('.modal-card').waitFor();
  await page.locator('#project-path').fill(projectDir);
  await page.locator('#project-name').fill('untitled');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await page.waitForTimeout(400);
  await page.locator('.group-item').filter({ hasText: 'untitled' }).locator('.group-main').click();
  await page.waitForTimeout(600);
  await page.locator('.group-item').filter({ hasText: 'untitled' }).click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  await page.getByRole('menuitem', { name: '打开编辑器', exact: true }).click();
  await page.locator('.editor-pane').waitFor();

  console.log('1. 新建空白窗口');
  await page.locator('.editor-tab-add').click();
  await page.waitForTimeout(600);
  const tabs = page.locator('.editor-tab-name');
  assert((await tabs.count()) === 1, `出现一个页签，实际 ${await tabs.count()}`);
  assert((await tabs.first().innerText()).includes('Untitled-1'), '标题是 Untitled-1');

  console.log('2. 再建一个是 Untitled-2');
  await page.locator('.editor-tab-add').click();
  await page.waitForTimeout(600);
  assert(
    (await page.locator('.editor-tab-name').allInnerTexts()).some((t) => t.includes('Untitled-2')),
    '出现 Untitled-2',
  );

  console.log('3. 关掉 Untitled-1 后再新建仍是 Untitled-1');
  await page.locator('.editor-tab').first().locator('.editor-tab-close').click();
  await page.waitForTimeout(500);
  await page.locator('.editor-tab-add').click();
  await page.waitForTimeout(600);
  const names = await page.locator('.editor-tab-name').allInnerTexts();
  assert(names.filter((n) => n.includes('Untitled-1')).length === 1, '编号复用最小可用值');

  console.log('4. 输入内容后 Ctrl+S 弹另存为');
  await page.locator('.cm-content').first().click();
  await page.keyboard.type('<?php echo 1;');
  await page.keyboard.press('Control+s');
  await page.locator('.modal-card').filter({ hasText: '另存为' }).waitFor({ timeout: 8000 });
  assert(true, '弹出另存为弹窗');

  console.log('5. 保存到 app/saved.php');
  const input = page.locator('.modal-card input[type="text"]').first();
  await input.fill('app/saved.php');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForTimeout(1500);
  assert(existsSync(join(projectDir, 'app', 'saved.php')), '文件落在磁盘上');
  assert(readFileSync(join(projectDir, 'app', 'saved.php'), 'utf8').includes('<?php echo 1;'), '内容写对了');
  const afterSave = await page.locator('.editor-tab-name').allInnerTexts();
  assert(afterSave.some((n) => n.includes('saved.php')), `页签标题变成文件名，实际 ${afterSave.join(',')}`);
  assert(!afterSave.some((n) => n.includes('Untitled')), '虚拟页签已消失');

  console.log('6. 保存后 Ctrl+Z 能撤销');
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  const text = await page.locator('.cm-content').first().innerText();
  assert(!text.includes('echo 1'), '撤销掉了保存前的输入');

  console.log('7. 另存为到已存在的路径会报错且不覆盖');
  await page.locator('.editor-tab-add').click();
  await page.waitForTimeout(500);
  await page.locator('.cm-content').first().click();
  await page.keyboard.type('OVERWRITE');
  await page.keyboard.press('Control+s');
  await page.locator('.modal-card').filter({ hasText: '另存为' }).waitFor({ timeout: 8000 });
  await page.locator('.modal-card input[type="text"]').first().fill('app/saved.php');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForTimeout(1200);
  assert(
    (await page.locator('.modal-card').filter({ hasText: '另存为' }).count()) === 1,
    '弹窗保持打开',
  );
  assert(readFileSync(join(projectDir, 'app', 'saved.php'), 'utf8').includes('<?php echo 1;'), '原文件未被覆盖');

  console.log('8. 空白窗口的对比入口置灰');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.waitForTimeout(400);
  const openRow = page
    .locator('.editor-sidebar-section')
    .first()
    .locator('.file-row')
    .filter({ hasText: /^Untitled-/ })
    .first();
  await openRow.click({ button: 'right' });
  await page.locator('.popup-menu').waitFor();
  const diskItem = page.getByRole('menuitem', { name: '与已保存文件比较', exact: true });
  assert((await diskItem.getAttribute('aria-disabled')) === 'true', '与磁盘比较置灰');
  const headItem = page.getByRole('menuitem', { name: '与 Git HEAD 比较', exact: true });
  assert((await headItem.getAttribute('aria-disabled')) === 'true', '与 HEAD 比较置灰');
  await page.keyboard.press('Escape');
} finally {
  await app?.close().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}

console.log(`\n全部通过：${passed} 项`);
```

- [ ] **Step 2: 运行**

Run:
```bash
npx tsc --noEmit && npx vite build
powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force"
node tests/editor-untitled.mjs
```
Expected: PASS

- [ ] **Step 3: 回归**

Run:
```bash
node tests/untitled-path.mjs
node tests/editor-file-tree.mjs
node tests/editor-goto-def.mjs
node tests/editor-modules.mjs
```
Expected: 全部 PASS

- [ ] **Step 4: 提交**

```bash
git add tests/editor-untitled.mjs
git commit -m "$(cat <<'EOF'
test(editor): 空白窗口新建、另存为、编号复用与对比置灰的端到端用例
EOF
)"
```

---

## Task 9: 文档

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 记录约定**

在 `CLAUDE.md` 的「编辑器模块」小节下、「文件树与对比」之前插入：

```markdown
### 空白窗口（Untitled）

- **空白窗口用虚拟路径 `untitled://N` 当 `files` 的键**，对上层完全透明：
  `activePath`、对比、打开的编辑器列表都当普通 `relPath` 用。判断只有一处
  `src/untitledPath.ts` 的 `isUntitledPath()`，**所有碰磁盘或 mtime 的地方必须先过它**
  （`open` / `save` / `reloadFromDisk` / 2 秒轮询 / 自动压缩）。不要在调用方各自
  `startsWith`——漏一处就会拿伪路径去读磁盘，表现是每 2 秒报一次错。
- **保存 = 另存为**：`save()` 对虚拟路径直接返回 `'unchanged'`，拦截在 `handleSave` 里。
  `saveUntitledAs` 必须**先 `createFile` 写盘成功、再原子换键**；反过来一旦写盘失败
  会留下指向不存在文件的页签。
- **换路径后不能重新 `open()`**：`EditorPane` 要先改 `appliedPathRef.current` 再调
  `onFilePathChange`，否则上层 `tab.filePath` 变化会触发重新读盘，撤销栈全丢。
- **编号复用最小可用值**：关掉 `Untitled-1` 再新建拿到的还是 `Untitled-1`。
- **空白窗口不能与磁盘版本或 Git HEAD 比较**（没有对应版本），菜单置灰 + 函数内兜底。
  两个空白窗口互比允许。
- **内容要进会话**：空白窗口没有磁盘文件可读，`session.json` 的 `untitledContents`
  按 `groupKey|untitled://N` 存内容，单窗口 256KB、总计 2MB 上限。会话文件不是存大文件的地方。
- **另存为用 `SaveAsModal`，不要用 `window.prompt`**——Electron 渲染进程里它直接抛错。
```

在测试清单里补两行：

```bash
node tests/untitled-path.mjs     # 虚拟路径判断与编号分配（离线）
node tests/editor-untitled.mjs   # 空白窗口新建、另存为与对比置灰
```

- [ ] **Step 2: 提交**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: 记录空白窗口的虚拟路径约定
EOF
)"
```

---

## Self-Review

**Spec coverage**

| Spec 条目 | 对应任务 |
|---|---|
| 虚拟路径与统一判断 | Task 1、2 |
| 新建入口（＋按钮、右键菜单） | Task 5 |
| 编号复用最小可用值 | Task 1、5 |
| Ctrl+S 另存为（输入框、支持目录） | Task 3、4、5 |
| 保存后转普通页签、撤销栈保留 | Task 3、5 |
| 关闭确认 | 复用现有 `requestCloseTab` 的 dirty 逻辑（虚拟路径同样有 `dirty`） |
| 会话恢复内容 | Task 7 |
| 参与对比 / 置灰 | Task 6 |
| 离线与 UI 测试 | Task 1、8 |
| 文档 | Task 9 |

**类型一致性**：`isUntitledPath` / `displayNameFor` / `nextUntitledIndex` / `untitledPathFor`
在 Task 1 定义，Task 2/5/6/7 消费，签名一致。`saveUntitledAs` 返回
`{ ok: boolean; message?: string }`，Task 5 的调用处按此处理。

**已知风险**

- Task 5 Step 4 的页签右键菜单需要 `MenuState` 类型，若 `src/types.ts` 里的名字不同，
  去 `PopupMenu.tsx` 确认后照抄。
- Task 7 的 `untitledRestore` prop 传递链路较长（App → EditorPane），实现时先确认
  session 加载完成的时机在 `EditorPane` 挂载之前，否则要改成 effect 里读。
- 空内容的空白窗口仍会被写入会话（内容为空串）。这是有意的：重启后编号与页签还在。

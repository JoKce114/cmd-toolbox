# 源代码管理点开文件的页签复用与未保存保护 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点击源代码管理里的文件时，有未保存修改就切到编辑器页签；连续点多个文件只复用一个未被交互过的差异页签。

**Architecture:** 全部改动集中在渲染进程。`App.tsx` 里抽出 `activateTab` 统一「激活项目 + 页签 + 右栏焦点」，`openDiffTab` 增加两道判断；`DiffPane` 加一个一次性 `onInteract` 回调，作为「这个差异页签被用户碰过」的信号。

**Tech Stack:** Electron / React 19 / TypeScript / Playwright GUI 测试

## Global Constraints

- 改了 `src/` 之后重建用 `npx tsc --noEmit && npx vite build`，**不要用 `npm run build`**。
- 提交信息不能加任何 AI 署名。
- UI 测试必须独占 17382 端口，跑之前先关掉正在运行的 Cmd Toolbox。
- 不新增依赖。

---

### Task 1: 抽取 `activateTab` 与未保存拦截

**Files:**
- Modify: `src/App.tsx:1862-1968`（`openDiffTab`、`openCommitDiffTab`、`openEditorFile`）

**Interfaces:**
- Consumes: 现有 `tabsRef`、`dirtyTabsRef`、`activeTabByGroupRef`、`rightIdsByGroupRef`、`setActiveGroupKey`、`setActiveTabByGroup`、`setRightActiveByGroup`、`setFocusSideByGroup`、`pushToast`
- Produces:
  - `activateTab(groupKey: string, tab: Tab): void`（组件内 `useCallback`）
  - `openDiffTab(group: Group, change: GitChange): void` 行为变化，签名不变

- [ ] **Step 1: 加 `activateTab`**

在 `openDiffTab` 定义之前插入：

```ts
  // 统一「激活项目 + 页签 + 右栏焦点」。三处入口原本各写了一遍，
  // 漏掉右栏分支会让分屏时点了没反应。
  const activateTab = useCallback((groupKey: string, tab: Tab) => {
    setActiveGroupKey(groupKey);
    setActiveTabByGroup((previous) => ({ ...previous, [groupKey]: tab.id }));
    if ((rightIdsByGroupRef.current[groupKey] || []).includes(tab.id)) {
      setRightActiveByGroup((previous) => ({ ...previous, [groupKey]: tab.id }));
      setFocusSideByGroup((previous) => ({ ...previous, [groupKey]: 'right' }));
    }
  }, []);
```

- [ ] **Step 2: 在 `openDiffTab` 里加未保存拦截**

把 `openDiffTab` 开头的：

```ts
      if (!group.exists) {
        pushToast('项目目录不存在，请先编辑项目路径', 'error');
        return;
      }
      const groupTabs = tabsRef.current[group.key] || [];
```

改成：

```ts
      if (!group.exists) {
        pushToast('项目目录不存在，请先编辑项目路径', 'error');
        return;
      }
      const groupTabs = tabsRef.current[group.key] || [];

      // 差异页签读的是磁盘，文件有未保存修改时看到的是旧内容。
      // 这条必须排在「已有同路径差异页签」之前，否则会切到一个过期视图。
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

- [ ] **Step 3: 把两处已有的激活写法换成 `activateTab`**

`openDiffTab` 里的：

```ts
      if (existing) {
        setActiveGroupKey(group.key);
        setActiveTabByGroup((previous) => ({ ...previous, [group.key]: existing.id }));
        return;
      }
```

改为：

```ts
      if (existing) {
        activateTab(group.key, existing);
        return;
      }
```

`openCommitDiffTab` 里同样的三行改为：

```ts
      if (existing) {
        activateTab(group.key, existing);
        return;
      }
```

`openEditorFile` 里的：

```ts
      if (existing) {
        setActiveTabByGroup((previous) => ({ ...previous, [group.key]: existing.id }));
        setActiveGroupKey(group.key);
        return;
      }
```

改为：

```ts
      if (existing) {
        activateTab(group.key, existing);
        return;
      }
```

- [ ] **Step 4: 修正依赖数组**

`openDiffTab` 的依赖数组加上 `activateTab`：

```ts
    [activateTab, applyTabs, pushToast],
```

`openCommitDiffTab` 的依赖数组加上 `activateTab`：

```ts
    [activateTab, applyTabs, pushToast],
```

`openEditorFile` 原本的依赖数组保持不变（它仍然用到 `applyTabs` / `createEditor` / `pushToast`），
但里面的 `activateTab` 需要在依赖里体现——若该函数在 Step 6 之前就用到 `activateTab`，
把它加进依赖：

```ts
    [activateTab, applyTabs, createEditor, pushToast],
```

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 6: 提交**

```bash
git add src/App.tsx
git commit -m "refactor(tabs): 统一页签激活逻辑，未保存文件不再打开差异页签"
```

---

### Task 2: 差异页签复用

**Files:**
- Modify: `src/components/DiffPane.tsx`
- Modify: `src/App.tsx`（`openDiffTab` 加复用分支、渲染处传 `onInteract`）

**Interfaces:**
- Consumes: `activateTab`（Task 1）、`touchedTabsRef`
- Produces: `DiffPaneProps` 新增 `onInteract?: () => void`

- [ ] **Step 1: 给 `DiffPane` 加一次性交互回调**

`src/components/DiffPane.tsx`：

1. import 改为：

```ts
import { useEffect, useMemo, useRef, useState } from 'react';
```

2. `DiffPaneProps` 里加（放在 `onToast` 之后）：

```ts
  // 用户第一次在这个页签里按下鼠标或滚动时回调一次；上层据此不再复用它
  onInteract?: () => void;
```

3. 解构里加 `onInteract`。

4. 在 `const [selectedPath, setSelectedPath] = useState('');` 之后加：

```ts
  // 只上报第一次交互：页签被复用时不重建组件，标记随之保留
  const interactedRef = useRef(false);
  const markInteracted = () => {
    if (interactedRef.current) return;
    interactedRef.current = true;
    onInteract?.();
  };
```

5. 根元素加上两个监听：

```tsx
    <section
      className={`terminal-pane diff-pane${active ? '' : ' is-hidden'}`}
      onPointerDown={markInteracted}
      onWheel={markInteracted}
    >
```

- [ ] **Step 2: `openDiffTab` 加复用分支**

在 Task 1 加的 `dirtyEditor` 判断之后、`const existing = groupTabs.find(...)` 之前，
先执行按路径去重（保持现状）：

```ts
      const existing = groupTabs.find(
        (item) => item.shellId === 'diff' && item.diffChange?.path === change.path,
      );
      if (existing) {
        activateTab(group.key, existing);
        return;
      }
```

紧接着加复用分支：

```ts
      // 只复用「变更类」差异页签：提交类页签有自己的去重口径，被顶掉会让历史页签莫名换内容
      const reusable = groupTabs.filter(
        (item) =>
          item.shellId === 'diff' &&
          Boolean(item.diffChange) &&
          !touchedTabsRef.current.has(item.id),
      );
      const activeId = activeTabByGroupRef.current[group.key];
      const target =
        reusable.find((item) => item.id === activeId) ?? reusable[reusable.length - 1];
      if (target) {
        applyTabs({
          ...tabsRef.current,
          [group.key]: groupTabs.map((item) =>
            item.id === target.id
              ? {
                  ...item,
                  diffChange: change,
                  descriptor: change.path.split('/').pop() || '差异',
                }
              : item,
          ),
        });
        activateTab(group.key, target);
        return;
      }
```

- [ ] **Step 3: 渲染处传 `onInteract`**

`App.tsx` 里渲染 `DiffPane` 的地方（`isDiffTab` 分支）：

```tsx
        <DiffPane
          key={tab.id}
          projectPath={group.path}
          wordWrap={prefs.editorWordWrap}
          target={
            tab.diffCommit
              ? { kind: 'commit', commit: tab.diffCommit }
              : { kind: 'change', change: tab.diffChange! }
          }
          active={active}
          onClose={() => closeTabs(tab.groupKey, [tab.id])}
          onOpenFile={(relPath) => openEditorFile(group, relPath)}
          onToast={pushToast}
          onInteract={() => touchedTabsRef.current.add(tab.id)}
        />
```

- [ ] **Step 4: 类型检查与构建**

Run: `npx tsc --noEmit && npx vite build`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add src/components/DiffPane.tsx src/App.tsx
git commit -m "feat(scm): 复用未交互过的差异页签"
```

---

### Task 3: GUI 测试

**Files:**
- Create: `tests/scm-open-behavior.mjs`

**Interfaces:**
- Consumes: Task 1、Task 2 的行为
- Produces: 无

- [ ] **Step 1: 写测试**

```js
// 源代码管理点开文件：未保存拦截、差异页签复用。需要独占 17382 端口。
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-scm-data-'));
const repo = mkdtempSync(join(tmpdir(), 'cmdtb-scm-repo-'));

execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });

for (const name of ['a.txt', 'b.txt', 'c.txt']) {
  writeFileSync(join(repo, name), 'one\ntwo\n');
}
execFileSync('git', ['add', '.'], { cwd: repo });
execFileSync('git', ['commit', '-m', '初始提交'], { cwd: repo });

// 三个文件都产生工作区改动，才会出现在源代码管理列表里
for (const name of ['a.txt', 'b.txt', 'c.txt']) {
  writeFileSync(join(repo, name), 'one\nTWO\n');
}

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log('  ok  ' + message);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.CMDTOOLBOX_NO_UPDATE = '1';

const app = await electron.launch({
  executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
  cwd: root,
  args: ['.', `--data-dir=${dataDir}`],
  env,
});
const page = await app.firstWindow();
page.on('pageerror', (error) => console.log('  [pageerror]', error.message));
await page.waitForLoadState('domcontentloaded');
await page.locator('.app').waitFor();
await page.waitForFunction(() => !document.querySelector('.boot-screen'));

// 主进程不认 --project 参数，项目必须走界面添加
async function addProject(path, name) {
  const modal = page.locator('.modal-card');
  const deadline = Date.now() + 20000;
  while ((await modal.count()) === 0) {
    if (Date.now() > deadline) throw new Error('等待超时：添加项目弹窗未出现');
    await page.locator('.add-project-btn').click({ force: true });
    await page.waitForTimeout(600);
  }
  await page.locator('#project-path').fill(path);
  await page.locator('#project-name').fill(name);
  await page.getByRole('button', { name: '保存项目', exact: true }).click({ force: true });
  await modal.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(800);
}

await addProject(repo, 'scm-proj');
await page.locator('.git-change-row').first().waitFor({ timeout: 15000 });

// 每个差异页签渲染一个 .diff-pane；页签被复用时数量不变
async function countDiffPanes() {
  return page.locator('.diff-pane').count();
}

async function openInTree(name) {
  await page.locator(`.file-tree .file-row[title="${name}"]`).click();
  await page.locator('.cm-editor').first().waitFor();
  await page.waitForTimeout(500);
}

async function clickChange(name) {
  await page.locator('.git-change-row', { hasText: name }).first().click({ force: true });
  await page.waitForTimeout(600);
}

console.log('1. 未保存文件点击改为切到编辑器');
{
  await openInTree('a.txt');
  await page.locator('.cm-content').click();
  await page.keyboard.type('X');
  await page.waitForTimeout(400);
  assert((await page.locator('.editor-pane:not(.is-hidden)').count()) === 1, '编辑器页签处于激活');

  await clickChange('a.txt');
  assert((await countDiffPanes()) === 0, '没有新开差异页签');
  assert(
    (await page.locator('.editor-pane:not(.is-hidden)').count()) === 1,
    '激活的仍是编辑器页签',
  );
  assert(
    (await page.locator('.toast', { hasText: '未保存修改' }).count()) >= 1,
    '出现未保存提示',
  );
}

console.log('2. 保存后点击开差异页签');
{
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(1000);
  await clickChange('a.txt');
  assert((await countDiffPanes()) === 1, '开出一个差异页签');
}

console.log('3. 连续点不同文件只复用一个差异页签');
{
  await clickChange('b.txt');
  await clickChange('c.txt');
  assert((await countDiffPanes()) === 1, '仍然只有一个差异页签');
  assert(
    (await page.locator('.diff-pane .pane-path', { hasText: 'c.txt' }).count()) >= 1,
    '内容是最后点击的 c.txt',
  );
}

console.log('4. 交互过的差异页签不再被复用');
{
  await page.locator('.diff-pane .diff-body').hover();
  await page.mouse.wheel(0, 40);
  await page.waitForTimeout(400);
  await clickChange('a.txt');
  assert((await countDiffPanes()) === 2, '新开了一个差异页签');
}

console.log('5. 关闭后恢复复用');
{
  while ((await countDiffPanes()) > 0) {
    await page
      .locator('.diff-pane .icon-btn[title="关闭"]')
      .first()
      .click({ force: true });
    await page.waitForTimeout(500);
  }
  await clickChange('b.txt');
  await clickChange('c.txt');
  assert((await countDiffPanes()) === 1, '关闭后重新恢复到单页签复用');
}

await app.close();
console.log(`\n全部通过：${passed} 项`);
```

- [ ] **Step 2: 清理残留进程并运行**

```bash
powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force"
```

Run: `node tests/scm-open-behavior.mjs`
Expected: 全部通过。

- [ ] **Step 3: 再跑一次既有 Git 面板测试确认没回归**

Run: `node tests/git-panel.mjs`
Expected: 全部通过。

- [ ] **Step 4: 提交**

```bash
git add tests/scm-open-behavior.mjs
git commit -m "test(scm): 未保存拦截与差异页签复用"
```

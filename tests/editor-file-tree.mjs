// 编辑器文件树：折叠区、工具栏新建、刷新、右键复制/剪切/粘贴/删除、打开的编辑器、对比。
// 需要独占 17382 端口，跑之前先关掉正在运行的 Cmd Toolbox。
import { _electron as electron } from 'playwright-core';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

// 端口被占时主进程会直接退出、窗口永远不出现，表现为 firstWindow 超时。
// 与其让人对着超时堆栈猜，不如在启动前直接报错。
if (await isPortInUse(17382)) {
  console.error(
    '错误：端口 17382 已被占用，请先关闭正在运行的 Cmd Toolbox（或残留 electron 进程）再跑测试。',
  );
  process.exit(1);
}

const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-ftree-'));
const projectDir = mkdtempSync(join(tmpdir(), 'cmdtb-ftree-proj-'));
console.log(`临时数据目录：${dataDir}`);
console.log(`临时项目目录：${projectDir}`);

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error('断言失败：' + message);
  passed += 1;
  console.log('  ok  ' + message);
}

mkdirSync(join(projectDir, 'sub'), { recursive: true });
writeFileSync(join(projectDir, 'alpha.php'), '<?php\necho 1;\n', 'utf8');
writeFileSync(join(projectDir, 'beta.php'), '<?php\necho 2;\n', 'utf8');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.CMDTOOLBOX_NO_UPDATE = '1';

let app;
// 记录被移入回收站的文件，finally 里提示用户自行清理（测试不会清空真实回收站）
const trashedFiles = [];
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
  // 窗口被遮挡时 Chromium 不投递合成的鼠标事件，确保置前
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.show();
    win?.focus();
    win?.moveTop();
  });

  // 加项目并打开编辑器
  await page.locator('.add-project-btn').click();
  await page.locator('.modal-card').waitFor();
  await page.locator('#project-path').fill(projectDir);
  await page.locator('#project-name').fill('ftree');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await page.waitForTimeout(400);
  await page.locator('.group-item').filter({ hasText: 'ftree' }).locator('.group-main').click();
  await page.waitForTimeout(600);
  await page.locator('.group-item').filter({ hasText: 'ftree' }).click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  await page.getByRole('menuitem', { name: '打开编辑器', exact: true }).click();
  await page.locator('.editor-pane').waitFor();

  console.log('1. 两个可折叠区存在、能折叠展开，侧栏可以拖拽改宽');
  const sections = page.locator('.editor-sidebar-section');
  assert((await sections.count()) === 2, '左栏有两个可折叠区');
  assert(
    (await sections.first().locator('.section-title').innerText()) === '打开的编辑器',
    '第一个区是「打开的编辑器」',
  );
  assert(
    (await sections.last().locator('.section-title').innerText()) === '文件',
    '第二个区是「文件」',
  );

  const openEditorsHeader = sections.first().locator('.section-header');
  const fileTreeHeader = sections.last().locator('.section-header');
  await openEditorsHeader.click();
  assert(
    (await openEditorsHeader.getAttribute('aria-expanded')) === 'false',
    '「打开的编辑器」可折叠（aria-expanded=false）',
  );
  assert(
    (await page.locator('.open-editors-list').count()) === 0 &&
      (await page.locator('.file-tree-empty').count()) === 0,
    '折叠后「打开的编辑器」内容不再渲染',
  );
  await openEditorsHeader.click();
  assert(
    (await openEditorsHeader.getAttribute('aria-expanded')) === 'true',
    '「打开的编辑器」可再次展开',
  );

  await fileTreeHeader.click();
  assert(
    (await fileTreeHeader.getAttribute('aria-expanded')) === 'false',
    '「文件」区可折叠',
  );
  assert((await page.locator('.file-tree').count()) === 0, '折叠后文件树不再渲染');
  await fileTreeHeader.click();
  await page.locator('.file-tree').waitFor({ timeout: 5000 });
  assert((await fileTreeHeader.getAttribute('aria-expanded')) === 'true', '「文件」区可再次展开');

  const sidebar = page.locator('.editor-sidebar');
  const widthBefore = (await sidebar.boundingBox()).width;
  const resizer = page.locator('.split-resizer[aria-label="调整侧栏宽度"]');
  const grip = await resizer.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 60, grip.y + grip.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const widthAfter = (await sidebar.boundingBox()).width;
  assert(
    widthAfter >= widthBefore + 40,
    `拖拽分界线后侧栏变宽（${Math.round(widthBefore)} → ${Math.round(widthAfter)}）`,
  );

  console.log('2. 打开的编辑器随打开文件而变化');
  assert(
    (await page.locator('.open-editors-list .file-row').count()) === 0,
    '还没打开文件时列表为空',
  );
  await page.locator('.file-tree .file-row[title="alpha.php"]').click();
  await waitFor(
    async () => (await page.locator('.editor-pane .pane-path').first().innerText()).endsWith('alpha.php'),
    10000,
    '编辑器切到 alpha.php',
  );
  assert(
    (await page.locator('.open-editors-list .file-row[title="alpha.php"]').count()) === 1,
    '打开的文件出现在「打开的编辑器」里',
  );
  assert(
    (await sections.first().locator('.open-editors-list .file-row').first().getAttribute('title')) ===
      'alpha.php',
    '第一个区里的条目是 alpha.php',
  );

  console.log('3. 工具栏新建文件（Modal 输入名字）');
  await page.locator('.file-tree-toolbar button[title="新建文件"]').click();
  const createFileModal = page.locator('.modal-card').filter({ hasText: '新建文件' });
  await createFileModal.waitFor({ timeout: 5000 });
  await createFileModal.locator('input.text-input').fill('created.php');
  await createFileModal.getByRole('button', { name: '创建', exact: true }).click();
  await createFileModal.waitFor({ state: 'detached', timeout: 10000 });
  await waitFor(() => existsSync(join(projectDir, 'created.php')), 8000, 'created.php 落盘');
  assert(existsSync(join(projectDir, 'created.php')), '新建文件落在磁盘上');
  assert(
    (await page.locator('.file-tree .file-row[title="created.php"]').count()) === 1,
    '新建的文件立即出现在树里',
  );

  console.log('4. 工具栏新建文件夹（Modal 输入名字）');
  await page.locator('.file-tree-toolbar button[title="新建文件夹"]').click();
  const createDirModal = page.locator('.modal-card').filter({ hasText: '新建文件夹' });
  await createDirModal.waitFor({ timeout: 5000 });
  await createDirModal.locator('input.text-input').fill('newdir');
  await createDirModal.getByRole('button', { name: '创建', exact: true }).click();
  await createDirModal.waitFor({ state: 'detached', timeout: 10000 });
  await waitFor(() => existsSync(join(projectDir, 'newdir')), 8000, 'newdir 落盘');
  assert(existsSync(join(projectDir, 'newdir')), '新建文件夹落在磁盘上');

  console.log('5. 刷新能看见外部新建的文件');
  writeFileSync(join(projectDir, 'external.php'), '<?php\n', 'utf8');
  await page.locator('.file-tree-toolbar button[title="刷新"]').click();
  await page
    .locator('.file-tree .file-row[title="external.php"]')
    .waitFor({ timeout: 10000 });
  assert(
    (await page.locator('.file-tree .file-row[title="external.php"]').count()) === 1,
    '外部新建的文件出现在树里',
  );

  console.log('6. 右键复制 → 粘贴到 sub（源文件仍在）');
  await openTreeMenu(page, 'beta.php');
  const fileTreeMenuText = await page.locator('.popup-menu').innerText();
  assert(
    !fileTreeMenuText.includes('与已保存文件比较'),
    '文件树的右键菜单里没有对比项（对比只在「打开的编辑器」里）',
  );
  await page.getByRole('menuitem', { name: '复制', exact: true }).click();
  await page.locator('.popup-menu').waitFor({ state: 'detached', timeout: 5000 });
  await openTreeMenu(page, 'sub');
  await page.getByRole('menuitem', { name: '粘贴', exact: true }).click();
  await page.locator('.popup-menu').waitFor({ state: 'detached', timeout: 5000 });
  await waitFor(() => existsSync(join(projectDir, 'sub', 'beta.php')), 10000, 'sub/beta.php 出现');
  assert(existsSync(join(projectDir, 'sub', 'beta.php')), '粘贴后文件出现在 sub 下');
  assert(existsSync(join(projectDir, 'beta.php')), '复制粘贴后原文件仍在');

  console.log('7. 右键剪切 → 粘贴（原位置消失）');
  await openTreeMenu(page, 'created.php');
  await page.getByRole('menuitem', { name: '剪切', exact: true }).click();
  await page.locator('.popup-menu').waitFor({ state: 'detached', timeout: 5000 });
  await openTreeMenu(page, 'sub');
  await page.getByRole('menuitem', { name: '粘贴', exact: true }).click();
  await page.locator('.popup-menu').waitFor({ state: 'detached', timeout: 5000 });
  await waitFor(
    () => !existsSync(join(projectDir, 'created.php')) && existsSync(join(projectDir, 'sub', 'created.php')),
    10000,
    'created.php 移动到 sub',
  );
  assert(!existsSync(join(projectDir, 'created.php')), '剪切后原位置消失');
  assert(existsSync(join(projectDir, 'sub', 'created.php')), '剪切后新位置出现');

  console.log('8. 删除弹确认，确认后文件消失');
  await openTreeMenu(page, 'external.php');
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  const deleteModal = page.locator('.modal-card').filter({ hasText: '删除到回收站' });
  await deleteModal.waitFor({ timeout: 8000 });
  assert(
    (await deleteModal.locator('.modal-title').innerText()) === '删除到回收站',
    '删除确认标题是「删除到回收站」',
  );
  assert(
    (await deleteModal.locator('.confirm-message').innerText()) ===
      '确定把「external.php」删除到回收站吗？',
    '删除确认点名了要删除的文件',
  );
  await deleteModal.locator('.btn-danger').click();
  await deleteModal.waitFor({ state: 'detached', timeout: 10000 });
  await waitFor(() => !existsSync(join(projectDir, 'external.php')), 10000, 'external.php 被移走');
  assert(!existsSync(join(projectDir, 'external.php')), '文件已被移走');
  trashedFiles.push(join(projectDir, 'external.php'));

  console.log('9. 删除后文件树立即刷新，已打开页签随之关闭');
  await waitFor(
    async () => (await page.locator('.file-tree .file-row[title="external.php"]').count()) === 0,
    10000,
    '删除后 external.php 的树行消失',
  );
  assert(
    (await page.locator('.file-tree .file-row[title="external.php"]').count()) === 0,
    '删除后文件树里的行立即消失',
  );

  await page.locator('.file-tree .file-row[title="beta.php"]').click();
  await waitFor(
    async () => (await page.locator('.editor-pane .pane-path').first().innerText()).endsWith('beta.php'),
    10000,
    '编辑器切到 beta.php',
  );
  assert(
    (await page.locator('.open-editors-list .file-row[title="beta.php"]').count()) === 1,
    'beta.php 已打开',
  );
  await openTreeMenu(page, 'beta.php');
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  const deleteOpenModal = page.locator('.modal-card').filter({ hasText: '删除到回收站' });
  await deleteOpenModal.waitFor({ timeout: 8000 });
  await deleteOpenModal.locator('.btn-danger').click();
  await deleteOpenModal.waitFor({ state: 'detached', timeout: 10000 });
  await waitFor(
    async () => (await page.locator('.file-tree .file-row[title="beta.php"]').count()) === 0,
    10000,
    '删除后 beta.php 的树行消失',
  );
  assert(
    (await page.locator('.file-tree .file-row[title="beta.php"]').count()) === 0,
    '删除已打开的文件后树行消失',
  );
  await waitFor(
    async () =>
      (await page.locator('.open-editors-list .file-row[title="beta.php"]').count()) === 0 &&
      (await page.locator('.editor-tab-name', { hasText: 'beta.php' }).count()) === 0,
    10000,
    'beta.php 的页签关闭',
  );
  assert(
    (await page.locator('.open-editors-list .file-row[title="beta.php"]').count()) === 0 &&
      (await page.locator('.editor-tab-name', { hasText: 'beta.php' }).count()) === 0,
    '删除已打开的文件后对应页签关闭',
  );
  trashedFiles.push(join(projectDir, 'beta.php'));

  console.log('10. 删除有未保存修改的文件时确认框点名未保存');
  await page.locator('.file-tree-toolbar button[title="新建文件"]').click();
  const dirtyCreateModal = page.locator('.modal-card').filter({ hasText: '新建文件' });
  await dirtyCreateModal.waitFor({ timeout: 5000 });
  await dirtyCreateModal.locator('input.text-input').fill('dirty.php');
  await dirtyCreateModal.getByRole('button', { name: '创建', exact: true }).click();
  await dirtyCreateModal.waitFor({ state: 'detached', timeout: 10000 });
  await waitFor(
    async () => (await page.locator('.editor-pane .pane-path').first().innerText()).endsWith('dirty.php'),
    10000,
    '编辑器切到 dirty.php',
  );
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n// unsaved');
  await page.locator('.editor-tab.active .editor-tab-dot').waitFor({ timeout: 5000 });

  await openTreeMenu(page, 'dirty.php');
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  const dirtyDeleteModal = page.locator('.modal-card').filter({ hasText: '删除到回收站' });
  await dirtyDeleteModal.waitFor({ timeout: 8000 });
  const dirtyDeleteMessage = await dirtyDeleteModal.locator('.confirm-message').innerText();
  assert(dirtyDeleteMessage.includes('未保存'), '确认框提示了未保存修改');
  assert(dirtyDeleteMessage.includes('不可恢复'), '确认框提示了删除后不可恢复');
  await dirtyDeleteModal.locator('.btn-secondary').click();
  await dirtyDeleteModal.waitFor({ state: 'detached', timeout: 5000 });
  assert(existsSync(join(projectDir, 'dirty.php')), '取消后文件仍在磁盘上');

  console.log('11. 重命名已打开的文件后页签标题跟着变');
  writeFileSync(join(projectDir, 'a.php'), '<?php\necho "a";\n', 'utf8');
  await page.locator('.file-tree-toolbar button[title="刷新"]').click();
  await page.locator('.file-tree .file-row[title="a.php"]').waitFor({ timeout: 10000 });
  await page.locator('.file-tree .file-row[title="a.php"]').click();
  await waitFor(
    async () => (await page.locator('.editor-pane .pane-path').first().innerText()).endsWith('a.php'),
    10000,
    '编辑器切到 a.php',
  );
  assert(
    (await page.locator('.editor-tab-name', { hasText: 'a.php' }).count()) === 1,
    'a.php 的页签已打开',
  );

  await openTreeMenu(page, 'a.php');
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  const renameModal = page.locator('.modal-card').filter({ hasText: '重命名' });
  await renameModal.waitFor({ timeout: 5000 });
  await renameModal.locator('input.text-input').fill('b.php');
  await renameModal.getByRole('button', { name: '重命名', exact: true }).click();
  await renameModal.waitFor({ state: 'detached', timeout: 10000 });
  await waitFor(() => existsSync(join(projectDir, 'b.php')), 10000, 'b.php 落盘');
  assert(!existsSync(join(projectDir, 'a.php')), '重命名后旧文件消失');
  await waitFor(
    async () => (await page.locator('.editor-tab-name', { hasText: 'b.php' }).count()) === 1,
    10000,
    '页签标题变成 b.php',
  );
  assert(
    (await page.locator('.editor-tab-name', { hasText: 'b.php' }).count()) === 1,
    '重命名后页签标题跟着变',
  );
  assert(
    (await page.locator('.editor-tab-name', { hasText: 'a.php' }).count()) === 0,
    '旧标题 a.php 不再显示',
  );

  console.log('12. 「打开的编辑器」右键对比：与已保存文件比较');
  // 从文件树重新打开 alpha.php（先前的预览页签在新建 created.php 时被顶替了），
  // 再制造内存里的未保存改动
  await page.locator('.file-tree .file-row[title="alpha.php"]').click();
  await waitFor(
    async () => (await page.locator('.editor-pane .pane-path').first().innerText()).endsWith('alpha.php'),
    10000,
    '编辑器切回 alpha.php',
  );
  await page
    .locator('.open-editors-list .file-row[title="alpha.php"]')
    .waitFor({ timeout: 5000 });
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n// changed in memory');
  await page.locator('.editor-tab.active .editor-tab-dot').waitFor({ timeout: 5000 });
  assert(
    (await page.locator('.editor-tab.active .editor-tab-dot').count()) === 1,
    'alpha.php 进入未保存状态（页签出现圆点）',
  );

  await page
    .locator('.open-editors-list .file-row[title="alpha.php"]')
    .click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  const compareMenuText = await page.locator('.popup-menu').innerText();
  assert(compareMenuText.includes('与已保存文件比较'), '右键菜单有「与已保存文件比较」');
  assert(compareMenuText.includes('选择以进行比较'), '右键菜单有「选择以进行比较」');
  assert(compareMenuText.includes('与 Git HEAD 比较'), '右键菜单有「与 Git HEAD 比较」');
  await page.getByRole('menuitem', { name: '与已保存文件比较', exact: true }).click();
  await page.locator('.editor-diff-split.is-comparing').waitFor({ timeout: 10000 });
  assert((await page.locator('.editor-diff-split.is-comparing').count()) === 1, '打开对比分栏');
  // 左侧编辑器容器与右侧对比容器共用 .editor-diff-pane，靠内含的 .diff-pane 区分
  const diffPane = page.locator('.editor-diff-pane:has(.diff-pane)');
  await diffPane.locator('.pane-path').waitFor({ timeout: 8000 });
  assert(
    (await diffPane.locator('.pane-path').innerText()) === 'alpha.php ↔ 磁盘版本',
    '对比分栏标题是 alpha.php ↔ 磁盘版本',
  );
  await waitFor(
    async () => (await diffPane.innerText()).includes('changed in memory'),
    8000,
    '对比里出现内存改动',
  );
  assert(
    (await diffPane.innerText()).includes('changed in memory'),
    '对比里能看到内存中的改动',
  );

  console.log('13. 只读 / 超大文件的三个对比入口全部置灰');
  // > 2MB 会被 file-api 判成只读，content 是空串；拿空串对比只会得到假结果。
  writeFileSync(join(projectDir, 'big.bin'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x41));
  await page.locator('.file-tree-toolbar button[title="刷新"]').click();
  await page.locator('.file-tree .file-row[title="big.bin"]').waitFor({ timeout: 10000 });
  await page.locator('.file-tree .file-row[title="big.bin"]').click();
  await waitFor(
    async () => (await page.locator('.editor-pane .pane-path').first().innerText()).endsWith('big.bin'),
    10000,
    '编辑器切到 big.bin',
  );
  await page.locator('.editor-notice').filter({ hasText: '只读' }).waitFor({ timeout: 8000 });
  assert(
    (await page.locator('.editor-notice').filter({ hasText: '只读' }).count()) === 1,
    'big.bin 显示只读提示',
  );

  await page
    .locator('.open-editors-list .file-row[title="big.bin"]')
    .click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  assert(
    await page.getByRole('menuitem', { name: '与已保存文件比较', exact: true }).isDisabled(),
    '「与已保存文件比较」置灰',
  );
  assert(
    await page.getByRole('menuitem', { name: '选择以进行比较', exact: true }).isDisabled(),
    '「选择以进行比较」置灰',
  );
  assert(
    await page.getByRole('menuitem', { name: '与 Git HEAD 比较', exact: true }).isDisabled(),
    '「与 Git HEAD 比较」置灰',
  );
  await page.keyboard.press('Escape');
  await page.locator('.popup-menu').waitFor({ state: 'detached', timeout: 5000 });

  console.log('14. 同一项目再点「打开编辑器」切到已有页签而不是新建');
  await page.locator('.group-item').filter({ hasText: 'ftree' }).click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  await page.getByRole('menuitem', { name: '打开编辑器', exact: true }).click();
  await page.waitForTimeout(500);
  assert(
    (await page.locator('.terminal-pane.editor-pane').count()) === 1,
    '同一项目仍然只有一个编辑器页签',
  );
} finally {
  await app?.close().catch(() => {});
  if (trashedFiles.length > 0) {
    console.log(
      `  [回收站] ${trashedFiles.join('、')} 已被删除到系统回收站；测试不会清空回收站，需要时请自行处理。`,
    );
  }
  console.log(`  [临时目录] ${dataDir}`);
  console.log(`  [临时目录] ${projectDir}`);
  for (const dir of [dataDir, projectDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.log(`  [cleanup] 临时目录清理失败：${error.message}`);
    }
  }
  // 残留 electron 会占着 17382 让下一次运行起不来，跑完必须确认端口真的释放了
  const released = await waitForPortRelease(17382, 5000);
  if (released) {
    console.log('17382 端口已释放，无残留 electron 进程');
  } else {
    console.error('错误：17382 端口仍被占用，可能有残留 electron 进程');
    process.exitCode = 1;
  }
}

console.log(`\n全部通过：${passed} 项`);

// 在文件树里右键指定 relPath 的行，等菜单出现
async function openTreeMenu(page, relPath) {
  await page.locator(`.file-tree .file-row[title="${relPath}"]`).first().click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
}

// 轮询到条件成立或超时。predicate 可以是异步的（要读 Playwright 的 DOM）。
async function waitFor(predicate, timeout, label) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeout) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${label}${lastError ? `（${lastError.message}）` : ''}`);
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.setTimeout(1000);
  });
}

async function waitForPortRelease(port, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (!(await isPortInUse(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

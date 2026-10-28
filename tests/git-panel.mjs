import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-data-'));
const repo = mkdtempSync(join(tmpdir(), 'cmdtb-repo-'));
const plain = mkdtempSync(join(tmpdir(), 'cmdtb-plain-'));
const shotDir = resolve(root, 'test-shots');
mkdirSync(shotDir, { recursive: true });

execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
writeFileSync(join(repo, 'index.php'), '<?php echo 1;\n');
writeFileSync(join(repo, '中文 文件.txt'), 'hello\n');
writeFileSync(join(plain, 'a.txt'), 'a\n');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

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
await page.waitForTimeout(1200);

// 若窗口被其他程序遮挡，Chromium 不会投递合成的鼠标事件；确保窗口置于最前
await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0];
  win?.show();
  win?.focus();
  win?.moveTop();
});

async function click(locator) {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      await locator.click({ timeout: 3000, force: true });
      return;
    } catch (error) {
      const box = await locator.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return;
      }
      if (Date.now() > deadline) throw error;
      await page.waitForTimeout(300);
    }
  }
}

async function waitFor(predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${message}`);
    await page.waitForTimeout(250);
  }
}

async function addProject(path, name) {
  const modal = page.locator('.modal-card');
  const deadline = Date.now() + 20000;
  while ((await modal.count()) === 0) {
    if (Date.now() > deadline) throw new Error('等待超时：添加项目弹窗未出现');
    await click(page.locator('.add-project-btn'));
    await page.waitForTimeout(600);
  }
  await page.locator('#project-path').fill(path);
  await page.locator('#project-name').fill(name);
  await click(page.getByRole('button', { name: '保存项目', exact: true }));
  await modal.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(400);
}

async function selectProject(name) {
  await click(page.locator('.group-item').filter({ hasText: name }).locator('.group-main'));
  await waitFor(
    async () => (await page.locator('.git-panel').count()) > 0,
    `切换到 ${name} 后面板出现`,
  );
  await page.waitForTimeout(600);
}

console.log('1. 非 Git 项目显示初始化按钮');
await addProject(plain, 'plain-proj');
await selectProject('plain-proj');
assert(await page.locator('.git-panel').isVisible(), 'Git 面板可见');
assert(
  (await page.locator('.git-panel').innerText()).includes('不是 Git 仓库'),
  '显示非仓库提示',
);
await click(page.getByRole('button', { name: '初始化仓库', exact: true }));
await waitFor(
  async () => (await page.locator('.git-panel').innerText()).includes('a.txt'),
  '初始化后出现变更列表',
);

console.log('2. 仓库项目显示变更');
await addProject(repo, 'git-proj');
await selectProject('git-proj');
const panelText = await page.locator('.git-panel').innerText();
assert(panelText.includes('index.php'), '列出 index.php');
assert(panelText.includes('中文 文件.txt'), '列出中文空格文件名');
assert(panelText.includes('main'), '显示分支名');
assert((await page.locator('.git-change-row').count()) === 2, '变更行数为 2');

console.log('3. 提交后进入推送态');
await page.locator('.git-group-action[title="全部暂存"]').click();
await waitFor(
  async () => (await page.locator('.git-change-badge').count()) >= 2,
  '暂存后两组都出现',
);
await waitFor(
  async () => (await page.locator('.git-group-title').allInnerTexts())[0] === '已暂存',
  '文件进入暂存区',
);
await page.locator('.git-message').fill('面板提交测试');
assert(
  await page.getByRole('button', { name: '提交', exact: true }).isEnabled(),
  '填写信息后提交按钮可用',
);
await click(page.getByRole('button', { name: '提交', exact: true }));
await waitFor(
  async () => (await page.getByRole('button', { name: '推送', exact: true }).count()) > 0,
  '提交后按钮变为「推送」',
);
assert((await page.locator('.git-message').isEditable()) === false, '输入框变为只读');
const logged = execFileSync('git', ['log', '-1', '--pretty=%s'], {
  cwd: repo,
  encoding: 'utf8',
}).trim();
assert(logged === '面板提交测试', 'git log 中的提交信息一致');

console.log('4. 继续编辑回到提交态');
// 提交后工作区已干净，必须先制造新变更，「继续编辑」才有意义
writeFileSync(join(repo, 'index.php'), '<?php echo 2;\n');
await click(page.locator('.git-icon-btn'));
await waitFor(
  async () => (await page.locator('.git-panel').innerText()).includes('index.php'),
  '刷新后看到新的变更',
);
await click(page.getByRole('button', { name: '继续编辑', exact: true }));
await waitFor(
  async () => (await page.getByRole('button', { name: '提交', exact: true }).count()) > 0,
  '点击继续编辑后回到提交态',
);
assert(
  await page.getByRole('button', { name: '提交', exact: true }).isVisible(),
  '按钮回到「提交」',
);
assert(
  await page.getByRole('button', { name: '提交', exact: true }).isDisabled(),
  '输入框为空时提交按钮禁用',
);

console.log('5. 推送无上游时保留推送态');
// commit 不再自动暂存，第二次提交前同样需要先暂存
await click(page.locator('.git-group-action[title="全部暂存"]'));
await waitFor(
  async () => (await page.locator('.git-group-title').allInnerTexts())[0] === '已暂存',
  '第二次提交前文件进入暂存区',
);
await page.locator('.git-message').fill('第二次提交');
await click(page.getByRole('button', { name: '提交', exact: true }));
await waitFor(
  async () => (await page.getByRole('button', { name: '推送', exact: true }).count()) > 0,
  '第二次提交后按钮变为「推送」',
);
await click(page.getByRole('button', { name: '推送', exact: true }));
await waitFor(
  async () =>
    (await page.locator('.toast').allInnerTexts()).some((text) => text.includes('上游')),
  '推送失败提示包含上游信息',
);
assert(
  await page.getByRole('button', { name: '推送', exact: true }).isVisible(),
  '失败后仍停留在「推送」',
);

console.log('6. 点击变更文件打开 diff 页签');
await selectProject('plain-proj');
writeFileSync(join(plain, 'b.txt'), 'b\n');
await click(page.locator('.git-icon-btn'));
await waitFor(
  async () => (await page.locator('.git-change-row').filter({ hasText: 'b.txt' }).count()) > 0,
  '刷新后看到 b.txt',
);
const beforeTabs = await page.locator('.tab').count();
// 点击变更行会打开彩色 diff 视图片签
await click(page.locator('.git-change-row').filter({ hasText: 'b.txt' }));
await waitFor(
  async () => (await page.locator('.tab').count()) === beforeTabs + 1,
  '打开 diff 页签',
);
await waitFor(
  async () => (await page.locator('.diff-pane:not(.is-hidden)').count()) > 0,
  'diff 视图出现',
);
const diffText = await page.locator('.diff-pane:not(.is-hidden)').innerText();
assert(diffText.includes('b.txt'), 'diff 视图显示文件名');
await waitFor(
  async () => (await page.locator('.diff-pane:not(.is-hidden) .diff-row.is-added').count()) > 0,
  '新增行以绿色标记呈现',
);
assert(true, '新增行以绿色标记呈现');

console.log('7. 分组与行内操作');
await selectProject('git-proj');
writeFileSync(join(repo, 'index.php'), '<?php echo 7;\n');
writeFileSync(join(repo, 'new-file.txt'), 'n\n');
await click(page.locator('.git-icon-btn'));
await waitFor(
  async () => (await page.locator('.git-change-row').count()) >= 2,
  '刷新后看到两个变更',
);
const groupTitles = await page.locator('.git-group-title').allInnerTexts();
assert(groupTitles.includes('更改'), '存在「更改」组');
assert(
  await page.locator('.git-change-item').filter({ hasText: 'new-file.txt' }).count() > 0,
  '新文件列在变更列表中',
);
const newRow = page.locator('.git-change-item').filter({ hasText: 'new-file.txt' });
await click(newRow.locator('.git-row-action[title="暂存"]'));
await waitFor(
  async () => (await page.locator('.git-group-title').allInnerTexts()).length === 2,
  '暂存后出现「已暂存」组',
);
const titlesAfterStage = await page.locator('.git-group-title').allInnerTexts();
assert(titlesAfterStage.includes('已暂存'), '出现「已暂存」组');

console.log('8. 取消暂存');
const stagedRow = page.locator('.git-change-item').filter({ hasText: 'new-file.txt' });
await click(stagedRow.locator('.git-row-action[title="取消暂存"]'));
await waitFor(
  async () => (await page.locator('.git-group-title').allInnerTexts()).length === 1,
  '取消后回到单组',
);

console.log('9. 放弃需要确认，取消则不改变文件');
const beforeDiscard = readFileSync(join(repo, 'index.php'), 'utf8');
await click(
  page.locator('.git-change-item').filter({ hasText: 'index.php' }).locator('.git-row-action[title="放弃修改"]'),
);
await page.getByRole('button', { name: '确定放弃', exact: true }).waitFor({ timeout: 8000 });
await click(page.getByRole('button', { name: '取消', exact: true }));
await page.waitForTimeout(400);
assert(readFileSync(join(repo, 'index.php'), 'utf8') === beforeDiscard, '取消后文件未变');

console.log('10. 确认放弃后文件恢复');
await click(
  page.locator('.git-change-item').filter({ hasText: 'index.php' }).locator('.git-row-action[title="放弃修改"]'),
);
await page.getByRole('button', { name: '确定放弃', exact: true }).waitFor({ timeout: 8000 });
await click(page.getByRole('button', { name: '确定放弃', exact: true }));
await waitFor(
  async () => readFileSync(join(repo, 'index.php'), 'utf8') !== beforeDiscard,
  '放弃后文件恢复原内容',
);

console.log('10b. 放弃未跟踪目录');
mkdirSync(join(repo, 'scratch-dir', 'nested'), { recursive: true });
writeFileSync(join(repo, 'scratch-dir', 'nested', 'x.txt'), 'x\n');
await click(page.locator('.git-icon-btn'));
await waitFor(
  async () =>
    (await page.locator('.git-change-item').filter({ hasText: 'scratch-dir/' }).count()) > 0,
  '刷新后看到未跟踪目录',
);
await click(
  page
    .locator('.git-change-item')
    .filter({ hasText: 'scratch-dir/' })
    .locator('.git-row-action[title="放弃修改"]'),
);
await page.getByRole('button', { name: '确定放弃', exact: true }).waitFor({ timeout: 8000 });
await click(page.getByRole('button', { name: '确定放弃', exact: true }));
await waitFor(async () => !existsSync(join(repo, 'scratch-dir')), '目录已从磁盘删除');
await waitFor(
  async () =>
    (await page.locator('.git-change-item').filter({ hasText: 'scratch-dir' }).count()) === 0,
  '刷新后目录行消失',
);

console.log('11. 未暂存时提交按钮禁用');
await page.locator('.git-message').fill('不该能提交');
await waitFor(
  async () => (await page.locator('.git-group-title').count()) === 1,
  '仍有未暂存改动',
);
assert(
  await page.getByRole('button', { name: '提交', exact: true }).isDisabled(),
  '没有已暂存内容时提交按钮禁用',
);

console.log('12. 分支列表与切换');
// 新建分支要求工作区干净：先清掉前面场景留下的改动
execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: repo });
rmSync(join(repo, 'new-file.txt'), { force: true });
await click(page.locator('.git-icon-btn'));
await waitFor(
  async () => (await page.locator('.git-change-row').count()) === 0,
  '刷新后工作区干净',
);
await page.locator('.git-branch-button').click();
await page.locator('.branch-menu').waitFor({ timeout: 8000 });
assert(
  (await page.locator('.branch-menu-name').first().innerText()).includes('main'),
  '当前分支在列表首位',
);
await click(page.getByRole('menuitem', { name: '新建分支…' }));
await page.locator('#new-branch-name').waitFor({ timeout: 8000 });
await page.locator('#new-branch-name').fill('feature-test');
await page.locator('#new-branch-start').selectOption('main');
await click(page.getByRole('button', { name: '创建并切换', exact: true }));
await waitFor(
  async () => (await page.locator('.git-branch-name').innerText()) === 'feature-test',
  '分支名更新为新分支',
);
assert(
  execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() ===
    'feature-test',
  'git 中已切换',
);

console.log('13. 有改动时切换分支被阻止');
writeFileSync(join(repo, 'dirty.txt'), 'd\n');
await page.waitForTimeout(1500);
await click(page.locator('.git-icon-btn'));
await page.waitForTimeout(800);
await page.locator('.git-branch-button').click();
await page.locator('.branch-menu').waitFor({ timeout: 8000 });
await click(page.locator('.branch-menu-name').filter({ hasText: 'main' }));
await waitFor(
  async () => (await page.locator('.toast').allInnerTexts()).some((t) => t.includes('未提交')),
  '提示需要先提交或放弃',
);
assert(
  execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() ===
    'feature-test',
  '分支未变',
);

await page.screenshot({ path: join(shotDir, 'git-panel.png') });
await app.close();
rmSync(dataDir, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 项`);

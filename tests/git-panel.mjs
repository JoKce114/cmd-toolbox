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
// 测试环境不发真实的 GitHub 更新请求
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

console.log('5b. 分支栏推送按钮按 ahead 常驻');
const remote = mkdtempSync(join(tmpdir(), 'cmdtb-remote-'));
execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: remote, stdio: 'ignore' });
execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo });
execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repo, stdio: 'ignore' });

writeFileSync(join(repo, 'pending.txt'), 'p\n');
execFileSync('git', ['add', 'pending.txt'], { cwd: repo });
execFileSync('git', ['commit', '-m', '待推送提交'], { cwd: repo });
const pendingHash = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repo,
  encoding: 'utf8',
}).trim();

// 上一节停在提交后的推送态，先回到 idle 才会走分支栏入口
await click(page.getByRole('button', { name: '继续编辑', exact: true }));
await click(page.locator('.git-icon-btn'));
await waitFor(
  async () => (await page.locator('.git-push-button').count()) > 0,
  '有本地提交待推送时出现推送按钮',
);

// 复现问题 1：切换项目会重建面板，推送按钮不能因此消失
await selectProject('plain-proj');
await selectProject('git-proj');
await waitFor(
  async () => (await page.locator('.git-branch-name').innerText()) === 'main',
  '回到 git-proj',
);
assert(
  await page.locator('.git-push-button').isVisible(),
  '切换项目后推送按钮仍在',
);
assert(
  (await page.locator('.git-pull-button').count()) === 0,
  '没有落后提交时不显示拉取按钮',
);

await click(page.locator('.git-push-button'));
await waitFor(
  async () =>
    (await page.locator('.toast').allInnerTexts()).some((text) => text.includes('已推送')),
  '分支栏推送成功',
);
assert(
  execFileSync('git', ['rev-parse', 'main'], { cwd: remote, encoding: 'utf8' }).trim() ===
    pendingHash,
  '远端已收到该提交',
);
await waitFor(
  async () => (await page.locator('.git-push-button').count()) === 0,
  '推送完成后按钮消失',
);

console.log('5c. 推送被拒 → 取消 → 切项目 → 拉取合并 → 自动推送');
const other = mkdtempSync(join(tmpdir(), 'cmdtb-other-'));
execFileSync('git', ['clone', '--quiet', remote, other], { cwd: tmpdir(), stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'other@example.com'], { cwd: other });
execFileSync('git', ['config', 'user.name', 'Other'], { cwd: other });
execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: other });
writeFileSync(join(other, 'remote-side.txt'), 'r\n');
execFileSync('git', ['add', 'remote-side.txt'], { cwd: other });
execFileSync('git', ['commit', '-m', '同事提交'], { cwd: other });
execFileSync('git', ['push', '--quiet', 'origin', 'main'], { cwd: other, stdio: 'ignore' });

writeFileSync(join(repo, 'local-side.txt'), 'l\n');
execFileSync('git', ['add', 'local-side.txt'], { cwd: repo });
execFileSync('git', ['commit', '-m', '本地提交'], { cwd: repo });

await click(page.locator('.git-icon-btn'));
await waitFor(
  async () =>
    (await page.locator('.git-push-button').count()) > 0 &&
    (await page.locator('.git-pull-button').count()) > 0,
  '分叉后同时出现拉取与推送按钮',
);
await click(page.locator('.git-push-button'));
await page.locator('.modal-card').filter({ hasText: '推送被拒绝' }).waitFor({ timeout: 15000 });

// 问题 1：取消弹窗后切换项目再返回，推送按钮必须还在
await click(page.getByRole('button', { name: '取消', exact: true }));
await page.locator('.modal-card').waitFor({ state: 'detached', timeout: 8000 });
await selectProject('plain-proj');
await selectProject('git-proj');
await waitFor(
  async () => (await page.locator('.git-push-button').count()) > 0,
  '取消弹窗并切换项目后推送按钮仍在',
);

// 问题 2 + 3：选择合并拉取后自动推送
await click(page.locator('.git-push-button'));
await page.locator('.modal-card').filter({ hasText: '推送被拒绝' }).waitFor({ timeout: 15000 });
await click(page.getByRole('button', { name: '拉取（合并）', exact: true }));
await waitFor(
  async () =>
    (await page.locator('.toast').allInnerTexts()).some((text) => text.includes('已推送')),
  '拉取合并后自动推送成功',
  (20000),
);
await waitFor(
  async () => (await page.locator('.modal-card').count()) === 0,
  '成功后弹窗自动关闭',
);
assert(
  execFileSync('git', ['rev-parse', 'main'], { cwd: remote, encoding: 'utf8' }).trim() ===
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  '远端与本地 HEAD 一致',
);
const remoteLog = execFileSync('git', ['log', '--pretty=%s', 'main'], {
  cwd: remote,
  encoding: 'utf8',
});
assert(
  remoteLog.includes('本地提交') && remoteLog.includes('同事提交'),
  '远端包含本地与线上两条提交',
);
await waitFor(
  async () =>
    (await page.locator('.git-push-button').count()) === 0 &&
    (await page.locator('.git-pull-button').count()) === 0,
  '同步完成后两个按钮都消失',
);

console.log('5d. 拉取合并遇到冲突时只提示不弹窗');
// 上一节是应用自动推送的，模拟同事需要先同步再改同一个文件
execFileSync('git', ['pull', '--quiet', '--ff-only', 'origin', 'main'], {
  cwd: other,
  stdio: 'ignore',
});
writeFileSync(join(other, 'a.txt'), 'remote\n');
execFileSync('git', ['add', 'a.txt'], { cwd: other });
execFileSync('git', ['commit', '-m', '线上改 a.txt'], { cwd: other });
execFileSync('git', ['push', '--quiet', 'origin', 'main'], { cwd: other, stdio: 'ignore' });

writeFileSync(join(repo, 'a.txt'), 'local\n');
execFileSync('git', ['add', 'a.txt'], { cwd: repo });
execFileSync('git', ['commit', '-m', '本地改 a.txt'], { cwd: repo });

await click(page.locator('.git-icon-btn'));
await waitFor(
  async () => (await page.locator('.git-push-button').count()) > 0,
  '冲突场景下推送按钮出现',
);
await click(page.locator('.git-push-button'));
await page.locator('.modal-card').filter({ hasText: '推送被拒绝' }).waitFor({ timeout: 15000 });
await click(page.getByRole('button', { name: '拉取（合并）', exact: true }));
await waitFor(
  async () =>
    (await page.locator('.toast').allInnerTexts()).some((text) => text.includes('冲突')),
  '冲突以 toast 提示',
  (20000),
);
assert(
  (await page.locator('.modal-card').count()) === 0,
  '冲突后不再保留弹窗',
);
await waitFor(
  async () => (await page.locator('.git-resolve-btn').count()) > 0,
  '左侧列表标出冲突文件',
);

// 收尾：放弃这次合并，避免影响后续用例
execFileSync('git', ['merge', '--abort'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['reset', '--hard', 'origin/main'], { cwd: repo, stdio: 'ignore' });
await click(page.locator('.git-icon-btn'));
await waitFor(
  async () => (await page.locator('.git-push-button').count()) === 0,
  '放弃合并后回到同步状态',
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
await page.locator('.branch-picker').waitFor({ timeout: 8000 });
assert(
  (await page.locator('.branch-picker-name').first().innerText()).includes('main'),
  '当前分支在列表首位',
);
await click(page.locator('.branch-picker-create').filter({ hasText: '新建分支…' }));
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
await page.locator('.branch-picker').waitFor({ timeout: 8000 });
await click(page.locator('.branch-picker-name').filter({ hasText: 'main' }));
await waitFor(
  async () => (await page.locator('.toast').allInnerTexts()).some((t) => t.includes('未提交')),
  '提示需要先提交或放弃',
);
assert(
  execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() ===
    'feature-test',
  '分支未变',
);

console.log('14. 提交历史打开 diff 页签');
execFileSync('git', ['checkout', 'main'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: repo, stdio: 'ignore' });
rmSync(join(repo, 'dirty.txt'), { force: true });
writeFileSync(join(repo, 'history-a.txt'), 'a\n');
writeFileSync(join(repo, 'history-b.txt'), 'b\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['commit', '-m', '历史多文件'], { cwd: repo });
await page.waitForTimeout(1200);
await click(page.locator('.git-icon-btn'));

const historyToggle = page.locator('.git-history-toggle');
if ((await page.locator('.git-history-button').count()) === 0) await click(historyToggle);
await waitFor(
  async () =>
    (await page.locator('.git-history-button').filter({ hasText: '历史多文件' }).count()) > 0,
  '提交历史刷新到最新提交',
);
await click(page.locator('.git-history-button').filter({ hasText: '历史多文件' }).first());
await waitFor(
  async () => (await page.locator('.diff-file-select').count()) > 0,
  '提交 diff 页签出现',
);
await waitFor(
  async () => (await page.locator('.diff-file-select option').count()) > 0,
  '提交 diff 文件列表加载完成',
);
assert(
  (await page.locator('.diff-file-select option').count()) === 2,
  '文件下拉有 2 个文件',
);

const commitPane = page
  .locator('.diff-pane')
  .filter({ has: page.locator('.diff-file-select') });
const firstBody = await commitPane.locator('.diff-body').innerText();
await page.locator('.diff-file-select').selectOption({ index: 1 });
await page.waitForTimeout(400);
const secondBody = await commitPane.locator('.diff-body').innerText();
assert(firstBody !== secondBody, '切换文件后正文变化');

console.log('15. 撤销提交');
await click(page.locator('.git-ops-button[data-action="undo"]'));
await page.locator('.modal-card').filter({ hasText: '撤销提交' }).waitFor({ timeout: 8000 });
await click(page.getByRole('button', { name: '确定撤销', exact: true }));
await waitFor(
  async () => (await page.locator('.git-message').inputValue()).includes('历史多文件'),
  '撤销后提交信息回填到输入框',
);
assert(
  execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: repo, encoding: 'utf8' }).trim() !==
    '历史多文件',
  '提交确实被撤销',
);
assert(
  execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' }).includes(
    'history-a.txt',
  ),
  '改动回到暂存区',
);

console.log('16. 修改提交');
// 先重新提交，让 HEAD 恢复存在
await click(page.getByRole('button', { name: '提交', exact: true }));
await waitFor(
  async () =>
    execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: repo, encoding: 'utf8' }).trim() ===
    '历史多文件',
  '重新提交完成',
);
await waitFor(
  async () => page.locator('.git-ops-button[data-action="amend"]').isEnabled(),
  '提交结束后操作按钮恢复可用',
);
await click(page.locator('.git-ops-button[data-action="amend"]'));
await page.locator('#amend-message').waitFor({ timeout: 8000 });
await page.locator('#amend-message').fill('改写后的信息');
await click(page.getByRole('button', { name: '保存修改', exact: true }));
await waitFor(
  async () =>
    execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: repo, encoding: 'utf8' }).trim() ===
    '改写后的信息',
  '提交信息已更新',
);

console.log('17. 收起与恢复改动');
// 先造两条 stash：ref 是位置型的，只有两行都在时才能验证并发操作期间的整行禁用
writeFileSync(join(repo, 'stash-earlier.txt'), 'e\n');
await page.waitForTimeout(1200);
await click(page.locator('.git-icon-btn'));
await waitFor(
  async () => (await page.locator('.git-change-row').count()) > 0,
  '出现待收起的改动',
);
await click(page.locator('.git-ops-button[data-action="stash"]'));
await waitFor(
  async () => (await page.locator('.git-stash-item').count()) === 1,
  '出现第一条 stash 记录',
);
assert(!existsSync(join(repo, 'stash-earlier.txt')), '较早的文件已被收起');

writeFileSync(join(repo, 'stash-ui.txt'), 's\n');
await page.waitForTimeout(1200);
await click(page.locator('.git-icon-btn'));
await waitFor(
  async () => (await page.locator('.git-change-row').count()) > 0,
  '再次出现待收起的改动',
);
await click(page.locator('.git-ops-button[data-action="stash"]'));
await waitFor(
  async () => (await page.locator('.git-stash-item').count()) === 2,
  '出现第二条 stash 记录',
);
assert(!existsSync(join(repo, 'stash-ui.txt')), '文件已被收起');

// 用 MutationObserver 记录「所有行的操作按钮同时被禁用」这一瞬时状态：
// 恢复是异步的，单次 isDisabled() 轮询可能刚好错过，观察者不会
await page.evaluate(() => {
  window.__stashAllDisabled = false;
  const check = () => {
    const actions = [...document.querySelectorAll('.git-stash-item .git-row-action')];
    if (actions.length >= 4 && actions.every((action) => action.disabled)) {
      window.__stashAllDisabled = true;
    }
  };
  const observer = new MutationObserver(check);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['disabled'],
  });
  window.__stashObserver = observer;
  check();
});

await click(
  page.locator('.git-stash-item').first().locator('.git-row-action[title="恢复"]'),
);
await waitFor(async () => existsSync(join(repo, 'stash-ui.txt')), '恢复后文件回来');
await waitFor(
  async () => (await page.locator('.git-stash-item').count()) === 1,
  '恢复后列表只剩一条',
);
const allDisabledSeen = await page.evaluate(() => {
  window.__stashObserver?.disconnect();
  return window.__stashAllDisabled;
});
assert(allDisabledSeen === true, '恢复进行中所有行的操作按钮同时禁用');

await click(
  page.locator('.git-stash-item').first().locator('.git-row-action[title="恢复"]'),
);
await waitFor(async () => existsSync(join(repo, 'stash-earlier.txt')), '第二条恢复后文件回来');
await waitFor(
  async () => (await page.locator('.git-stash-item').count()) === 0,
  '恢复后列表清空',
);

// 17b. 收起改动进行中同样禁用行操作
// 恢复出来的两个文件还在工作区，先收成一条 stash，让行按钮渲染出来
await page.waitForFunction(
  () =>
    !document.querySelector('.git-ops-button[data-action="stash"]')?.hasAttribute('disabled'),
  null,
  { timeout: 15000 },
);
await click(page.locator('.git-ops-button[data-action="stash"]'));
await waitFor(
  async () => (await page.locator('.git-stash-item').count()) === 1,
  '再次出现 stash 记录',
);
// stash push 需要工作区有改动，否则立刻失败、观察窗口太短
writeFileSync(join(repo, 'stash-saving.txt'), 'g\n');
await page.waitForTimeout(1200);
await click(page.locator('.git-icon-btn'));
await waitFor(
  async () => (await page.locator('.git-change-row').count()) > 0,
  '收起前工作区有改动',
);
await page.evaluate(() => {
  window.__stashSaveAllDisabled = false;
  const check = () => {
    const actions = [...document.querySelectorAll('.git-stash-item .git-row-action')];
    if (actions.length >= 2 && actions.every((action) => action.disabled)) {
      window.__stashSaveAllDisabled = true;
    }
  };
  const observer = new MutationObserver(check);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['disabled'],
  });
  window.__stashSaveObserver = observer;
  check();
});
await click(page.locator('.git-ops-button[data-action="stash"]'));
await waitFor(
  async () => (await page.locator('.git-stash-item').count()) === 2,
  '收起后出现第二条 stash',
);
const saveAllDisabledSeen = await page.evaluate(() => {
  window.__stashSaveObserver?.disconnect();
  return window.__stashSaveAllDisabled;
});
assert(saveAllDisabledSeen === true, '收起改动进行中所有行的操作按钮同时禁用');
assert(!existsSync(join(repo, 'stash-saving.txt')), '收起后文件已进 stash');

console.log('18. 冲突行可直接进入编辑器');
// 上一步恢复的未跟踪文件会干扰 checkout，先清干净
rmSync(join(repo, 'stash-ui.txt'), { force: true });
execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['checkout', '-b', 'conflict-a'], { cwd: repo, stdio: 'ignore' });
writeFileSync(join(repo, 'index.php'), '<?php echo "a";\n');
execFileSync('git', ['commit', '-am', 'a 改'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['checkout', 'main'], { cwd: repo, stdio: 'ignore' });
writeFileSync(join(repo, 'index.php'), '<?php echo "b";\n');
execFileSync('git', ['commit', '-am', 'b 改'], { cwd: repo, stdio: 'ignore' });
try {
  execFileSync('git', ['merge', 'conflict-a'], { cwd: repo, stdio: 'ignore' });
} catch {
  // 冲突时 git merge 退出码非零，属预期
}
await page.waitForTimeout(1200);
await click(page.locator('.git-icon-btn'));
await waitFor(
  async () => (await page.locator('.git-resolve-btn').count()) > 0,
  '出现解决冲突按钮',
);
await click(page.locator('.git-resolve-btn').first());
await waitFor(
  async () => (await page.locator('.conflict-bar').count()) > 0,
  '编辑器打开冲突文件并显示工具栏',
);

await page.screenshot({ path: join(shotDir, 'git-panel.png') });
await app.close();
rmSync(dataDir, { recursive: true, force: true });
rmSync(remote, { recursive: true, force: true });
rmSync(other, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 项`);

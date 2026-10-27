import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
await page.waitForTimeout(1500);

async function click(locator) {
  try {
    await locator.click({ timeout: 6000 });
  } catch (error) {
    const box = await locator.boundingBox();
    if (!box) throw error;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
}

async function addProject(path, name) {
  await click(page.locator('.add-project-btn'));
  await page.locator('.modal-card').waitFor();
  await page.locator('#project-path').fill(path);
  await page.locator('#project-name').fill(name);
  await click(page.getByRole('button', { name: '保存项目', exact: true }));
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await page.waitForTimeout(500);
}

async function selectProject(name) {
  await click(page.locator('.group-item').filter({ hasText: name }).locator('.group-main'));
  await page.waitForTimeout(1200);
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
await page.waitForTimeout(1600);
assert(
  (await page.locator('.git-panel').innerText()).includes('a.txt'),
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
await page.locator('.git-message').fill('面板提交测试');
assert(
  await page.getByRole('button', { name: '提交', exact: true }).isEnabled(),
  '填写信息后提交按钮可用',
);
await click(page.getByRole('button', { name: '提交', exact: true }));
await page.waitForTimeout(2000);
assert(
  await page.getByRole('button', { name: '推送', exact: true }).isVisible(),
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
await page.waitForTimeout(1400);
await click(page.getByRole('button', { name: '继续编辑', exact: true }));
await page.waitForTimeout(600);
assert(
  await page.getByRole('button', { name: '提交', exact: true }).isVisible(),
  '按钮回到「提交」',
);
assert(
  await page.getByRole('button', { name: '提交', exact: true }).isDisabled(),
  '输入框为空时提交按钮禁用',
);

console.log('5. 推送无上游时保留推送态');
await page.locator('.git-message').fill('第二次提交');
await click(page.getByRole('button', { name: '提交', exact: true }));
await page.waitForTimeout(2000);
await click(page.getByRole('button', { name: '推送', exact: true }));
await page.waitForTimeout(2500);
const toastText = await page.locator('.toast').last().innerText();
assert(toastText.includes('上游'), '推送无上游时提示上游信息');
assert(
  await page.getByRole('button', { name: '推送', exact: true }).isVisible(),
  '失败后仍停留在「推送」',
);

console.log('6. 点击变更文件打开 diff 页签');
await selectProject('plain-proj');
writeFileSync(join(plain, 'b.txt'), 'b\n');
await click(page.locator('.git-icon-btn'));
await page.waitForTimeout(1200);
const beforeTabs = await page.locator('.tab').count();
await click(page.locator('.git-change-row').filter({ hasText: 'b.txt' }));
await page.waitForTimeout(2500);
assert((await page.locator('.tab').count()) === beforeTabs + 1, '打开了一个新页签');
const rows = await page.locator('.terminal-pane:not(.is-hidden) .xterm-rows').innerText();
assert(rows.includes('b.txt'), 'diff 内容出现在终端中');

await page.screenshot({ path: join(shotDir, 'git-panel.png') });
await app.close();
rmSync(dataDir, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 项`);

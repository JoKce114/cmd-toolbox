import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'icon-data-'));
const repo = mkdtempSync(join(tmpdir(), 'icon-repo-'));
const shots = resolve(root, 'test-shots');
mkdirSync(shots, { recursive: true });

const run = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
run(['init', '-b', 'main']);
run(['config', 'user.email', 't@e.com']);
run(['config', 'user.name', 'T']);
run(['config', 'commit.gpgsign', 'false']);
run(['config', 'core.autocrlf', 'false']);

writeFileSync(join(repo, 'main.css'), '.a { color: red; }\n');
writeFileSync(join(repo, 'app.config'), 'setting=1\n');
writeFileSync(join(repo, 'config.json'), '{}\n');
writeFileSync(join(repo, 'index.php'), '<?php echo 1;\n');
run(['add', '.']);
run(['commit', '-m', 'init']);
writeFileSync(join(repo, 'main.css'), '.a { color: blue; }\n');
writeFileSync(join(repo, 'app.config'), 'setting=2\n');
writeFileSync(join(repo, 'config.json'), '{ "a": 1 }\n');
writeFileSync(join(repo, 'index.php'), '<?php echo 2;\n');
writeFileSync(join(repo, 'note.unknown'), 'x\n');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
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
await page.waitForTimeout(1200);

await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0];
  win?.show();
  win?.focus();
  win?.moveTop();
});

async function addProject() {
  await page.locator('.add-project-btn').click();
  await page.locator('.modal-card input').first().fill('图标用例');
  await page.locator('.modal-card input').nth(1).fill(repo);
  await page.locator('.modal-card button[type="submit"], .modal-card .btn-primary').last().click();
  await page.waitForSelector('.group-item.active', { timeout: 10000 });
}

await page.locator('.sidebar').waitFor();
await addProject();

await page.waitForFunction(
  () => document.querySelectorAll('.git-change-row').length > 0,
  undefined,
  { timeout: 20000 },
);

// 每行读出：状态字母、路径、图标 lucide class、stroke 颜色
const rows = await page.$$eval('.git-change-row', (nodes) =>
  nodes.map((node) => {
    const badge = node.querySelector('.git-change-badge');
    const path = node.querySelector('.git-change-path');
    const svg = node.querySelector('.file-type-icon');
    return {
      badge: badge ? badge.textContent : null,
      path: path ? path.textContent : null,
      iconClass: svg ? svg.getAttribute('class') : null,
      stroke: svg ? svg.getAttribute('stroke') : null,
    };
  }),
);

console.log('  行数据：', JSON.stringify(rows, null, 2));

const byPath = (name) => rows.find((row) => (row.path || '').includes(name));

const css = byPath('main.css');
assert(Boolean(css), '.css 出现在更改列表');
assert(css?.iconClass?.includes('lucide-hash'), '.css 用 hash 图标');
assert(css?.stroke?.toLowerCase() === '#4aa8e0', '.css 图标颜色是蓝色 #4aa8e0');

const config = byPath('app.config');
assert(Boolean(config), '.config 出现在更改列表');
assert(config?.iconClass?.includes('lucide-settings'), '.config 用齿轮图标');
assert(config?.stroke?.toLowerCase() === '#a074c4', '.config 图标颜色是紫色 #a074c4');

const json = byPath('config.json');
assert(json?.iconClass?.includes('lucide-file-json'), '.json 用 file-json 图标');

const php = byPath('index.php');
assert(php?.iconClass?.includes('lucide-file-code'), '.php 用 code 图标');

const unknown = byPath('note.unknown');
assert(Boolean(unknown), '.unknown 出现在更改列表');
assert(unknown?.iconClass?.includes('lucide-file'), '.unknown 回落到通用文件图标');
assert(unknown?.stroke?.toLowerCase() === '#9aa0a6', '.unknown 图标颜色是灰色');

await page.screenshot({ path: join(shots, 'change-icons.png') });
console.log(`  截图：${join(shots, 'change-icons.png')}`);

// 侧栏拖拽
const sidebar = page.locator('.sidebar');
const before = (await sidebar.boundingBox()).width;
const resizer = page.locator('.sidebar-resizer');
assert(Boolean(await resizer.count()), '侧栏有拖拽条');
const box = await resizer.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 8 });
await page.mouse.up();
const after = (await sidebar.boundingBox()).width;
assert(after > before + 60, `拖动后侧栏变宽（${before} → ${after}）`);
const stored = await page.evaluate(() => window.localStorage.getItem('cmd-toolbox.sidebar-width'));
assert(Number(stored) === Math.round(after), `宽度已落盘（${stored}）`);

await page.screenshot({ path: join(shots, 'sidebar-wide.png') });

// 双击复原
await page.mouse.move(box.x + 90 + 3, box.y + box.height / 2);
await page.mouse.dblclick(box.x + 90 + 3, box.y + box.height / 2);
await page.waitForTimeout(300);
const restored = (await sidebar.boundingBox()).width;
assert(Math.abs(restored - before) < 2, `双击复原默认宽度（${restored}）`);
const cleared = await page.evaluate(() =>
  window.localStorage.getItem('cmd-toolbox.sidebar-width'),
);
assert(cleared === null, '双击后存储值被清空');

await app.close();
console.log(`\n全部通过：${passed} 项`);

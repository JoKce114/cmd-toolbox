import { _electron as electron } from 'playwright-core';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-data-'));
const repo = mkdtempSync(join(tmpdir(), 'cmdtb-ipc-fs-'));
mkdirSync(join(repo, 'src'));
writeFileSync(join(repo, 'index.php'), '<?php echo 1;\n');

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
await page.waitForLoadState('domcontentloaded');
await page.locator('.app').waitFor();
await page.waitForTimeout(1200);

await page.evaluate((p) => window.api.projects.save({ name: 'fs-proj', path: p }), repo);

const listed = await page.evaluate((p) => window.api.files.list(p, ''), repo);
assert(listed.entries.some((e) => e.name === 'index.php'), 'IPC 列出文件');

const read = await page.evaluate((p) => window.api.files.read(p, 'index.php'), repo);
assert(read.content === '<?php echo 1;\n', 'IPC 读取内容');
assert(read.encoding === 'utf8', 'IPC 返回编码');

await page.evaluate(
  ([p, mtime]) => window.api.files.write(p, 'index.php', '<?php echo 2;\n', 'utf8', mtime),
  [repo, read.mtime],
);
const reread = await page.evaluate((p) => window.api.files.read(p, 'index.php'), repo);
assert(reread.content === '<?php echo 2;\n', 'IPC 写入生效');

let blocked = '';
try {
  await page.evaluate(() => window.api.files.read('C:\\Windows', 'win.ini'));
} catch (error) {
  blocked = error.message;
}
assert(blocked.includes('未保存'), '未保存项目被白名单拒绝');

await app.close();
rmSync(dataDir, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 项`);

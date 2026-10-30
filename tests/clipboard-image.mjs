// 剪贴板图片识别。
// Electron 45 移除了同步的 clipboard.readImage()，只剩异步的 read()/write()。
// 旧写法会在主进程抛 TypeError 并被 catch 吞成 false，表现为「剪贴板里有图也贴不进去」。
// 这里直接对真实图片和纯文本各断言一次，防止再被 Electron 升级悄悄破坏。
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-clip-'));

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

try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.app').waitFor();

  console.log('1. 纯文本剪贴板不算图片');
  await page.evaluate(() => window.api.clipboard.write('只是文本'));
  assert((await page.evaluate(() => window.api.clipboard.hasImage())) === false, '文本返回 false');

  console.log('2. 真实图片能被识别');
  const png = join(dataDir, 'probe.png');
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      [
        'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
        '$bmp = New-Object System.Drawing.Bitmap(40,20)',
        '$g = [System.Drawing.Graphics]::FromImage($bmp)',
        '$g.Clear([System.Drawing.Color]::FromArgb(220,60,60))',
        '$g.Dispose()',
        `$bmp.Save('${png}', [System.Drawing.Imaging.ImageFormat]::Png)`,
        `$img = [System.Drawing.Image]::FromFile('${png}')`,
        '[System.Windows.Forms.Clipboard]::SetImage($img)',
        '$img.Dispose(); $bmp.Dispose()',
      ].join('; '),
    ],
    { stdio: 'ignore' },
  );
  assert((await page.evaluate(() => window.api.clipboard.hasImage())) === true, '图片返回 true');

  console.log('3. 文本读取仍然正常');
  await page.evaluate(() => window.api.clipboard.write('文本回来了'));
  assert((await page.evaluate(() => window.api.clipboard.read())) === '文本回来了', 'write/read 往返');
} finally {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n全部通过：${passed} 项`);

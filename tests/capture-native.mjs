import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
  cwd: root,
  args: ['.', `--data-dir=${resolve(root, '.test-data')}`],
  env,
});

const page = await app.firstWindow();
await page.locator('.app').waitFor();
await page.waitForTimeout(900);
await app.evaluate(({ BrowserWindow }) => {
  const window = BrowserWindow.getAllWindows()[0];
  window.show();
  window.focus();
});
await page.waitForTimeout(400);

const output = execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    resolve(root, 'scripts/capture-window.ps1'),
    '-Out',
    resolve(root, 'test-shots/14-native-window.png'),
  ],
  { encoding: 'utf8' },
);
console.log(output.trim());
await app.close();

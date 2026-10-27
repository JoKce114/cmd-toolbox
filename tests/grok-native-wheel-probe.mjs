import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const exe = resolve(root, 'release/CmdToolbox.exe');
const dataDir = resolve(root, '.test-data/grok-native-wheel');
const port = 9357;
const injector = resolve(root, 'tests/conpty-inject.ps1');
const outDir = resolve(root, '.test-data/grok-native-wheel-out');

if (!existsSync(exe)) throw new Error(`找不到便携版程序：${exe}`);
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

async function waitForCdp(timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // extracting / starting
    }
    await wait(750);
  }
  throw new Error('便携版启动超时');
}

async function rows(page) {
  return page.locator('.terminal-pane:not(.is-hidden) .xterm-rows').innerText();
}

async function waitText(page, needle, timeout = 60000) {
  await page.waitForFunction(
    (text) => document.querySelector('.terminal-pane:not(.is-hidden) .xterm-rows')?.textContent.includes(text),
    needle,
    { timeout },
  );
}

async function click(page, locator) {
  try {
    await locator.click({ timeout: 6000 });
  } catch (error) {
    const box = await locator.boundingBox();
    if (!box) throw error;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
}

function inject(pid, mode, delta = 120) {
  const res = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', injector,
    '-TargetPid', String(pid),
    '-Mode', mode,
    '-Delta', String(delta),
  ], { cwd: root, encoding: 'utf8', timeout: 20000 });
  if (res.status !== 0) return `ERR ${res.status} ${String(res.stderr || '').slice(0, 200)}`;
  try {
    return readFileSync(resolve(root, '.test-data/inject.log'), 'utf8').trim();
  } catch {
    return 'no log';
  }
}

function findCmdPid(appPort) {
  const script = `
$port = ${appPort}
$all = Get-CimInstance Win32_Process
$byId = @{}
foreach ($process in $all) { $byId[[int]$process.ProcessId] = [int]$process.ParentProcessId }
$appIds = @($all | Where-Object { $_.CommandLine -like "*--remote-debugging-port=$port*" } | ForEach-Object { [int]$_.ProcessId })
$candidates = @($all | Where-Object { $_.Name -eq 'cmd.exe' } | Where-Object {
  $p = [int]$_.ParentProcessId
  $depth = 0
  $hit = $false
  while ($p -gt 0 -and $depth -lt 10) {
    if ($appIds -contains $p) { $hit = $true; break }
    $p = [int]$byId[$p]
    $depth = $depth + 1
  }
  $hit
} | Sort-Object CreationDate -Descending)
if ($candidates.Count -gt 0) { $candidates[0].ProcessId } else { 0 }
`;
  const res = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 30000 });
  return Number(String(res.stdout || '').trim()) || 0;
}

const child = spawn(exe, [`--data-dir=${dataDir}`, `--remote-debugging-port=${port}`], {
  stdio: 'ignore',
  windowsHide: false,
  env,
});

let browser;
let page;
const record = [];
try {
  await waitForCdp();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  page = context.pages()[0] || (await context.waitForEvent('page', { timeout: 20000 }));
  await page.locator('.app').waitFor({ timeout: 20000 });
  await wait(600);

  await click(page, page.locator('.add-project-btn'));
  await page.locator('#project-path').fill('E:/phpstudy_pro/WWW/web-7.0');
  await page.locator('#project-name').fill('Grok Native Wheel');
  await click(page, page.getByRole('button', { name: '保存项目', exact: true }));
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await wait(400);
  await click(page, page.getByRole('button', { name: '打开命令提示符', exact: true }));
  await page.locator('.terminal-pane').waitFor();
  await waitText(page, 'web-7.0>', 60000);
  await page.locator('.terminal-pane:not(.is-hidden) .xterm-screen').click();
  await wait(500);

  const cmdPid = findCmdPid(port);
  record.push(`app pid=${child.pid} cmd pid=${cmdPid}`);
  console.log(record[record.length - 1]);

  const zlog = inject(cmdPid, 'z');
  await wait(700);
  const afterZ = await rows(page);
  record.push(`z inject: ${zlog.replace(/\s+/g, ' ')}`);
  record.push(`z visible: ${afterZ.includes('z')}`);
  console.log(record[record.length - 1]);
  await page.keyboard.press('Backspace');
  await wait(300);

  await page.keyboard.type('grok');
  await page.keyboard.press('Enter');
  console.log('grok 启动中...');
  await waitText(page, 'Grok', 120000).catch(() => console.log('未检测到 Grok 标题'));
  await wait(4500);
  await page.keyboard.type('/resume');
  await wait(1500);
  await page.keyboard.press('Enter');
  await waitText(page, 'nav', 30000);
  await wait(1500);
  await page.keyboard.press('Enter');
  await wait(6000);
  await page.keyboard.press('Tab');
  await wait(1000);

  const snapshot = async (label) => {
    const text = await rows(page);
    writeFileSync(resolve(outDir, `${label}.txt`), text, 'utf8');
    record.push(`--- ${label} ---`);
    record.push(text);
    return text;
  };

  await snapshot('baseline');

  for (let i = 1; i <= 3; i += 1) {
    const log = inject(cmdPid, 'mouse', 120);
    record.push(`wheel up ${i}: ${log.replace(/\s+/g, ' ')}`);
    await wait(500);
    await snapshot(`up-${i}`);
  }

  await page.screenshot({ path: resolve(outDir, 'wheel-up.png') });

  for (let i = 1; i <= 3; i += 1) {
    const log = inject(cmdPid, 'mouse', -120);
    record.push(`wheel down ${i}: ${log.replace(/\s+/g, ' ')}`);
    await wait(500);
    await snapshot(`down-${i}`);
  }

  await page.screenshot({ path: resolve(outDir, 'wheel-down.png') });
} finally {
  writeFileSync(resolve(outDir, 'report.txt'), record.join('\n'), 'utf8');
  try { await browser?.close(); } catch {}
  try { child.kill(); } catch {}
  spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', `
$port = ${port}
$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'Cmd Toolbox*' -and $_.CommandLine -like "*--remote-debugging-port=$port*" }
foreach ($p in $procs) { taskkill /PID $p.ProcessId /T /F | Out-Null }
`], { timeout: 30000 });
  await wait(800);
  process.exit(0);
}

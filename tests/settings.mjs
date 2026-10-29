import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'st-'));
const repo = mkdtempSync(join(tmpdir(), 'str-'));
const shots = resolve(root, 'test-shots');
mkdirSync(shots, { recursive: true });

const longLine = 'const value = "' + 'x'.repeat(220) + '";\n';
writeFileSync(join(repo, 'long.js'), '// wrap test\n' + longLine);

let passed = 0;
const ok = (c, m) => {
  if (!c) throw new Error('断言失败：' + m);
  passed += 1;
  console.log('  ok  ' + m);
};
const waitFor = async (fn, msg, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error('等待超时：' + msg);
    await page.waitForTimeout(250);
  }
};

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
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  w?.show();
  w?.focus();
  w?.moveTop();
  w?.setContentSize(1380, 880);
});
await page.waitForLoadState('domcontentloaded');
await page.locator('.app').waitFor({ timeout: 30000 });
await page.waitForTimeout(1500);

const click = async (loc) => {
  for (let i = 0; i < 40; i += 1) {
    try {
      await loc.click({ timeout: 2500, force: true });
      return;
    } catch {
      const b = await loc.boundingBox().catch(() => null);
      if (b) {
        await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
        return;
      }
      await page.waitForTimeout(250);
    }
  }
  throw new Error('click failed');
};

console.log('1. 打开设置');
await click(page.getByRole('button', { name: '设置', exact: true }).or(page.locator('.titlebar-settings')));
await waitFor(async () => (await page.locator('.settings-body').count()) > 0, '设置面板');
ok(true, '设置面板打开');
const tabLabels = await page.locator('.settings-tab').allInnerTexts();
ok(
  ['关于', '终端', '编辑器', '快捷键'].every((label) =>
    tabLabels.some((text) => text.includes(label)),
  ),
  '包含关于、终端、编辑器与快捷键页签',
);
ok(
  (await page.locator('.settings-tab.is-active').innerText()).includes('关于'),
  '默认停在关于页签',
);
await page.screenshot({ path: join(shots, 'settings.png') });

console.log('2. 自动换行开关');
await click(page.getByRole('tab', { name: '编辑器' }));
await page.waitForTimeout(200);
const wrapSwitch = page.locator('.settings-item').filter({ hasText: '自动换行' }).locator('.settings-switch');
ok((await wrapSwitch.getAttribute('aria-checked')) === 'true', '默认开启');
await click(wrapSwitch);
await page.waitForTimeout(300);
ok((await wrapSwitch.getAttribute('aria-checked')) === 'false', '点击后关闭');
await click(wrapSwitch);
await page.waitForTimeout(300);

console.log('3. 保存并验证编辑器换行');
await click(page.getByRole('button', { name: '保存', exact: true }));
await page.waitForTimeout(600);

await click(page.locator('.add-project-btn'));
await page.locator('.modal-card').waitFor({ timeout: 15000 });
await page.locator('#project-path').fill(repo);
await page.locator('#project-name').fill('wrap-proj');
await click(page.getByRole('button', { name: '保存项目', exact: true }));
await page.locator('.modal-card').waitFor({ state: 'detached', timeout: 15000 });
await page.waitForTimeout(800);
await page.locator('.group-item').filter({ hasText: 'wrap-proj' }).click({ button: 'right' });
await page.locator('.popup-menu').waitFor({ timeout: 8000 });
await click(page.getByRole('menuitem', { name: '打开编辑器', exact: true }));
await page.waitForTimeout(1200);
await click(page.locator('.editor-pane .file-row').filter({ hasText: 'long.js' }));
await page.waitForTimeout(2000);

const wrapOn = await page.evaluate(() => {
  const content = document.querySelector('.cm-content');
  const scroller = document.querySelector('.cm-scroller');
  return {
    hasWrapping: content?.classList.contains('cm-lineWrapping') ?? false,
    scrollW: scroller?.scrollWidth ?? 0,
    clientW: scroller?.clientWidth ?? 0,
  };
});
console.log('   换行开:', JSON.stringify(wrapOn));
ok(wrapOn.hasWrapping || wrapOn.scrollW <= wrapOn.clientW + 2, '开启时内容不横向溢出');

// 关掉换行
await click(page.locator('.titlebar-settings'));
await waitFor(async () => (await page.locator('.settings-body').count()) > 0, '设置面板');
await click(page.getByRole('tab', { name: '编辑器' }));
await page.waitForTimeout(200);
await click(page.locator('.settings-item').filter({ hasText: '自动换行' }).locator('.settings-switch'));
await page.waitForTimeout(300);
await click(page.getByRole('button', { name: '保存', exact: true }));
await page.waitForTimeout(1200);

const wrapOff = await page.evaluate(() => {
  const content = document.querySelector('.cm-content');
  const scroller = document.querySelector('.cm-scroller');
  return {
    hasWrapping: content?.classList.contains('cm-lineWrapping') ?? false,
    scrollW: scroller?.scrollWidth ?? 0,
    clientW: scroller?.clientWidth ?? 0,
  };
});
console.log('   换行关:', JSON.stringify(wrapOff));
ok(wrapOff.scrollW > wrapOff.clientW, '关闭后长行横向溢出');

await page.screenshot({ path: join(shots, 'nowrap.png') });

console.log('4. 关于分组显示版本与检查更新结果');
await click(page.locator('.titlebar-settings'));
await waitFor(async () => (await page.locator('.settings-body').count()) > 0, '设置面板');
const aboutItem = page.locator('.settings-item').filter({ hasText: 'Cmd Toolbox' });
await waitFor(async () => (await aboutItem.count()) > 0, '关于行出现');
const aboutText = await aboutItem.innerText();
ok(/Cmd Toolbox v\d+\.\d+\.\d+/.test(aboutText), '显示版本号');
// 测试启动时带了 CMDTOOLBOX_NO_UPDATE=1，能显示这条文案说明 IPC 往返正常
await waitFor(
  async () => (await aboutItem.innerText()).includes('环境变量'),
  '启动时自动检查的结果已回填到设置里',
);
ok(
  (await page.getByRole('button', { name: '检查更新', exact: true }).count()) > 0,
  '有手动检查按钮',
);
await aboutItem.scrollIntoViewIfNeeded();
await page.screenshot({ path: join(shots, 'settings-about.png') });

console.log('5. 编辑器页签分三组');
// 上一节结束时设置面板还开着，先关掉再重新打开，避免遮罩挡住标题栏按钮
if ((await page.locator('.settings-body').count()) > 0) {
  await click(page.getByRole('button', { name: '取消', exact: true }));
  await page.waitForTimeout(400);
}
await click(page.locator('.titlebar-settings'));
await waitFor(async () => (await page.locator('.settings-body').count()) > 0, '设置面板');
await click(page.getByRole('tab', { name: '编辑器' }));
await page.waitForTimeout(300);
const groupTitles = await page.locator('.settings-group-title').allInnerTexts();
ok(
  ['字体', '显示', '缩进'].every((title) => groupTitles.some((text) => text.includes(title))),
  '包含字体、显示、缩进三组',
);

console.log('6. 字号与行距滑块');
const fontItem = page.locator('.settings-item').filter({ hasText: '字号' }).first();
await fontItem.locator('input[type="range"]').fill('20');
await page.waitForTimeout(200);
ok((await fontItem.locator('em').innerText()).trim() === '20px', '字号滑块显示 20px');

const lineItem = page.locator('.settings-item').filter({ hasText: '行距' }).first();
await lineItem.locator('input[type="range"]').fill('2');
await page.waitForTimeout(200);
const lineLabel = await lineItem.locator('em').innerText();
ok(lineLabel.includes('2.00'), '行距显示两位小数，实际 ' + lineLabel);
ok(lineLabel.includes('40.0px'), '括号内显示折算像素，实际 ' + lineLabel);

console.log('7. 保存后编辑器外观生效');
await click(page.getByRole('button', { name: '保存', exact: true }));
await page.waitForTimeout(900);
const applied = await page.evaluate(() => {
  const editor = document.querySelector('.cm-editor');
  const scroller = document.querySelector('.cm-scroller');
  return editor && scroller
    ? { fontSize: getComputedStyle(editor).fontSize, lineHeight: getComputedStyle(scroller).lineHeight }
    : null;
});
ok(applied !== null, '编辑器仍在页面上');
ok(applied.fontSize === '20px', '编辑器字号变为 20px，实际 ' + (applied && applied.fontSize));
ok(applied.lineHeight === '40px', '编辑器行高变为 40px，实际 ' + (applied && applied.lineHeight));

console.log('8. 显示开关生效');
await click(page.locator('.titlebar-settings'));
await waitFor(async () => (await page.locator('.settings-body').count()) > 0, '设置面板');
await click(page.getByRole('tab', { name: '编辑器' }));
await page.waitForTimeout(300);
await click(page.locator('.settings-item').filter({ hasText: '显示行号' }).locator('.settings-switch'));
await page.waitForTimeout(300);
await click(page.getByRole('button', { name: '保存', exact: true }));
await page.waitForTimeout(900);
ok(
  (await page.evaluate(() => Boolean(document.querySelector('.cm-gutters')))) === false,
  '关闭后行号槽消失',
);

console.log('9. 常规页签暂时隐藏');
await click(page.locator('.titlebar-settings'));
await waitFor(async () => (await page.locator('.settings-body').count()) > 0, '设置面板');
const tabsNow = await page.locator('.settings-tab').allInnerTexts();
ok(tabsNow[0].includes('关于'), '关于仍是第一个页签');
ok(!tabsNow.some((text) => text.includes('常规')), '常规页签未显示（开机启动尚未真机验证）');
ok(tabsNow.length === 4, '设置面板回到四个页签，实际 ' + tabsNow.length);

console.log(`\n全部通过：${passed} 项`);
await app.close();

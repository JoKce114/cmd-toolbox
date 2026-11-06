// 选区必须在深色 / 浅色两套主题下都看得见，包括「当前行」上的选区。
// 历史坑一：自定义主题的选区规则优先级不够，被 CodeMirror 基础主题的
//   `.ͼ1.cm-focused > .cm-scroller > .cm-selectionLayer ...` 压住，
//   深色下落到 #233，和 #1e1e1e 背景几乎同色，表现成「选了但看不见」。
// 历史坑二：当前行底色写死成不透明色，把 z-index -2 的选区层整个盖住。
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'sel-data-'));
const repo = mkdtempSync(join(tmpdir(), 'sel-repo-'));
writeFileSync(
  join(repo, 'demo.js'),
  ['function alpha(value) {', '  return value + 1;', '}', '', 'const beta = alpha(2);', ''].join(
    '\n',
  ),
);

let passed = 0;
const ok = (cond, message) => {
  if (!cond) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
};

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
page.on('pageerror', (error) => console.log('[pageerror]', error.message));
await page.waitForLoadState('domcontentloaded');
await page.locator('.app').waitFor({ timeout: 30000 });
await page.waitForTimeout(1200);
await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0];
  win?.show();
  win?.focus();
  win?.setContentSize(1380, 880);
});

const click = async (locator) => {
  for (let index = 0; index < 40; index += 1) {
    try {
      await locator.click({ timeout: 2500, force: true });
      return;
    } catch {
      const box = await locator.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return;
      }
      await page.waitForTimeout(250);
    }
  }
  throw new Error('click failed');
};

const setTheme = async (mode) => {
  await page.evaluate((next) => {
    localStorage.setItem('cmd-toolbox.terminal-theme', next);
  }, mode);
  await page.reload();
  await page.locator('.app').waitFor({ timeout: 30000 });
  await page.waitForTimeout(1200);
};

const openEditor = async () => {
  if ((await page.locator('.editor-pane').count()) === 0) {
    await page.locator('.group-item').filter({ hasText: 'sel-proj' }).click({ button: 'right' });
    await page.locator('.popup-menu').waitFor({ timeout: 8000 });
    await click(page.getByRole('menuitem', { name: '打开编辑器', exact: true }));
    await page.waitForTimeout(1000);
  }
  const row = page
    .locator('.editor-pane:not(.is-hidden) .file-row')
    .filter({ hasText: 'demo.js' })
    .first();
  await row.waitFor({ timeout: 15000 });
  await click(row);
  await page.waitForTimeout(1200);
};

const selectionPaint = () =>
  page.evaluate(() => ({
    boxes: [...document.querySelectorAll('.cm-selectionBackground')].map((box) => {
      const rect = box.getBoundingClientRect();
      return {
        background: getComputedStyle(box).backgroundColor,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }),
    activeLines: [...document.querySelectorAll('.cm-line.cm-activeLine')].map(
      (line) => getComputedStyle(line).backgroundColor,
    ),
  }));

const dragSelect = async () => {
  const first = await page.locator('.cm-line').nth(0).boundingBox();
  const second = await page.locator('.cm-line').nth(1).boundingBox();
  await page.mouse.move(first.x + 30, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + 200, second.y + second.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
};

const columnSelect = async () => {
  const first = await page.locator('.cm-line').nth(0).boundingBox();
  const second = await page.locator('.cm-line').nth(1).boundingBox();
  await page.mouse.move(first.x + 40, first.y + first.height / 2);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(second.x + 200, second.y + second.height / 2, { steps: 10 });
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(300);
};

// 当前行底色必须带透明度，否则压在选区层（z-index -2）上会把选区盖没
const assertTranslucent = (colors, label) => {
  ok(colors.length > 0, `${label}：选区所在行有当前行高亮`);
  for (const color of colors) {
    ok(/^rgba\(.+,\s*0?\.\d+\)$/.test(color), `${label}：当前行底色半透明（${color}）`);
  }
};

console.log('1. 深色主题下左键拖选');
await setTheme('dark');
await click(page.locator('.add-project-btn'));
await page.locator('.modal-card').waitFor({ timeout: 15000 });
await page.locator('#project-path').fill(repo);
await page.locator('#project-name').fill('sel-proj');
await click(page.getByRole('button', { name: '保存项目', exact: true }));
await page.locator('.modal-card').waitFor({ state: 'detached', timeout: 15000 });
await page.waitForTimeout(800);
await openEditor();
await dragSelect();
let paint = await selectionPaint();
ok(paint.boxes.length > 0, '深色：画出了选区矩形');
ok(
  paint.boxes.every((box) => box.background === 'rgb(38, 79, 120)'),
  `深色：选区底色是 #264f78，实际 ${paint.boxes.map((box) => box.background).join(' / ')}`,
);
ok(
  paint.boxes.every((box) => box.width > 0 && box.height > 0),
  '深色：选区矩形有实际尺寸',
);
assertTranslucent(paint.activeLines, '深色');

console.log('2. 深色主题下中键列选择');
await columnSelect();
paint = await selectionPaint();
ok(paint.boxes.length >= 2, `深色：列选择每行各一块选区（${paint.boxes.length} 块）`);
ok(
  paint.boxes.every((box) => box.background === 'rgb(38, 79, 120)'),
  '深色：列选择用的也是同一套选区底色',
);
assertTranslucent(paint.activeLines, '深色列选择');

console.log('3. 浅色主题下左键拖选');
await setTheme('light');
await openEditor();
await dragSelect();
paint = await selectionPaint();
ok(paint.boxes.length > 0, '浅色：画出了选区矩形');
ok(
  paint.boxes.every((box) => box.background === 'rgb(173, 214, 255)'),
  `浅色：选区底色是 #add6ff，实际 ${paint.boxes.map((box) => box.background).join(' / ')}`,
);
assertTranslucent(paint.activeLines, '浅色');

console.log('4. 失焦后选区仍可见');
await page.evaluate(() => {
  document.activeElement?.blur();
});
await page.waitForTimeout(300);
paint = await selectionPaint();
ok(
  paint.boxes.length > 0 &&
    paint.boxes.every((box) => box.background === 'rgb(229, 235, 241)'),
  `失焦：选区换成浅一档的 #e5ebf1，不会消失（实际 ${paint.boxes.map((box) => box.background).join(' / ')}）`,
);

await app.close();
console.log(`\n全部通过：${passed} 项`);

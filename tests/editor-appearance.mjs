import { _electron as electron } from 'playwright-core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'appear-'));
const repo = mkdtempSync(join(tmpdir(), 'appear-repo-'));
writeFileSync(join(repo, 'demo.js'), 'function demo(value) {\n  return value;\n}\n');

let passed = 0;
const ok = (cond, msg) => {
  if (!cond) throw new Error('断言失败：' + msg);
  passed += 1;
  console.log('  ok  ' + msg);
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
  w?.setContentSize(1380, 880);
});
await page.waitForLoadState('domcontentloaded');
await page.locator('.app').waitFor({ timeout: 30000 });
await page.waitForTimeout(1200);

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

const seedPrefs = async (patch) => {
  await page.evaluate((next) => {
    localStorage.setItem('cmd-toolbox.prefs', JSON.stringify(next));
  }, patch);
  await page.reload();
  await page.locator('.app').waitFor({ timeout: 30000 });
  await page.waitForTimeout(1000);
};

const addProjectOnce = async () => {
  await click(page.locator('.add-project-btn'));
  await page.locator('.modal-card').waitFor({ timeout: 15000 });
  await page.locator('#project-path').fill(repo);
  await page.locator('#project-name').fill('appear-proj');
  await click(page.getByRole('button', { name: '保存项目', exact: true }));
  await page.locator('.modal-card').waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(800);
};

// 项目存在主进程的 store 里，reload 不会丢；编辑器页签也会被恢复，
// 所以只有确实没有编辑器页签时才重新打开，避免叠加出多个页签。
const openEditor = async () => {
  await page.waitForTimeout(500);
  if ((await page.locator('.editor-pane').count()) === 0) {
    await page.locator('.group-item').filter({ hasText: 'appear-proj' }).click({ button: 'right' });
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
  await page.waitForTimeout(1500);
};

const readStyle = () =>
  page.evaluate(() => {
    const editor = document.querySelector('.cm-editor');
    const scroller = document.querySelector('.cm-scroller');
    if (!editor || !scroller) return null;
    const es = getComputedStyle(editor);
    const ss = getComputedStyle(scroller);
    return {
      fontSize: es.fontSize,
      lineHeight: ss.lineHeight,
      fontFamily: ss.fontFamily,
      gutters: Boolean(document.querySelector('.cm-gutters')),
      whitespace: Boolean(document.querySelector('.cm-highlightSpace')),
      matching: Boolean(document.querySelector('.cm-matchingBracket')),
      activeLine: document.querySelectorAll('.cm-activeLine').length,
      styles: document.querySelectorAll('style').length,
      // Chromium 下 style-mod 用 adoptedStyleSheets 挂载，新的 StyleModule
      // 会往同一个 sheet 里 insertRule 且永不回收，所以累的是规则条数，
      // 不是 <style> 元素个数（没有 adoptedStyleSheets 时退回到 <style>）。
      styleRules: (() => {
        const count = (sheet) => {
          try {
            return sheet ? sheet.cssRules.length : 0;
          } catch {
            return 0;
          }
        };
        const adopted = Array.from(document.adoptedStyleSheets || []).reduce(
          (total, sheet) => total + count(sheet),
          0,
        );
        const inline = Array.from(document.querySelectorAll('style')).reduce(
          (total, element) => total + count(element.sheet),
          0,
        );
        return adopted + inline;
      })(),
    };
  });

console.log('1. 字号、行距、字体生效');
await seedPrefs({
  editorFontSize: 20,
  editorLineHeight: 2,
  editorFontFamily: 'lucida',
});
await addProjectOnce();
await openEditor();
let style = await readStyle();
ok(style !== null, '编辑器已挂载');
ok(style.fontSize === '20px', '字号为 20px，实际 ' + style.fontSize);
ok(style.lineHeight === '40px', '行距 2 × 20px = 40px，实际 ' + style.lineHeight);
ok(style.fontFamily.includes('Lucida Console'), '字体为 Lucida Console，实际 ' + style.fontFamily);

console.log('2. 关闭行号');
await seedPrefs({ editorLineNumbers: false });
await openEditor();
style = await readStyle();
ok(style.gutters === false, '行号槽消失');

console.log('3. 高亮当前行开关');
await seedPrefs({ editorHighlightActiveLine: false });
await openEditor();
style = await readStyle();
ok(style.activeLine === 0, '关闭时没有当前行高亮，实际 ' + style.activeLine);

await seedPrefs({ editorHighlightActiveLine: true });
await openEditor();
await click(page.locator('.cm-content'));
await page.waitForTimeout(400);
style = await readStyle();
ok(style.activeLine >= 1, '开启时当前行有高亮，实际 ' + style.activeLine);

console.log('4. 显示空白字符');
await seedPrefs({ editorShowWhitespace: true });
await openEditor();
style = await readStyle();
ok(style.whitespace === true, '空白字符标记出现');

console.log('5. 括号匹配开关');
await seedPrefs({ editorBracketMatching: false });
await openEditor();
await click(page.locator('.cm-content'));
await page.keyboard.press('Control+Home');
for (let i = 0; i < 14; i += 1) await page.keyboard.press('ArrowRight');
await page.waitForTimeout(600);
style = await readStyle();
ok(style.matching === false, '关闭时没有括号匹配高亮');

await seedPrefs({ editorBracketMatching: true });
await openEditor();
await click(page.locator('.cm-content'));
await page.keyboard.press('Control+Home');
for (let i = 0; i < 14; i += 1) await page.keyboard.press('ArrowRight');
await waitFor(
  async () => (await readStyle()).matching === true,
  '光标在左括号后应出现匹配高亮',
);
ok(true, '开启时括号匹配高亮出现');

console.log('6. Ctrl+滚轮调整字号且阻止默认行为');
await seedPrefs({ editorFontSize: 13 });
await openEditor();
const before = (await readStyle()).fontSize;
// 合成的 WheelEvent 不会触发 Chromium 的默认缩放，所以只能断言
// dispatchEvent 的返回值：false 表示处理器调用了 preventDefault。
// 这是阻止页面缩放的唯一手段，但无法证明浏览器「本来会缩放」。
const defaultPrevented = await page.evaluate(() => {
  const target = document.querySelector('.cm-content');
  const event = new WheelEvent('wheel', {
    deltaY: -120,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  const notCancelled = target.dispatchEvent(event);
  return !notCancelled;
});
await page.waitForTimeout(600);
const after = (await readStyle()).fontSize;
ok(before === '13px', '缩放前 13px，实际 ' + before);
ok(after === '14px', '缩放后 14px，实际 ' + after);
ok(defaultPrevented === true, 'Ctrl+滚轮阻止了默认行为（页面不会缩放）');

// 触控板横向手势 deltaY 为 0：同样要拦下默认行为，但不能改字号
const horizontalPrevented = await page.evaluate(() => {
  const target = document.querySelector('.cm-content');
  const event = new WheelEvent('wheel', {
    deltaY: 0,
    deltaX: 120,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  const notCancelled = target.dispatchEvent(event);
  return !notCancelled;
});
await page.waitForTimeout(400);
ok(horizontalPrevented === true, '横向 Ctrl+滚轮同样阻止默认行为');
ok((await readStyle()).fontSize === '14px', '横向 Ctrl+滚轮不改字号');

console.log('7. 连续 Ctrl+滚轮不会累积样式规则（StyleModule 泄漏）');
// 每次重配外观时若都新建 EditorView.theme，style-mod 会把新的规则永久插进
// 文档的样式表；Ctrl+滚轮是这条路的热路径。字号在 13/14 之间来回，
// 每个刻度都是真实的状态变更，20 步后样式规则数与 <style> 数量都必须不变。
await seedPrefs({ editorFontSize: 13 });
await openEditor();
const beforeTick = await readStyle();
const styleRules = [];
const styleTags = [];
for (let i = 0; i < 20; i += 1) {
  await page.evaluate((deltaY) => {
    document.querySelector('.cm-content').dispatchEvent(
      new WheelEvent('wheel', { deltaY, ctrlKey: true, bubbles: true, cancelable: true }),
    );
  }, i % 2 === 0 ? -120 : 120);
  await page.waitForTimeout(80);
  const current = await readStyle();
  styleRules.push(current.styleRules);
  styleTags.push(current.styles);
}
const afterTick = await readStyle();
ok(
  styleRules.every((count) => count === beforeTick.styleRules),
  `20 次缩放过程中样式规则数始终为 ${beforeTick.styleRules}，实际 ${styleRules.join(',')}`,
);
ok(
  styleTags.every((count) => count === beforeTick.styles),
  `20 次缩放过程中 <style> 数量始终为 ${beforeTick.styles}，实际 ${styleTags.join(',')}`,
);
ok(afterTick.styleRules === beforeTick.styleRules,
  `缩放结束后规则数仍为 ${beforeTick.styleRules}，实际 ${afterTick.styleRules}`);
ok(afterTick.fontSize === '13px', '来回缩放后字号回到 13px');

console.log(`\n全部通过：${passed} 项`);
await app.close();

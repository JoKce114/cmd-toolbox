// 编辑器 Ctrl+点击符号：弹简介卡片、跳转到定义、模块关闭后不弹。
// 需要独占 17382 端口，跑之前先关掉正在运行的 Cmd Toolbox。
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-goto-'));
const projectDir = mkdtempSync(join(tmpdir(), 'cmdtb-goto-proj-'));

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const NL = '\n';
mkdirSync(join(projectDir, 'app'), { recursive: true });
writeFileSync(
  join(projectDir, 'app', 'target.php'),
  [
    '<?php',
    'namespace App;',
    '',
    'class HelpsVisualV2 {',
    '  /**',
    '   * 去读输出对应的h标签html',
    '   *',
    '   * @param string $Name',
    '   * @param array $options',
    '   * @return string',
    '   */',
    '  public static function echoListHTags($Name, $options = []) {',
    '    return $Name;',
    '  }',
    '}',
  ].join(NL),
  'utf8',
);
writeFileSync(
  join(projectDir, 'app', 'caller.php'),
  ['<?php', 'namespace App;', '$x = HelpsVisualV2::echoListHTags("a");', 'foreach ($items as $item) {', '  echo $item;', '}'].join(NL),
  'utf8',
);
// 同名多候选：两个文件各有一个 sharedMethod
writeFileSync(
  join(projectDir, 'app', 'first.php'),
  ['<?php', 'namespace App;', 'class First {', '  public function sharedMethod() {}', '}'].join(NL),
  'utf8',
);
writeFileSync(
  join(projectDir, 'app', 'second.php'),
  ['<?php', 'namespace App;', 'class Second {', '  public function sharedMethod() {}', '}'].join(NL),
  'utf8',
);
// PHP 变量：只在当前文件里找赋值行
writeFileSync(
  join(projectDir, 'app', 'vars.php'),
  [
    '<?php',
    '$amazonImage = $_GET["img"];',
    '$extName = HelpsFile::getExtName($amazonImage);',
    'echo $extName;',
  ].join(NL),
  'utf8',
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.CMDTOOLBOX_NO_UPDATE = '1';

let app;
try {
  app = await electron.launch({
    executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
    cwd: root,
    args: ['.', `--data-dir=${dataDir}`],
    env,
  });

  const page = await app.firstWindow();
  page.on('pageerror', (error) => console.log('  [pageerror]', error.message));
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.app').waitFor();
  await page.waitForTimeout(1000);

  // 窗口被遮挡时 Chromium 不投递合成的鼠标事件，确保置前
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.show();
    win?.focus();
    win?.moveTop();
  });

  await page.locator('.add-project-btn').click();
  await page.locator('.modal-card').waitFor();
  await page.locator('#project-path').fill(projectDir);
  await page.locator('#project-name').fill('goto-proj');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await page.waitForTimeout(400);
  await page.locator('.group-item').filter({ hasText: 'goto-proj' }).locator('.group-main').click();
  await page.waitForTimeout(600);
  await page
    .locator('.group-item')
    .filter({ hasText: 'goto-proj' })
    .click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  await page.getByRole('menuitem', { name: '打开编辑器', exact: true }).click();
  await page.locator('.editor-pane').waitFor();

  console.log('1. Ctrl+点击方法名弹出简介卡片');
  await openFile(page, 'app/caller.php');
  // 第 3 行（0 起为 2）：$x = HelpsVisualV2::echoListHTags("a");
  await ctrlClickWord(page, 2, 'echoListHTags');
  const card = page.locator('.symbol-card');
  await card.waitFor({ timeout: 10000 });
  // 卡片先以「正在查找定义…」出现，等签名渲染完再读内容，否则会偶发读到加载态
  await card.locator('.symbol-card-signature').waitFor({ timeout: 10000 });
  const cardText = await card.innerText();
  assert(cardText.includes('target.php:12'), '卡片标出定义所在的文件与行号');
  assert(cardText.includes('@param string $Name'), '卡片显示 @param');
  assert(cardText.includes('@return string'), '卡片显示 @return');
  assert(cardText.includes('public static function echoListHTags'), '卡片显示完整签名');

  console.log('2. 点「跳到定义」打开目标文件并定位');
  await card.getByRole('button', { name: /跳到定义/ }).click();
  // 等到面板标题真的切到目标文件，代替固定 sleep
  await waitFor(
    async () => (await currentPanePath(page)).endsWith('target.php'),
    10000,
    '编辑器切到 target.php',
  );
  const header = await currentPanePath(page);
  assert(header.endsWith('target.php'), `切到了定义所在文件，实际 ${header}`);
  // 内容载入后光标才会被移到声明行
  await waitFor(
    async () =>
      (await page.locator('.cm-content').first().innerText()).includes('public static function echoListHTags'),
    10000,
    'target.php 内容载入',
  );
  // 方法声明在第 12 行（1 起），CodeMirror 里是 0 起的 11
  await waitFor(async () => (await activeLineIndex(page)) === 11, 5000, '光标定位到第 12 行').catch(
    () => {},
  );
  const activeLine = await activeLineIndex(page);
  assert(activeLine === 11, `光标停在第 12 行（0 起 11），实际 ${activeLine}`);

  console.log('3. 同名多候选时列出全部');
  await openFile(page, 'app/first.php');
  await ctrlClickWord(page, 3, 'sharedMethod');
  const listCard = page.locator('.symbol-card');
  await listCard.waitFor({ timeout: 10000 });
  const items = listCard.locator('.symbol-card-item');
  await items.first().waitFor({ timeout: 5000 });
  const itemCount = await items.count();
  assert(itemCount === 2, `列出两个候选，实际 ${itemCount}`);
  // 当前文件 first.php 排第一，第二项就是 second.php
  await items.nth(1).click();
  await waitFor(
    async () => (await currentPanePath(page)).endsWith('second.php'),
    10000,
    '编辑器切到 second.php',
  );
  const second = await currentPanePath(page);
  assert(second.endsWith('second.php'), `点了第二项跳到第二个文件，实际 ${second}`);

  console.log('4. 模块关闭后不弹卡片');
  // 正向对照：先在模块开启时做同样的点击，证明落点有效。
  // 没有这一步时，「卡片数为 0」也可能是点空了造成的假通过。
  await openFile(page, 'app/caller.php');
  await ctrlClickWord(page, 2, 'echoListHTags');
  const controlCard = page.locator('.symbol-card');
  await controlCard.waitFor({ timeout: 10000 });
  assert((await controlCard.count()) === 1, '关闭模块前同样点击能弹出卡片（证明落点有效）');
  // 关掉卡片，避免旧的卡片残留让后面的否定断言失去意义
  await controlCard.locator('.symbol-card-close').click();
  await controlCard.waitFor({ state: 'detached', timeout: 5000 });

  await setReferenceModule(page, false);
  await ctrlClickWord(page, 2, 'echoListHTags');
  // 否定判断没法「等条件成立」，只能等一段足够长的时间确认没有卡片冒出来：
  // 1.5 秒远大于模块开启时卡片出现的耗时，慢机器上也够用。
  await page.waitForTimeout(1500);
  const cardCount = await page.locator('.symbol-card').count();
  assert(cardCount === 0, `关闭模块后 Ctrl+点击不弹卡片，实际 ${cardCount} 个`);

  // 恢复开关，避免这个用例留下「模块关闭」的状态影响后续运行
  await setReferenceModule(page, true);

  console.log('5. PHP 变量跳到赋值行且不白屏');
  // 回归：跳转按钮的点击发生在 CodeMirror 自身的更新循环里，同步 dispatch
  // 会抛「update in progress」，React 19 没有 ErrorBoundary 时整棵树被卸载，
  // 表现为整个窗口白屏。这里断言跳转后界面还在。
  await openFile(page, 'app/vars.php');
  await ctrlClickWord(page, 2, '$extName');
  const varCard = page.locator('.symbol-card');
  await varCard.waitFor({ timeout: 10000 });
  const varText = await varCard.innerText();
  assert(varText.includes('$extName = HelpsFile::getExtName'), '卡片显示赋值行原文');
  await varCard.locator('.symbol-card-jump').click();
  await page.waitForTimeout(1200);

  assert((await page.locator('.app').count()) === 1, '跳转后界面没有白屏');
  const varActiveLine = await page.evaluate(() => {
    const lines = [...document.querySelectorAll('.cm-line')];
    return lines.findIndex((el) => el.classList.contains('cm-activeLine'));
  });
  assert(varActiveLine === 2, `光标落在赋值行（0 起 2），实际 ${varActiveLine}`);
  assert((await page.locator('.symbol-card').count()) === 0, '跳转后卡片自动关闭');
} finally {
  // app.close() 自己可能抛错，不能让它跳过后面的清理和端口检查
  await app?.close().catch(() => {});
  for (const dir of [dataDir, projectDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.log(`  [cleanup] 临时目录清理失败：${error.message}`);
    }
  }
  // 残留 electron 会占着 17382 让下一次运行起不来，跑完明确报出端口状态
  const released = await waitForPortRelease(17382, 5000);
  console.log(
    released
      ? '17382 端口已释放，无残留 electron 进程'
      : '警告：17382 端口仍被占用，可能有残留 electron 进程',
  );
}

console.log(`\n全部通过：${passed} 项`);

async function currentPanePath(page) {
  return page.locator('.editor-pane .pane-path').first().innerText();
}

// 打开文件树里的文件。夹具放在 app/ 子目录，先逐层展开沿途目录。
// 目录行和文件行都用 title=relPath（FileTree.tsx），比按文字匹配稳。
async function openFile(page, relPath) {
  const parts = relPath.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join('/');
    const anyChild = page.locator(`.file-row[title^="${dir}/"]`).first();
    if ((await anyChild.count()) > 0) continue;
    const dirRow = page.locator(`.file-row[title="${dir}"]`).first();
    await dirRow.waitFor({ timeout: 10000 });
    await dirRow.click();
  }
  const entry = page.locator(`.file-row[title="${relPath}"]`).first();
  await entry.waitFor({ timeout: 10000 });
  await entry.click();
  // 等面板标题切到目标文件、且正文已经载入。固定 sleep 在慢机器上不够、
  // 快机器上又白等；.cm-content 可能在切换前就命中旧编辑器，不能单独依赖。
  await waitFor(
    async () => {
      const path = await currentPanePath(page).catch(() => '');
      if (!path.endsWith(relPath)) return false;
      const text = await page.locator('.cm-content').first().innerText().catch(() => '');
      return text.trim().length > 0;
    },
    10000,
    `编辑器载入 ${relPath}`,
  );
}

// 通过设置面板切换「PHP 跳转与简介」。保存后才生效。
async function setReferenceModule(page, enabled) {
  await page.locator('.titlebar-settings').click();
  await page.locator('.settings-body').waitFor({ timeout: 10000 });
  await page.getByRole('tab', { name: '模块', exact: true }).click();
  const row = page.locator('.settings-item').filter({ hasText: 'PHP 跳转与简介' });
  await row.waitFor({ timeout: 8000 });
  const toggle = row.getByRole('switch');
  if ((await toggle.getAttribute('aria-checked')) !== String(enabled)) {
    await toggle.click();
  }
  await page
    .locator('.modal-footer')
    .getByRole('button', { name: '保存', exact: true })
    .click();
  await page.locator('.settings-body').waitFor({ state: 'detached', timeout: 10000 });
  // 保存后 prefs 才通过 IPC 落到编辑器；给重配留一点时间再继续点击
  await page.waitForTimeout(300);
}

// Ctrl+点击第 lineIndex 行（0 起）里的 word。
// 列号手算太容易错：先用 TreeWalker 把「行内字符序号」映射到真实文本节点，
// 取该字符的 client rect，再按坐标点击。实现在 DOM 里查得到就一定能点中。
async function ctrlClickWord(page, lineIndex, word, occurrence = 0) {
  const point = await page.evaluate(
    ({ lineIndex, word, occurrence }) => {
      const content = document.querySelector('.cm-content');
      if (!content) return { error: '找不到 .cm-content' };
      const lines = [...content.querySelectorAll('.cm-line')];
      const target = lines[lineIndex];
      if (!target) return { error: `没有第 ${lineIndex} 行，共 ${lines.length} 行` };

      const text = target.textContent || '';
      let index = -1;
      let seen = 0;
      for (let i = 0; i + word.length <= text.length; i += 1) {
        if (!text.startsWith(word, i)) continue;
        if (seen === occurrence) {
          index = i;
          break;
        }
        seen += 1;
      }
      if (index < 0) {
        return { error: `第 ${lineIndex} 行 ${JSON.stringify(text)} 里找不到「${word}」` };
      }

      // 字符序号 → 文本节点 + 节点内偏移
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
      let consumed = 0;
      let node = walker.nextNode();
      while (node) {
        const length = node.textContent.length;
        if (consumed + length > index) break;
        consumed += length;
        node = walker.nextNode();
      }
      if (!node) return { error: '定位不到目标文本节点' };

      // 只选中一个字符，矩形最稳定（整词跨节点/折行时不会有歧义）
      const local = index - consumed;
      const range = document.createRange();
      range.setStart(node, local);
      range.setEnd(node, Math.min(local + 1, node.textContent.length));
      const rect = range.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) {
        return { error: '目标字符的矩形为空' };
      }
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    },
    { lineIndex, word, occurrence },
  );
  if (point.error) throw new Error(point.error);

  await page.mouse.move(point.x, point.y);
  await page.keyboard.down('Control');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Control');
}

// 当前激活的编辑器里 .cm-activeLine 所在的行号（0 起）
async function activeLineIndex(page) {
  return page.evaluate(() => {
    const content = document.querySelector('.cm-content');
    if (!content) return -1;
    const lines = [...content.querySelectorAll('.cm-line')];
    return lines.findIndex((item) => item.classList.contains('cm-activeLine'));
  });
}

// 轮询到条件成立或超时。predicate 可以是异步的（要读 Playwright 的 DOM）。
async function waitFor(predicate, timeout, label) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeout) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${label}${lastError ? `（${lastError.message}）` : ''}`);
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.setTimeout(1000);
  });
}

async function waitForPortRelease(port, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (!(await isPortInUse(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

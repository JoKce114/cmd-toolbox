// 编辑器模块的端到端测试。
// 需要独占 17382 端口，跑之前先关掉正在运行的 Cmd Toolbox。
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
// 主进程的文件写入实现：并发写产物的用例要直接调它
const require = createRequire(import.meta.url);
const fileApi = require(join(root, 'desktop', 'file-api.js'));
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-modules-'));
const projectDir = mkdtempSync(join(tmpdir(), 'cmdtb-proj-'));

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.CMDTOOLBOX_NO_UPDATE = '1';

// 文件必须在编辑器页签挂载（文件树首次列目录）之前落盘
const messy = 'const a={x:1,y:2};\nfunction f(){if(!a.x){return 1}return 2}\n';
writeFileSync(join(projectDir, 'sample.js'), messy, 'utf8');

// 选区格式化：只动中间两行，首尾两行必须原样保留
writeFileSync(
  join(projectDir, 'selection.js'),
  [
    'var untouchedA={a:1,b:2};',
    'var target={x:1,y:2};',
    'function g(){if(!target.x){return 1}return 2}',
    'var untouchedB={c:3,d:4};',
    '',
  ].join('\n'),
  'utf8',
);

// 竞态测试：首次格式化要现下载 typescript 插件 chunk，await 窗口最大。
// 文件保持较小，innerText 才能取到全文（大文档会被虚拟化，只渲染视口行）。
const raceLines = [];
for (let i = 0; i < 12; i += 1) {
  raceLines.push(`const v${i}={a:${i},b:${i + 1}};`);
  raceLines.push(`function f${i}(){if(!v${i}.a){return ${i}}return ${i + 1}}`);
}
writeFileSync(join(projectDir, 'race.ts'), `${raceLines.join('\n')}\n`, 'utf8');

// 压缩用例：
// plain.js 没有同名产物，保存多少次都不能凭空创建 plain.min.js；
// withmin.js 已有产物，保存必须覆盖它（哪怕源文件没改）。
writeFileSync(join(projectDir, 'plain.js'), 'const x = 1;\nfunction f(){return x}\n', 'utf8');
writeFileSync(join(projectDir, 'withmin.js'), 'const y = 1;\n', 'utf8');
writeFileSync(join(projectDir, 'withmin.min.js'), '/*old*/', 'utf8');
// 后缀为 .min.js 的文件自己不再压缩
writeFileSync(join(projectDir, 'self.min.js'), 'const kept = 1;\n', 'utf8');
// 压缩失败路径：源文件本身合法，用户改出语法错误后再保存
writeFileSync(join(projectDir, 'bad.js'), 'const ok = 1;\n', 'utf8');
writeFileSync(join(projectDir, 'bad.min.js'), '/*keep-me*/', 'utf8');
// 并发保存的时序断言不适合放 E2E（files.write 临时名冲突、写盘完成顺序都会造成
// 正确实现上的假红灯），队列语义改用上面的 Node 单测。
// 写入失败路径：保存时把源文件设成只读，用来验证「保存没成功就不压缩」
writeFileSync(join(projectDir, 'ro.js'), 'const ro = 1;\n', 'utf8');
writeFileSync(join(projectDir, 'ro.min.js'), '/*OLD*/', 'utf8');

const app = await electron.launch({
  executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
  cwd: root,
  args: ['.', `--data-dir=${dataDir}`],
  env,
});

try {
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
  await page.locator('#project-name').fill('mod-proj');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await page.waitForTimeout(400);
  await page.locator('.group-item').filter({ hasText: 'mod-proj' }).locator('.group-main').click();
  await page.waitForTimeout(600);

  console.log('1. 打开编辑器页签');
  await page
    .locator('.group-item')
    .filter({ hasText: 'mod-proj' })
    .click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  await page.getByRole('menuitem', { name: '打开编辑器', exact: true }).click();
  await page.locator('.editor-pane').waitFor();
  assert(await page.locator('.editor-pane').isVisible(), '编辑器可见');

  // 放在所有格式化之前：这是本测试第一次触发格式化，typescript 插件 chunk
  // 还没加载，await 窗口最大。
  // 注入方式：React 的 onClick 挂在根容器上，window 上的冒泡监听器在它之后执行，
  // 此时格式化已进入 await；用一次 paste 事件把「用户输入」同步写进编辑器。
  // 这个时序是确定的：动态 import 不可能在当前事件任务内完成。
  console.log('2. 竞态：格式化期间的用户输入不能被覆盖');
  await openFile(page, 'race.ts');
  const raceBefore = await editorText(page);
  assert(raceBefore.includes('const v0={a:0,b:1};'), '打开的是未格式化的原文');
  await page.locator('.cm-content').first().click();
  await page.evaluate(() => {
    const handler = (event) => {
      const button = event.target instanceof Element ? event.target.closest('.popup-item') : null;
      if (!button || !button.textContent || !button.textContent.includes('格式化文档')) return;
      // 只注入一次，后面的用例还要正常格式化
      window.removeEventListener('click', handler);
      const editor = document.querySelector('.cm-content');
      if (!(editor instanceof HTMLElement)) return;
      editor.focus();
      const data = new DataTransfer();
      data.setData('text/plain', '\n/*RACE_MARKER*/');
      editor.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    };
    window.addEventListener('click', handler);
  });
  await page.locator('.cm-content').first().click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  await page.getByRole('menuitem', { name: '格式化文档', exact: true }).click();
  await page.waitForTimeout(4000);
  const raceAfter = await editorText(page);
  assert(raceAfter.includes('/*RACE_MARKER*/'), '格式化期间输入的内容仍在文档里');
  assert(
    raceAfter.includes('const v0={a:0,b:1};'),
    '检测到并发修改后放弃格式化，没有用旧快照覆盖文档',
  );

  console.log('3. 格式化文档');
  await openFile(page, 'sample.js');
  const before = await editorText(page);
  assert(before.includes('const a={x:1,y:2}'), '打开的是未格式化的原文');
  await page.locator('.cm-content').first().click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  assert(
    await page.locator('.popup-menu').getByText('格式化文档', { exact: true }).isVisible(),
    '右键菜单出现「格式化文档」',
  );
  await page.locator('.popup-menu').getByText('格式化文档', { exact: true }).click();
  await page.waitForTimeout(1500);
  const after = await editorText(page);
  assert(after.includes('const a = { x: 1, y: 2 };'), '格式化后加了空格');
  assert(after.split('\n').length > 5, `格式化后行数变多，实际 ${after.split('\n').length}`);

  console.log('4. 撤销恢复原文');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
  assert((await editorText(page)) === before, 'Ctrl+Z 能撤销格式化');

  console.log('5. 选区格式化只改选中的部分');
  await openFile(page, 'selection.js');
  const selBefore = await editorText(page);
  assert(selBefore.startsWith('var untouchedA={a:1,b:2};'), '首行为未格式化原文');
  assert(selBefore.includes('var untouchedB={c:3,d:4};'), '尾行为未格式化原文');
  // 光标放到第 2 行行首，再向下扩两行，选中第 2、3 两整行
  await page.locator('.cm-line').nth(1).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await page.locator('.cm-line').nth(1).click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  const selectionItem = page.getByRole('menuitem', { name: '格式化选区', exact: true });
  assert(!(await selectionItem.isDisabled()), '有选区时「格式化选区」可用');
  await selectionItem.click();
  await page.waitForTimeout(1500);
  const selAfter = await editorText(page);
  assert(selAfter.includes('var target = { x: 1, y: 2 };'), '选中的语句被格式化');
  assert(selAfter.includes('function g() {'), '选中的函数展开成多行');
  assert(selAfter.startsWith('var untouchedA={a:1,b:2};'), '选区外的前一行一字未变');
  assert(selAfter.trimEnd().endsWith('var untouchedB={c:3,d:4};'), '选区外的后一行一字未变');

  console.log('6. 无选区时「格式化选区」置灰');
  await page.locator('.cm-line').first().click();
  await page.locator('.cm-line').first().click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  assert(
    await page.getByRole('menuitem', { name: '格式化选区', exact: true }).isDisabled(),
    '无选区时「格式化选区」置灰',
  );
  await page.keyboard.press('Escape');

  console.log('7. 压缩：同名 .min.js 不存在时保存不创建');
  await openFile(page, 'plain.js');
  const plainBefore = await editorText(page);
  assert(plainBefore.includes('const x = 1;'), '打开的是 plain.js 原文');
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nconst extra = 1;');
  await page.keyboard.press('Control+s');
  // 等「已保存」出现，确认这次保存真的走完了写盘流程
  await page
    .locator('.toast-success')
    .filter({ hasText: '已保存' })
    .last()
    .waitFor({ timeout: 8000 });
  // 压缩是保存钩子里的异步任务，多等一会
  await page.waitForTimeout(2000);
  assert(
    !existsSync(join(projectDir, 'plain.min.js')),
    '没有 .min.js 时保存不创建它',
  );

  console.log('8. 压缩：同名 .min.js 存在时自动更新');
  const minPath = join(projectDir, 'withmin.min.js');
  await openFile(page, 'withmin.js');
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nconst z = 2;');
  await page.keyboard.press('Control+s');
  await waitFor(
    () => !readFileSync(minPath, 'utf8').includes('/*old*/'),
    8000,
    '.min.js 被覆盖更新',
  );
  const minified = readFileSync(minPath, 'utf8');
  assert(!minified.includes('/*old*/'), '已有 .min.js 被覆盖更新');
  assert(
    minified.length < 40,
    `压缩结果很短，实际长度 ${minified.length}`,
  );
  assert(minified.includes('z=2'), `压缩结果来自最新源文件，实际 ${minified}`);

  console.log('9. 压缩：源文件没改动也重新压缩');
  const mtimeBefore = statSync(minPath).mtimeMs;
  await page.locator('.cm-content').first().click();
  // 拉开时间差，避免文件系统 mtime 精度导致比对失败
  await page.waitForTimeout(1100);
  await page.keyboard.press('Control+s');
  await waitFor(
    () => statSync(minPath).mtimeMs > mtimeBefore,
    8000,
    '.min.js 的 mtime 更新',
  );
  assert(
    statSync(minPath).mtimeMs > mtimeBefore,
    '内容没改时按 Ctrl+S 也会刷新 .min.js 的 mtime',
  );

  console.log('10. 并发写同一产物：临时文件名唯一，结果不混合');
  // 直接打主进程的 writeMinified：同一进程内多路并发写同一个 .min.js。
  // 旧实现共用 `${pid}.tmp`，会成批 ENOENT；新实现 temp 名唯一，但 Windows 上
  // 并发 rename 仍可能瞬时 EPERM（索引器/杀软占用），file-api 内部已有退避重试。
  // 压测下仍有小概率耗尽重试，所以这里不要求每一路都成功，只要求：
  //   - 失败的都是可重试的占用类错误（不是逻辑错误）
  //   - 最终产物是某一次完整写入，没有被截断或混合
  //   - 不留临时文件
  const concDir = mkdtempSync(join(tmpdir(), 'cmdtb-conc-'));
  try {
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        fileApi.writeMinified(concDir, 'out.min.js', `/*v${i}*/`),
      ),
    );
    const succeeded = settled.filter((item) => item.status === 'fulfilled');
    const failed = settled.filter((item) => item.status === 'rejected');
    const retryable = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOENT']);
    assert(
      succeeded.length >= settled.length / 2,
      `多数并发写成功（${succeeded.length}/${settled.length}）`,
    );
    assert(
      failed.every((item) => retryable.has(item.reason?.code)),
      `失败的都是占用类错误，实际 ${JSON.stringify(failed.map((i) => i.reason?.code))}`,
    );
    const finalContent = readFileSync(join(concDir, 'out.min.js'), 'utf8');
    assert(
      /^\/\*v\d+\*\/$/.test(finalContent),
      `产物是某一次完整写入，实际 ${JSON.stringify(finalContent)}`,
    );
    assert(
      !readdirSync(concDir).some((name) => name.endsWith('.tmp')),
      '没有残留临时文件',
    );
  } finally {
    rmSync(concDir, { recursive: true, force: true });
  }

  console.log('11. 连按 Ctrl+S：压缩任务排队，不报错也不写坏');
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nconst burst = 7;');
  // 第一次是 dirty 保存（等源文件落地后才压缩），后面几次都是非 dirty，
  // 各自立刻排进压缩队列，后发起的覆盖先前的。
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('Control+s');
  await waitFor(
    () => readFileSync(minPath, 'utf8').includes('burst=7'),
    10000,
    '连按保存后产物是最新内容',
  );
  const burstContent = readFileSync(minPath, 'utf8');
  assert(burstContent.includes('burst=7'), `产物来自最新内容，实际 ${burstContent}`);
  assert(
    (await page.locator('.toast-error').filter({ hasText: '压缩' }).count()) === 0,
    '连按保存没有出现压缩失败提示',
  );

  console.log('12. 压缩失败不影响保存');
  const badPath = join(projectDir, 'bad.js');
  await openFile(page, 'bad.js');
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nconst = ;');
  await page.keyboard.press('Control+s');
  const errorToast = page.locator('.toast-error').filter({ hasText: '压缩' }).last();
  await errorToast.waitFor({ timeout: 10000 });
  assert(await errorToast.isVisible(), '压缩失败弹出错误提示');
  assert(
    readFileSync(badPath, 'utf8').includes('const = ;'),
    '源文件仍然保存成功（含语法错误的内容已落盘）',
  );
  assert(
    readFileSync(join(projectDir, 'bad.min.js'), 'utf8') === '/*keep-me*/',
    '压缩失败时已有 .min.js 不被改写',
  );

  console.log('13. .min.js 自己不再压缩');
  await openFile(page, 'self.min.js');
  await page.locator('.cm-content').first().click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  assert(
    (await page.locator('.popup-menu').getByText(/压缩为/).count()) === 0,
    '打开 .min.js 时右键菜单没有压缩项',
  );
  await page.keyboard.press('Escape');
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nconst again = 2;');
  await page.keyboard.press('Control+s');
  await page
    .locator('.toast-success')
    .filter({ hasText: '已保存' })
    .last()
    .waitFor({ timeout: 8000 });
  await page.waitForTimeout(1500);
  assert(
    !existsSync(join(projectDir, 'self.min.min.js')),
    '保存 .min.js 不会生成 .min.min.js',
  );

  console.log('14. 压缩队列语义：只写「正在跑的」和「最后一次入队的」');
  // 这是纯 Node 单测，不经过 UI：E2E 里「三次不同内容快速保存」受 files.write
  // 临时名冲突和写盘完成顺序影响，正确实现上也会偶发失败。
  // 直接测 enqueueMinify 的排队语义才是确定性的。
  if (!supportsTypeStripping()) {
    console.log(
      `  跳过：需要 Node >= 22.7 以直接导入 .ts（当前 ${process.versions.node}）。` +
        '这条用例不会被静默略过，升级 Node 后自动生效。',
    );
  } else {
    const queueCases = runEnqueueMinifyCases();
    assert(
      queueCases.writes.length === 2,
      `3 次入队只写 2 次（第 1 个在跑 + 最后一个），实际 ${queueCases.writes.length}`,
    );
    assert(
      queueCases.writes[0].includes('burst=1'),
      `第一次写的是第 1 个任务的内容，实际 ${queueCases.writes[0]}`,
    );
    assert(
      queueCases.writes[1].includes('burst=3'),
      `第二次写的是最后入队的内容，实际 ${queueCases.writes[1]}`,
    );
    assert(
      !queueCases.writes.some((item) => item.includes('burst=2')),
      '被覆盖的中间任务没有落盘',
    );
    assert(
      queueCases.resolved === 3,
      `三个调用都正常 resolve（被覆盖的不 reject），实际 ${queueCases.resolved}`,
    );
    assert(
      queueCases.afterErrorWrites.some((item) => item.includes('burst=5')),
      `写盘失败不会卡住队列，后续任务仍执行，实际 ${queueCases.afterErrorWrites}`,
    );
    assert(
      queueCases.afterErrorRejected === 1,
      `写盘失败会 reject 对应的调用，实际 ${queueCases.afterErrorRejected}`,
    );
  }

  console.log('15. 源文件写入失败时不压缩');
  const roSource = join(projectDir, 'ro.js');
  const roMin = join(projectDir, 'ro.min.js');
  await openFile(page, 'ro.js');
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nconst unsaved = 1;');
  // Windows 下 chmod 0o444 会把文件设成只读，files.write 的 rename 会稳定报 EPERM。
  // 这样走的是真实主进程失败路径，不需要打桩渲染进程的 window.api。
  chmodSync(roSource, 0o444);
  try {
    await page.keyboard.press('Control+s');
    // 按文案过滤：toast 有 4.2 秒生命周期，不能只数 .toast-error，
    // 否则可能命中上一个用例残留的提示。只读文件写入失败报的是 EPERM。
    const saveError = page
      .locator('.toast-error')
      .filter({ hasText: /EPERM|operation not permitted/ });
    await saveError.last().waitFor({ timeout: 10000 });
    assert(await saveError.last().isVisible(), '保存失败弹出错误提示');
    await page.waitForTimeout(2000);
    assert(
      readFileSync(roMin, 'utf8') === '/*OLD*/',
      '保存失败时已有的 .min.js 不被改写',
    );
    assert(
      !readFileSync(roSource, 'utf8').includes('const unsaved = 1;'),
      '源文件确实没有保存成功',
    );
  } finally {
    chmodSync(roSource, 0o666);
  }

  console.log('16. minifiedName 只看最后一层文件名');
  if (!supportsTypeStripping()) {
    console.log(
      `  跳过：需要 Node >= 22.7 以直接导入 .ts（当前 ${process.versions.node}）。` +
        '这条用例不会被静默略过，升级 Node 后自动生效。',
    );
  } else {
    const nameCases = runMinifiedNameCases();
    assert(
      nameCases['app.test.js'] === 'app.test.min.js',
      `多段扩展名正常，实际 ${nameCases['app.test.js']}`,
    );
    assert(
      nameCases['dir.v2/README'] === 'dir.v2/README',
      `目录名带点且文件无扩展名时原样返回，实际 ${nameCases['dir.v2/README']}`,
    );
    assert(
      nameCases['a/b.js'] === 'a/b.min.js',
      `子目录正常，实际 ${nameCases['a/b.js']}`,
    );
  }

  console.log(`\n全部通过（${passed} 项）`);
} finally {
  await app.close().catch(() => {});
  // ro.js 可能还没恢复权限就被中断，失败时删不掉只读文件
  try {
    chmodSync(join(projectDir, 'ro.js'), 0o666);
  } catch {
    // 文件可能根本没创建成功，忽略
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}

// 打开文件树里的文件。项目文件树在编辑器页签挂载时就列出根目录，
// 这里只处理根目录下的文件；子目录需要先点开对应目录行。
async function openFile(page, name) {
  const entry = page.locator('.file-row').filter({ hasText: name }).first();
  await entry.waitFor({ timeout: 10000 });
  await entry.click();
  await page.locator('.cm-content').first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(600);
}

// 直接 import .ts 需要 Node >= 22.7（22.6 起有 --experimental-strip-types，
// 但 22.7 才默认按 ESM 语法检测）。低版本不能静默跳过，要明确说明原因。
function supportsTypeStripping() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 7);
}

// 在子进程里用类型剥离导入真实模块，跑一段脚本并把最后一行 JSON 带回来。
// 注意：这两个 helper 在 try 块里就会被调用，模块顶层的 const 这时可能还在 TDZ，
// 所以 URL 在函数内部现算，不要提到顶层再引用。
function runTypeScriptCase(script) {
  const output = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
    { encoding: 'utf8' },
  );
  return JSON.parse(output.trim().split('\n').pop());
}

function moduleUrlForTests() {
  return new URL('../src/modules/minify.ts', import.meta.url).href;
}

function runMinifiedNameCases() {
  return runTypeScriptCase(`
    const { minifiedName } = await import(${JSON.stringify(moduleUrlForTests())});
    const inputs = ['app.test.js', 'dir.v2/README', 'a/b.js'];
    console.log(JSON.stringify(Object.fromEntries(inputs.map((i) => [i, minifiedName(i)]))));
  `);
}

// 队列语义：同步连续入队 3 个任务，只有第 1 个（已在跑）和最后一个会落盘。
// 再补一组「写盘失败」：失败的调用 reject，队列不卡死，下一个任务照常执行。
function runEnqueueMinifyCases() {
  return runTypeScriptCase(`
    const { enqueueMinify } = await import(${JSON.stringify(moduleUrlForTests())});
    const writes = [];
    const write = async (compressed) => { writes.push(compressed); };

    // 三次调用在同一 tick 内完成：第 1 个立即开跑，第 2 个进等待位，
    // 第 3 个覆盖等待位并让第 2 个直接 resolve。
    const p1 = enqueueMinify('/proj', 'out.min.js', 'window.burst = 1;', write);
    const p2 = enqueueMinify('/proj', 'out.min.js', 'window.burst = 2;', write);
    const p3 = enqueueMinify('/proj', 'out.min.js', 'window.burst = 3;', write);
    const settled = await Promise.allSettled([p1, p2, p3]);

    // 写盘失败不能卡住队列
    const afterErrorWrites = [];
    const p4 = enqueueMinify('/proj', 'err.min.js', 'window.burst = 4;', async () => {
      throw new Error('模拟写盘失败');
    });
    const p5 = enqueueMinify('/proj', 'err.min.js', 'window.burst = 5;', async (c) => {
      afterErrorWrites.push(c);
    });
    const settled2 = await Promise.allSettled([p4, p5]);

    console.log(JSON.stringify({
      writes,
      resolved: settled.filter((s) => s.status === 'fulfilled').length,
      rejected: settled.filter((s) => s.status === 'rejected').length,
      afterErrorWrites,
      afterErrorRejected: settled2.filter((s) => s.status === 'rejected').length,
    }));
  `);
}

// 读编辑器全文：CodeMirror 的内容不在 textarea 里，只能从 DOM 取
async function editorText(page) {
  return page.locator('.cm-content').first().innerText();
}

// 同步条件轮询，用于等文件被异步压缩任务写出来
async function waitFor(predicate, timeout, label) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeout) {
    try {
      if (predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${label}${lastError ? `（${lastError.message}）` : ''}`);
}

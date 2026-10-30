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

// 压缩用例：
// plain.js 没有同名产物，保存多少次都不能凭空创建 plain.min.js；
// withmin.js 已有产物，保存必须覆盖它（哪怕源文件没改）。
writeFileSync(join(projectDir, 'plain.js'), 'const x = 1;\nfunction f(){return x}\n', 'utf8');
writeFileSync(join(projectDir, 'withmin.js'), 'const y = 1;\n', 'utf8');
writeFileSync(join(projectDir, 'withmin.min.js'), '/*old*/', 'utf8');
// 用例 18：min.js 页签开着时改源文件，压缩会更新产物，需要给出提示
writeFileSync(join(projectDir, 'pair.js'), 'const pairBase = 1;\n', 'utf8');
writeFileSync(join(projectDir, 'pair.min.js'), '/*pair-old*/', 'utf8');
// 用例 19：外部改动后自动重新加载
writeFileSync(join(projectDir, 'live.js'), 'const liveOld = 1;\n', 'utf8');
// 后缀为 .min.js 的文件自己不再压缩
writeFileSync(join(projectDir, 'self.min.js'), 'const kept = 1;\n', 'utf8');
// 文件树右键「生成压缩版」的源文件，此前没有任何产物
writeFileSync(
  join(projectDir, 'fresh.js'),
  'const freshValue = 1;\nfunction freshFn(){ return freshValue + 1 }\n',
  'utf8',
);
// 压缩失败路径：源文件本身合法，用户改出语法错误后再保存
writeFileSync(join(projectDir, 'bad.js'), 'const ok = 1;\n', 'utf8');
writeFileSync(join(projectDir, 'bad.min.js'), '/*keep-me*/', 'utf8');
// 并发保存的时序断言不适合放 E2E（files.write 临时名冲突、写盘完成顺序都会造成
// 正确实现上的假红灯），队列语义改用上面的 Node 单测。
// 写入失败路径：保存时把源文件设成只读，用来验证「保存没成功就不压缩」
writeFileSync(join(projectDir, 'ro.js'), 'const ro = 1;\n', 'utf8');
writeFileSync(join(projectDir, 'ro.min.js'), '/*OLD*/', 'utf8');
// 诊断用例的夹具：文件树只在编辑器页签挂载时列一次根目录，
// 所以必须在启动前就创建好（测试中途新建的文件不会出现在树里）。
// 错误故意放在第 2 行，用来断言波浪线落在正确行。
writeFileSync(
  join(projectDir, 'diag-bad.js'),
  'const a = 1;\nconst = ;\nconst b = 3;\n',
  'utf8',
);
writeFileSync(join(projectDir, 'diag-valid.js'), 'const a = 1;\nfunction f() { return a; }\n', 'utf8');
writeFileSync(join(projectDir, 'diag-bad.php'), '<?php $a = ;\n', 'utf8');
// 合法 JSX：没有 acorn-jsx 时 acorn 会在这里整段误报
writeFileSync(
  join(projectDir, 'diag-valid.jsx'),
  'export function App() {\n  return <div className="x">hi</div>;\n}\n',
  'utf8',
);

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

  console.log('2. 压缩：同名 .min.js 不存在时保存不创建');
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

  console.log('3. 压缩：同名 .min.js 存在时自动更新');
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

  console.log('4. 压缩：源文件没改动也重新压缩');
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

  console.log('5. 并发写同一产物：临时文件名唯一，结果不混合');
  // 直接打主进程的 writeMinified：同一进程内多路并发写同一个 .min.js。
  // 旧实现共用 `${pid}.tmp`，会成批 ENOENT；新实现 temp 名唯一，但 Windows 上
  // 并发 rename 仍可能瞬时 EPERM（索引器/杀软占用），file-api 内部已有退避重试。
  // 这条用例守的是「temp 名唯一 + 产物不混合」：
  //   - 不得出现 ENOENT（那正是共享 temp 被抢走的 signature，且不在重试码里）
  //   - 其他失败只能是可重试的占用类错误
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
    const codes = failed.map((item) => item.reason?.code);
    // ENOENT 不在 renameWithRetry 的重试码里，出现即说明临时文件被并发抢走。
    assert(!codes.includes('ENOENT'), `并发写没有出现 ENOENT，实际 ${JSON.stringify(codes)}`);
    // 当前实现实测稳定 10/10；只容忍 1 次极端占用导致的 EPERM 耗尽重试，
    // 再低就说明并发临时文件机制退化了。
    assert(
      succeeded.length >= 9,
      `并发写基本全部成功（${succeeded.length}/${settled.length}）`,
    );
    const retryable = new Set(['EPERM', 'EBUSY', 'EACCES']);
    assert(
      failed.every((item) => retryable.has(item.reason?.code)),
      `失败的都是占用类错误，实际 ${JSON.stringify(codes)}`,
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

  console.log('6. 连按 Ctrl+S：压缩任务排队，不报错也不写坏');
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

  console.log('7. 压缩失败不影响保存');
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

  console.log('8. .min.js 自己不再压缩');
  await openFile(page, 'self.min.js');
  // 编辑器已没有右键菜单，这里直接验证保存行为
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

  console.log('9. 压缩队列语义：只写「正在跑的」和「最后一次入队的」');
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
    // 契约标注：「只写 2 次」和「burst=2 从未落盘」锁的是 enqueueMinify 的内部合并策略
    // （中间任务被后到者取代并直接 resolve），不是用户可见不变量。
    // 如果将来改成「串行把每个任务都写一遍」，最终产物仍是 burst=3、行为依然正确，
    // 这几条断言会变红——改策略时要同步改断言，别把它当成回归。
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
      '被覆盖的中间任务没有落盘（同上：锁的是内部合并策略）',
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

  console.log('10. 源文件写入失败时不压缩');
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

  console.log('11. minifiedName 只看最后一层文件名');
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

  console.log('11b. 压缩配置与 Nu-Minify 一致');
  // 配置来自 VS Code 的 Nu-Minify 扩展，项目里存量的 .min.js 都是它生成的。
  // 换个配置就会让交叉压缩产生巨大 diff，所以把关键行为锁住：
  //   - 顶层变量名必须保留（global_obj 这类被数百个 PHP 模板引用）
  //   - 局部变量要缩写
  //   - 超长自动折行（max_line_len 32000），不会压成单独一行
  const cfgSrc = readFileSync(join(root, 'src/modules/minify.ts'), 'utf8');
  assert(/hoist_funs:\s*true/.test(cfgSrc), 'hoist_funs 打开，与存量文件顺序一致');
  assert(/max_line_len:\s*32000/.test(cfgSrc), 'max_line_len 32000，超长折行');
  assert(
    /collapse_vars:\s*false/.test(cfgSrc) && /reduce_vars:\s*false/.test(cfgSrc),
    'collapse_vars / reduce_vars 关闭，避免与存量文件产生大 diff',
  );
  assert(!/toplevel\s*:/.test(cfgSrc), '没有开启 toplevel，顶层名保持原样');

  console.log('12. 文件树右键可生成压缩版');
  // 右键菜单删掉后，这是创建第一个 .min.js 的唯一入口。
  // 用 fresh.js，它此前没有任何产物。
  assert(!existsSync(join(projectDir, 'fresh.min.js')), 'fresh.min.js 一开始不存在');
  await page.locator('.file-row').filter({ hasText: /^fresh\.js$/ }).click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  assert(
    (await page.locator('.popup-menu').getByText('生成 fresh.min.js').count()) > 0,
    '文件树右键出现「生成 fresh.min.js」',
  );
  await page.locator('.popup-menu').getByText('生成 fresh.min.js').click();
  await page.waitForTimeout(2500);
  assert(existsSync(join(projectDir, 'fresh.min.js')), '产物已生成');
  const freshMin = readFileSync(join(projectDir, 'fresh.min.js'), 'utf8');
  assert(freshMin.length > 0, '产物非空');
  assert(
    freshMin.length < readFileSync(join(projectDir, 'fresh.js'), 'utf8').length,
    '产物比源文件短',
  );

  console.log('13. .min.js 自身没有压缩菜单');
  // 用测试开始前就已存在的 self.min.js：刚生成的 fresh.min.js 不在文件树缓存里，
  // 树不会自动刷新，拿它测会等不到元素
  await page
    .locator('.file-row')
    .filter({ hasText: 'self.min.js' })
    .first()
    .click({ button: 'right' });
  await page.waitForTimeout(800);
  assert(
    (await page.locator('.popup-menu').count()) === 0,
    '.min.js 右键不弹压缩菜单',
  );

  console.log('14. 诊断：默认不开 JS 诊断，开启后出现波浪线');
  await openFile(page, 'diag-bad.js');
  // 默认 diag-js 关闭，等过 linter 的 500ms 延迟确认确实没有标记
  await page.waitForTimeout(1200);
  assert(
    (await page.locator('.cm-lint-marker').count()) === 0,
    '默认关闭 JS 诊断时语法错误不标波浪线',
  );

  // 设置 → 模块 → 打开「JS / JSX 语法检查」→ 保存（开关点保存才生效）
  await page.locator('.titlebar-settings').click();
  await page.locator('.settings-body').waitFor({ timeout: 8000 });
  await page.getByRole('tab', { name: '模块' }).click();
  await page.waitForTimeout(200);
  const jsDiagRow = page.locator('.settings-item').filter({ hasText: "JS / JSX 语法检查" });
  await jsDiagRow.locator('.settings-switch').click();
  await page
    .locator('.modal-footer')
    .getByRole('button', { name: '保存', exact: true })
    .click();
  await page.locator('.settings-body').waitFor({ state: 'detached', timeout: 8000 });
  // 保存后 prefs 更新会重配 linter，linter 自身还有 500ms 延迟；
  // 用 waitFor 等标记出现，避免固定的 sleep 在慢机器上偶发失败。
  await page.locator('.cm-lint-marker').first().waitFor({ timeout: 10000 });
  assert(
    (await page.locator('.cm-lint-marker').count()) > 0,
    '开启 JS 诊断后语法错误出现波浪线',
  );
  // 夹具第 2 行是 `const = ;`，波浪线应该落在那一行而不是文件开头
  const lintLine = await page.evaluate(() => {
    const range = document.querySelector('.cm-lintRange-error');
    return range?.closest('.cm-line')?.textContent ?? null;
  });
  assert(
    typeof lintLine === 'string' && lintLine.includes('const = ;'),
    `波浪线落在出错行，实际 ${JSON.stringify(lintLine)}`,
  );

  console.log('15. 诊断：合法 JS 不误报');
  await openFile(page, 'diag-valid.js');
  await page.waitForTimeout(1500);
  assert(
    (await page.locator('.cm-lint-marker').count()) === 0,
    '合法 JS 没有波浪线',
  );

  console.log('15b. 诊断：合法 JSX 不误报');
  await openFile(page, 'diag-valid.jsx');
  await page.waitForTimeout(1500);
  assert(
    (await page.locator('.cm-lint-marker').count()) === 0,
    '合法 JSX 没有波浪线',
  );

  console.log('16. 诊断：PHP 默认开启，语法错误标波浪线');
  await openFile(page, 'diag-bad.php');
  await page.locator('.cm-lint-marker').first().waitFor({ timeout: 10000 });
  assert(
    (await page.locator('.cm-lint-marker').count()) > 0,
    'PHP 语法错误出现波浪线',
  );

  console.log('17. 诊断：关闭 JS 诊断并保存后，已打开文件的波浪线消失');
  await openFile(page, 'diag-bad.js');
  await page.locator('.cm-lint-marker').first().waitFor({ timeout: 10000 });
  await page.locator('.titlebar-settings').click();
  await page.locator('.settings-body').waitFor({ timeout: 8000 });
  await page.getByRole('tab', { name: '模块' }).click();
  await page.waitForTimeout(200);
  await jsDiagRow.locator('.settings-switch').click();
  await page
    .locator('.modal-footer')
    .getByRole('button', { name: '保存', exact: true })
    .click();
  await page.locator('.settings-body').waitFor({ state: 'detached', timeout: 8000 });
  await page
    .locator('.cm-lint-marker')
    .first()
    .waitFor({ state: 'detached', timeout: 10000 });
  assert(
    (await page.locator('.cm-lint-marker').count()) === 0,
    '关闭 JS 诊断并保存后波浪线消失',
  );

  console.log('18. 压缩更新已打开的 .min.js 时静默同步');
  // 用户开着 min.js 页签（旧内容）时改源文件，后台会重写 min.js。
  // 页签必须在压缩完成后自动变成新内容——否则用户切过去看到的还是旧内容，
  // 按保存会把刚生成的产物覆盖掉。和 VS Code 一样不弹提示。
  // 先让 min.js 页签占住（没碰过的页签会被新文件顶替）。
  await openFile(page, 'pair.min.js');
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(800);
  await openFile(page, 'pair.js');
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nconst pairMarker = 42;');
  await page.keyboard.press('Control+s');
  // 产物落盘
  await waitFor(
    () => readFileSync(join(projectDir, 'pair.min.js'), 'utf8').includes('pairMarker'),
    8000,
    'pair.min.js 含最新内容',
  );
  // 切回 min.js 页签，编辑器里应该已经是新内容（不需要关掉重开）
  await openFile(page, 'pair.min.js');
  await page
    .locator('.cm-content')
    .first()
    .filter({ hasText: 'pairMarker' })
    .waitFor({ timeout: 10000 });
  assert(true, '压缩后已打开的 .min.js 页签自动同步，无需重新打开');
  assert(
    (await page.locator('.toast').filter({ hasText: '关闭该页签' }).count()) === 0,
    '不再提示「关闭页签重新打开」',
  );

  console.log('19. 激活页签在磁盘上被改后自动重新加载');
  // 用外部写入模拟「别的工具改了文件」，编辑器应该在 2 秒内自己刷新
  await openFile(page, 'live.js');
  const liveBefore = await editorText(page);
  assert(liveBefore.includes('const liveOld = 1;'), '打开的是旧内容');
  writeFileSync(
    join(projectDir, 'live.js'),
    'const liveNew = 2;\nfunction liveFn() { return liveNew; }\n',
    'utf8',
  );
  await page
    .locator('.cm-content')
    .first()
    .filter({ hasText: 'liveNew' })
    .waitFor({ timeout: 12000 });
  assert(true, '激活页签自动重新加载');

  console.log('19b. 有未保存修改时不覆盖');
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nconst myUnsavedEdit = 9;');
  // 此时 dirty=true，外部再改磁盘不能冲掉我的编辑
  writeFileSync(
    join(projectDir, 'live.js'),
    'const externalWrite = 3;\n',
    'utf8',
  );
  await page.waitForTimeout(4000);
  const kept = await editorText(page);
  assert(kept.includes('myUnsavedEdit'), '未保存的编辑没有被覆盖');
  assert(!kept.includes('externalWrite'), '有修改时不载入磁盘内容');

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
  // 用精确匹配：diag-valid.js 与 diag-valid.jsx 这种前缀相同的文件，
  // hasText 子串匹配会命中错误的行。
  const exact = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const entry = page.locator('.file-row').filter({ hasText: exact }).first();
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

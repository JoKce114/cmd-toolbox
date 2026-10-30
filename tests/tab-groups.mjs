// 标签组：建组 / 改名 / 改色 / 折叠 / 拖拽归属 / 重启恢复。
// 需要先关掉正在运行的 Cmd Toolbox：pane-api 写死 17382，端口被占窗口就起不来。
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-tabgroups-'));

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.CMDTOOLBOX_NO_UPDATE = '1';

async function launch() {
  const app = await electron.launch({
    executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
    cwd: root,
    args: ['.', `--data-dir=${dataDir}`],
    env,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.app').waitFor();
  await page.waitForTimeout(800);
  return { app, page };
}

async function count(page, selector) {
  return page.locator(selector).count();
}

let session = await launch();

try {
  let { page } = session;

  await page.locator('.add-project-btn').click();
  await page.locator('.modal-card').waitFor();
  await page.locator('#project-path').fill('D:/project-demo/cmd-toolbox');
  await page.locator('#project-name').fill('group-proj');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await page.waitForTimeout(400);
  await page.locator('.group-main', { hasText: 'group-proj' }).click();
  await page.waitForTimeout(400);

  console.log('1. 准备三个终端页签');
  for (let index = 0; index < 3; index += 1) {
    await page.locator('.new-terminal-main').first().click();
    await page.waitForTimeout(1200);
  }
  assert((await count(page, '.tab')) === 3, `三个页签，实际 ${await count(page, '.tab')}`);
  assert((await count(page, '.tab-group')) === 0, '一开始没有标签组');

  console.log('2. 右键页签建组并自动进入改名');
  await page.locator('.tab').first().click({ button: 'right' });
  await page.locator('.popup-menu').getByText('添加到新标签组', { exact: true }).click();
  await page.locator('.tab-group-input').waitFor();
  assert((await count(page, '.tab-group')) === 1, '出现一个标签组');
  assert((await count(page, '.tab-group .tab')) === 1, '新组只含被右键的那个页签');

  console.log('3. 回车确认组名');
  await page.locator('.tab-group-input').fill('构建');
  await page.locator('.tab-group-input').press('Enter');
  await page.waitForTimeout(300);
  assert((await count(page, '.tab-group-input')) === 0, '提交后退出编辑态');
  const groupName = await page.locator('.tab-group-name').innerText();
  assert(groupName === '构建', `组名是「构建」，实际「${groupName}」`);

  console.log('4. 右键组标题改颜色');
  await page.locator('.tab-group-label').click({ button: 'right' });
  await page.locator('.popup-menu').getByText('蓝色', { exact: true }).click();
  await page.waitForTimeout(300);
  const color = await page.locator('.tab-group').getAttribute('data-color');
  assert(color === 'blue', `组颜色是蓝色，实际 ${color}`);

  console.log('5. 折叠只留药丸，展开后页签回来');
  const transition = await page
    .locator('.tab-group-tabs')
    .evaluate((node) => getComputedStyle(node).transitionDuration);
  assert(
    transition !== '0s',
    `折叠有过渡动画，transition-duration 实际 ${transition}`,
  );
  await page.locator('.tab-group-toggle').click();
  await page.waitForTimeout(500);
  assert((await count(page, '.tab-group.is-collapsed')) === 1, '组进入折叠态');
  const innerBox = await page.locator('.tab-group-tabs-inner').boundingBox();
  assert(
    !innerBox || innerBox.width < 1,
    `折叠后组内容宽度归零（有过渡动画），实际 ${innerBox?.width}`,
  );
  assert(
    (await count(page, '.tab-group .tab')) === 1,
    '折叠期间页签留在 DOM 里，动画才有东西可播',
  );
  assert((await count(page, '.tab')) === 3, '折叠不影响页签总数');
  await page.locator('.tab-group-toggle').click();
  await page.waitForTimeout(500);
  assert((await count(page, '.tab')) === 3, '展开后页签全部回来');
  const openBox = await page.locator('.tab-group-tabs-inner').boundingBox();
  assert((openBox?.width ?? 0) > 100, `展开后组内容恢复宽度，实际 ${openBox?.width}`);

  console.log('6. 把页签拖到组标题上并入组');
  await page.locator('.tab').nth(1).dragTo(page.locator('.tab-group-label'));
  await page.waitForTimeout(400);
  assert(
    (await count(page, '.tab-group .tab')) === 2,
    `拖入后组里有两个页签，实际 ${await count(page, '.tab-group .tab')}`,
  );
  await page.screenshot({ path: resolve(root, 'test-shots/tab-groups-expanded.png') });

  console.log('7. 重启后组还在');
  await session.app.close();
  await new Promise((done) => setTimeout(done, 1500));
  session = await launch();
  page = session.page;
  await page.locator('.group-main', { hasText: 'group-proj' }).click();
  await page.waitForTimeout(3000);
  assert((await count(page, '.tab-group')) === 1, '重启后仍有一个标签组');
  assert(
    (await page.locator('.tab-group-name').innerText()) === '构建',
    '重启后组名保留',
  );
  assert(
    (await page.locator('.tab-group').getAttribute('data-color')) === 'blue',
    '重启后颜色保留',
  );
  assert(
    (await count(page, '.tab-group .tab')) === 2,
    `重启后组里仍是两个页签，实际 ${await count(page, '.tab-group .tab')}`,
  );

  console.log('8. 拖到组外退出分组');
  const outsideTab = page.locator('.tab').last();
  await page.locator('.tab-group .tab').last().dragTo(outsideTab);
  await page.waitForTimeout(400);
  assert(
    (await count(page, '.tab-group .tab')) === 1,
    `拖出后组里剩一个页签，实际 ${await count(page, '.tab-group .tab')}`,
  );

  console.log('9. 拖动组标题整组移动');
  const beforeOrder = await page.locator('.tab').evaluateAll((nodes) =>
    nodes.map((node) => node.querySelector('.tab-pane')?.textContent),
  );
  const lastTab = page.locator('.tab').last();
  await page.locator('.tab-group-label').dragTo(lastTab, {
    targetPosition: { x: 4, y: 8 },
  });
  await page.waitForTimeout(500);
  const afterOrder = await page.locator('.tab').evaluateAll((nodes) =>
    nodes.map((node) => node.querySelector('.tab-pane')?.textContent),
  );
  assert(
    afterOrder.join(',') !== beforeOrder.join(','),
    `整组被挪了位置：${beforeOrder.join(',')} → ${afterOrder.join(',')}`,
  );
  assert(
    (await count(page, '.tab-group')) === 1,
    '整组拖动后仍然只有一个组，没有被拆成两个',
  );

  console.log('10. 关掉组里最后一个页签后组消失');
  await page.locator('.tab-group .tab .tab-close').click();
  await page.waitForTimeout(500);
  assert((await count(page, '.tab-group')) === 0, '空组被自动回收');

  console.log('11. 两个不同颜色的组同时存在');
  for (const name of ['构建', '测试']) {
    const loose = page.locator('.tab:not(.in-group)').first();
    await loose.click({ button: 'right' });
    await page.locator('.popup-menu').getByText('添加到新标签组', { exact: true }).click();
    await page.locator('.tab-group-input').fill(name);
    await page.locator('.tab-group-input').press('Enter');
    await page.waitForTimeout(300);
  }
  await page.locator('.tab-group-label').first().click({ button: 'right' });
  await page.locator('.popup-menu').getByText('绿色', { exact: true }).click();
  await page.waitForTimeout(400);
  assert((await count(page, '.tab-group')) === 2, '两个标签组同时存在');
  const colors = await page
    .locator('.tab-group')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-color')));
  assert(new Set(colors).size === 2, `两个组颜色不同，实际 ${colors.join('/')}`);
  await page.screenshot({ path: resolve(root, 'test-shots/tab-groups-two.png') });

  console.log(`\n全部通过（${passed} 项）`);
} finally {
  await session.app.close().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
}

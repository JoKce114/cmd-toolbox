import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLoginItem } = require('../desktop/login-item.js');

let passed = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  passed += 1;
  console.log('  ok  ' + msg);
};

function makeApp({ packaged = true, acceptWrites = true, initial = false } = {}) {
  let state = initial;
  const calls = [];
  return {
    calls,
    isPackaged: packaged,
    getLoginItemSettings: () => ({ openAtLogin: state }),
    setLoginItemSettings: (options) => {
      calls.push(options);
      if (acceptWrites) state = options.openAtLogin;
    },
  };
}

console.log('1. 开发模式下不可用');
{
  const app = makeApp({ packaged: false });
  const item = createLoginItem(app);
  const state = item.getState();
  ok(state.supported === false, '开发模式 supported 为 false');
  ok(typeof state.reason === 'string' && state.reason.includes('开发模式'), '给出中文原因');
  const result = item.setEnabled(true);
  ok(result.ok === false, '开发模式写入被拒绝');
  ok(app.calls.length === 0, '开发模式不触碰系统设置');
}

console.log('2. 正常开启与关闭');
{
  const app = makeApp();
  const item = createLoginItem(app);
  ok(item.getState().enabled === false, '初始为关闭');
  const enabled = item.setEnabled(true);
  ok(enabled.ok === true, '开启成功');
  ok(item.getState().enabled === true, '读回为开启');
  const disabled = item.setEnabled(false);
  ok(disabled.ok === true, '关闭成功');
  ok(item.getState().enabled === false, '读回为关闭');
}

console.log('3. 被安全软件拦截时如实报错');
{
  const app = makeApp({ acceptWrites: false });
  const item = createLoginItem(app);
  const result = item.setEnabled(true);
  ok(result.ok === false, '写入未生效时返回失败');
  ok(result.message.includes('安全软件'), '提示可能是安全软件拦截');
  ok(item.getState().enabled === false, '状态没有被谎报为开启');
}

console.log('4. 启动时修复路径');
{
  const enabledApp = makeApp({ initial: true });
  const enabledItem = createLoginItem(enabledApp);
  enabledItem.repairOnStartup();
  ok(enabledApp.calls.length === 1, '已开启时重写一次路径');
  ok(enabledApp.calls[0].openAtLogin === true, '重写时保持开启状态');

  const disabledApp = makeApp({ initial: false });
  const disabledItem = createLoginItem(disabledApp);
  disabledItem.repairOnStartup();
  ok(disabledApp.calls.length === 0, '未开启时不写入');

  const devApp = makeApp({ packaged: false, initial: true });
  const devItem = createLoginItem(devApp);
  devItem.repairOnStartup();
  ok(devApp.calls.length === 0, '开发模式不修复');
}

console.log('5. 便携版使用真实 exe 路径');
{
  const app = makeApp();
  const item = createLoginItem(app);
  process.env.PORTABLE_EXECUTABLE_FILE = 'D:\\Apps\\CmdToolbox.exe';
  item.setEnabled(true);
  ok(app.calls[0].path === 'D:\\Apps\\CmdToolbox.exe', '优先使用 PORTABLE_EXECUTABLE_FILE');
  delete process.env.PORTABLE_EXECUTABLE_FILE;

  const plainApp = makeApp();
  createLoginItem(plainApp).setEnabled(true);
  ok(plainApp.calls[0].path === process.execPath, '没有该变量时回落到 process.execPath');
  ok(Array.isArray(plainApp.calls[0].args) && plainApp.calls[0].args.length === 0, '不携带额外参数');
}

console.log(`\n全部通过：${passed} 项`);

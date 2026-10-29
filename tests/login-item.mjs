import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLoginItem, LOGIN_VALUE_NAME } = require('../desktop/login-item.js');

let passed = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  passed += 1;
  console.log('  ok  ' + msg);
};

// 从注册表命令行里取路径（与模块内的解析逻辑一致，用来做独立校验）
function pathOf(commandLine) {
  const value = String(commandLine ?? '').trim();
  if (!value) return '';
  if (value.startsWith('"')) {
    const end = value.indexOf('"', 1);
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }
  return value.split(/\s+/)[0];
}

// 假 app + 假注册表。getLoginItemSettings 刻意复刻 Electron 的真实语义：
// 它只比较注册表路径与传入路径，路径过期时返回 openAtLogin: false。
function makeHarness({ packaged = true, acceptWrites = true, entry = null } = {}) {
  const registry = new Map();
  if (entry != null) registry.set(LOGIN_VALUE_NAME, entry);
  const writes = [];
  const counters = { registryReads: 0, electronReads: 0 };
  const app = {
    isPackaged: packaged,
    getLoginItemSettings: (options) => {
      counters.electronReads += 1;
      const command = registry.get(LOGIN_VALUE_NAME);
      return { openAtLogin: command != null && pathOf(command) === options.path };
    },
    setLoginItemSettings: (options) => {
      writes.push(options);
      if (!acceptWrites) return;
      if (options.openAtLogin) registry.set(LOGIN_VALUE_NAME, `"${options.path}"`);
      else registry.delete(LOGIN_VALUE_NAME);
    },
  };
  const readRunEntry = (valueName) => {
    counters.registryReads += 1;
    return registry.get(valueName) ?? null;
  };
  return { app, writes, counters, registry, readRunEntry };
}

console.log('1. 开发模式下不可用');
{
  const h = makeHarness({ packaged: false });
  const item = createLoginItem(h.app, { readRunEntry: h.readRunEntry });
  const state = item.getState();
  ok(state.supported === false, '开发模式 supported 为 false');
  ok(typeof state.reason === 'string' && state.reason.includes('开发模式'), '给出中文原因');
  const result = item.setEnabled(true);
  ok(result.ok === false, '开发模式写入被拒绝');
  ok(h.writes.length === 0, '开发模式不触碰系统设置');
  ok(h.counters.registryReads === 0 && h.counters.electronReads === 0, '开发模式也不读系统设置');
}

console.log('2. 正常开启与关闭');
{
  const h = makeHarness();
  const item = createLoginItem(h.app, { readRunEntry: h.readRunEntry });
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
  const h = makeHarness({ acceptWrites: false });
  const item = createLoginItem(h.app, { readRunEntry: h.readRunEntry });
  const result = item.setEnabled(true);
  ok(result.ok === false, '写入未生效时返回失败');
  ok(result.message.includes('安全软件'), '提示可能是安全软件拦截');
  ok(item.getState().enabled === false, '状态没有被谎报为开启');
}

console.log('4. getState 以注册表项为准，不看 Electron 的比较结果');
{
  const h = makeHarness({ entry: '"D:\\Old\\CmdToolbox.exe"' });
  const item = createLoginItem(h.app, { readRunEntry: h.readRunEntry });
  ok(h.app.getLoginItemSettings({ path: process.execPath, args: [] }).openAtLogin === false,
    'Electron 比较口径认为未开启');
  ok(item.getState().enabled === true, '注册表项存在即视为已开启');
}

console.log('5. 启动时修复路径');
{
  const stale = makeHarness({ entry: '"D:\\Old\\CmdToolbox.exe"' });
  createLoginItem(stale.app, { readRunEntry: stale.readRunEntry }).repairOnStartup();
  ok(stale.writes.length === 1, '路径过期时重写一次');
  ok(stale.writes[0].path === process.execPath, '重写为当前 exe 路径');
  ok(stale.writes[0].openAtLogin === true, '重写时保持开启状态');

  const matching = makeHarness({ entry: `"${process.execPath}"` });
  createLoginItem(matching.app, { readRunEntry: matching.readRunEntry }).repairOnStartup();
  ok(matching.writes.length === 0, '路径一致时不写入');

  const absent = makeHarness();
  createLoginItem(absent.app, { readRunEntry: absent.readRunEntry }).repairOnStartup();
  ok(absent.writes.length === 0, '未开启时不写入');

  const dev = makeHarness({ packaged: false, entry: '"D:\\Old\\CmdToolbox.exe"' });
  createLoginItem(dev.app, { readRunEntry: dev.readRunEntry }).repairOnStartup();
  ok(dev.writes.length === 0 && dev.counters.registryReads === 0, '开发模式不修复也不读注册表');
}

console.log('6. 便携版使用真实 exe 路径');
{
  const portable = makeHarness();
  const item = createLoginItem(portable.app, { readRunEntry: portable.readRunEntry });
  process.env.PORTABLE_EXECUTABLE_FILE = 'D:\\Apps\\CmdToolbox.exe';
  const result = item.setEnabled(true);
  ok(result.ok === true, '便携版写入成功');
  ok(portable.writes[0].path === 'D:\\Apps\\CmdToolbox.exe', '优先使用 PORTABLE_EXECUTABLE_FILE');
  delete process.env.PORTABLE_EXECUTABLE_FILE;

  const plain = makeHarness();
  const plainResult = createLoginItem(plain.app, { readRunEntry: plain.readRunEntry }).setEnabled(true);
  ok(plainResult.ok === true, '非便携版写入成功');
  ok(plain.writes[0].path === process.execPath, '没有该变量时回落到 process.execPath');
  ok(Array.isArray(plain.writes[0].args) && plain.writes[0].args.length === 0, '不携带额外参数');
}

console.log(`\n全部通过：${passed} 项`);

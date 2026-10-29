const { spawnSync } = require('child_process');
const iconv = require('iconv-lite');

// 必须与 main.js 中的 app.setName(APP_NAME) 保持一致：Electron 用应用名
// 作为 HKCU Run 键下的项名，改名会读不到已有的开机项。
const LOGIN_VALUE_NAME = 'Cmd Toolbox';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

// 从注册表里的命令行取出 exe 路径。Electron 写入的是带引号的完整路径，
// 但也兼容不带引号（路径含空格时取第一段，与 Windows 的解析习惯一致）。
function registeredPath(commandLine) {
  const value = String(commandLine ?? '').trim();
  if (!value) return '';
  if (value.startsWith('"')) {
    const end = value.indexOf('"', 1);
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }
  return value.split(/\s+/)[0];
}

// 直接读 Run 键，而不是用 app.getLoginItemSettings()：后者只会把注册表里的
// 路径和传入路径作比较，便携版换目录后旧路径对不上就返回 openAtLogin: false，
// 恰好把“需要修复”的情况误判成“没开启”。
function defaultReadRunEntry(valueName) {
  const result = spawnSync('reg', ['query', RUN_KEY, '/v', valueName], {
    encoding: null,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || !result.stdout) return null;
  // 中文 Windows 的 reg 输出是 GBK，按 UTF-8 解码会把中文路径变成乱码。
  const text = iconv.decode(result.stdout, 'gbk');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(.+?)\s+(REG_[A-Z_]+)\s*(.*)$/);
    if (match && match[1].trim() === valueName) {
      return match[3].trim();
    }
  }
  return null;
}

function samePath(commandLine, targetPath) {
  const left = registeredPath(commandLine).replace(/[\\/]+$/, '');
  // 右侧是已知的完整路径，不能过 registeredPath，否则含空格的目录会被截断。
  const right = String(targetPath ?? '').replace(/[\\/]+$/, '');
  return left.toLowerCase() === right.toLowerCase();
}

function createLoginItem(app, { readRunEntry = defaultReadRunEntry } = {}) {
  // 便携版运行时先解包到临时目录，process.execPath 指向临时目录里的 exe，
  // 写进注册表后下次开机会指向已清空的路径。electron-builder 为便携版
  // 注入了 PORTABLE_EXECUTABLE_FILE，指向用户真正双击的那个 exe。
  const exePath = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const query = () => ({ path: exePath(), args: [] });

  function supported() {
    return process.platform === 'win32' && app.isPackaged === true;
  }

  function getState() {
    if (!supported()) {
      return { supported: false, enabled: false, reason: '开发模式下不支持开机启动' };
    }
    // 以注册表项是否存在为准：路径过期也算“已开启”，用户能看到并关掉它。
    const entry = readRunEntry(LOGIN_VALUE_NAME);
    return { supported: true, enabled: entry != null };
  }

  function setEnabled(enabled) {
    if (!supported()) {
      return { ok: false, message: '开发模式下不支持开机启动' };
    }
    try {
      app.setLoginItemSettings({ ...query(), openAtLogin: Boolean(enabled) });
      // 安全软件会静默拦截注册表写入，必须直接读 Run 键校验。
      // 不能用 getLoginItemSettings 校验，它只是“是否等于传入路径”的比较。
      const entry = readRunEntry(LOGIN_VALUE_NAME);
      const applied = enabled
        ? entry != null && samePath(entry, exePath())
        : entry == null;
      if (!applied) {
        return { ok: false, message: '系统拒绝写入开机启动项，可能被安全软件拦截' };
      }
      return { ok: true };
    } catch (error) {
      const detail = error && error.message ? String(error.message) : '';
      return {
        ok: false,
        message: detail ? `写入开机启动项失败：${detail}` : '写入开机启动项失败',
      };
    }
  }

  // 便携版被挪目录或从旧路径升级后，开机项会指向已不存在的 exe，启动时重写一遍
  function repairOnStartup() {
    if (!supported()) return;
    try {
      const entry = readRunEntry(LOGIN_VALUE_NAME);
      if (entry == null) return;
      if (samePath(entry, exePath())) return;
      app.setLoginItemSettings({ openAtLogin: true, path: exePath(), args: [] });
    } catch {
      // 修不好只影响下次开机，不值得打断启动
    }
  }

  return { getState, setEnabled, repairOnStartup };
}

module.exports = { createLoginItem, LOGIN_VALUE_NAME };

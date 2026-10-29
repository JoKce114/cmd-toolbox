const { spawnSync } = require('child_process');
const iconv = require('iconv-lite');

// Electron 的 setLoginItemSettings 默认用 AppUserModelId（local.cmd.toolbox）
// 作为 HKCU Run 下的项名，而不是 app.setName() 的应用名。所以每次写入都必须
// 显式传 name: LOGIN_VALUE_NAME，否则写进注册表的项名和这里读的名字对不上，
// 表现为「写入成功却读回失败」。
const LOGIN_VALUE_NAME = 'Cmd Toolbox';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

// 从注册表里的命令行取出 exe 路径。Electron 写入时即使路径含空格也不加引号，
// 而我们写入时 args 恒为空，所以不带引号的值整条就是路径，不能按空格切分
// （否则 C:\Program Files\... 会被截成 C:\Program）。带引号的情况仍可能是
// 手工添加或旧版本留下的，保留原有解析。
function registeredPath(commandLine) {
  const value = String(commandLine ?? '').trim();
  if (!value) return '';
  if (value.startsWith('"')) {
    const end = value.indexOf('"', 1);
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }
  return value;
}

// 返回 { status: 'present', commandLine } | { status: 'absent' } | { status: 'error', detail }。
// 不能用 null 同时表示「没有这一项」和「读取失败」：前者是正常的关闭状态，
// 后者必须如实报错，否则注册表读不了时会被误当成「关闭成功」。
//
// 直接读 Run 键，而不是用 app.getLoginItemSettings()：后者只会把注册表里的
// 路径和传入路径作比较，便携版换目录后旧路径对不上就返回 openAtLogin: false，
// 恰好把“需要修复”的情况误判成“没开启”。
function readRunKey(key) {
  return spawnSync('reg', ['query', key], { encoding: null, windowsHide: true });
}

function decodeOutput(buffer) {
  return buffer ? iconv.decode(buffer, 'gbk') : '';
}

function defaultReadRunEntry(valueName) {
  const result = spawnSync('reg', ['query', RUN_KEY, '/v', valueName], {
    encoding: null,
    windowsHide: true,
  });
  if (result.error) {
    return { status: 'error', detail: String(result.error.message || result.error) };
  }
  if (result.status === 0) {
    // 中文 Windows 的 reg 输出是 GBK，按 UTF-8 解码会把中文路径变成乱码。
    const text = decodeOutput(result.stdout);
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(.+?)\s+(REG_[A-Z_]+)\s*(.*)$/);
      if (match && match[1].trim() === valueName) {
        return { status: 'present', commandLine: match[3].trim() };
      }
    }
    return { status: 'error', detail: '无法解析注册表输出' };
  }
  // reg 查询不到值（和查询不到键一样）返回 1，但真正出错（语法错误、拒绝访问）
  // 也返回 1，输出文案还随系统语言变化。再查一次整个 Run 键：能读到就说明
  // 只是这一项不存在，读不到才算错误。
  const keyResult = readRunKey(RUN_KEY);
  if (!keyResult.error && keyResult.status === 0) {
    return { status: 'absent' };
  }
  const detail = keyResult.error
    ? String(keyResult.error.message || keyResult.error)
    : decodeOutput(keyResult.stderr).trim();
  return { status: 'error', detail: detail || '读取开机启动项失败' };
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
    if (entry.status === 'error') {
      return { supported: true, enabled: false, reason: entry.detail };
    }
    return { supported: true, enabled: entry.status === 'present' };
  }

  function setEnabled(enabled) {
    if (!supported()) {
      return { ok: false, message: '开发模式下不支持开机启动' };
    }
    try {
      app.setLoginItemSettings({
        ...query(),
        openAtLogin: Boolean(enabled),
        name: LOGIN_VALUE_NAME,
      });
      // 安全软件会静默拦截注册表写入，必须直接读 Run 键校验。
      // 不能用 getLoginItemSettings 校验，它只是“是否等于传入路径”的比较。
      const entry = readRunEntry(LOGIN_VALUE_NAME);
      if (entry.status === 'error') {
        return { ok: false, message: `读取开机启动项失败：${entry.detail}` };
      }
      const applied = enabled
        ? entry.status === 'present' && samePath(entry.commandLine, exePath())
        : entry.status === 'absent';
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
      // 读取失败和「本来就没开启」都无需修复：错误不该在启动阶段被当成待修复状态
      if (entry.status !== 'present') return;
      if (samePath(entry.commandLine, exePath())) return;
      app.setLoginItemSettings({
        openAtLogin: true,
        path: exePath(),
        args: [],
        name: LOGIN_VALUE_NAME,
      });
    } catch {
      // 修不好只影响下次开机，不值得打断启动
    }
  }

  return { getState, setEnabled, repairOnStartup };
}

module.exports = { createLoginItem, LOGIN_VALUE_NAME };

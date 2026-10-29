function createLoginItem(app) {
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
    const settings = app.getLoginItemSettings(query());
    return { supported: true, enabled: Boolean(settings.openAtLogin) };
  }

  function setEnabled(enabled) {
    if (!supported()) {
      return { ok: false, message: '开发模式下不支持开机启动' };
    }
    try {
      app.setLoginItemSettings({ ...query(), openAtLogin: Boolean(enabled) });
      // 安全软件会静默拦截注册表写入，必须读回校验，否则会显示成功但实际没生效
      const after = app.getLoginItemSettings(query());
      if (Boolean(after.openAtLogin) !== Boolean(enabled)) {
        return { ok: false, message: '系统拒绝写入开机启动项，可能被安全软件拦截' };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error && error.message ? error.message : '写入开机启动项失败' };
    }
  }

  // 便携版被挪目录或从旧路径升级后，开机项会指向已不存在的 exe，启动时重写一遍
  function repairOnStartup() {
    if (!supported()) return;
    try {
      if (!app.getLoginItemSettings(query()).openAtLogin) return;
      app.setLoginItemSettings({ ...query(), openAtLogin: true });
    } catch {
      // 修不好只影响下次开机，不值得打断启动
    }
  }

  return { getState, setEnabled, repairOnStartup };
}

module.exports = { createLoginItem };

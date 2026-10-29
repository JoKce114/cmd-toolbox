// electron-updater 只在打包后的环境可用：开发模式下没有 resources/app-update.yml
const IDLE_STATE = { phase: 'idle', percent: 0, version: '', message: '' };

let state = { ...IDLE_STATE };
let sendToRenderer = () => {};
let prepareInstall = () => {};
let autoUpdater = null;
let loaded = false;

function loadUpdater() {
  if (loaded) return autoUpdater;
  loaded = true;
  try {
    const electron = require('electron');
    if (!electron || !electron.app || !electron.app.isPackaged) return null;
    autoUpdater = require('electron-updater').autoUpdater;
    return autoUpdater;
  } catch (error) {
    console.warn('[updater] 无法加载 electron-updater：', error && error.message ? error.message : error);
    autoUpdater = null;
    return null;
  }
}

function setState(patch) {
  state = { ...state, ...patch };
  sendToRenderer('updater:event', state);
}

// 主进程抛出来的多是 net::ERR_* 之类，直接展示没有意义
function describeError(error) {
  const raw = error && error.message ? String(error.message) : String(error || '');
  if (/No published versions|Cannot find .*latest\.yml|latest\.yml.*not found/i.test(raw)) {
    return '还没有发布可用的安装包，请前往下载页手动安装';
  }
  if (/ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|ERR_CONNECTION_CLOSED|ECONNRESET|ETIMEDOUT|ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED/i.test(raw)) {
    return '下载失败，请检查网络或代理后重试';
  }
  if (/ENOENT|app-update\.yml|Cannot find/i.test(raw)) {
    return '安装包信息缺失，请前往下载页手动安装';
  }
  if (/ENOSPC/i.test(raw)) return '磁盘空间不足，无法下载安装包';
  return raw || '下载安装包失败';
}

// beforeInstall 由主进程注入：装包前要先收掉所有终端进程，否则 exe 会被占用
function init(send, beforeInstall) {
  if (typeof send === 'function') sendToRenderer = send;
  if (typeof beforeInstall === 'function') prepareInstall = beforeInstall;

  const updater = loadUpdater();
  if (!updater) {
    state = { ...IDLE_STATE, phase: 'unsupported', message: '开发模式下不支持自动更新' };
    return;
  }

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;

  updater.on('update-available', (info) => {
    setState({ phase: 'downloading', percent: 0, version: (info && info.version) || '', message: '' });
  });
  updater.on('download-progress', (progress) => {
    setState({
      phase: 'downloading',
      percent: Math.round(Number(progress && progress.percent) || 0),
      message: '',
    });
  });
  updater.on('update-downloaded', (info) => {
    setState({
      phase: 'downloaded',
      percent: 100,
      version: (info && info.version) || state.version,
      message: '',
    });
  });
  updater.on('update-not-available', () => {
    // GitHub API 说有新版但 Release 里没传 latest.yml 时会走到这里
    setState({
      phase: 'error',
      percent: 0,
      message: '没有找到可用的安装包，请前往下载页手动安装',
    });
  });
  updater.on('error', (error) => {
    setState({ phase: 'error', percent: 0, message: describeError(error) });
  });
}

function getState() {
  return { ...state };
}

async function startDownload() {
  const updater = loadUpdater();
  if (!updater) return { ok: false, message: '开发模式下不支持自动更新' };
  if (state.phase === 'downloaded') return { ok: true };

  setState({ phase: 'downloading', percent: 0, message: '' });
  try {
    await updater.checkForUpdates();
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    setState({ phase: 'error', percent: 0, message });
    return { ok: false, message };
  }
}

function install() {
  const updater = loadUpdater();
  if (!updater) return { ok: false, message: '开发模式下不支持自动更新' };
  if (state.phase !== 'downloaded') return { ok: false, message: '安装包还没有下载完成' };

  setImmediate(() => {
    try {
      prepareInstall();
    } catch (error) {
      console.warn('[updater] 安装前清理失败：', error && error.message ? error.message : error);
    }
    // 留一点时间让终端进程退出并释放文件句柄，否则 NSIS 删不掉旧的 exe
    setTimeout(() => {
      try {
        updater.quitAndInstall(true, true);
      } catch (error) {
        setState({ phase: 'error', percent: 100, message: describeError(error) });
      }
    }, 300);
  });
  return { ok: true };
}

module.exports = { init, getState, startDownload, install };

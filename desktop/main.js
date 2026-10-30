const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const store = require('./store');
const sessionStore = require('./session');
const ptyHost = require('./pty-host');
const paneApi = require('./pane-api');
const mcpConfig = require('./mcp-config');
const git = require('./git');
const fileApi = require('./file-api');
const updates = require('./updates');
const updater = require('./updater');
const { createLoginItem } = require('./login-item');
const { listShells, listTools, resolveShell } = require('./shells');

const APP_NAME = 'Cmd Toolbox';
const APP_ID = 'local.cmd.toolbox';
const isDev = process.env.CMDTOOLBOX_DEV === '1';

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);

const dataDirArgument = process.argv.find((argument) => argument.startsWith('--data-dir='));
if (dataDirArgument) {
  const directory = dataDirArgument.slice('--data-dir='.length).trim();
  if (directory) {
    const resolved = path.resolve(directory);
    fs.mkdirSync(resolved, { recursive: true });
    app.setPath('userData', resolved);
  }
}

const loginItem = createLoginItem(app);

let mainWindow = null;
let quittingForUpdate = false;

function send(...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(...args);
  }
}

function normalizeDir(input) {
  let value = String(input ?? '').trim().replace(/^["']|["']$/g, '');
  if (!value) return '';
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      value = decodeURIComponent(url.pathname);
      if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(value)) value = value.slice(1);
    } catch {
      // keep the original value
    }
  }
  return path.resolve(value.replace(/\//g, path.sep));
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function assertDirectory(input) {
  const target = normalizeDir(input);
  if (!target) throw new Error('请填写本地项目目录');
  if (!isDirectory(target)) throw new Error('目录不存在，请检查路径后重试');
  return target;
}

function deriveName(target) {
  const base = path.basename(target);
  if (base) return base;
  const root = path.parse(target).root;
  return root ? `${root.replace(/[:\\/]/g, '')} 盘` : '本地项目';
}

function cleanName(input, fallback) {
  const value = String(input ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  return (value || fallback).slice(0, 60);
}

function projectsWithState() {
  return store.list().map((project) => ({
    ...project,
    exists: isDirectory(project.path),
  }));
}

function validExternalUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1000,
    minHeight: 660,
    show: false,
    backgroundColor: '#ffffff',
    title: APP_NAME,
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay:
      process.platform === 'win32'
        ? { color: '#ffffff', symbolColor: '#45474e', height: 40 }
        : undefined,
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 12 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (validExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    const src = String(params.src || '');
    if (src && src !== 'about:blank' && !validExternalUrl(src)) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.on('render-process-gone', () => {
    ptyHost.closeAll();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (isDev) {
    mainWindow.loadURL('http://127.0.0.1:5173');
    if (process.env.CMDTOOLBOX_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    homeDir: os.homedir(),
    dataDir: app.getPath('userData'),
    shells: listShells(),
    tools: listTools(),
    defaultShellId: listShells()[0]?.id || 'cmd',
  }));

  ipcMain.handle('app:get-login-item', () => loginItem.getState());
  ipcMain.handle('app:set-login-item', (_event, enabled) =>
    loginItem.setEnabled(Boolean(enabled)),
  );

  ipcMain.handle('updates:check', (_event, seenVersion) =>
    updates.checkForUpdate(app.getVersion(), seenVersion),
  );

  ipcMain.handle('updater:download', () => updater.startDownload());
  ipcMain.handle('updater:install', () => updater.install());
  ipcMain.handle('updater:state', () => updater.getState());

  ipcMain.handle('session:load', () => sessionStore.load());

  ipcMain.handle('session:save', (_event, payload) => sessionStore.save(payload));

  ipcMain.on('session:save-sync', (event, payload) => {
    try {
      sessionStore.save(payload);
      event.returnValue = true;
    } catch {
      event.returnValue = false;
    }
  });

  ipcMain.handle('projects:list', () => projectsWithState());

  ipcMain.handle('projects:save', (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const projectPath = assertDirectory(input.path);
    const storedProjects = store.list();
    const existing = input.id
      ? storedProjects.find((project) => project.id === input.id)
      : null;
    const duplicate = storedProjects.find(
      (project) =>
        project.id !== (existing?.id || '') &&
        project.path.toLowerCase() === projectPath.toLowerCase(),
    );
    if (duplicate) throw new Error('这个目录已经保存过了');

    const id = existing?.id || (typeof input.id === 'string' && input.id) || crypto.randomUUID();
    const project = {
      id,
      name: cleanName(input.name, deriveName(projectPath)),
      path: projectPath,
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    store.upsert(project);
    const projects = projectsWithState();
    return {
      projects,
      project: projects.find((item) => item.id === id) || { ...project, exists: true },
    };
  });

  ipcMain.handle('projects:remove', (_event, id) => {
    if (typeof id !== 'string' || !id) throw new Error('缺少项目编号');
    ptyHost.closeByGroup(`project:${id}`);
    store.remove(id);
    return projectsWithState();
  });

  ipcMain.handle('projects:reorder', (_event, ids) => {
    store.reorder(ids);
    return projectsWithState();
  });

  // 渲染进程只能对已保存项目执行 git 操作
  function assertProjectPath(input) {
    const target = normalizeDir(input);
    const known = store
      .list()
      .find((project) => normalizeDir(project.path).toLowerCase() === target.toLowerCase());
    if (!known) throw new Error('项目未保存，无法执行 Git 操作');
    return known.path;
  }

  ipcMain.handle('git:status', (_event, projectPath) =>
    git.status(assertProjectPath(projectPath)),
  );

  ipcMain.handle('git:commit', (_event, projectPath, message) =>
    git.commit(assertProjectPath(projectPath), message),
  );

  ipcMain.handle('git:push', (_event, projectPath, options) =>
    git.push(assertProjectPath(projectPath), options),
  );

  ipcMain.handle('git:file-diff', (_event, projectPath, filePath, changeStatus) =>
    git.fileDiff(assertProjectPath(projectPath), filePath, changeStatus),
  );

  ipcMain.handle('git:log', (_event, projectPath, limit) =>
    git.log(assertProjectPath(projectPath), limit),
  );

  ipcMain.handle('git:fetch', (_event, projectPath) =>
    git.fetchRemote(assertProjectPath(projectPath)),
  );

  ipcMain.handle('git:pull', (_event, projectPath, options) =>
    git.pull(assertProjectPath(projectPath), options),
  );

  ipcMain.handle('git:repair-upstream', (_event, projectPath) =>
    git.repairUpstream(assertProjectPath(projectPath)),
  );

  ipcMain.handle('git:init', (_event, projectPath) =>
    git.init(assertProjectPath(projectPath)),
  );

  ipcMain.handle('git:diff', (_event, projectPath, filePath, changeStatus) =>
    git.diffCommand(assertProjectPath(projectPath), filePath, changeStatus),
  );

  ipcMain.handle('git:stage', (_event, projectPath, paths) =>
    git.stage(assertProjectPath(projectPath), paths),
  );

  ipcMain.handle('git:unstage', (_event, projectPath, paths) =>
    git.unstage(assertProjectPath(projectPath), paths),
  );

  ipcMain.handle('git:discard', (_event, projectPath, payload) =>
    git.discard(assertProjectPath(projectPath), payload),
  );

  ipcMain.handle('git:stage-all', (_event, projectPath) =>
    git.stageAll(assertProjectPath(projectPath)),
  );

  ipcMain.handle('git:discard-all', (_event, projectPath) =>
    git.discardAll(assertProjectPath(projectPath)),
  );

  ipcMain.handle('git:branches', (_event, projectPath) =>
    git.branches(assertProjectPath(projectPath)),
  );

  ipcMain.handle('git:checkout', (_event, projectPath, branch) =>
    git.checkout(assertProjectPath(projectPath), branch),
  );

  ipcMain.handle('git:create-branch', (_event, projectPath, name, startPoint) =>
    git.createBranch(assertProjectPath(projectPath), name, startPoint),
  );

  ipcMain.handle('git:merge', (_event, projectPath, branch) =>
    git.merge(assertProjectPath(projectPath), branch),
  );

  ipcMain.handle('git:merge-into', (_event, projectPath, source, target) =>
    git.mergeInto(assertProjectPath(projectPath), source, target),
  );

  ipcMain.handle('git:head-commit', (_event, projectPath) =>
    git.headCommit(assertProjectPath(projectPath)),
  );

  ipcMain.handle('git:undo-commit', (_event, projectPath) =>
    git.undoCommit(assertProjectPath(projectPath)),
  );

  ipcMain.handle('git:amend', (_event, projectPath, message) =>
    git.amend(assertProjectPath(projectPath), message),
  );

  ipcMain.handle('git:stash-list', (_event, projectPath) =>
    git.stashList(assertProjectPath(projectPath)),
  );

  ipcMain.handle('git:stash-save', (_event, projectPath) =>
    git.stashSave(assertProjectPath(projectPath)),
  );

  ipcMain.handle('git:stash-pop', (_event, projectPath, ref) =>
    git.stashPop(assertProjectPath(projectPath), ref),
  );

  ipcMain.handle('git:stash-drop', (_event, projectPath, ref) =>
    git.stashDrop(assertProjectPath(projectPath), ref),
  );

  ipcMain.handle('git:commit-diff', (_event, projectPath, hash) =>
    git.commitDiff(assertProjectPath(projectPath), hash),
  );

  ipcMain.handle('fs:list', (_event, projectPath, relDir) =>
    fileApi.list(assertProjectPath(projectPath), relDir),
  );

  ipcMain.handle('fs:read', (_event, projectPath, relPath) =>
    fileApi.read(assertProjectPath(projectPath), relPath),
  );

  ipcMain.handle('fs:write', (_event, projectPath, relPath, content, encoding, mtime) =>
    fileApi.write(assertProjectPath(projectPath), relPath, content, encoding, mtime),
  );

  ipcMain.handle('fs:search', (_event, projectPath, query, options) =>
    fileApi.search(assertProjectPath(projectPath), query, options),
  );

  ipcMain.handle('dialog:pick-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择本地项目目录',
      buttonLabel: '选择此目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('pty:create', (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const cwd = assertDirectory(input.cwd);
    const resumeId = typeof input.resumeId === 'string' ? input.resumeId : '';
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
    resolveShell(input.shellId, {
      resume: Boolean(input.resume),
      resumeId,
      sessionId,
    });
    const groupKey = typeof input.groupKey === 'string' ? input.groupKey.slice(0, 120) : '';
    return ptyHost.spawnSession(
      {
        cwd,
        groupKey,
        shellId: input.shellId,
        cols: input.cols,
        rows: input.rows,
        resume: Boolean(input.resume),
        resumeId,
        sessionId,
      },
      send,
    );
  });

  ipcMain.on('pty:write', (_event, id, data) => {
    if (typeof id !== 'string' || typeof data !== 'string') return;
    if (data.length > 1024 * 1024) return;
    ptyHost.writeSession(id, data);
  });

  ipcMain.on('pty:wheel', (_event, id, delta, col, row) => {
    if (typeof id !== 'string') return;
    if (delta !== 120 && delta !== -120) return;
    ptyHost.wheelSession(id, delta, Number(col), Number(row));
  });

  ipcMain.on('pty:click', (_event, id, col, row) => {
    if (typeof id !== 'string') return;
    ptyHost.clickSession(id, Number(col), Number(row));
  });

  ipcMain.on('pty:alt-v', (_event, id) => {
    if (typeof id !== 'string') return;
    ptyHost.altVSession(id);
  });

  ipcMain.on('pty:resize', (_event, id, cols, rows) => {
    if (typeof id !== 'string') return;
    ptyHost.resizeSession(id, cols, rows);
  });

  ipcMain.handle('pty:kill', (_event, id) => {
    ptyHost.killSession(id);
    return true;
  });

  ipcMain.handle('pty:reset-all', () => {
    ptyHost.closeAll();
    return true;
  });

  ipcMain.handle('shell:reveal', async (_event, target) => {
    const directory = assertDirectory(target);
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
    return true;
  });

  ipcMain.handle('shell:open-external', async (_event, url) => {
    if (!validExternalUrl(url)) throw new Error('链接格式不正确');
    await shell.openExternal(String(url));
    return true;
  });

  ipcMain.handle('clipboard:read', () => clipboard.readText());

  ipcMain.handle('clipboard:write', (_event, text) => {
    if (typeof text === 'string') clipboard.writeText(text);
    return true;
  });

  ipcMain.on('panes:sync', (_event, next) => {
    paneApi.setPanes(Array.isArray(next) ? next : []);
  });

  ipcMain.on('panes:attach-browser', (_event, tabId, webContentsId) => {
    paneApi.attachBrowser(tabId, webContentsId);
  });

  // Electron 45 移除了同步的 clipboard.readImage()，只剩异步的 read()/write()。
  // 旧写法会抛 TypeError 并被下面的 catch 吞成 false，表现为「剪贴板里有图也贴不进去」。
  ipcMain.handle('clipboard:has-image', async () => {
    try {
      const items = await clipboard.read();
      return items.some((item) =>
        item.types.some((type) => type.startsWith('image/')),
      );
    } catch {
      return false;
    }
  });
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'webview') paneApi.bindBrowserKeys(contents);
  });

  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'light';
    const mcp = await paneApi.start({
      dataDir: app.getPath('userData'),
      getTerminalOutput: (sessionId) => ptyHost.getLastOutput(sessionId),
    });
    ptyHost.setExtraEnv({
      CMDTOOLBOX_MCP_URL: mcp.url,
      CMDTOOLBOX_MCP_TOKEN: mcp.token,
    });
    mcpConfig.installGlobal(mcp);
    loginItem.repairOnStartup();
    registerIpc();
    createWindow();
    updater.init(send, () => {
      // 装包时 Electron 会马上退出，跳过 before-quit 里 600ms 的缓冲，否则 NSIS 删不掉被占用的 exe
      quittingForUpdate = true;
      ptyHost.interruptCliSessions();
      ptyHost.closeAll();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  let quitStarted = false;
  app.on('window-all-closed', () => {
    ptyHost.closeAll();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (quittingForUpdate) return;
    if (quitStarted) {
      ptyHost.closeAll();
      return;
    }
    event.preventDefault();
    quitStarted = true;
    send('app:will-quit');
    ptyHost.interruptCliSessions();
    setTimeout(() => {
      ptyHost.closeAll();
      app.quit();
    }, 600);
  });
}

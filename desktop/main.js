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
const symbols = require('./symbols');
const { createLoginItem } = require('./login-item');
const { listShells, listTools, resolveShell } = require('./shells');
const aiBridge = require('./ai-bridge');

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

  // 每次重建窗口都重新注入：闭包读的是模块级 mainWindow，窗口换了也能发到新窗口。
  // 窗口不在时必须抛错而不是静默跳过：ai-bridge 靠 send 抛错立即 reject，
  // 否则请求会干等满 15s，AI 会误以为操作还在进行。
  aiBridge.configure({
    send: (payload) => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        const error = new Error('窗口未就绪，无法执行该操作');
        error.code = 'ui-unavailable';
        throw error;
      }
      mainWindow.webContents.send('bridge:request', payload);
    },
  });
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

  ipcMain.handle('symbols:lookup', (_event, projectPath, name, options) => {
    // projectPath 来自渲染进程，只允许查询已保存项目：否则传 `C:\` 就能
    // 递归扫描整个盘并取回源码签名/docblock。
    let knownPath;
    try {
      knownPath = assertProjectPath(projectPath);
    } catch {
      // 未保存的项目不是错误：Ctrl+点击只该表现为「没有找到定义」，
      // 不能让卡片变成红色错误提示。
      return { ok: true, matches: [], truncated: false, scanned: 0 };
    }
    // name 同样来自渲染进程。非字符串经 String() 会变成 "[object Object]"，
    // 长度足够长，从而白白触发一次全项目扫描；这里提前拦截。
    if (typeof name !== 'string' || name.trim().length < 2) {
      return { ok: true, matches: [], truncated: false, scanned: 0 };
    }
    const input = options && typeof options === 'object' ? options : {};
    return symbols.lookup(knownPath, name, input);
  });

  // 打开项目时预热符号索引：用户在编辑器里第一次 Ctrl+点击就已经是快的。
  // 失败不影响任何功能，只是首次点击会等一次建索引。
  ipcMain.handle('symbols:warm', (_event, projectPath) => {
    let knownPath;
    try {
      knownPath = assertProjectPath(projectPath);
    } catch {
      return { ok: false, files: 0 };
    }
    return symbols.warmIndex(knownPath).catch(() => ({ ok: false, files: 0 }));
  });

  // 文件树刷新时调用：外部改动（git 切分支、外部工具写文件）后立即丢掉
  // 符号索引，下一次查询同步重建，不用等 10 分钟 TTL。
  ipcMain.handle('symbols:invalidate', (_event, projectPath) => {
    symbols.invalidate(assertProjectPath(projectPath));
    return { ok: true };
  });

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

  ipcMain.handle('git:file-diff', (_event, projectPath, filePath, changeStatus, base) =>
    git.fileDiff(assertProjectPath(projectPath), filePath, changeStatus, base),
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

  ipcMain.handle('git:blame', (_event, projectPath, filePath, line) =>
    git.blame(assertProjectPath(projectPath), filePath, line),
  );

  ipcMain.handle('git:show-file-diff', (_event, projectPath, hash, filePath) =>
    git.showFileDiff(assertProjectPath(projectPath), hash, filePath),
  );

  ipcMain.handle('fs:list', (_event, projectPath, relDir) =>
    fileApi.list(assertProjectPath(projectPath), relDir),
  );

  ipcMain.handle('fs:read', (_event, projectPath, relPath) =>
    fileApi.read(assertProjectPath(projectPath), relPath),
  );

  ipcMain.handle('fs:write', async (_event, projectPath, relPath, content, encoding, mtime) => {
    const known = assertProjectPath(projectPath);
    const result = await fileApi.write(known, relPath, content, encoding, mtime);
    // 保存后让符号索引失效，否则刚写的函数要等索引过期才查得到
    symbols.invalidate(known);
    return result;
  });

  ipcMain.handle('fs:stat', (_event, projectPath, relPath) =>
    fileApi.stat(assertProjectPath(projectPath), relPath),
  );

  ipcMain.handle('fs:write-minified', async (_event, projectPath, relPath, content) => {
    const known = assertProjectPath(projectPath);
    const result = await fileApi.writeMinified(known, relPath, content);
    symbols.invalidate(known);
    return result;
  });

  // 以下这些都会改动磁盘，成功后让符号索引失效：
  // 否则新建的文件在索引里不存在，Ctrl+点击会漏掉。
  ipcMain.handle('fs:create-file', async (_event, projectPath, relPath, content) => {
    const known = assertProjectPath(projectPath);
    const result = await fileApi.createFile(known, relPath, content);
    symbols.invalidate(known);
    return result;
  });

  ipcMain.handle('fs:create-dir', async (_event, projectPath, relPath) => {
    const known = assertProjectPath(projectPath);
    const result = await fileApi.createDir(known, relPath);
    symbols.invalidate(known);
    return result;
  });

  ipcMain.handle('fs:copy', async (_event, projectPath, fromRel, toRel) => {
    const known = assertProjectPath(projectPath);
    const result = await fileApi.copy(known, fromRel, toRel);
    symbols.invalidate(known);
    return result;
  });

  ipcMain.handle('fs:move', async (_event, projectPath, fromRel, toRel) => {
    const known = assertProjectPath(projectPath);
    const result = await fileApi.move(known, fromRel, toRel);
    symbols.invalidate(known);
    return result;
  });

  ipcMain.handle('fs:trash', async (_event, projectPath, relPath) => {
    const known = assertProjectPath(projectPath);
    const result = await fileApi.trash(known, relPath);
    symbols.invalidate(known);
    return result;
  });

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

  ipcMain.on('bridge:reply', (_event, requestId, ok, payload) => {
    aiBridge.settle(requestId, Boolean(ok), payload);
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
      // terminal_run 需要直接读写 pty，并监听所有会话的输出/退出
      jobs: (jobTools) => {
        jobTools.configure({
          writeSession: (sessionId, data) => ptyHost.writeSession(sessionId, data),
          // 绝对偏移切片：缓冲区按尾部截断，cursor 不能直接用缓冲长度
          getOutputSlice: (sessionId, fromOffset) =>
            ptyHost.getOutputSlice(sessionId, fromOffset),
          isOpen: (sessionId) => ptyHost.isOpen(sessionId),
          findPane: (ref) => paneApi.findPaneForTool(ref),
          panes: () => paneApi.listPanesForTool(),
          subscribeData: (handler) => ptyHost.subscribeAllData(handler),
          subscribeExit: (handler) => ptyHost.subscribeAllExit(handler),
        });
      },
      // 网页里的 target="_blank"：http(s) 在同一个项目里开新的浏览器页签，
      // mailto 交给系统，其余丢弃
      openUrlInNewTab: (tabId, url) => {
        const target = String(url || '');
        if (/^mailto:/i.test(target)) {
          void shell.openExternal(target);
          return;
        }
        if (!validExternalUrl(target)) return;
        send('browser:open-url', { tabId, url: target });
      },
    });
    ptyHost.setExtraEnv({
      CMDTOOLBOX_MCP_URL: mcp.url,
      CMDTOOLBOX_MCP_TOKEN: mcp.token,
    });
    mcpConfig.installGlobal(mcp);
    loginItem.repairOnStartup();
    // Release 列表落盘，重启应用后不必重新打 GitHub API
    updates.configure({ cacheFile: path.join(app.getPath('userData'), 'update-cache.json') });
    // 符号索引按项目落盘，重启应用后不必重建
    symbols.configure({ indexDir: path.join(app.getPath('userData'), 'symbol-index') });
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

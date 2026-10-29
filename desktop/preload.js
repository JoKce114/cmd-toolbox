const { contextBridge, ipcRenderer } = require('electron');

function cleanError(error) {
  const message = error && error.message ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

async function invoke(channel, ...args) {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (error) {
    throw new Error(cleanError(error));
  }
}

function subscribe(channel, handler) {
  const listener = (event, ...args) => handler(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  getInfo: () => invoke('app:info'),

  updates: {
    check: (seenVersion) => invoke('updates:check', seenVersion),
  },

  updater: {
    download: () => invoke('updater:download'),
    install: () => invoke('updater:install'),
    state: () => invoke('updater:state'),
    onEvent: (handler) => subscribe('updater:event', handler),
  },

  session: {
    load: () => invoke('session:load'),
    save: (payload) => invoke('session:save', payload),
    saveSync: (payload) => ipcRenderer.sendSync('session:save-sync', payload),
  },
  onWillQuit: (handler) => subscribe('app:will-quit', handler),

  projects: {
    list: () => invoke('projects:list'),
    save: (project) => invoke('projects:save', project),
    remove: (id) => invoke('projects:remove', id),
    reorder: (ids) => invoke('projects:reorder', ids),
    pickFolder: () => invoke('dialog:pick-folder'),
  },

  pty: {
    create: (payload) => invoke('pty:create', payload),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    wheel: (id, delta, col, row) => ipcRenderer.send('pty:wheel', id, delta, col, row),
    click: (id, col, row) => ipcRenderer.send('pty:click', id, col, row),
    altV: (id) => ipcRenderer.send('pty:alt-v', id),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id) => invoke('pty:kill', id),
    resetAll: () => invoke('pty:reset-all'),
    onData: (handler) => subscribe('pty:data', (id, data) => handler(id, data)),
    onExit: (handler) => subscribe('pty:exit', (id, code) => handler(id, code)),
  },

  shell: {
    reveal: (target) => invoke('shell:reveal', target),
    openExternal: (url) => invoke('shell:open-external', url),
  },

  git: {
    status: (projectPath) => invoke('git:status', projectPath),
    commit: (projectPath, message) => invoke('git:commit', projectPath, message),
    push: (projectPath, options) => invoke('git:push', projectPath, options),
    fileDiff: (projectPath, filePath, changeStatus) =>
      invoke('git:file-diff', projectPath, filePath, changeStatus),
    log: (projectPath, limit) => invoke('git:log', projectPath, limit),
    fetch: (projectPath) => invoke('git:fetch', projectPath),
    pull: (projectPath, options) => invoke('git:pull', projectPath, options),
    repairUpstream: (projectPath) => invoke('git:repair-upstream', projectPath),
    init: (projectPath) => invoke('git:init', projectPath),
    diff: (projectPath, filePath, changeStatus) =>
      invoke('git:diff', projectPath, filePath, changeStatus),
    stage: (projectPath, paths) => invoke('git:stage', projectPath, paths),
    unstage: (projectPath, paths) => invoke('git:unstage', projectPath, paths),
    discard: (projectPath, payload) => invoke('git:discard', projectPath, payload),
    stageAll: (projectPath) => invoke('git:stage-all', projectPath),
    discardAll: (projectPath) => invoke('git:discard-all', projectPath),
    branches: (projectPath) => invoke('git:branches', projectPath),
    checkout: (projectPath, branch) => invoke('git:checkout', projectPath, branch),
    createBranch: (projectPath, name, startPoint) =>
      invoke('git:create-branch', projectPath, name, startPoint),
    merge: (projectPath, branch) => invoke('git:merge', projectPath, branch),
    mergeInto: (projectPath, source, target) =>
      invoke('git:merge-into', projectPath, source, target),
    headCommit: (projectPath) => invoke('git:head-commit', projectPath),
    undoCommit: (projectPath) => invoke('git:undo-commit', projectPath),
    amend: (projectPath, message) => invoke('git:amend', projectPath, message),
  },

  files: {
    list: (projectPath, relDir) => invoke('fs:list', projectPath, relDir),
    read: (projectPath, relPath) => invoke('fs:read', projectPath, relPath),
    write: (projectPath, relPath, content, encoding, mtime) =>
      invoke('fs:write', projectPath, relPath, content, encoding, mtime),
    search: (projectPath, query, options) =>
      invoke('fs:search', projectPath, query, options),
  },

  panes: {
    sync: (panes) => ipcRenderer.send('panes:sync', panes),
    attachBrowser: (tabId, webContentsId) =>
      ipcRenderer.send('panes:attach-browser', tabId, webContentsId),
  },

  clipboard: {
    read: () => invoke('clipboard:read'),
    write: (text) => invoke('clipboard:write', text),
    hasImage: () => invoke('clipboard:has-image'),
  },
});

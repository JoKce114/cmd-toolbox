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

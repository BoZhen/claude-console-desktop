'use strict';
// Bridge for the window's own page (shell/index.html): a fixed set of calls and events.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set([
  'open-in-pane', 'find', 'close-tab', 'cycle-tab', 'toggle-pane', 'reload', 'open-fm',
  'auth-request', 'toast', 'tab-action', 'update-state', 'local-state', 'local-line',
  'switch-computer', 'add-computer', 'edit-computer', 'computer-action', 'attention',
]);

contextBridge.exposeInMainWorld('app', {
  config: () => ipcRenderer.invoke('get-config'),
  // { id?, name, kind: 'local' | 'remote', url } → { config, id, restartForMic }
  saveComputer: (c) => ipcRenderer.invoke('save-computer', c),
  removeComputer: (id) => ipcRenderer.invoke('remove-computer', id),   // asks first; → { removed, config }
  setCurrent: (id) => ipcRenderer.send('set-current', id),
  computerMenu: (id) => ipcRenderer.send('computer-menu', id),
  localRetry: () => ipcRenderer.invoke('local-retry'),
  setOrigins: (o) => ipcRenderer.send('origins', o),   // { id, console, fm, guest }
  savePane: (pane) => ipcRenderer.send('save-pane', pane),   // { id, open, frac, tabs, active }
  openExternal: (url) => ipcRenderer.send('open-external', url),
  authReply: (reply) => ipcRenderer.send('auth-reply', reply),
  showItem: (file) => ipcRenderer.send('show-item', file),
  tabMenu: (tab) => ipcRenderer.send('tab-menu', tab),
  updateInfo: () => ipcRenderer.invoke('desktop-update-info'),
  updateInstall: () => ipcRenderer.invoke('desktop-update-install'),
  on: (channel, fn) => {
    if (EVENTS.has(channel)) ipcRenderer.on(channel, (e, ...args) => fn(...args));
  },
});

'use strict';
// Bridge for the window's own page (shell/index.html): a fixed set of calls and events.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set([
  'open-in-pane', 'find', 'close-tab', 'cycle-tab', 'toggle-pane', 'reload', 'open-fm',
  'edit-url', 'auth-request', 'toast', 'tab-action', 'update-state', 'local-state', 'local-line',
]);

contextBridge.exposeInMainWorld('app', {
  config: () => ipcRenderer.invoke('get-config'),
  setServer: (choice) => ipcRenderer.invoke('set-server', choice),   // { mode: 'local' | 'remote', url }
  localRetry: () => ipcRenderer.invoke('local-retry'),
  setOrigins: (o) => ipcRenderer.send('origins', o),
  savePane: (pane) => ipcRenderer.send('save-pane', pane),
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

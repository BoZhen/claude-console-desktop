'use strict';
// Runs in the console and file-manager pages (isolated world; no Node, no page globals).
const { contextBridge, ipcRenderer } = require('electron');

// Mouse back / forward buttons walk the page's history, as in a browser.
window.addEventListener('mouseup', (e) => {
  if (e.button === 3) { e.preventDefault(); history.back(); }
  if (e.button === 4) { e.preventDefault(); history.forward(); }
});

// The header colours, so the window's tab bar and borders match the page's theme.
// The console switches theme by setting data-theme on <html>.
function reportColors() {
  const header = document.querySelector('header');
  if (!header || !document.body) return;
  const h = getComputedStyle(header);
  ipcRenderer.sendToHost('colors', {
    bar: h.backgroundColor,
    text: h.color,
    page: getComputedStyle(document.body).backgroundColor,
  });
}

window.addEventListener('DOMContentLoaded', () => {
  reportColors();
  new MutationObserver(() => { setTimeout(reportColors, 60); setTimeout(reportColors, 400); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
});

// The console page's Settings > About: the desktop app's version and its updates.
// info() / check() / update() answer with the updater's state (see updater.js);
// "ccd-update-changed" on document says it changed. serverInfo() says where the
// console runs ({ mode: 'local' | 'remote', url, claude }), serverDialog() opens the
// app's Server dialog; "ccd-server-changed" says the server changed.
contextBridge.exposeInMainWorld('ClaudeConsoleDesktop', {
  info: () => ipcRenderer.invoke('desktop-update-info'),
  check: () => ipcRenderer.invoke('desktop-update-check'),
  update: () => ipcRenderer.invoke('desktop-update-install'),
  serverInfo: () => ipcRenderer.invoke('desktop-server-info'),
  serverDialog: () => ipcRenderer.invoke('desktop-server-open'),
});
ipcRenderer.on('desktop-update-changed', () => document.dispatchEvent(new CustomEvent('ccd-update-changed')));
ipcRenderer.on('desktop-server-changed', () => document.dispatchEvent(new CustomEvent('ccd-server-changed')));

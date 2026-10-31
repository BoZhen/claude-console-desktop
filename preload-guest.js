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

// The console's drawer, for the window's rail. The page's own rail is hidden in this
// app, but its buttons still say which drawer tab is open (class "on"), and its Agents
// button's badge how many subagents run in the session shown. Sent when it changes:
// { agents: the page has an Agents tab, running: the badge's text ('' when none run),
//   title, open: 'agents' | 'side' | '', badgeBg, badgeFg: the badge's colours }.
let lastDrawer = '';
function reportDrawer() {
  const agents = document.getElementById('prAgents');
  const side = document.getElementById('prSide');
  const badge = agents && agents.querySelector('.rbadge');
  const on = (b) => !!b && b.classList.contains('on');
  const st = {
    agents: !!agents,
    running: badge && !badge.hidden ? badge.textContent : '',
    title: agents ? agents.title : '',
    open: on(agents) ? 'agents' : on(side) ? 'side' : '',
    badgeBg: badge ? getComputedStyle(badge).backgroundColor : '',
    badgeFg: badge ? getComputedStyle(badge).color : '',
  };
  const key = JSON.stringify(st);
  if (key === lastDrawer) return;
  lastDrawer = key;
  ipcRenderer.sendToHost('drawer', st);
}

window.addEventListener('DOMContentLoaded', () => {
  reportColors();
  new MutationObserver(() => {
    setTimeout(reportColors, 60); setTimeout(reportColors, 400);
    setTimeout(reportDrawer, 60);   // a theme brings its own badge colours
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  const rail = document.getElementById('prail');
  if (!rail) return;   // the file manager, or a console without the rail
  reportDrawer();
  new MutationObserver(reportDrawer).observe(rail, {
    subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'title'],
  });
});

// The console page's Settings > About: the desktop app's version and its updates.
// info() / check() / update() answer with the updater's state (see updater.js);
// "ccd-update-changed" on document says it changed. serverInfo() says where the
// console runs ({ mode: 'local' | 'remote', url, name, computers, claude }), serverDialog() opens the
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

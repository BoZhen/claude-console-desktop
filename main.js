'use strict';
/*
 * Claude Console desktop: one window that holds the Claude Console page and, in a
 * side pane with tabs, the web file manager and every file the chat links to.
 *
 * The window loads a local page (shell/index.html) that lays out <webview> elements:
 * the console on the left, the pane tabs on the right. This file decides where links
 * go, answers HTTP logins, handles downloads, permissions, the context menu and the
 * keyboard shortcuts the pages must not swallow. The console either runs on another
 * computer (an address) or on this one, started and stopped by the app (localserver.js).
 */
const {
  app, BrowserWindow, Menu, ipcMain, shell, session, safeStorage, clipboard,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createUpdater } = require('./updater');
const { LocalServer, serverFiles, CONSOLE_PORT, FM_PORT: LOCAL_FM_PORT } = require('./localserver');

/* The console addresses tried in order until one answers, unless an address was
   chosen (Server…, --url, CLAUDE_CONSOLE_URL). They come from config.json
   beside this file: a local file that git ignores (see config.example.json), which
   scripts/stage.sh copies into packages and updates. Several addresses are for one
   console reached over different networks. Without the file the list is empty and
   the app asks for an address on first start. */
const CONFIG_FILE = path.join(__dirname, 'config.json');
const DEFAULT_URLS = readConfigUrls();
const IS_MAC = process.platform === 'darwin';
const FM_PORT = 7701;   // the console's own fallback for the file manager address

// ------------------------------------------------------------------ settings

let settings = {};
const userFile = (name) => path.join(app.getPath('userData'), name);

function loadJson(name) {
  try { return JSON.parse(fs.readFileSync(userFile(name), 'utf8')); } catch { return {}; }
}

function saveJson(name, value, mode) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const file = userFile(name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), { mode: mode || 0o644 });
  fs.renameSync(file + '.tmp', file);
}

const saveSettings = () => saveJson('settings.json', settings);

function argValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

/** "192.168.1.10:7703" → "http://192.168.1.10:7703/"; throws on anything but http(s). */
function normalizeUrl(text) {
  let t = String(text || '').trim();
  if (!t) throw new Error('Enter an address');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = 'http://' + t;
  const u = new URL(t);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https addresses work');
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** config.json's "urls", normalized; [] without the file or on a bad entry. */
function readConfigUrls() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return []; }
  const list = [];
  for (const u of Array.isArray(cfg && cfg.urls) ? cfg.urls : []) {
    try { list.push(normalizeUrl(u)); } catch { /* skip it */ }
  }
  return list;
}

/* Where the console runs: 'local' (this computer: the app starts it, localserver.js)
   or 'remote' (an address). --url and CLAUDE_CONSOLE_URL force an address, --local
   and CLAUDE_CONSOLE_LOCAL=1 this computer. '' until the first start has asked. */
function serverMode() {
  if (argValue('url') || process.env.CLAUDE_CONSOLE_URL) return 'remote';
  if (process.argv.includes('--local') || process.env.CLAUDE_CONSOLE_LOCAL === '1') return 'local';
  if (settings.server === 'local' || settings.server === 'remote') return settings.server;
  return settings.url || DEFAULT_URLS.length || process.env.CLAUDE_CONSOLE_URLS ? 'remote' : '';
}

/* The console and file manager on this computer. Its folder holds the Python
   environment, the logs and the file manager's login; settings.json "localPorts"
   ({ "console": 17703, "fm": 17701 }) moves the ports. */
let local = null;
function localServer() {
  if (!local) {
    const ports = settings.localPorts || {};
    local = new LocalServer({
      dataDir: path.join(app.getPath('userData'), 'server'),
      files: serverFiles({ resourcesPath: app.isPackaged ? process.resourcesPath : null, appDir: __dirname }),
      consolePort: Number(ports.console) || CONSOLE_PORT,
      fmPort: Number(ports.fm) || LOCAL_FM_PORT,
    });
    local.on('state', (s) => { send('local-state', s); notifyGuests('desktop-server-changed'); });
    local.on('line', (line) => send('local-line', line));
  }
  return local;
}
const localUrl = () => localServer().url;

/** The console addresses to try, in order: on this computer its own address, else
    remoteUrls(). */
function consoleUrls() {
  return serverMode() === 'local' ? [localUrl()] : remoteUrls();
}

/** Another computer's console: the chosen address, else DEFAULT_URLS
    (CLAUDE_CONSOLE_URLS, comma-separated, replaces that list). */
function remoteUrls() {
  for (const candidate of [argValue('url'), process.env.CLAUDE_CONSOLE_URL, settings.url]) {
    if (!candidate) continue;
    try { return [normalizeUrl(candidate)]; } catch { /* fall through to the next one */ }
  }
  const list = [];
  for (const u of (process.env.CLAUDE_CONSOLE_URLS || '').split(',')) {
    try { if (u.trim()) list.push(normalizeUrl(u)); } catch { /* skip it */ }
  }
  return list.length ? list : DEFAULT_URLS;
}

function defaultFmOrigin(url) {
  if (!url) return '';
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}:${FM_PORT}`;
}

// ------------------------------------------------------------------ origins

/* Pages from these two origins stay in the app; everything else opens in the
   system browser. The shell reports the file manager address once the console page
   has loaded (it is the page's own webfmBase()). */
const origins = { console: '', fm: '' };
let consoleGuestId = -1;

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

function isInternal(url) {
  const o = originOf(url);
  return o !== '' && (o === origins.console || o === origins.fm);
}

// ------------------------------------------------------------------ window

let win = null;

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function createWindow() {
  const b = settings.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1500,
    height: b.height || 950,
    x: b.x,
    y: b.y,
    minWidth: 760,
    minHeight: 480,
    title: 'Claude Console',
    // run from the checkout, your own icon (assets/local, git-ignored) if there is one;
    // a package carries the one it was built with as assets/icon.png
    icon: [path.join(__dirname, 'assets', 'local', 'icon.png'), path.join(__dirname, 'assets', 'icon.png')].find((f) => fs.existsSync(f)),
    backgroundColor: '#252526',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-shell.js'),
      webviewTag: true,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (settings.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.webContents.once('did-finish-load', () => { if (updater) updater.started(); });
  win.loadFile(path.join(__dirname, 'shell', 'index.html'));

  // Size and place are saved as they change, so they survive a crash or a kill too.
  let boundsTimer = null;
  const rememberBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      settings.maximized = win.isMaximized();
      settings.bounds = win.getNormalBounds();
      saveSettings();
    }, 800);
  };
  win.on('resize', rememberBounds);
  win.on('move', rememberBounds);
  win.on('close', () => {
    clearTimeout(boundsTimer);
    settings.maximized = win.isMaximized();
    settings.bounds = win.getNormalBounds();
    saveSettings();
  });
  win.on('closed', () => { win = null; });

  const wc = win.webContents;
  // The shell page itself never navigates (a file dropped outside the console would).
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('before-input-event', (e, input) => { if (shortcut(input, null)) e.preventDefault(); });

  wc.on('will-attach-webview', (e, prefs, params) => {
    // Every guest gets the same locked-down preferences, whatever the markup asked for.
    prefs.preload = path.join(__dirname, 'preload-guest.js');
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.spellcheck = false;
    if (params.src && !/^(https?:|about:blank)/.test(params.src)) e.preventDefault();
  });
  wc.on('did-attach-webview', (e, guest) => setupGuest(guest));
}

function setupGuest(guest) {
  // target=_blank links and window.open(): ours go to a pane tab, the rest to the browser.
  guest.setWindowOpenHandler(({ url }) => {
    route(url);
    return { action: 'deny' };
  });
  guest.on('will-navigate', (details) => {
    const url = details.url;
    if (!details.isMainFrame) return;
    const isConsole = guest.id === consoleGuestId;
    const stay = isConsole ? originOf(url) === origins.console : isInternal(url);
    if (stay) return;
    details.preventDefault();
    route(url);
  });
  guest.on('context-menu', (e, params) => contextMenu(guest, params));
  guest.on('before-input-event', (e, input) => { if (shortcut(input, guest)) e.preventDefault(); });
}

function route(url) {
  if (isInternal(url)) {
    send('open-in-pane', url);
    return;
  }
  let u;
  try { u = new URL(url); } catch { return; }
  if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') shell.openExternal(url);
}

// ------------------------------------------------------------------ keyboard

/* Shortcuts handled here, before the page sees the key. Escape is never taken: in the
   console, Escape interrupts a running turn. Ctrl+W closes a pane tab, never the window. */
function shortcut(input, guest) {
  if (input.type !== 'keyDown') return false;
  const mod = IS_MAC ? input.meta : input.control;
  const key = (input.key || '').toLowerCase();
  const where = guest ? (guest.id === consoleGuestId ? 'console' : 'pane') : 'shell';
  if (process.env.CCD_DEBUG) console.log(`[key] ${input.key} ctrl=${input.control} from=${where} guest=${guest && guest.id}`);

  if (mod && !input.alt && !input.shift && key === 'f') { send('find', where); return true; }
  if (mod && !input.alt && key === 'w') { send('close-tab'); return true; }
  if (input.control && key === 'tab') { send('cycle-tab', input.shift ? -1 : 1); return true; }
  if (mod && input.code === 'Backslash') { send('toggle-pane'); return true; }
  if ((mod && !input.alt && key === 'r') || key === 'f5') { send('reload', where, input.shift); return true; }
  if (key === 'f12' || (mod && input.shift && key === 'i') || (IS_MAC && input.meta && input.alt && key === 'i')) {
    (guest || win.webContents).toggleDevTools();
    return true;
  }
  if (guest && mod && !input.alt && (key === '=' || key === '+' || key === '-' || key === '0')) {
    const level = key === '0' ? 0 : guest.getZoomLevel() + (key === '-' ? -0.5 : 0.5);
    guest.setZoomLevel(Math.max(-4, Math.min(4, level)));
    return true;
  }
  const back = IS_MAC ? input.meta && input.code === 'BracketLeft' : input.alt && key === 'arrowleft';
  const fwd = IS_MAC ? input.meta && input.code === 'BracketRight' : input.alt && key === 'arrowright';
  if (guest && (back || fwd)) {
    const h = guest.navigationHistory;
    if (back && h.canGoBack()) h.goBack();
    if (fwd && h.canGoForward()) h.goForward();
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ context menu

function contextMenu(guest, p) {
  if (process.env.CCD_DEBUG) console.log(`[context-menu] guest=${guest.id} link=${p.linkURL} editable=${p.isEditable}`);
  const t = [];
  const sep = () => t.push({ type: 'separator' });
  const link = p.linkURL && /^(https?|mailto):/i.test(p.linkURL) ? p.linkURL : '';
  if (link) {
    if (isInternal(link) && guest.id === consoleGuestId) t.push({ label: 'Open in side pane', click: () => send('open-in-pane', link) });
    if (isInternal(link) && guest.id !== consoleGuestId) t.push({ label: 'Open in new tab', click: () => send('open-in-pane', link) });
    t.push({ label: 'Open in browser', click: () => shell.openExternal(link) });
    t.push({ label: 'Copy link address', click: () => clipboard.writeText(link) });
    sep();
  }
  if (p.mediaType === 'image' && p.srcURL) {
    t.push({ label: 'Copy image', click: () => guest.copyImageAt(p.x, p.y) });
    t.push({ label: 'Save image as…', click: () => guest.downloadURL(p.srcURL) });
    sep();
  }
  const f = p.editFlags || {};
  if (p.isEditable) {
    t.push({ label: 'Undo', enabled: f.canUndo, click: () => guest.undo() });
    t.push({ label: 'Redo', enabled: f.canRedo, click: () => guest.redo() });
    sep();
    t.push({ label: 'Cut', enabled: f.canCut, click: () => guest.cut() });
    t.push({ label: 'Copy', enabled: f.canCopy, click: () => guest.copy() });
    t.push({ label: 'Paste', enabled: f.canPaste, click: () => guest.paste() });
    t.push({ label: 'Select all', click: () => guest.selectAll() });
    sep();
  } else if (p.selectionText) {
    t.push({ label: 'Copy', click: () => guest.copy() });
    sep();
  }
  const h = guest.navigationHistory;
  t.push({ label: 'Back', enabled: h.canGoBack(), click: () => h.goBack() });
  t.push({ label: 'Reload', click: () => guest.reload() });
  sep();
  t.push({ label: 'Inspect element', click: () => guest.inspectElement(p.x, p.y) });
  popup(t);
}

/** Pops up a menu template after dropping leading, trailing and doubled separators. */
function popup(template) {
  if (process.env.CCD_DEBUG) console.log(`[popup] ${template.length} items`);
  const items = template.filter((it, i, a) =>
    it.type !== 'separator' || (i > 0 && i < a.length - 1 && a[i - 1].type !== 'separator'));
  if (win) Menu.buildFromTemplate(items).popup({ window: win });
}

// ------------------------------------------------------------------ HTTP logins

/* The file manager asks for HTTP Basic Auth. Logins the user chose to remember are
   kept encrypted with the system keyring (safeStorage: KWallet / libsecret / Keychain).
   A saved login is offered once per URL; if the same URL asks again right away, the
   saved login was refused, and the user is asked. */
const LOGIN_FILE = 'logins.json';
const offered = new Map();          // url → time the saved login was offered for it
const prompts = new Map();          // login key → { id, callbacks: [] }
let promptSeq = 0;

function readLogin(key) {
  const blob = loadJson(LOGIN_FILE)[key];
  if (!blob || !safeStorage.isEncryptionAvailable()) return null;
  try { return JSON.parse(safeStorage.decryptString(Buffer.from(blob, 'base64'))); } catch { return null; }
}

function writeLogin(key, login) {
  const all = loadJson(LOGIN_FILE);
  if (login) all[key] = safeStorage.encryptString(JSON.stringify(login)).toString('base64');
  else delete all[key];
  saveJson(LOGIN_FILE, all, 0o600);
}

app.on('login', (event, wc, details, authInfo, callback) => {
  if (authInfo.isProxy) return;
  event.preventDefault();
  const key = `${authInfo.scheme}|${authInfo.host}:${authInfo.port}|${authInfo.realm}`;
  const url = details.url;
  // The file manager the app started has a login only the app knows.
  if (local && serverMode() === 'local' && authInfo.host === '127.0.0.1' && Number(authInfo.port) === local.fmPort
      && Date.now() - (offered.get(url) || 0) > 10000) {
    offered.set(url, Date.now());
    const c = local.fmCredentials();
    callback(c.user, c.pass);
    return;
  }
  const saved = readLogin(key);
  const last = offered.get(url) || 0;
  const refused = Date.now() - last < 10000;
  if (saved && !refused) {
    offered.set(url, Date.now());
    callback(saved.user, saved.pass);
    return;
  }
  const open = prompts.get(key);
  if (open) { open.callbacks.push(callback); return; }
  if (!win) { callback(); return; }
  const id = ++promptSeq;
  prompts.set(key, { id, callbacks: [callback], url });
  send('auth-request', {
    id,
    host: `${authInfo.host}:${authInfo.port}`,
    realm: authInfo.realm,
    retry: refused,
    canRemember: safeStorage.isEncryptionAvailable(),
  });
});

ipcMain.on('auth-reply', (e, reply) => {
  for (const [key, p] of prompts) {
    if (p.id !== reply.id) continue;
    prompts.delete(key);
    if (reply.user == null) {
      for (const cb of p.callbacks) cb();
      return;
    }
    if (reply.remember && safeStorage.isEncryptionAvailable()) writeLogin(key, { user: reply.user, pass: reply.pass });
    else if (readLogin(key)) writeLogin(key, null);
    offered.set(p.url, Date.now());
    for (const cb of p.callbacks) cb(reply.user, reply.pass);
    return;
  }
});

// ------------------------------------------------------------------ downloads, permissions

const savedFiles = new Set();
const reserved = new Set();   // paths of downloads still running

/** "name.ext", or "name (1).ext", "name (2).ext", … if taken. */
function freePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || 'download';
  let file = path.join(dir, name || 'download');
  for (let i = 1; fs.existsSync(file) || reserved.has(file); i++) file = path.join(dir, `${stem} (${i})${ext}`);
  return file;
}

function setupSession() {
  const ses = session.defaultSession;
  ses.on('will-download', (e, item) => {
    // Straight into Downloads, as a browser does by default; never over an existing file.
    const file = freePath(app.getPath('downloads'), item.getFilename());
    reserved.add(file);
    item.setSavePath(file);
    item.once('done', (ev, state) => {
      reserved.delete(file);
      if (state === 'completed') {
        savedFiles.add(item.getSavePath());
        send('toast', { text: `Saved ${path.basename(item.getSavePath())}`, path: item.getSavePath() });
      } else if (state === 'interrupted') {
        send('toast', { text: `Download failed: ${item.getFilename()}` });
      }
    });
  });

  // The console's microphone and clipboard buttons; nothing for other origins.
  const allowed = new Set(['media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'notifications']);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = details.requestingUrl || (wc && wc.getURL()) || '';
    if (!isInternal(url) || !allowed.has(permission)) return callback(false);
    if (permission === 'media' && (details.mediaTypes || []).includes('video')) return callback(false);
    callback(true);
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => isInternal(origin) && allowed.has(permission));
}

// ------------------------------------------------------------------ updates

let updater = null;
function setupUpdater() {
  updater = createUpdater({
    consoleOrigin: () => origins.console,
    onChange: (state) => {
      send('update-state', state);
      notifyGuests('desktop-update-changed');   // the console page's Settings > About follows too
    },
  });
}

function notifyGuests(channel) {
  for (const wc of require('electron').webContents.getAllWebContents()) {
    if (wc.getType() === 'webview' && !wc.isDestroyed()) wc.send(channel);
  }
}
// From the shell (the rail's update button) and the console page (Settings > About).
ipcMain.handle('desktop-update-info', () => (updater ? updater.info() : null));
ipcMain.handle('desktop-update-check', () => (updater ? updater.check() : null));
ipcMain.handle('desktop-update-install', () => (updater ? updater.install() : null));

// ------------------------------------------------------------------ IPC from the shell

function shellConfig() {
  return {
    mode: serverMode(),
    urls: consoleUrls(),
    chosen: !!settings.url,
    remoteUrl: settings.url || '',
    remoteUrls: remoteUrls(),
    defaults: DEFAULT_URLS.length,
    local: local ? local.state : null,
    fmOrigin: origins.fm,
    pane: settings.pane || {},
    platform: process.platform,
  };
}
ipcMain.handle('get-config', shellConfig);

/* The Server dialog. This computer: start the servers here (progress goes out as
   local-state). Another computer: an address, or empty to go back to trying
   DEFAULT_URLS, when config.json has some; the servers here stop. */
ipcMain.handle('set-server', async (e, { mode, url } = {}) => {
  if (mode === 'local') {
    settings.server = 'local';
    saveSettings();
    origins.console = originOf(localUrl());
    localServer().start();
  } else {
    if (!String(url || '').trim()) {
      if (!DEFAULT_URLS.length) throw new Error('Enter the address of your Claude Console server');
      delete settings.url;
    } else {
      settings.url = normalizeUrl(url);   // throws: the shell shows the message
    }
    settings.server = 'remote';
    saveSettings();
    if (local) await local.stop();
    origins.console = originOf(consoleUrls()[0]);
  }
  notifyGuests('desktop-server-changed');
  return shellConfig();
});
ipcMain.handle('local-retry', () => { if (serverMode() === 'local') localServer().start(); });

// From the console page's Settings > About: where the console runs, and the dialog.
ipcMain.handle('desktop-server-info', () => {
  const mode = serverMode();
  return { mode, url: consoleUrls()[0] || '', claude: mode === 'local' && local ? local.state.claude || '' : '' };
});
ipcMain.handle('desktop-server-open', () => { send('edit-url'); if (win) win.focus(); });

ipcMain.on('origins', (e, o) => {
  if (o.console) origins.console = originOf(o.console);
  if (o.fm) {
    origins.fm = originOf(o.fm);
    if (settings.fmOrigin !== origins.fm) { settings.fmOrigin = origins.fm; saveSettings(); }
  }
  if (typeof o.consoleGuestId === 'number') consoleGuestId = o.consoleGuestId;
});

ipcMain.on('save-pane', (e, pane) => { settings.pane = pane; saveSettings(); });

ipcMain.on('open-external', (e, url) => {
  if (/^https?:\/\//i.test(String(url))) shell.openExternal(url);
});

ipcMain.on('show-item', (e, file) => { if (savedFiles.has(file)) shell.showItemInFolder(file); });

ipcMain.on('tab-menu', (e, tab) => {
  const act = (action) => () => send('tab-action', { id: tab.id, action });
  popup([
    { label: 'Reload', click: act('reload') },
    { label: 'Open in browser', click: act('browser') },
    { label: 'Copy address', click: () => clipboard.writeText(tab.url || '') },
    { type: 'separator' },
    { label: 'Close', enabled: !!tab.closable, click: act('close') },
    { label: 'Close other tabs', click: act('close-others') },
    { label: 'Close all file tabs', click: act('close-all') },
  ]);
});

// ------------------------------------------------------------------ app menu

function buildMenu() {
  const t = [];
  if (IS_MAC) t.push({ role: 'appMenu' });
  t.push({
    label: 'File',
    submenu: [
      { label: 'Server…', click: () => send('edit-url') },
      { type: 'separator' },
      IS_MAC ? { role: 'close' } : { role: 'quit' },
    ],
  });
  t.push({ role: 'editMenu' });
  t.push({
    label: 'View',
    submenu: [
      { label: 'File manager', click: () => send('open-fm') },
      // The keys themselves are handled in shortcut(); here they are only shown.
      { label: 'Show / hide side pane', accelerator: 'CmdOrCtrl+\\', registerAccelerator: false, click: () => send('toggle-pane') },
      { label: 'Find…', accelerator: 'CmdOrCtrl+F', registerAccelerator: false, click: () => send('find', 'last') },
      { type: 'separator' },
      { label: 'Reload console', click: () => send('reload', 'console', false) },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });
  t.push({ role: 'windowMenu' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

// ------------------------------------------------------------------ start

settings = loadJson('settings.json');
{
  // Plain-http pages are no "secure context", so Chromium hides the microphone and the
  // async clipboard from them. These origins are the user's own; treat them as secure.
  // (The switch is read once at start, so it lists every address that may be used.)
  const urls = consoleUrls();
  origins.console = originOf(urls[0]);
  origins.fm = settings.fmOrigin || defaultFmOrigin(urls[0]);
  const plain = new Set([origins.fm]);
  for (const u of urls) { plain.add(originOf(u)); plain.add(defaultFmOrigin(u)); }
  const http = [...plain].filter((o) => o && o.startsWith('http:'));
  if (http.length) app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', http.join(','));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    setupSession();
    buildMenu();
    setupUpdater();
    createWindow();
    if (serverMode() === 'local') localServer().start();
  });
  app.on('window-all-closed', () => app.quit());
  // The servers on this computer stop with the app, the claude processes they run too.
  let stopped = false;
  app.on('will-quit', (e) => {
    if (stopped || !local || !Object.keys(local.children).length) return;
    e.preventDefault();
    stopped = true;
    local.stop({ quiet: true }).finally(() => app.quit());
  });
  // Pages other than the shell never get a window of their own.
  app.on('web-contents-created', (e, wc) => {
    if (wc.getType() !== 'webview' && wc.getType() !== 'window') wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

'use strict';
/*
 * Claude Console desktop: one window that holds Claude Console and, in a side pane
 * with tabs, the web file manager and every file the chat links to.
 *
 * The window loads a local page (shell/index.html) that lays out <webview> elements:
 * the console on the left, the pane tabs on the right. It can hold several computers,
 * each with its own Claude Console (computers.js): one is shown, the others keep running,
 * and the rail switches between them. A computer is another one at an address, or this
 * one, where the app starts the console itself (localserver.js).
 *
 * This file decides where links go, answers HTTP logins, handles downloads,
 * permissions, the context menu and the keyboard shortcuts the pages must not swallow,
 * and watches the computers not shown for approvals and questions waiting.
 */
const {
  app, BrowserWindow, Menu, ipcMain, shell, session, safeStorage, clipboard, net,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createUpdater } = require('./updater');
const { LocalServer, serverFiles, CONSOLE_PORT, FM_PORT: LOCAL_FM_PORT } = require('./localserver');
const {
  normalizeUrl, configComputers, urlsFor, displayName, nextId, loadComputers,
} = require('./computers');

/* config.json beside this file: a local file that git ignores (see
   config.example.json), which scripts/stage.sh copies into packages and updates. It
   names the computers a build starts with: "urls" for one (several addresses of the
   same console, over different networks), "computers" for several. Without the file
   the app asks on first start where the console runs. */
const CONFIG_FILE = path.join(__dirname, 'config.json');
const CONFIG_COMPUTERS = configComputers(readConfig(), process.env.CLAUDE_CONSOLE_URLS);
const IS_MAC = process.platform === 'darwin';
const FM_PORT = 7701;   // the console's own fallback for the file manager address

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; }
}

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

// ------------------------------------------------------------------ computers

/* The list, in rail order, and the one shown. --url / CLAUDE_CONSOLE_URL and
   --local / CLAUDE_CONSOLE_LOCAL=1 replace the list for one run (transient: not saved). */
let computers = [];
let currentId = '';
let transient = false;

const byId = (id) => computers.find((c) => c.id === id) || null;
const currentComputer = () => byId(currentId) || computers[0] || null;
const hasLocal = () => computers.some((c) => c.kind === 'local');
const nameOf = (c) => displayName(c, CONFIG_COMPUTERS);

function saveComputers() {
  if (transient) return;
  settings.computers = computers;
  settings.current = currentId;
  saveSettings();
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

/** The console addresses to try for a computer, in order. */
function consoleUrlsOf(c) {
  if (!c) return [];
  return c.kind === 'local' ? [localUrl()] : urlsFor(c, CONFIG_COMPUTERS);
}

function defaultFmOrigin(url) {
  if (!url) return '';
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}:${FM_PORT}`;
}

// ------------------------------------------------------------------ origins

/* Pages from a computer's console and file manager stay in the app; everything else
   opens in the system browser. Once a console page has loaded, the shell reports its
   origin and the file manager's (the page's own webfmBase()); until then they follow
   from the computer's first address. */
const live = new Map();            // computer id → { console, fm } as reported
const consoleGuests = new Map();   // console webContents id → computer id

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

function originsOf(c) {
  const l = live.get(c.id) || {};
  const first = consoleUrlsOf(c)[0] || '';
  return {
    console: l.console || originOf(first),
    fm: l.fm || (settings.fmOrigins || {})[c.id]
      || (c.kind === 'local' ? originOf(localServer().fmUrl) : defaultFmOrigin(first)),
  };
}

function isInternal(url) {
  const o = originOf(url);
  if (!o) return false;
  return computers.some((c) => { const x = originsOf(c); return o === x.console || o === x.fm; });
}

/** The console origin of the computer whose console page this guest is, else ''. */
function consoleOriginOfGuest(guestId) {
  const c = byId(consoleGuests.get(guestId));
  return c ? originsOf(c).console : '';
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
    // The consoles not shown keep running at full speed: their sessions stream on.
    prefs.backgroundThrottling = false;
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
    const own = consoleOriginOfGuest(guest.id);
    const stay = consoleGuests.has(guest.id) ? originOf(url) === own : isInternal(url);
    if (stay) return;
    details.preventDefault();
    route(url);
  });
  guest.on('context-menu', (e, params) => contextMenu(guest, params));
  guest.on('before-input-event', (e, input) => { if (shortcut(input, guest)) e.preventDefault(); });
}

/** A link: one of the computers' pages goes to a pane tab (the shell picks the
    computer by its origin), anything else to the browser. */
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
   console, Escape interrupts a running turn. Ctrl+W closes a pane tab, never the window.
   Ctrl+1…9 (⌘ on macOS) switch computers, and are only taken when there are several. */
function shortcut(input, guest) {
  if (input.type !== 'keyDown') return false;
  const mod = IS_MAC ? input.meta : input.control;
  const key = (input.key || '').toLowerCase();
  const where = guest ? (consoleGuests.has(guest.id) ? 'console' : 'pane') : 'shell';
  if (process.env.CCD_DEBUG) console.log(`[key] ${input.key} ctrl=${input.control} from=${where} guest=${guest && guest.id}`);

  if (mod && !input.alt && !input.shift && /^Digit[1-9]$/.test(input.code || '') && computers.length > 1) {
    send('switch-computer', Number(input.code.slice(5)) - 1);
    return true;
  }
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
  const isConsole = consoleGuests.has(guest.id);
  if (link) {
    if (isInternal(link) && isConsole) t.push({ label: 'Open in side pane', click: () => send('open-in-pane', link) });
    if (isInternal(link) && !isConsole) t.push({ label: 'Open in new tab', click: () => send('open-in-pane', link) });
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
  if (local && hasLocal() && authInfo.host === '127.0.0.1' && Number(authInfo.port) === local.fmPort
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
    // the computer shown: any console serves the same signed updates
    consoleOrigin: () => { const c = currentComputer(); return c ? originsOf(c).console : ''; },
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

// ------------------------------------------------------------------ waiting on other computers

/* With several computers, each console's api/notify/stream (the feed the phone app's
   notifications use) tells what waits there: approvals and questions, and turns that
   finished. The shell puts a dot on the computers not shown. A console without the
   stream (an older version) answers 404 and gets no dot. */
const streams = new Map();   // computer id → { origin, stop }

function syncStreams() {
  const want = new Map();
  if (computers.length > 1) {
    for (const c of computers) {
      const o = (live.get(c.id) || {}).console;
      if (o) want.set(c.id, o);
    }
  }
  for (const [id, s] of streams) {
    if (want.get(id) === s.origin) continue;
    s.stop();
    streams.delete(id);
    send('attention', { id, waiting: 0 });
  }
  for (const [id, origin] of want) if (!streams.has(id)) streams.set(id, watch(id, origin));
}

function watch(id, origin) {
  const ctrl = new AbortController();
  let timer = null;
  let delay = 5000;
  let waiting = new Map();   // "session|aid" → item
  const report = () => send('attention', { id, waiting: waiting.size, first: [...waiting.values()][0] || null });
  const onMessage = (m) => {
    const key = `${m.session}|${m.aid}`;
    if (m.type === 'snapshot') waiting = new Map((m.waiting || []).map((w) => [`${w.session}|${w.aid}`, w]));
    else if (m.type === 'waiting') waiting.set(key, m);
    else if (m.type === 'resolved') waiting.delete(key);
    else if (m.type === 'ended') { for (const k of [...waiting.keys()]) if (k.startsWith(`${m.session}|`)) waiting.delete(k); }
    else if (m.type === 'finished') { send('attention', { id, finished: true }); return; }
    else return;
    report();
  };
  const run = async () => {
    try {
      const res = await net.fetch(`${origin}/api/notify/stream`, { signal: ctrl.signal, headers: { Accept: 'text/event-stream' } });
      if (res.status === 404) return;
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      delay = 5000;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (data) { try { onMessage(JSON.parse(data)); } catch { /* not an event */ } }
        }
      }
    } catch { /* unreachable, or the link dropped */ }
    if (ctrl.signal.aborted) return;
    if (waiting.size) { waiting = new Map(); report(); }   // unknown until the next snapshot
    timer = setTimeout(run, delay);
    delay = Math.min(delay * 2, 60000);
  };
  run();
  return { origin, stop: () => { ctrl.abort(); clearTimeout(timer); } };
}

// ------------------------------------------------------------------ IPC from the shell

/* Origins treated as secure (read once at start, see below): a computer added later
   at a plain-http address gets the microphone and the clipboard after a restart. */
const secureAtStart = new Set();

function computerInfo(c) {
  const entry = c.config ? CONFIG_COMPUTERS.find((e) => e.key === c.config) : null;
  return {
    id: c.id,
    name: nameOf(c),
    givenName: c.name || '',
    kind: c.kind,
    urls: consoleUrlsOf(c),
    url: c.url || '',
    configUrls: entry ? entry.urls : [],
    // this computer's file manager, known before its console page has loaded
    fm: c.kind === 'local' ? originOf(localServer().fmUrl) : '',
  };
}

function shellConfig() {
  return {
    computers: computers.map(computerInfo),
    current: currentId,
    transient,
    local: local ? local.state : null,
    panes: settings.panes || {},
    frac: settings.paneFrac,
    fmOrigins: settings.fmOrigins || {},
    platform: process.platform,
  };
}
ipcMain.handle('get-config', shellConfig);

/* Add a computer (no id) or change one: its name, and this computer or another one at
   an address. An empty address on a computer from config.json goes back to
   config.json's addresses. Only one entry can be this computer. */
ipcMain.handle('save-computer', async (e, { id, name, kind, url } = {}) => {
  const existing = id ? byId(id) : null;
  if (id && !existing) throw new Error('That computer is no longer in the list');
  kind = kind === 'local' ? 'local' : 'remote';
  if (kind === 'local' && computers.some((c) => c.kind === 'local' && c !== existing)) {
    throw new Error('This computer is already in the list');
  }
  const c = existing ? { ...existing } : { id: kind === 'local' && !byId('local') ? 'local' : nextId(computers) };
  c.kind = kind;
  c.name = String(name || '').trim();
  if (kind === 'local') {
    delete c.url;
    delete c.config;
  } else {
    const text = String(url || '').trim();
    if (text) c.url = normalizeUrl(text);   // throws: the shell shows the message
    else if (c.config) delete c.url;
    else throw new Error('Enter the address of your Claude Console server');
  }
  if (existing) computers[computers.indexOf(existing)] = c;
  else computers.push(c);
  currentId = c.id;
  live.delete(c.id);   // its page reports again once it has loaded
  saveComputers();
  if (c.kind === 'local') localServer().start();
  else if (existing && existing.kind === 'local' && local) await local.stop();
  syncStreams();
  buildMenu();
  notifyGuests('desktop-server-changed');
  const o = originsOf(c).console;
  return { config: shellConfig(), id: c.id, restartForMic: !!o && o.startsWith('http:') && !secureAtStart.has(o) };
});

/* Remove a computer (the shell has asked); the last one stays. */
ipcMain.handle('remove-computer', async (e, id) => {
  const c = byId(id);
  if (!c || computers.length < 2) return { removed: false, config: shellConfig() };
  const i = computers.indexOf(c);
  computers.splice(i, 1);
  if (c.config) settings.removedConfig = [...new Set([...(settings.removedConfig || []), c.config])];
  if (settings.panes) delete settings.panes[id];
  if (settings.fmOrigins) delete settings.fmOrigins[id];
  live.delete(id);
  for (const [g, cid] of consoleGuests) if (cid === id) consoleGuests.delete(g);
  if (currentId === id) currentId = (computers[i] || computers[i - 1]).id;
  saveComputers();
  if (c.kind === 'local' && local) await local.stop();
  syncStreams();
  buildMenu();
  return { removed: true, config: shellConfig() };
});

ipcMain.on('set-current', (e, id) => {
  if (!byId(id) || id === currentId) return;
  currentId = id;
  if (!transient) { settings.current = id; saveSettings(); }
  buildMenu();
});

ipcMain.on('computer-menu', (e, id) => {
  const c = byId(id);
  if (!c) return;
  const act = (action) => () => send('computer-action', { id, action });
  popup([
    { label: `Edit ${nameOf(c)}…`, click: act('edit') },
    { label: 'Reload its console', click: act('reload') },
    { type: 'separator' },
    { label: 'Remove…', enabled: computers.length > 1, click: act('remove') },
  ]);
});

ipcMain.handle('local-retry', () => { if (hasLocal()) localServer().start(); });

// From a console page's Settings > About: where that console runs, and the dialog.
ipcMain.handle('desktop-server-info', (e) => {
  const c = byId(consoleGuests.get(e.sender.id)) || currentComputer();
  if (!c) return { mode: '', url: '', name: '', claude: '' };
  return {
    mode: c.kind,
    url: consoleUrlsOf(c)[0] || '',
    name: nameOf(c),
    computers: computers.length,
    claude: c.kind === 'local' && local ? local.state.claude || '' : '',
  };
});
ipcMain.handle('desktop-server-open', (e) => {
  const c = byId(consoleGuests.get(e.sender.id)) || currentComputer();
  send('edit-computer', c ? c.id : '');
  if (win) win.focus();
});

ipcMain.on('origins', (e, o) => {
  if (!o || !byId(o.id)) return;
  const prev = live.get(o.id) || {};
  const next = { console: originOf(o.console) || prev.console || '', fm: originOf(o.fm) || prev.fm || '' };
  live.set(o.id, next);
  if (next.fm && !transient) {
    settings.fmOrigins = settings.fmOrigins || {};
    if (settings.fmOrigins[o.id] !== next.fm) { settings.fmOrigins[o.id] = next.fm; saveSettings(); }
  }
  if (typeof o.guest === 'number') consoleGuests.set(o.guest, o.id);
  if (prev.console !== next.console) syncStreams();
});

ipcMain.on('save-pane', (e, p) => {
  if (!p || !byId(p.id)) return;
  settings.panes = settings.panes || {};
  settings.panes[p.id] = { open: !!p.open, tabs: Array.isArray(p.tabs) ? p.tabs : [], active: p.active || '' };
  if (typeof p.frac === 'number') settings.paneFrac = p.frac;
  saveSettings();
});

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
      { label: 'Add computer…', click: () => send('add-computer') },
      { label: 'Edit computer…', enabled: computers.length > 0, click: () => send('edit-computer', currentId) },
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
  if (computers.length > 1) {
    t.push({
      label: 'Computers',
      submenu: computers.map((c, i) => ({
        label: nameOf(c),
        type: 'radio',
        checked: c.id === currentId,
        accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined,
        registerAccelerator: false,
        click: () => send('switch-computer', i),
      })),
    });
  }
  t.push({ role: 'windowMenu' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

// ------------------------------------------------------------------ start

settings = loadJson('settings.json');
{
  let r;
  const args = {
    url: argValue('url') || process.env.CLAUDE_CONSOLE_URL,
    local: process.argv.includes('--local') || process.env.CLAUDE_CONSOLE_LOCAL === '1',
  };
  try { r = loadComputers(settings, CONFIG_COMPUTERS, args); } catch { r = loadComputers(settings, CONFIG_COMPUTERS, {}); }
  computers = r.list;
  currentId = r.current;
  transient = r.transient;
  if (r.changed && !transient) saveSettings();

  // Plain-http pages are no "secure context", so Chromium hides the microphone and the
  // async clipboard from them. These origins are the user's own; treat them as secure.
  // (The switch is read once at start, so it lists every address that may be used.)
  const plain = new Set(Object.values(settings.fmOrigins || {}));
  for (const c of computers) {
    for (const u of consoleUrlsOf(c)) plain.add(originOf(u));
    plain.add(originsOf(c).fm);
    for (const u of urlsFor(c, CONFIG_COMPUTERS)) plain.add(defaultFmOrigin(u));
  }
  for (const e of CONFIG_COMPUTERS) for (const u of e.urls) { plain.add(originOf(u)); plain.add(defaultFmOrigin(u)); }
  const http = [...plain].filter((o) => o && o.startsWith('http:'));
  for (const o of http) secureAtStart.add(o);
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
    if (hasLocal()) localServer().start();
  });
  app.on('window-all-closed', () => app.quit());
  // The servers on this computer stop with the app, the claude processes they run too.
  let stopped = false;
  app.on('will-quit', (e) => {
    for (const s of streams.values()) s.stop();
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

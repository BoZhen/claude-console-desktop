'use strict';
/* The window's own page: the console on the left; on the right a side pane whose
   tabs hold the file manager ("Files", always first) and the files the chat links to.
   Links reach openInPane() from main.js, which decides what stays in the app. */

const $ = (id) => document.getElementById(id);
const consoleView = $('console');

const MIN_PANE = 320;      // px
const MIN_CONSOLE = 420;   // px
const DEFAULT_FRAC = 0.42; // pane share of the window width

const state = {
  mode: '',         // where the console runs: 'local' (this computer), 'remote', '' not chosen yet
  remoteUrl: '',    // the address chosen for another computer
  remoteUrls: [],   // the addresses another computer would be tried at (main.js remoteUrls)
  urls: [],         // console addresses to try, in order (main.js consoleUrls)
  urlIdx: 0,
  tried: 0,         // addresses failed in a row
  chosen: false,    // the user picked one address (Server…)
  defaults: 0,      // how many addresses config.json gives (main.js DEFAULT_URLS)
  url: '',          // console page
  fmRoot: '',       // file manager root, "http://host:7701/"
  tabs: [],         // { id, key, fm, title, el, box, view, loaded }
  active: null,
  seq: 0,
  paneOpen: false,
  paneFrac: DEFAULT_FRAC,
  lastArea: 'console',
};

const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
const defaultFm = (u) => { if (!u) return ''; const x = new URL(u); return `${x.protocol}//${x.hostname}:7701`; };

/** Loads a URL in a webview whether or not it has attached yet. */
function navigate(view, url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return;   // no server address yet
  try {
    view.loadURL(url);
  } catch {
    view.src = url;
  }
}

// ------------------------------------------------------------------ console

consoleView.addEventListener('page-title-updated', (e) => { document.title = e.title || 'Claude Console'; });
consoleView.addEventListener('focus', () => { state.lastArea = 'console'; });
consoleView.addEventListener('ipc-message', (e) => { if (e.channel === 'colors') applyColors(e.args[0]); });
consoleView.addEventListener('found-in-page', onFound);
consoleView.addEventListener('render-process-gone', () => setTimeout(() => navigate(consoleView, state.url), 500));
// Chromium's error page carries the failed URL, so "the server answered" is judged by
// the HTTP status of the committed navigation, not by the URL.
let consoleAnswered = false;
consoleView.addEventListener('did-fail-load', (e) => {
  if (!e.isMainFrame || e.errorCode === -3) return;   // -3: replaced by a newer navigation
  consoleAnswered = false;
  state.tried += 1;
  if (state.tried < state.urls.length) {   // the next address (another network to the same console)
    connect(state.urlIdx + 1);
    return;
  }
  showOffline(e.errorDescription || `error ${e.errorCode}`);
});
consoleView.addEventListener('did-navigate', (e) => {
  consoleAnswered = e.httpResponseCode > 0;
  if (consoleAnswered) { state.tried = 0; hideOffline(); }
});

/** Loads address number i of state.urls. */
function connect(i) {
  if (!state.urls.length) { openUrlBox(); return; }   // no address to try: ask for one
  state.urlIdx = ((i % state.urls.length) + state.urls.length) % state.urls.length;
  state.url = state.urls[state.urlIdx];
  navigate(consoleView, state.url);
}

/** A new round over every address, starting with the first. */
function reconnect() {
  state.tried = 0;
  connect(0);
}
consoleView.addEventListener('dom-ready', onConsoleReady);

async function onConsoleReady() {
  if (!consoleAnswered || originOf(consoleView.getURL()) !== originOf(state.url)) return;
  let base = '';
  try {
    base = await consoleView.executeJavaScript("typeof webfmBase==='function'?webfmBase():''");
  } catch { /* older console without webfmBase */ }
  base = String(base || '').replace(/\/+$/, '') || defaultFm(state.url);
  state.fmRoot = base + '/';
  window.app.setOrigins({ console: state.url, fm: state.fmRoot, consoleGuestId: consoleView.getWebContentsId() });
  // Tabs from another address of the same console or file manager (restored from a
  // run over another network) move to this one.
  const consoles = new Set(state.urls.map(originOf));
  const fms = new Set(state.urls.map(defaultFm).concat([state.lastFm]));
  for (const t of state.tabs) {
    const from = originOf(t.key);
    const to = t.fm || fms.has(from) ? base : consoles.has(from) ? originOf(state.url) : '';
    if (!to || from === to) continue;
    t.key = t.fm ? state.fmRoot : to + t.key.slice(from.length);
    if (t.loaded) navigate(t.view, t.key);
  }
  state.lastFm = base;
}

function applyColors(c) {
  const transparent = (v) => !v || v === 'transparent' || /,\s*0\)$/.test(v);
  const root = document.documentElement.style;
  if (!transparent(c.bar)) root.setProperty('--bar', c.bar);
  if (c.text) root.setProperty('--text', c.text);
  const page = transparent(c.page) ? c.bar : c.page;
  if (!transparent(page)) root.setProperty('--page', page);
  const rgb = String(page || c.bar).match(/[\d.]+/g);
  if (rgb) {
    const [r, g, b] = rgb.map(Number);
    root.colorScheme = 0.299 * r + 0.587 * g + 0.114 * b > 150 ? 'light' : 'dark';
  }
}

// ------------------------------------------------------------------ unreachable console

let retryTimer = null;

function showOffline(error) {
  $('offline-url').textContent = state.urls.join('\n');
  $('offline-error').textContent = error;
  $('offline').hidden = false;
  let n = 5;
  $('offline-count').textContent = n;
  clearInterval(retryTimer);
  retryTimer = setInterval(() => {
    n -= 1;
    $('offline-count').textContent = Math.max(n, 0);
    if (n <= 0) {
      clearInterval(retryTimer);
      reconnect();
    }
  }, 1000);
}

function hideOffline() {
  clearInterval(retryTimer);
  $('offline').hidden = true;
}

$('offline-retry').addEventListener('click', () => { clearInterval(retryTimer); reconnect(); });
$('offline-edit').addEventListener('click', openUrlBox);

// ------------------------------------------------------------------ console on this computer

/* While the app starts the console here (main.js, localserver.js) this screen shows
   what it is doing: the first start makes a Python environment, which takes a while.
   On ready the console page loads; on a failure, the error and what to do. */
const localLines = [];

function showLocal(s) {
  if (state.mode !== 'local' || !s) return;
  if (s.phase === 'ready') {
    $('local').hidden = true;
    state.urls = [s.url];
    reconnect();
    return;
  }
  if (s.phase === 'stopped') return;
  hideOffline();
  const failed = s.phase === 'failed';
  $('local').hidden = false;
  $('local-title').textContent = failed ? 'Claude Console did not start' : 'Starting Claude Console on this computer';
  $('local-step').textContent = failed ? s.error || 'It stopped.' : s.step || 'Starting…';
  $('local-detail').textContent = failed ? s.detail || '' : '';
  $('local-detail').hidden = !failed || !s.detail;
  $('local-log').hidden = failed || !localLines.length;
  $('local-buttons').hidden = !failed;
  if (!failed) localLines.length = 0;
  if (s.phase === 'preparing' && !failed) $('local-log').textContent = '';
}

function localLine(line) {
  localLines.push(line);
  if (localLines.length > 12) localLines.shift();
  $('local-log').textContent = localLines.join('\n');
  $('local-log').hidden = $('local').hidden || !$('local-buttons').hidden;
  $('local-log').scrollTop = $('local-log').scrollHeight;
}

$('local-retry').addEventListener('click', () => {
  showLocal({ phase: 'preparing', step: 'Starting…' });
  window.app.localRetry();
});
$('local-edit').addEventListener('click', openUrlBox);

// ------------------------------------------------------------------ pane tabs

/** A short tab label: the file name of ?open=… (folders end in "/"), else the last path part. */
function titleFor(url, fm) {
  if (fm) return 'Files';
  try {
    const u = new URL(url);
    const p = u.searchParams.get('open') || u.searchParams.get('path') || u.searchParams.get('file') || u.pathname;
    const folder = p.endsWith('/');
    const name = p.replace(/\/+$/, '').split('/').pop() || p;
    return folder ? name + '/' : name;
  } catch {
    return url;
  }
}

function tooltipFor(url, fm) {
  if (fm) return 'File manager';
  try {
    const u = new URL(url);
    return u.searchParams.get('open') || u.searchParams.get('path') || url;
  } catch {
    return url;
  }
}

function makeTab(key, fm = false) {
  const tab = { id: ++state.seq, key, fm, loaded: false };
  tab.title = titleFor(key, fm);

  const el = document.createElement('div');
  el.className = fm ? 'tab fm' : 'tab';
  el.setAttribute('role', 'tab');
  el.title = tooltipFor(key, fm);
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = tab.title;
  el.append(label);
  if (!fm) {
    const close = document.createElement('button');
    close.className = 'close icon';
    close.textContent = '×';
    close.title = 'Close (Ctrl+W)';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab); });
    el.append(close);
  }
  el.addEventListener('click', () => activate(tab));
  el.addEventListener('auxclick', (e) => { if (e.button === 1 && !fm) closeTab(tab); });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.app.tabMenu({ id: tab.id, url: tabUrl(tab), closable: !fm });
  });

  const box = document.createElement('div');
  box.className = 'view';
  const view = document.createElement('webview');
  view.setAttribute('allowpopups', '');
  box.append(view);
  view.addEventListener('focus', () => { state.lastArea = 'pane'; });
  view.addEventListener('found-in-page', onFound);
  view.addEventListener('render-process-gone', () => setTimeout(() => navigate(view, tab.key), 500));

  const cover = document.createElement('div');
  cover.className = 'cover';
  cover.hidden = true;
  const card = document.createElement('div');
  card.className = 'card';
  const h = document.createElement('h1');
  h.textContent = fm ? 'Cannot reach the file manager' : 'Cannot open this file';
  const err = document.createElement('p');
  err.className = 'muted';
  const retry = document.createElement('button');
  retry.className = 'primary';
  retry.textContent = 'Try again';
  retry.addEventListener('click', () => { cover.hidden = true; navigate(view, tab.key); });
  const row = document.createElement('div');
  row.className = 'row';
  row.append(retry);
  card.append(h, err, row);
  cover.append(card);
  box.append(cover);
  const showCover = (title, text, button) => {
    h.textContent = title;
    err.textContent = text;
    retry.textContent = button;
    cover.hidden = false;
  };
  view.addEventListener('did-fail-load', (e) => {
    if (!e.isMainFrame || e.errorCode === -3) return;
    showCover(fm ? 'Cannot reach the file manager' : 'Cannot open this file',
      `${e.validatedURL || tab.key}: ${e.errorDescription || 'error ' + e.errorCode}`, 'Try again');
  });
  view.addEventListener('did-navigate', (e) => {
    // A cancelled login leaves an empty 401 page.
    if (e.httpResponseCode === 401) showCover('Not signed in', 'The file manager asks for a login.', 'Sign in');
    else if (e.httpResponseCode > 0) cover.hidden = true;
  });

  Object.assign(tab, { el, box, view });
  return tab;
}

function tabUrl(tab) {
  if (!tab.loaded) return tab.key;
  try { return tab.view.getURL() || tab.key; } catch { return tab.key; }
}

function addTab(tab, first = false) {
  const after = state.active && state.tabs.includes(state.active) ? state.active : null;
  if (first) {
    state.tabs.unshift(tab);
    $('tabs').prepend(tab.el);
  } else if (after) {
    state.tabs.splice(state.tabs.indexOf(after) + 1, 0, tab);
    after.el.after(tab.el);
  } else {
    state.tabs.push(tab);
    $('tabs').append(tab.el);
  }
  $('views').append(tab.box);
  updateTabControls();
}

function activate(tab) {
  state.active = tab;
  for (const t of state.tabs) {
    t.el.classList.toggle('active', t === tab);
    t.box.classList.toggle('active', t === tab);
  }
  // Tabs restored from the last run load when first shown.
  if (!tab.loaded && state.paneOpen) {
    tab.loaded = true;
    tab.view.src = tab.key;
  }
  tab.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  savePane();
}

function closeTab(tab) {
  if (!tab || tab.fm) return;
  const i = state.tabs.indexOf(tab);
  if (i < 0) return;
  if (findView === tab.view) closeFind(false);
  state.tabs.splice(i, 1);
  tab.el.remove();
  tab.box.remove();
  if (state.active === tab) activate(state.tabs[i] || state.tabs[i - 1] || fmTab());
  updateTabControls();
  savePane();
}

function fmTab() {
  let fm = state.tabs.find((t) => t.fm);
  if (!fm) {
    fm = makeTab(state.fmRoot || defaultFm(state.url) + '/', true);
    addTab(fm, true);
  }
  return fm;
}

function openInPane(url) {
  if (state.fmRoot && url.replace(/\/+$/, '') === state.fmRoot.replace(/\/+$/, '')) {
    showFiles();
    return;
  }
  let tab = state.tabs.find((t) => !t.fm && t.key === url);
  if (tab) {
    const wasLoaded = tab.loaded;
    if (!state.paneOpen) setPane(true);
    activate(tab);
    // Clicking a file again shows it as it is now: Claude may have changed it.
    if (wasLoaded) tab.view.reload();
  } else {
    fmTab();
    tab = makeTab(url);
    addTab(tab);
    if (!state.paneOpen) setPane(true);
    activate(tab);
  }
}

function showFiles() {
  if (!state.url) { openUrlBox(); return; }
  const fm = fmTab();
  if (!state.paneOpen) setPane(true);
  activate(fm);
}

function cycleTab(step) {
  if (!state.paneOpen || state.tabs.length < 2) return;
  const i = state.tabs.indexOf(state.active);
  activate(state.tabs[(i + step + state.tabs.length) % state.tabs.length]);
}

// "Close all" shows while any file tab is open.
function updateTabControls() {
  $('pane-closeall').hidden = !state.tabs.some((t) => !t.fm);
}

function closeAllFileTabs() {
  for (const t of [...state.tabs]) if (!t.fm) closeTab(t);
  activate(fmTab());
}

// ------------------------------------------------------------------ pane, splitter

function setPane(open) {
  state.paneOpen = open;
  $('pane').hidden = !open;
  $('splitter').hidden = !open;
  $('rail').hidden = open;
  if (open) {
    activate(state.active || fmTab());
    layoutPane();
  } else if (findView && findView !== consoleView) {
    closeFind(false);
  }
  savePane();
}

function clampFrac(frac) {
  const w = window.innerWidth;
  const lo = MIN_PANE / w;
  const hi = 1 - MIN_CONSOLE / w;
  return hi < lo ? 0.5 : Math.min(hi, Math.max(lo, frac));
}

function layoutPane() {
  $('pane').style.width = Math.round(clampFrac(state.paneFrac) * window.innerWidth) + 'px';
  if (!$('findbar').hidden) placeFind();
}

let saveTimer = null;
function savePane() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.app.savePane({
      open: state.paneOpen,
      frac: state.paneFrac,
      tabs: state.tabs.filter((t) => !t.fm).map((t) => t.key),
      active: state.active && !state.active.fm ? state.active.key : '',
    });
  }, 300);
}

const splitter = $('splitter');
splitter.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  splitter.setPointerCapture(e.pointerId);
  document.body.classList.add('dragging');
  const move = (ev) => {
    state.paneFrac = clampFrac((window.innerWidth - ev.clientX) / window.innerWidth);
    layoutPane();
  };
  const up = () => {
    document.body.classList.remove('dragging');
    splitter.removeEventListener('pointermove', move);
    splitter.removeEventListener('pointerup', up);
    splitter.removeEventListener('pointercancel', up);
    savePane();
  };
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', up);
  splitter.addEventListener('pointercancel', up);
});
splitter.addEventListener('dblclick', () => { state.paneFrac = DEFAULT_FRAC; layoutPane(); savePane(); });
window.addEventListener('resize', layoutPane);

$('pane-hide').addEventListener('click', () => setPane(false));
$('pane-browser').addEventListener('click', () => { if (state.active) window.app.openExternal(tabUrl(state.active)); });
$('rail-files').addEventListener('click', () => setPane(true));

// Side chats live in the console page's right drawer. This button opens that
// drawer on its Side chats tab, or closes it when it is already showing them,
// through the page's own functions.
const SIDE_TOGGLE_JS = `(() => {
  if (typeof openDrawer !== 'function' || typeof sideTab !== 'function') return 'unsupported';
  const d = document.getElementById('drawer');
  if (d.classList.contains('open') && sideTab()) { d.classList.remove('open'); return 'closed'; }
  openDrawer('side'); return 'open';
})()`;
async function toggleSideChats() {
  if (!$('offline').hidden) return;
  let r = '';
  try { r = await consoleView.executeJavaScript(SIDE_TOGGLE_JS); } catch { r = 'error'; }
  if (r === 'open') consoleView.focus();
  else if (r === 'unsupported') toast({ text: 'This console version has no side chats.' });
}
$('rail-side').addEventListener('click', toggleSideChats);

// The console's Settings (Appearance, Accounts, About), through the page's own
// functions; a second press closes it.
const SETTINGS_TOGGLE_JS = `(() => {
  if (typeof openSettings !== 'function' || typeof closeSettings !== 'function') return 'unsupported';
  const d = document.getElementById('settings');
  if (d && d.open) { closeSettings(); return 'closed'; }
  openSettings(); return 'open';
})()`;
async function toggleSettings() {
  if (!$('offline').hidden) return;
  let r = '';
  try { r = await consoleView.executeJavaScript(SETTINGS_TOGGLE_JS); } catch { r = 'error'; }
  if (r === 'open') consoleView.focus();
  else if (r === 'unsupported') toast({ text: 'This console version has no settings dialog.' });
}
$('rail-settings').addEventListener('click', toggleSettings);

// An update downloaded and checked by updater.js: the green button restarts into it.
function showUpdate(s) {
  const ready = s && s.ready;
  for (const id of ['rail-update', 'pane-update']) {
    const b = $(id);
    b.hidden = !ready;
    if (ready) b.title = `Restart to update to ${ready.version}` + (ready.notes ? ` · ${ready.notes}` : '');
  }
}
window.app.on('update-state', showUpdate);
window.app.updateInfo().then(showUpdate).catch(() => {});
for (const id of ['rail-update', 'pane-update']) $(id).addEventListener('click', () => window.app.updateInstall());
$('pane-settings').addEventListener('click', toggleSettings);   // the rail is hidden while the pane is open
$('pane-side').addEventListener('click', toggleSideChats);
$('pane-closeall').addEventListener('click', closeAllFileTabs);   // the rail is hidden while the pane is open

// A file dropped outside the console's composer must not replace this page.
for (const type of ['dragover', 'drop']) document.addEventListener(type, (e) => e.preventDefault());

// ------------------------------------------------------------------ find in page

let findView = null;
let findOpenedAt = 0;

function openFind(where) {
  // A menu shortcut can arrive right after the same key from main.js; the first one names the area.
  if (where === 'last' && !$('findbar').hidden && Date.now() - findOpenedAt < 300) return;
  findOpenedAt = Date.now();
  if (where === 'last' || where === 'shell') where = state.lastArea;
  const view = where === 'pane' && state.paneOpen && state.active ? state.active.view : consoleView;
  if (findView && findView !== view) closeFind(false);
  findView = view;
  $('findbar').hidden = false;
  placeFind();
  const input = $('find-input');
  input.focus();
  input.select();
  if (input.value) runFind(true, false);
}

function placeFind() {
  const area = findView === consoleView ? $('left') : $('views');
  const r = area.getBoundingClientRect();
  const fb = $('findbar');
  fb.style.top = `${r.top + (findView === consoleView ? 58 : 8)}px`;
  fb.style.right = `${window.innerWidth - r.right + 16}px`;
}

function runFind(fresh, backward) {
  if (!findView) return;
  const text = $('find-input').value;
  if (!text) {
    findView.stopFindInPage('clearSelection');
    $('find-count').textContent = '';
    return;
  }
  // findNext: true starts a new search; false moves to the next match.
  findView.findInPage(text, { forward: !backward, findNext: fresh });
  requestAnimationFrame(() => $('find-input').focus());
}

function onFound(e) {
  if (e.target !== findView) return;
  const r = e.result;
  if (r.matches !== undefined) $('find-count').textContent = r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : '0/0';
}

function closeFind(refocus = true) {
  if (findView) {
    try { findView.stopFindInPage('keepSelection'); } catch { /* the tab is gone */ }
    if (refocus) findView.focus();
  }
  findView = null;
  $('findbar').hidden = true;
  $('find-count').textContent = '';
}

$('find-input').addEventListener('input', () => runFind(true, false));
$('find-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runFind(false, e.shiftKey); }
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
$('find-prev').addEventListener('click', () => runFind(false, true));
$('find-next').addEventListener('click', () => runFind(false, false));
$('find-close').addEventListener('click', () => closeFind());

// ------------------------------------------------------------------ login dialog

const authQueue = [];
let authCurrent = null;

function nextAuth() {
  authCurrent = authQueue.shift() || null;
  if (!authCurrent) {
    $('auth').hidden = true;
    return;
  }
  $('auth-host').textContent = `${authCurrent.host} asks for a login (${authCurrent.realm || 'no realm'}).`;
  $('auth-retry').hidden = !authCurrent.retry;
  $('auth-remember').checked = authCurrent.canRemember;
  $('auth-remember').disabled = !authCurrent.canRemember;
  $('auth-remember-text').textContent = authCurrent.canRemember
    ? 'Remember on this computer'
    : 'Remember (needs the system keyring, which is not available)';
  $('auth-pass').value = '';
  $('auth').hidden = false;
  ($('auth-user').value ? $('auth-pass') : $('auth-user')).focus();
}

function answerAuth(user, pass) {
  if (!authCurrent) return;
  window.app.authReply({ id: authCurrent.id, user, pass, remember: $('auth-remember').checked });
  nextAuth();
}

$('auth-form').addEventListener('submit', (e) => { e.preventDefault(); answerAuth($('auth-user').value, $('auth-pass').value); });
$('auth-cancel').addEventListener('click', () => answerAuth(null, null));
$('auth').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); answerAuth(null, null); } });

// ------------------------------------------------------------------ server dialog

/* This computer, or another computer at an address. The first start (no config.json,
   nothing chosen) offers this computer first; typing an address picks the other. */
function applyConfig(c) {
  state.mode = c.mode;
  state.urls = c.urls;
  state.chosen = c.chosen;
  state.remoteUrl = c.remoteUrl || '';
  state.remoteUrls = c.remoteUrls || [];
  state.defaults = c.defaults;
}

function syncServerChoice() {
  $('url-input').classList.toggle('dim', !$('srv-remote').checked);
  $('url-defaults').hidden = !state.defaults;
}

function openUrlBox() {
  const local = state.mode ? state.mode === 'local' : !state.remoteUrls.length;
  $('srv-local').checked = local;
  $('srv-remote').checked = !local;
  $('url-input').value = state.chosen ? state.remoteUrl : '';
  $('url-input').placeholder = !state.chosen && state.remoteUrls.length ? 'automatic: ' + state.remoteUrls.join(' , then ')
    : 'http://192.168.1.10:7703/';
  $('url-cancel').hidden = !state.mode;   // nothing to go back to before the first choice
  $('url-error').hidden = true;
  syncServerChoice();
  $('urlbox').hidden = false;
  if (local) $('srv-local').focus();   // not the address field: focusing it picks Another computer
  else { $('url-input').focus(); $('url-input').select(); }
}

for (const id of ['srv-local', 'srv-remote']) $(id).addEventListener('change', () => {
  syncServerChoice();
  if ($('srv-remote').checked) $('url-input').focus();
});
// clicking into the address field, or typing in it, picks Another computer
for (const ev of ['focus', 'input']) $('url-input').addEventListener(ev, () => { $('srv-remote').checked = true; syncServerChoice(); });

$('url-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  // an address typed (or set by a script) means another computer
  if ($('url-input').value.trim()) $('srv-remote').checked = true;
  const mode = $('srv-local').checked ? 'local' : 'remote';
  try {
    const r = await window.app.setServer({ mode, url: $('url-input').value });
    applyConfig(r);
    $('urlbox').hidden = true;
    hideOffline();
    if (mode === 'local') showLocal(r.local && r.local.phase !== 'stopped' ? r.local : { phase: 'preparing', step: 'Starting…' });
    else { $('local').hidden = true; reconnect(); }
  } catch (err) {
    $('url-error').textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    $('url-error').hidden = false;
  }
});
$('url-cancel').addEventListener('click', () => { if (state.mode) $('urlbox').hidden = true; });
$('urlbox').addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.mode) $('urlbox').hidden = true; });

// ------------------------------------------------------------------ toast

let toastTimer = null;
function toast(t) {
  const el = $('toast');
  el.textContent = t.path ? `${t.text} · show in folder` : t.text;
  el.classList.toggle('link', !!t.path);
  el.onclick = t.path ? () => window.app.showItem(t.path) : null;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

// ------------------------------------------------------------------ events from main.js

window.app.on('open-in-pane', openInPane);
window.app.on('open-fm', showFiles);
window.app.on('toggle-pane', () => setPane(!state.paneOpen));
window.app.on('close-tab', () => { if (state.paneOpen) closeTab(state.active); });
window.app.on('cycle-tab', cycleTab);
window.app.on('find', openFind);
window.app.on('edit-url', openUrlBox);
window.app.on('local-state', showLocal);
window.app.on('local-line', localLine);
window.app.on('toast', toast);
window.app.on('auth-request', (req) => { authQueue.push(req); if (!authCurrent) nextAuth(); });
window.app.on('reload', (where, hard) => {
  if (where === 'shell') where = state.lastArea;
  const view = where === 'pane' && state.paneOpen && state.active ? state.active.view : consoleView;
  if (view === consoleView && !$('offline').hidden) { reconnect(); return; }
  if (hard) view.reloadIgnoringCache(); else view.reload();
});
window.app.on('tab-action', ({ id, action }) => {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  if (action === 'reload' && tab.loaded) tab.view.reload();
  if (action === 'browser') window.app.openExternal(tabUrl(tab));
  if (action === 'close') closeTab(tab);
  if (action === 'close-others') for (const t of [...state.tabs]) if (t !== tab) closeTab(t);
  if (action === 'close-all') closeAllFileTabs();
});

// ------------------------------------------------------------------ start

(async function start() {
  const cfg = await window.app.config();
  document.documentElement.classList.toggle('mac', cfg.platform === 'darwin');
  applyConfig(cfg);
  state.url = cfg.urls[0] || '';
  state.fmRoot = state.url ? (cfg.fmOrigin || defaultFm(state.url)) + '/' : '';
  state.lastFm = state.fmRoot ? originOf(state.fmRoot) : '';
  // this computer: the page loads once main.js says the console is up
  if (state.mode === 'local') showLocal(cfg.local && cfg.local.phase !== 'stopped' ? cfg.local : { phase: 'preparing', step: 'Starting…' });
  else if (state.url) consoleView.src = state.url;
  else openUrlBox();   // first start without config.json: ask where the console runs

  const pane = cfg.pane || {};
  if (typeof pane.frac === 'number') state.paneFrac = pane.frac;
  const saved = Array.isArray(pane.tabs) ? pane.tabs.filter((u) => typeof u === 'string') : [];
  if (saved.length) {
    const fm = fmTab();
    state.active = fm;
    for (const url of saved) {   // each one after the previous: addTab() inserts after the active tab
      const t = makeTab(url);
      addTab(t);
      state.active = t;
    }
    state.active = state.tabs.find((t) => !t.fm && t.key === pane.active) || fm;
  }
  if (pane.open) setPane(true);
})();

'use strict';
/* The window's own page: the console on the left; on the right a side pane whose
   tabs hold the file manager ("Files", always first) and the files the chat links to.
   It can hold several computers, each with its own console page and its own pane tabs:
   the one shown is `cur`, the others keep running behind it, and the rail switches
   (Ctrl+1…9). Links reach openInPane() from main.js, which decides what stays in the app. */

const $ = (id) => document.getElementById(id);

const MIN_PANE = 320;      // px
const MIN_CONSOLE = 420;   // px
const DEFAULT_FRAC = 0.42; // pane share of the window width

const state = {
  seq: 0,
  paneFrac: DEFAULT_FRAC,
  lastArea: 'console',
  platform: '',
};

/* A computer, as the shell keeps it:
   { id, name, givenName, kind: 'local' | 'remote', urls (to try, in order), url (the
     chosen address, '' for config.json's), configUrls,
     view (its console webview), urlIdx, tried, page (the console address in use),
     answered, fmRoot ("http://host:7701/"), lastFm, title, colors,
     offline (null, or { error }) and its retry countdown, localState (this computer),
     tabs, active, paneOpen, waiting, unseen, btn (its rail button) } */
const comps = [];
let cur = null;

const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
const defaultFm = (u) => { if (!u) return ''; const x = new URL(u); return `${x.protocol}//${x.hostname}:7701`; };
const byId = (id) => comps.find((c) => c.id === id) || null;
const multi = () => comps.length > 1;

/** Loads a URL in a webview whether or not it has attached yet. */
function navigate(view, url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return;   // no server address yet
  try {
    view.loadURL(url);
  } catch {
    view.src = url;
  }
}

// ------------------------------------------------------------------ computers

function makeComp(info) {
  const c = {
    id: info.id, name: '', givenName: '', kind: '', urls: [], url: '', configUrls: [], fmHint: '',
    urlIdx: 0, tried: 0, page: '', answered: false, fmRoot: '', lastFm: '', title: '', colors: null,
    offline: null, countdown: 0, retryTimer: null, localState: null,
    tabs: [], active: null, paneOpen: false, saveTimer: null, waiting: 0, unseen: false, btn: null,
  };
  updateComp(c, info);
  const view = document.createElement('webview');
  view.className = 'console';
  view.setAttribute('allowpopups', '');
  $('consoles').append(view);
  c.view = view;
  view.addEventListener('page-title-updated', (e) => { c.title = e.title || ''; if (c === cur) showTitle(); });
  view.addEventListener('focus', () => { state.lastArea = 'console'; });
  view.addEventListener('ipc-message', (e) => {
    if (e.channel !== 'colors') return;
    c.colors = e.args[0];
    if (c === cur) applyColors(c.colors);
  });
  view.addEventListener('found-in-page', onFound);
  view.addEventListener('render-process-gone', () => setTimeout(() => navigate(view, c.page), 500));
  // Chromium's error page carries the failed URL, so "the server answered" is judged by
  // the HTTP status of the committed navigation, not by the URL.
  view.addEventListener('did-fail-load', (e) => {
    if (!e.isMainFrame || e.errorCode === -3) return;   // -3: replaced by a newer navigation
    c.answered = false;
    c.tried += 1;
    if (c.tried < c.urls.length) {   // the next address (another network to the same console)
      connect(c, c.urlIdx + 1);
      return;
    }
    showOffline(c, e.errorDescription || `error ${e.errorCode}`);
  });
  view.addEventListener('did-navigate', (e) => {
    c.answered = e.httpResponseCode > 0;
    if (c.answered) { c.tried = 0; hideOffline(c); }
  });
  view.addEventListener('dom-ready', () => onConsoleReady(c));
  // main.js knows this webview is a console from the start, before its page answers
  view.addEventListener('did-attach', () => window.app.setOrigins({ id: c.id, guest: view.getWebContentsId() }));
  return c;
}

/** Takes what main.js says about a computer; true if where it runs changed. */
function updateComp(c, info) {
  const moved = c.kind !== info.kind || c.urls.join(' ') !== (info.urls || []).join(' ');
  Object.assign(c, {
    name: info.name, givenName: info.givenName || '', kind: info.kind,
    urls: info.urls || [], url: info.url || '', configUrls: info.configUrls || [], fmHint: info.fm || '',
  });
  return moved;
}

/** Starts (or restarts) a computer's console: this computer waits for its servers. */
function startComp(c, localState) {
  hideOffline(c);
  if (c.kind === 'local') {
    c.localState = null;
    showLocal(localState && localState.phase !== 'stopped' ? localState : { phase: 'preparing', step: 'Starting…' });
  } else {
    c.localState = null;
    if (c === cur) renderCovers();
    reconnect(c);
  }
}

function destroyComp(c) {
  clearInterval(c.retryTimer);
  clearTimeout(c.saveTimer);
  if (findView && (findView === c.view || c.tabs.some((t) => t.view === findView))) closeFind(false);
  for (const t of c.tabs) { t.el.remove(); t.box.remove(); }
  c.view.remove();
  if (c.btn) c.btn.remove();
  comps.splice(comps.indexOf(c), 1);
}

/** Brings the list in line with main.js (after a change there); returns the computers
    that are new or now run somewhere else. */
function applyComputers(cfg) {
  const ids = cfg.computers.map((i) => i.id);
  for (const c of comps.filter((x) => !ids.includes(x.id))) destroyComp(c);
  const fresh = [];
  for (const info of cfg.computers) {
    let c = byId(info.id);
    if (!c) {
      c = makeComp(info);
      comps.push(c);
      fresh.push(c);
    } else if (updateComp(c, info)) {
      fresh.push(c);
    }
  }
  comps.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  document.body.classList.toggle('multi', multi());
  renderRail();
  return fresh;
}

/** Shows computer c: its console, its pane tabs, its covers; the others run on. */
function switchTo(c, { focus = true } = {}) {
  if (!c) return;
  const changed = c !== cur;
  if (changed && findView) closeFind(false);
  cur = c;
  for (const x of comps) x.view.classList.toggle('active', x === c);
  c.unseen = false;
  renderRail();
  if (c.colors) applyColors(c.colors);
  showTitle();
  renderPane();
  renderCovers();
  if (changed) window.app.setCurrent(c.id);
  if (focus && $('urlbox').hidden) c.view.focus();
}

function showTitle() {
  const t = (cur && cur.title) || 'Claude Console';
  document.title = cur && multi() ? `${cur.name} · ${t}` : t;
}

// ------------------------------------------------------------------ console

/** Loads address number i of c.urls. */
function connect(c, i) {
  if (!c.urls.length) { if (c === cur) openBox('edit', c); return; }   // nothing to try: ask
  c.urlIdx = ((i % c.urls.length) + c.urls.length) % c.urls.length;
  c.page = c.urls[c.urlIdx];
  navigate(c.view, c.page);
}

/** A new round over every address, starting with the first. */
function reconnect(c) {
  c.tried = 0;
  connect(c, 0);
}

async function onConsoleReady(c) {
  if (!c.answered || originOf(c.view.getURL()) !== originOf(c.page)) return;
  let base = '';
  try {
    base = await c.view.executeJavaScript("typeof webfmBase==='function'?webfmBase():''");
  } catch { /* older console without webfmBase */ }
  base = String(base || '').replace(/\/+$/, '') || defaultFm(c.page);
  c.fmRoot = base + '/';
  window.app.setOrigins({ id: c.id, console: c.page, fm: c.fmRoot, guest: c.view.getWebContentsId() });
  // Tabs from another address of the same console or file manager (restored from a
  // run over another network) move to this one.
  const consoles = new Set(c.urls.map(originOf));
  const fms = new Set(c.urls.map(defaultFm).concat([c.lastFm, c.fmHint]));
  for (const t of c.tabs) {
    const from = originOf(t.key);
    const to = t.fm || fms.has(from) ? base : consoles.has(from) ? originOf(c.page) : '';
    if (!to || from === to) continue;
    t.key = t.fm ? c.fmRoot : to + t.key.slice(from.length);
    if (t.loaded) navigate(t.view, t.key);
  }
  c.lastFm = base;
  if (c === cur && c.paneOpen && c.active && !c.active.loaded) activate(c.active);   // Files waited for this
}

function applyColors(col) {
  if (!col) return;
  const transparent = (v) => !v || v === 'transparent' || /,\s*0\)$/.test(v);
  const root = document.documentElement.style;
  if (!transparent(col.bar)) root.setProperty('--bar', col.bar);
  if (col.text) root.setProperty('--text', col.text);
  const page = transparent(col.page) ? col.bar : col.page;
  if (!transparent(page)) root.setProperty('--page', page);
  const rgb = String(page || col.bar).match(/[\d.]+/g);
  if (rgb) {
    const [r, g, b] = rgb.map(Number);
    root.colorScheme = 0.299 * r + 0.587 * g + 0.114 * b > 150 ? 'light' : 'dark';
  }
}

// ------------------------------------------------------------------ covers: unreachable, starting here

/* Each computer keeps its own state; the covers over the console show the current
   one's. A computer that cannot be reached retries every 5 s, shown or not. */
function showOffline(c, error) {
  c.offline = { error };
  c.countdown = 5;
  clearInterval(c.retryTimer);
  c.retryTimer = setInterval(() => {
    c.countdown -= 1;
    if (c === cur) $('offline-count').textContent = Math.max(c.countdown, 0);
    if (c.countdown <= 0) {
      clearInterval(c.retryTimer);
      reconnect(c);
    }
  }, 1000);
  if (c === cur) renderCovers();
}

function hideOffline(c) {
  clearInterval(c.retryTimer);
  c.offline = null;
  if (c === cur) renderCovers();
}

function renderCovers() {
  const c = cur;
  const off = c && c.offline;
  $('offline').hidden = !off;
  if (off) {
    $('offline-title').textContent = multi() ? `Cannot reach Claude Console on ${c.name}` : 'Cannot reach Claude Console';
    $('offline-url').textContent = c.urls.join('\n');
    $('offline-error').textContent = off.error;
    $('offline-count').textContent = Math.max(c.countdown, 0);
  }
  const s = c && c.kind === 'local' ? c.localState : null;
  const showing = !!s && s.phase !== 'ready' && s.phase !== 'stopped';
  $('local').hidden = !showing;
  if (!showing) return;
  const failed = s.phase === 'failed';
  $('local-title').textContent = failed ? 'Claude Console did not start' : 'Starting Claude Console on this computer';
  $('local-step').textContent = failed ? s.error || 'It stopped.' : s.step || 'Starting…';
  $('local-detail').textContent = failed ? s.detail || '' : '';
  $('local-detail').hidden = !failed || !s.detail;
  $('local-log').hidden = failed || !localLines.length;
  $('local-buttons').hidden = !failed;
}

$('offline-retry').addEventListener('click', () => { if (cur) { clearInterval(cur.retryTimer); reconnect(cur); } });
$('offline-edit').addEventListener('click', () => openBox('edit', cur));

/* While the app starts the console here (main.js, localserver.js) a cover shows what
   it is doing: the first start makes a Python environment, which takes a while. On
   ready the console page loads; on a failure, the error and what to do. */
const localLines = [];

function showLocal(s) {
  const c = comps.find((x) => x.kind === 'local');
  if (!c || !s) return;
  const was = c.localState;
  c.localState = s;
  if (s.phase === 'ready') {
    if (!was || was.phase !== 'ready' || !c.answered) {
      c.urls = [s.url];
      reconnect(c);
    }
  } else if (s.phase !== 'stopped') {
    hideOffline(c);
    // each step shows the output since it began
    if (s.phase !== 'failed') localLines.length = 0;
    if (s.phase === 'preparing') $('local-log').textContent = '';
  }
  if (c === cur) renderCovers();
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
$('local-edit').addEventListener('click', () => openBox('edit', comps.find((x) => x.kind === 'local') || cur));

// ------------------------------------------------------------------ the rail's computers

/** Up to two characters: the last part of an IP address, the first letters of a
    name's first two words, else its first two letters (as computers.js initials()). */
function initials(name) {
  const n = String(name || '').trim();
  if (!n) return '?';
  if (/^\d+(\.\d+){3}$/.test(n)) return n.split('.').pop();
  const words = n.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const w = words[0] || n;
  return w[0].toUpperCase() + (w[1] || '');
}

/* With one computer the rail has only + (adding a second one); from two on, a button
   per computer above it. */
function renderRail() {
  const box = $('rail-computers');
  box.hidden = !comps.length;
  $('rail').hidden = !!(cur && cur.paneOpen) && !multi();
  const key = state.platform === 'darwin' ? '⌘' : 'Ctrl+';
  for (const c of comps) if (c.btn && !multi()) { c.btn.remove(); }
  if (multi()) comps.forEach((c, i) => {
    if (!c.btn) {
      c.btn = document.createElement('button');
      c.btn.className = 'computer';
      c.btn.addEventListener('click', () => switchTo(c));
      c.btn.addEventListener('contextmenu', (e) => { e.preventDefault(); window.app.computerMenu(c.id); });
    }
    const b = c.btn;
    b.classList.toggle('active', c === cur);
    const parts = [c.name + (c.kind === 'local' ? ' (this computer)' : '')];
    if (i < 9) parts.push(key + (i + 1));
    if (c.waiting) parts.push(c.waiting === 1 ? '1 approval or question waiting' : `${c.waiting} approvals or questions waiting`);
    else if (c.unseen) parts.push('a turn finished');
    b.title = parts.join(' · ') + '\nRight-click to edit or remove';
    b.textContent = initials(c.name);
    if (c !== cur && (c.waiting || c.unseen)) {
      const dot = document.createElement('span');
      dot.className = c.waiting ? 'dot' : 'dot done';
      dot.textContent = c.waiting ? String(Math.min(c.waiting, 9)) : '';
      b.append(dot);
    }
    box.append(b);   // in list order
  });
  let add = $('rail-add');
  if (!add) {
    add = document.createElement('button');
    add.id = 'rail-add';
    add.className = 'icon';
    add.title = 'Add a computer: each one gets a button here and keeps running while another is shown';
    // a monitor with a plus on its screen, drawn like the rail's other icons
    add.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">'
      + '<rect x="3" y="4" width="18" height="12.5" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.6"/>'
      + '<path d="M9 20.5h6 M12 16.5v4 M12 7.6v5.3 M9.35 10.25h5.3" fill="none" stroke="currentColor" '
      + 'stroke-width="1.6" stroke-linecap="round"/></svg>';
    add.addEventListener('click', () => openBox('add'));
  }
  box.append(add);
}

/** From main.js: what waits on a computer (its api/notify/stream). */
function attention(a) {
  const c = byId(a.id);
  if (!c) return;
  if (typeof a.waiting === 'number') c.waiting = a.waiting;
  if (a.finished && c !== cur) c.unseen = true;
  renderRail();
}

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

function makeTab(c, key, fm = false) {
  const tab = { id: ++state.seq, comp: c, key, fm, loaded: false };
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

/** Adds a tab to its computer's list: first, or after the active one. All computers'
    tabs share #tabs and #views; only the current one's show. */
function addTab(tab, first = false) {
  const c = tab.comp;
  const after = c.active && c.tabs.includes(c.active) ? c.active : null;
  if (first) {
    c.tabs.unshift(tab);
    $('tabs').prepend(tab.el);
  } else if (after) {
    c.tabs.splice(c.tabs.indexOf(after) + 1, 0, tab);
    after.el.after(tab.el);
  } else {
    c.tabs.push(tab);
    $('tabs').append(tab.el);
  }
  $('views').append(tab.box);
  tab.el.hidden = c !== cur;
  updateTabControls();
}

function activate(tab) {
  const c = tab.comp;
  c.active = tab;
  if (c === cur) {
    for (const t of c.tabs) {
      t.el.classList.toggle('active', t === tab);
      t.box.classList.toggle('active', t === tab);
    }
    tab.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  // Tabs restored from the last run load when first shown; Files only once its address
  // is known (saved from an earlier run, or reported by the console page): the guess
  // before that, the console's host on port 7701, can be another file manager.
  if (!tab.loaded && c.paneOpen && c === cur && (!tab.fm || c.fmRoot || c.fmHint)) {
    tab.loaded = true;
    tab.view.src = tab.key;
  }
  savePane(c);
}

/** The pane as the current computer has it: its tabs shown, the others' hidden. */
function renderPane() {
  for (const c of comps) {
    for (const t of c.tabs) {
      const mine = c === cur;
      t.el.hidden = !mine;
      t.el.classList.toggle('active', mine && t === c.active);
      t.box.classList.toggle('active', mine && t === c.active);
    }
  }
  const open = !!(cur && cur.paneOpen);
  $('pane').hidden = !open;
  $('splitter').hidden = !open;
  renderRail();
  updateTabControls();
  if (open) {
    activate(cur.active || fmTab(cur));
    layoutPane();
  }
}

function closeTab(tab) {
  if (!tab || tab.fm) return;
  const c = tab.comp;
  const i = c.tabs.indexOf(tab);
  if (i < 0) return;
  if (findView === tab.view) closeFind(false);
  c.tabs.splice(i, 1);
  tab.el.remove();
  tab.box.remove();
  if (c.active === tab) activate(c.tabs[i] || c.tabs[i - 1] || fmTab(c));
  updateTabControls();
  savePane(c);
}

function fmTab(c) {
  let fm = c.tabs.find((t) => t.fm);
  if (!fm) {
    fm = makeTab(c, c.fmRoot || (c.fmHint || defaultFm(c.page || c.urls[0])) + '/', true);
    addTab(fm, true);
  }
  return fm;
}

/** The computer a link belongs to: the one whose file manager or console it is on
    (the current one first), else the current one. */
function compForUrl(url) {
  const o = originOf(url);
  const mine = (c) => o && ((c.fmRoot && originOf(c.fmRoot) === o) || originOf(c.page) === o
    || (!c.fmRoot && (c.fmHint || (c.page && defaultFm(c.page))) === o));
  if (cur && mine(cur)) return cur;
  return comps.find(mine) || cur;
}

function openInPane(url) {
  const c = compForUrl(url);
  if (!c) return;
  if (c !== cur) switchTo(c, { focus: false });
  if (c.fmRoot && url.replace(/\/+$/, '') === c.fmRoot.replace(/\/+$/, '')) {
    showFiles();
    return;
  }
  let tab = c.tabs.find((t) => !t.fm && t.key === url);
  if (tab) {
    const wasLoaded = tab.loaded;
    if (!c.paneOpen) setPane(true);
    activate(tab);
    // Clicking a file again shows it as it is now: Claude may have changed it.
    if (wasLoaded) tab.view.reload();
  } else {
    fmTab(c);
    tab = makeTab(c, url);
    addTab(tab);
    if (!c.paneOpen) setPane(true);
    activate(tab);
  }
}

function showFiles() {
  if (!cur || !(cur.page || cur.urls.length)) { openBox(cur ? 'edit' : 'first', cur); return; }
  const fm = fmTab(cur);
  if (!cur.paneOpen) setPane(true);
  activate(fm);
}

function cycleTab(step) {
  if (!cur || !cur.paneOpen || cur.tabs.length < 2) return;
  const i = cur.tabs.indexOf(cur.active);
  activate(cur.tabs[(i + step + cur.tabs.length) % cur.tabs.length]);
}

// "Close all" shows while any file tab of the current computer is open.
function updateTabControls() {
  $('pane-closeall').hidden = !(cur && cur.tabs.some((t) => !t.fm));
}

function closeAllFileTabs() {
  if (!cur) return;
  for (const t of [...cur.tabs]) if (!t.fm) closeTab(t);
  activate(fmTab(cur));
}

// ------------------------------------------------------------------ pane, splitter

function setPane(open) {
  if (!cur) return;
  cur.paneOpen = open;
  if (!open && findView && findView !== cur.view) closeFind(false);
  renderPane();
  savePane(cur);
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

function savePane(c) {
  if (!c) return;
  clearTimeout(c.saveTimer);
  c.saveTimer = setTimeout(() => {
    window.app.savePane({
      id: c.id,
      open: c.paneOpen,
      frac: state.paneFrac,
      tabs: c.tabs.filter((t) => !t.fm).map((t) => t.key),
      active: c.active && !c.active.fm ? c.active.key : '',
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
    savePane(cur);
  };
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', up);
  splitter.addEventListener('pointercancel', up);
});
splitter.addEventListener('dblclick', () => { state.paneFrac = DEFAULT_FRAC; layoutPane(); savePane(cur); });
window.addEventListener('resize', layoutPane);

$('pane-hide').addEventListener('click', () => setPane(false));
$('pane-browser').addEventListener('click', () => { if (cur && cur.active) window.app.openExternal(tabUrl(cur.active)); });
// With several computers the rail stays beside the open pane: Files then closes it again.
$('rail-files').addEventListener('click', () => setPane(!(cur && cur.paneOpen)));

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
  if (!cur || cur.offline) return;
  let r = '';
  try { r = await cur.view.executeJavaScript(SIDE_TOGGLE_JS); } catch { r = 'error'; }
  if (r === 'open') cur.view.focus();
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
  if (!cur || cur.offline) return;
  let r = '';
  try { r = await cur.view.executeJavaScript(SETTINGS_TOGGLE_JS); } catch { r = 'error'; }
  if (r === 'open') cur.view.focus();
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
$('pane-closeall').addEventListener('click', closeAllFileTabs);

// A file dropped outside the console's composer must not replace this page.
for (const type of ['dragover', 'drop']) document.addEventListener(type, (e) => e.preventDefault());

// ------------------------------------------------------------------ find in page

let findView = null;
let findOpenedAt = 0;

function openFind(where) {
  if (!cur) return;
  // A menu shortcut can arrive right after the same key from main.js; the first one names the area.
  if (where === 'last' && !$('findbar').hidden && Date.now() - findOpenedAt < 300) return;
  findOpenedAt = Date.now();
  if (where === 'last' || where === 'shell') where = state.lastArea;
  const view = where === 'pane' && cur.paneOpen && cur.active ? cur.active.view : cur.view;
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
  const inConsole = cur && findView === cur.view;
  const area = inConsole ? $('left') : $('views');
  const r = area.getBoundingClientRect();
  const fb = $('findbar');
  fb.style.top = `${r.top + (inConsole ? 58 : 8)}px`;
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

// ------------------------------------------------------------------ the computer dialog

/* One dialog for three things:
   first  the first start without config.json: where does the console run? (no name,
          no Cancel: there is nothing to go back to)
   add    another computer for the rail
   edit   a computer's name, and this computer or an address; Remove when there are
          several. An empty address on a computer from config.json goes back to its
          addresses there. Only one computer can be "this computer". */
const box = { mode: '', comp: null };

function openBox(mode, c = null) {
  if (mode === 'edit' && !c) mode = comps.length ? 'add' : 'first';
  box.mode = mode;
  box.comp = mode === 'edit' ? c : null;
  const other = comps.find((x) => x.kind === 'local' && x !== box.comp);
  const localTaken = !!other;
  const local = mode === 'edit' ? c.kind === 'local' : mode === 'first' && !localTaken;
  $('url-title').textContent = mode === 'add' ? 'Add a computer' : mode === 'edit' && multi() ? `Edit ${c.name}` : 'Server';
  $('url-intro').textContent = mode === 'add'
    ? 'Another computer with its own Claude Console. It gets a button on the rail, and keeps running while another one is shown.'
    : 'Where Claude Console runs.';
  $('url-name-row').hidden = mode === 'first' || (mode === 'edit' && !multi());
  $('url-name').value = mode === 'edit' ? c.givenName : '';
  $('url-name').placeholder = mode === 'edit' ? c.name : 'shown on the rail, for example Office';
  $('srv-local').disabled = localTaken;
  $('srv-local').closest('label').classList.toggle('taken', localTaken);
  $('srv-local-taken').hidden = !localTaken;
  $('srv-local').checked = local && !localTaken;
  $('srv-remote').checked = !$('srv-local').checked;
  const chosen = mode === 'edit' && c.kind === 'remote' ? c.url : '';
  const fromConfig = mode === 'edit' ? c.configUrls : [];
  $('url-input').value = chosen;
  $('url-input').placeholder = !chosen && fromConfig.length ? 'automatic: ' + fromConfig.join(' , then ') : 'http://192.168.1.10:7703/';
  $('url-defaults').hidden = !fromConfig.length;
  $('url-submit').textContent = mode === 'add' ? 'Add' : mode === 'edit' && multi() ? 'Save' : 'Connect';
  $('url-cancel').hidden = mode === 'first';
  $('url-remove').hidden = !(mode === 'edit' && multi());
  $('url-error').hidden = true;
  syncServerChoice();
  $('urlbox').hidden = false;
  if (!$('url-name-row').hidden && mode === 'add') $('url-name').focus();
  else if ($('srv-local').checked) $('srv-local').focus();   // not the address field: focusing it picks Another computer
  else { $('url-input').focus(); $('url-input').select(); }
}

function closeBox() {
  if (box.mode === 'first') return;
  $('urlbox').hidden = true;
  if (cur) cur.view.focus();
}

function syncServerChoice() {
  $('url-input').classList.toggle('dim', !$('srv-remote').checked);
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
  const kind = $('srv-local').checked ? 'local' : 'remote';
  const editing = box.mode === 'edit' ? box.comp : null;
  try {
    const r = await window.app.saveComputer({
      id: editing ? editing.id : undefined,
      name: $('url-name-row').hidden && editing ? editing.givenName : $('url-name').value,
      kind,
      url: $('url-input').value,
    });
    $('urlbox').hidden = true;
    box.mode = '';
    const moved = applyComputers(r.config);
    const c = byId(r.id);
    for (const x of moved) startComp(x, r.config.local);
    switchTo(c);
    if (r.restartForMic) toast({ text: `Restart the app to use the microphone and the clipboard buttons with ${c.name}.` });
  } catch (err) {
    $('url-error').textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    $('url-error').hidden = false;
  }
});
$('url-cancel').addEventListener('click', closeBox);
$('urlbox').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeBox(); } });
$('url-remove').addEventListener('click', () => { const c = box.comp; if (c) removeComp(c, true); });

async function removeComp(c, fromBox = false) {
  if (comps.length < 2) return;
  if (fromBox) { $('urlbox').hidden = true; box.mode = ''; }
  const ok = await ask(`Remove ${c.name} from the app?`, c.kind === 'local'
    ? 'Claude Console and the file manager on this computer stop, and the sessions they run with them.'
    : 'Nothing changes on that computer: its console keeps running there, and you can add it again.', 'Remove');
  if (!ok) { if (cur) cur.view.focus(); return; }
  const r = await window.app.removeComputer(c.id);
  if (!r.removed) return;
  applyComputers(r.config);
  switchTo(byId(r.config.current) || comps[0]);
}

/** A yes / no question in the window; resolves true for the first button. */
function ask(title, text, okLabel) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = okLabel;
  $('confirm').hidden = false;
  $('confirm-cancel').focus();
  return new Promise((resolve) => {
    const done = (answer) => {
      $('confirm').hidden = true;
      $('confirm-form').onsubmit = null;
      $('confirm-cancel').onclick = null;
      $('confirm').onkeydown = null;
      resolve(answer);
    };
    $('confirm-form').onsubmit = (e) => { e.preventDefault(); done(true); };
    $('confirm-cancel').onclick = () => done(false);
    $('confirm').onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(false); } };
  });
}

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
window.app.on('toggle-pane', () => setPane(!(cur && cur.paneOpen)));
window.app.on('close-tab', () => { if (cur && cur.paneOpen) closeTab(cur.active); });
window.app.on('cycle-tab', cycleTab);
window.app.on('find', openFind);
window.app.on('switch-computer', (i) => { if (comps[i]) switchTo(comps[i]); });
window.app.on('add-computer', () => openBox(comps.length ? 'add' : 'first'));
window.app.on('edit-computer', (id) => openBox('edit', byId(id) || cur));
window.app.on('computer-action', ({ id, action }) => {
  const c = byId(id);
  if (!c) return;
  if (action === 'edit') openBox('edit', c);
  if (action === 'remove') removeComp(c);
  if (action === 'reload') { if (c.offline || !c.answered) reconnect(c); else c.view.reload(); }
});
window.app.on('attention', attention);
window.app.on('local-state', showLocal);
window.app.on('local-line', localLine);
window.app.on('toast', toast);
window.app.on('auth-request', (req) => { authQueue.push(req); if (!authCurrent) nextAuth(); });
window.app.on('reload', (where, hard) => {
  if (!cur) return;
  if (where === 'shell') where = state.lastArea;
  const view = where === 'pane' && cur.paneOpen && cur.active ? cur.active.view : cur.view;
  if (view === cur.view && (cur.offline || !cur.answered)) { reconnect(cur); return; }
  if (hard) view.reloadIgnoringCache(); else view.reload();
});
window.app.on('tab-action', ({ id, action }) => {
  const tab = cur && cur.tabs.find((t) => t.id === id);
  if (!tab) return;
  if (action === 'reload' && tab.loaded) tab.view.reload();
  if (action === 'browser') window.app.openExternal(tabUrl(tab));
  if (action === 'close') closeTab(tab);
  if (action === 'close-others') for (const t of [...cur.tabs]) if (t !== tab) closeTab(t);
  if (action === 'close-all') closeAllFileTabs();
});

// ------------------------------------------------------------------ start

(async function start() {
  const cfg = await window.app.config();
  state.platform = cfg.platform;
  document.documentElement.classList.toggle('mac', cfg.platform === 'darwin');
  const panes = cfg.panes || {};
  const frac = typeof cfg.frac === 'number' ? cfg.frac : (panes[cfg.current] || {}).frac;
  if (typeof frac === 'number') state.paneFrac = frac;
  applyComputers(cfg);
  if (!comps.length) { openBox('first'); return; }   // first start without config.json
  // every computer starts at once: the ones not shown keep running behind
  for (const c of comps) {
    const fmOrigin = (cfg.fmOrigins || {})[c.id];
    if (fmOrigin) { c.fmRoot = fmOrigin + '/'; c.lastFm = fmOrigin; }
    const pane = panes[c.id] || {};
    const saved = Array.isArray(pane.tabs) ? pane.tabs.filter((u) => typeof u === 'string') : [];
    if (saved.length) {
      const fm = fmTab(c);
      c.active = fm;
      for (const url of saved) {   // each one after the previous: addTab() inserts after the active tab
        const t = makeTab(c, url);
        addTab(t);
        c.active = t;
      }
      c.active = c.tabs.find((t) => !t.fm && t.key === pane.active) || fm;
    }
    c.paneOpen = !!pane.open;
    startComp(c, cfg.local);
  }
  switchTo(byId(cfg.current) || comps[0], { focus: true });
})();

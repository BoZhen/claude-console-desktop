'use strict';
/*
 * The computers the app shows, each running its own Claude Console. Plain functions
 * and no Electron, so the tests load this file directly.
 *
 * A computer, as settings.json keeps it in "computers":
 *   { id, name, kind: 'local' }                   this computer: the app starts the console
 *   { id, name, kind: 'remote', url }             another computer, at an address
 *   { id, name, kind: 'remote', config: key }     another computer at the addresses
 *                                                 config.json gives it (tried in order)
 * A remote computer from config.json that was given an address keeps both: the address
 * wins, and clearing it goes back to config.json's.
 *
 * config.json names computers in one of two ways:
 *   "urls": [...]                                 one computer (key "default"), reached
 *                                                 over different networks
 *   "computers": [{ "name": "...", "urls": [...] }, ...]   several (key = the name)
 */

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

function urlList(list) {
  const out = [];
  for (const u of Array.isArray(list) ? list : []) {
    try { out.push(normalizeUrl(u)); } catch { /* skip it */ }
  }
  return out;
}

/** config.json's computers: [{ key, name, urls }]. envUrls (CLAUDE_CONSOLE_URLS,
    comma-separated) replaces them with one computer at those addresses. */
function configComputers(cfg, envUrls) {
  const fromEnv = urlList(String(envUrls || '').split(',').filter((u) => u.trim()));
  if (fromEnv.length) return [{ key: 'default', name: '', urls: fromEnv }];
  if (!cfg || typeof cfg !== 'object') return [];
  if (Array.isArray(cfg.computers) && cfg.computers.length) {
    const out = [];
    for (const c of cfg.computers) {
      if (!c || typeof c !== 'object') continue;
      const urls = urlList(c.urls || (c.url ? [c.url] : []));
      const name = String(c.name || '').trim();
      const key = name || (urls[0] ? hostLabel(urls[0]) : '');
      if (urls.length && key && !out.some((o) => o.key === key)) out.push({ key, name, urls });
    }
    return out;
  }
  const urls = urlList(cfg.urls);
  return urls.length ? [{ key: 'default', name: '', urls }] : [];
}

/** A short name from an address: the host's first label ("office" of
    "office.example.ts.net"), an IP address as it is. */
function hostLabel(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return ''; }
  if (/^\d+(\.\d+){3}$/.test(host) || host.includes(':') || host.startsWith('[')) return host;
  return host.split('.')[0] || host;
}

/** The addresses to try for a computer (not for this computer: its address comes
    from the server the app starts). */
function urlsFor(c, config) {
  if (!c || c.kind === 'local') return [];
  if (c.url) return [c.url];
  const entry = (config || []).find((e) => e.key === c.config);
  return entry ? entry.urls.slice() : [];
}

function displayName(c, config) {
  if (c.name) return c.name;
  if (c.kind === 'local') return 'This computer';
  const entry = (config || []).find((e) => e.key === c.config);
  if (entry && entry.name) return entry.name;
  return hostLabel(urlsFor(c, config)[0]) || 'Computer';
}

/** Up to two characters for the rail: the last part of an IP address, the first
    letters of a name's first two words ("lab-server" → "LS"), else its first two letters. */
function initials(name) {
  const n = String(name || '').trim();
  if (!n) return '?';
  if (/^\d+(\.\d+){3}$/.test(n)) return n.split('.').pop();
  const words = n.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const w = words[0] || n;
  return w[0].toUpperCase() + (w[1] || '');
}

function nextId(list) {
  let i = 1;
  while (list.some((c) => c.id === `c${i}`)) i += 1;
  return `c${i}`;
}

function clean(c) {
  if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id) return null;
  const out = { id: c.id, name: typeof c.name === 'string' ? c.name.trim() : '', kind: c.kind === 'local' ? 'local' : 'remote' };
  if (out.kind === 'remote') {
    if (c.url) { try { out.url = normalizeUrl(c.url); } catch { /* dropped */ } }
    if (typeof c.config === 'string' && c.config) out.config = c.config;
    if (!out.url && !out.config) return null;
  }
  return out;
}

/**
 * The computer list for this run, from settings.json, config.json and the command line.
 *   settings  settings.json, as read
 *   config    configComputers(...)
 *   args      { url, local }: --url / CLAUDE_CONSOLE_URL, --local / CLAUDE_CONSOLE_LOCAL=1
 * Returns { list, current, transient, changed }:
 *   transient  the list comes from the command line and is not saved
 *   changed    settings were moved over from the single-server format (or config.json
 *              brought a new computer); the caller saves them. Settings are changed in place.
 */
function loadComputers(settings, config, args = {}) {
  if (args.url) {
    const url = normalizeUrl(args.url);
    return { list: [{ id: 'cli', name: '', kind: 'remote', url }], current: 'cli', transient: true, changed: false };
  }
  if (args.local) return { list: [{ id: 'local', name: '', kind: 'local' }], current: 'local', transient: true, changed: false };

  let changed = false;
  let list;
  let legacy = null;   // the single-server pane and file manager address, for the first computer
  if (Array.isArray(settings.computers)) {
    list = settings.computers.map(clean).filter(Boolean);
    if (list.length !== settings.computers.length) changed = true;
  } else {
    // The single-server settings of earlier versions: server, url, pane, fmOrigin.
    list = [];
    const removed = [];
    if (settings.server === 'local') {
      list.push({ id: 'local', name: '', kind: 'local' });
      removed.push('default');            // config.json's addresses were this one server's
    } else if (settings.url) {
      try { list.push({ id: 'c1', name: '', kind: 'remote', url: normalizeUrl(settings.url) }); } catch { /* dropped */ }
      removed.push('default');            // the chosen address replaced config.json's
    }
    if (removed.length) settings.removedConfig = removed;
    legacy = { pane: settings.pane, fmOrigin: settings.fmOrigin };
    for (const k of ['server', 'url', 'pane', 'fmOrigin']) delete settings[k];
    changed = true;
  }
  // config.json's computers that are not in the list yet (and were not removed)
  const removed = new Set(Array.isArray(settings.removedConfig) ? settings.removedConfig : []);
  for (const e of config || []) {
    if (removed.has(e.key) || list.some((c) => c.config === e.key)) continue;
    const id = list.some((c) => c.id === `cfg:${e.key}`) ? nextId(list) : `cfg:${e.key}`;
    list.push({ id, name: '', kind: 'remote', config: e.key });
    changed = true;
  }
  if (legacy && list.length) {
    if (legacy.pane) settings.panes = { [list[0].id]: legacy.pane };
    if (legacy.fmOrigin) settings.fmOrigins = { [list[0].id]: legacy.fmOrigin };
  }
  // at most one "this computer"
  const firstLocal = list.findIndex((c) => c.kind === 'local');
  if (firstLocal >= 0 && list.some((c, i) => c.kind === 'local' && i !== firstLocal)) {
    list = list.filter((c, i) => c.kind !== 'local' || i === firstLocal);
    changed = true;
  }
  if (changed) settings.computers = list;
  const current = list.some((c) => c.id === settings.current) ? settings.current : list.length ? list[0].id : '';
  return { list, current, transient: false, changed };
}

module.exports = {
  normalizeUrl, configComputers, hostLabel, urlsFor, displayName, initials, nextId, loadComputers,
};

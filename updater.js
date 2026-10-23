'use strict';
/*
 * In-app updates from the console. The console serves the newest published bundle
 * (scripts/publish.sh): GET api/desktop/latest is its manifest, GET
 * api/desktop/bundle/<version> its bytes. A newer one is downloaded into
 * <userData>/updates, checked (bundle-pick.js) and then offered: the rail's update
 * button (and Settings > About in the console) restarts into it, and loader.js runs
 * it from then on. Only packaged installs update; a git checkout runs its own code.
 */
const { app, session } = require('electron');
const path = require('node:path');
const pickLib = require('./bundle-pick');

const FIRST_CHECK_MS = 15_000;          // after the console has answered
const CHECK_EVERY_MS = 6 * 3600_000;

function createUpdater({ consoleOrigin, onChange }) {
  const b = global.ccdBundle || {
    version: 'dev', builtin: 'dev', source: 'builtin', packaged: false,
    updatesDir: path.join(app.getPath('userData'), 'updates'),
  };
  const dir = b.updatesDir;
  const fs = pickLib.rawFs;
  const electronMajor = Number(process.versions.electron.split('.')[0]);
  const state = {
    running: b.version, builtin: b.builtin, source: b.source, packaged: !!b.packaged,
    ready: null,            // {version, notes}: downloaded and checked, a restart away
    needsReinstall: null,   // {version}: needs a newer Electron, so a new install
    checking: false, checked: 0, error: null,
  };
  const info = () => ({ ...state });
  const changed = () => { try { onChange(info()); } catch { /* a closing window */ } };
  const fileFor = (v, ext) => path.join(dir, `claude-console-desktop-${v}${ext}`);

  /** The bundle for manifest m, already here or downloaded now; true once it is here and trusted. */
  async function bundleFor(base, m) {
    if (fs.existsSync(fileFor(m.version, '.json.bad'))) throw new Error(`version ${m.version} did not start here; skipped`);
    try {
      if (pickLib.trusted(fs.readFileSync(fileFor(m.version, '.asar')), m)) return true;
    } catch { /* not downloaded yet */ }
    const res = await session.defaultSession.fetch(new URL(m.url, base + '/').toString(), { cache: 'no-store' });
    if (!res.ok) throw new Error(`download: HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    if (!pickLib.trusted(data, m)) throw new Error('the download does not match its signature');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fileFor(m.version, '.asar.part'), data);
    fs.renameSync(fileFor(m.version, '.asar.part'), fileFor(m.version, '.asar'));
    const keep = { version: m.version, size: m.size, sha256: m.sha256, signature: m.signature, electron: m.electron, notes: m.notes || '' };
    fs.writeFileSync(fileFor(m.version, '.json'), JSON.stringify(keep, null, 1));
    return true;
  }

  async function check() {
    if (!state.packaged || state.checking) return info();
    if (!pickLib.PUBLIC_KEY) {   // see bundle-pick.js: a build without an update key
      state.error = 'this build has no update key, so new versions come as new packages';
      changed();
      return info();
    }
    state.checking = true;
    changed();
    try {
      const base = consoleOrigin();
      if (!base) throw new Error('the console has not answered yet');
      const res = await session.defaultSession.fetch(base + '/api/desktop/latest', { cache: 'no-store' });
      const json = (res.headers.get('content-type') || '').startsWith('application/json');
      if (res.status === 404 || (res.ok && !json)) {
        state.ready = null; state.needsReinstall = null;   // nothing published, or a console from before updates
      } else if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      } else {
        const m = await res.json();
        state.ready = null; state.needsReinstall = null;
        if (pickLib.newer(m.version, state.running)) {
          if ((Number(m.electron) || 0) > electronMajor) state.needsReinstall = { version: m.version };
          else if (await bundleFor(base, m)) state.ready = { version: m.version, notes: m.notes || '' };
        }
      }
      state.error = null;
      state.checked = Date.now();
    } catch (e) {
      state.error = e.message || String(e);
    }
    state.checking = false;
    changed();
    return info();
  }

  /** Restart into the downloaded version. */
  function install() {
    if (!state.ready) return info();
    app.relaunch();
    app.quit();
    return info();
  }

  /** The window has loaded: this version starts fine. Tidy the folder. */
  function started() {
    try { fs.unlinkSync(pickLib.trying(dir, state.running)); } catch { /* not an update, or already gone */ }
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    const bad = new Set(names.map((n) => /^claude-console-desktop-(\d+(?:\.\d+)*)\.json\.bad$/.exec(n)).filter(Boolean).map((m) => m[1]));
    for (const n of names) {
      const m = /^claude-console-desktop-(\d+(?:\.\d+)*)\.(asar|json)$/.exec(n);
      const old = m && m[1] !== state.running && !pickLib.newer(m[1], state.running);
      const t = /^\.trying-(.+)$/.exec(n);
      // older versions, half downloads, a set-aside version's code (its .bad note stays,
      // so it is not fetched again) and start markers left by other versions
      const drop = old || n.endsWith('.part') || (m && m[2] === 'asar' && bad.has(m[1])) || (t && t[1] !== state.running);
      if (drop) { try { fs.unlinkSync(path.join(dir, n)); } catch { /* in use */ } }
    }
  }

  if (state.packaged && pickLib.PUBLIC_KEY) {
    setTimeout(check, FIRST_CHECK_MS);
    setInterval(check, CHECK_EVERY_MS);
  }
  return { info, check, install, started };
}

module.exports = { createUpdater };

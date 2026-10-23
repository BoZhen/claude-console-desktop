'use strict';
/*
 * The app's entry point. It starts one copy of the app's code (main.js and what it
 * loads):
 *   - an update from the console, kept in <userData>/updates (see updater.js), when
 *     a trusted one is newer than the built-in code (bundle-pick.js decides);
 *   - otherwise the code that came with this install, next to this file.
 * Run from a git checkout (not packaged) the checkout's own code always runs.
 *
 * Before an update's code runs, a ".trying-<version>" marker is written; main.js
 * removes it once the window has loaded. A start that dies before that leaves the
 * marker, and the next start sets that version aside and runs the built-in code.
 * An update that throws while loading is set aside at once and the app restarts.
 */
const { app } = require('electron');
const path = require('node:path');
const pickLib = require('./bundle-pick');

function builtinVersion() {
  try { return JSON.parse(require('node:fs').readFileSync(path.join(__dirname, 'bundle.json'), 'utf8')).version; } catch { return 'dev'; }
}

const builtin = builtinVersion();
const updatesDir = path.join(app.getPath('userData'), 'updates');
let run = { dir: __dirname, version: builtin, source: 'builtin' };
if (app.isPackaged && !process.env.CCD_NO_UPDATES) {
  const major = Number(process.versions.electron.split('.')[0]);
  const u = pickLib.pick(updatesDir, builtin, major);
  if (u) {
    run = { dir: u.file, version: u.version, source: 'update' };
    try { pickLib.rawFs.writeFileSync(pickLib.trying(updatesDir, u.version), new Date().toISOString() + '\n'); } catch { /* best effort */ }
  }
}
global.ccdBundle = { ...run, builtin, updatesDir, packaged: app.isPackaged };
try {
  require(path.join(run.dir, 'main.js'));
} catch (e) {
  if (run.source !== 'update') throw e;
  // The update itself fails to start: set it aside and start again on the built-in code.
  pickLib.markBad(updatesDir, run.version, `threw on start: ${e && e.message}`);
  app.relaunch();
  app.exit(1);
}

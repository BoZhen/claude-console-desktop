'use strict';
/*
 * Which copy of the app's code to run, and whether a downloaded one may be trusted.
 * Used by loader.js at start and by updater.js after a download; plain Node, so the
 * tests run it outside Electron.
 *
 * An update is a bundle (an asar archive of the app's code with bundle.json naming
 * its version) and a manifest {version, size, sha256, signature, electron}. It is
 * trusted when its bytes have that size and SHA-256 and the signature is valid for
 * PUBLIC_KEY, whose private half stays on the build machine
 * (scripts/make-update-key.sh). Versions are dates, 2026.10.23.0612.
 */
const crypto = require('node:crypto');
const path = require('node:path');

/* The key updates must be signed with: "updateKey" in the config.json beside this
   file, the private settings of whoever builds the app (scripts/make-update-key.sh
   writes it there). The loader reads it from the installed package, so an update
   cannot bring a key of its own. A build without one, a public build for instance,
   trusts no update: a newer version comes as a newer package. */
function configuredKey() {
  try {
    const key = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, 'config.json'), 'utf8')).updateKey;
    return typeof key === 'string' && key.includes('BEGIN PUBLIC KEY') ? key.trim() : null;
  } catch {
    return null;
  }
}
const PUBLIC_KEY = configuredKey();

// Electron's fs treats a *.asar file as a folder; its original-fs reads the bytes.
let rawFs;
try { rawFs = require('original-fs'); } catch { rawFs = require('node:fs'); }

const BUNDLE = /^claude-console-desktop-(\d+(?:\.\d+)*)\.json$/;

/** true when version a is newer than b ("dev" and other non-dates are never newer). */
function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  if (pa.some(Number.isNaN)) return false;
  if (pb.some(Number.isNaN)) return true;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** The bundle's bytes match its manifest and carry our signature. */
function trusted(data, manifest, publicKey = PUBLIC_KEY) {
  if (!publicKey || !manifest || !Buffer.isBuffer(data)) return false;
  if (manifest.size && data.length !== manifest.size) return false;
  if (crypto.createHash('sha256').update(data).digest('hex') !== manifest.sha256) return false;
  try {
    return crypto.verify(null, data, publicKey, Buffer.from(String(manifest.signature || ''), 'base64'));
  } catch {
    return false;
  }
}

function readManifest(file) {
  try { return JSON.parse(rawFs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * The newest trusted update in dir that is newer than builtinVersion and fits this
 * Electron (manifest.electron <= electronMajor), as {file, version, manifest}, or
 * null. A version whose last start never finished (its ".trying" marker is still
 * there) is set aside as ".bad", so a broken update cannot keep the app from
 * starting; so is one that fails the check.
 */
function pick(dir, builtinVersion, electronMajor, publicKey = PUBLIC_KEY) {
  if (!publicKey) return null;   // no key, no updates: and nothing in dir is touched
  let names = [];
  try { names = rawFs.readdirSync(dir); } catch { return null; }
  const found = names.map((n) => BUNDLE.exec(n)).filter(Boolean)
    .map((m) => ({ version: m[1], json: path.join(dir, m[0]), file: path.join(dir, m[0].replace(/\.json$/, '.asar')) }))
    .filter((c) => newer(c.version, builtinVersion))
    .sort((a, b) => (newer(a.version, b.version) ? -1 : 1));
  for (const c of found) {
    const manifest = readManifest(c.json);
    if (!manifest || String(manifest.version) !== c.version) continue;
    if ((Number(manifest.electron) || 0) > electronMajor) continue;   // needs a newer app install
    const marker = trying(dir, c.version);
    if (rawFs.existsSync(marker)) { setAside(c, 'did not start'); continue; }
    let data;
    try { data = rawFs.readFileSync(c.file); } catch { continue; }
    if (!trusted(data, manifest, publicKey)) { setAside(c, 'failed the check'); continue; }
    return { file: c.file, version: c.version, manifest };
  }
  return null;
}

const trying = (dir, version) => path.join(dir, `.trying-${version}`);

function setAside(c, why) {
  try { rawFs.renameSync(c.json, c.json + '.bad'); } catch { /* already gone */ }
  try { rawFs.writeFileSync(c.json + '.why', why + '\n'); } catch { /* best effort */ }
}

/** Sets a version aside, so pick() skips it from now on. */
function markBad(dir, version, why) {
  setAside({ json: path.join(dir, `claude-console-desktop-${version}.json`) }, why);
}

module.exports = { PUBLIC_KEY, newer, trusted, pick, trying, markBad, rawFs, BUNDLE };

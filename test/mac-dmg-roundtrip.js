'use strict';
// Unpacks the image scripts/build-mac.sh made and compares it with the signed app it
// was made from:
//
//   node test/mac-dmg-roundtrip.js [arm64] [dist/public]
//
// UDIF checksums (7z), the volume's top level and the Applications link, the
// background, the Finder layout against the volume's catalog (mac-layout-check.py),
// every file's bytes and mode and every symlink of the app, the volume headers, and
// the code signatures' hashes (mac-signatures.py). This does not replace checking on
// a Mac: hdiutil verify, codesign --verify --deep --strict, and a look at the window.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { APP_NAME, TOOLS, linuxLayoutMetadata, layoutPython } = require('../scripts/mac-dmg');

const arch = process.argv[2] || 'arm64';
const root = path.resolve(__dirname, '..');
const dist = path.resolve(root, process.argv[3] || 'dist');   // dist/public for build-mac.sh --public
const dmg = process.env.DMG_TOOL || path.join(TOOLS, 'libdmg-hfsplus/build/dmg/dmg');
const hfsplus = process.env.HFSPLUS_TOOL || path.join(TOOLS, 'libdmg-hfsplus/build/hfs/hfsplus');
const source = path.join(dist, `${APP_NAME}-darwin-${arch}`, APP_NAME + '.app');
const artifact = path.join(dist, `Claude-Console-mac-${arch}.dmg`);
function run(command, args) { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }); }
function manifest(dir, base = dir, entries = {}) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name), rel = path.relative(base, file), info = fs.lstatSync(file);
    if (info.isSymbolicLink()) entries[rel] = { link: fs.readlinkSync(file) };
    else if (info.isDirectory()) { entries[rel] = { directory: true }; manifest(file, base, entries); }
    else entries[rel] = { sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), executable: info.mode & 0o111 };
  }
  return entries;
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-dmg-roundtrip-'));
try {
  run('7z', ['t', '-bd', artifact]);
  const hfs = path.join(temp, 'volume.hfs'), extracted = path.join(temp, 'extracted');
  fs.mkdirSync(extracted);
  run(dmg, ['extract', artifact, hfs]);
  run(hfsplus, [hfs, 'extractall', '/', extracted]);
  assert.deepEqual(fs.readdirSync(extracted).sort(), ['.DS_Store', '.background', 'Applications', APP_NAME + '.app'].sort());
  assert.equal(fs.readlinkSync(path.join(extracted, 'Applications')), '/Applications');
  assert.deepEqual(fs.readFileSync(path.join(extracted, '.background/background.png')), fs.readFileSync(path.join(root, 'assets/mac-dmg-background.png')));
  const meta = linuxLayoutMetadata(hfs, temp);
  console.log(layoutPython([path.join(root, 'test/mac-layout-check.py'), extracted, JSON.stringify(meta)]).trim());
  const actual = manifest(path.join(extracted, APP_NAME + '.app'));
  assert.deepEqual(actual, manifest(source), 'the image keeps every file, mode and symlink of the app');
  const header = Buffer.alloc(512), fd = fs.openSync(hfs, 'r');
  try { fs.readSync(fd, header, 0, 512, 1024); } finally { fs.closeSync(fd); }
  assert.equal(header.readUInt32BE(88), 2, 'Finder opens the root folder');
  assert.ok(!header.subarray(104, 112).equals(Buffer.alloc(8)), 'the volume has its own nonzero ID');
  const signatures = JSON.parse(run(process.env.DMG_PYTHON || 'python3', [path.join(root, 'test/mac-signatures.py'), path.join(extracted, APP_NAME + '.app')]));
  assert.ok(signatures.signed_binaries >= 10);
  console.log('PASS:', Object.keys(actual).length, 'app entries, the Applications link, the layout, the volume headers, UDIF checksums, signature hashes:', signatures);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

'use strict';
// Turns the packaged "Claude Console.app" into a drag-to-install disk image:
// dist/Claude-Console-mac-<arch>.dmg, a compressed UDIF image holding one HFS+ volume
// with the app, a link to /Applications and a Finder window laid out over a
// background that says what to do.
//
//   node scripts/mac-dmg.js "dist/Claude Console-darwin-arm64" arm64
//
// scripts/build-mac.sh runs it after packaging. On Linux it needs the tools that
// scripts/mac-tools.sh builds; on a Mac it uses codesign and hdiutil.
//
// The app is signed ad hoc (rcodesign on Linux, codesign on a Mac): Apple silicon
// refuses to start an unsigned bundle. Nothing here removes the download quarantine
// or touches Gatekeeper; the first start is approved on the Mac, as the background
// explains.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const APP_NAME = 'Claude Console';
const TOOLS = process.env.MAC_TOOLS || path.join(os.homedir(), '.cache', 'claude-console-desktop', 'mac-tools');
const ASSETS = path.resolve(__dirname, '..', 'assets');

function tool(variable, fallback, cached) {
  if (process.env[variable]) return process.env[variable];
  const candidate = path.join(TOOLS, cached);
  return fs.existsSync(candidate) ? candidate : fallback;
}
function run(command, args, env = process.env) {
  try { return execFileSync(command, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }); }
  catch (error) { throw new Error(`${command} failed: ${error.stderr || error.message}`); }
}

// xorriso writes an ISO 9660 / HFS+ hybrid behind an Apple partition map. Find the
// one Apple_HFS partition, checking every bound, so only HFS+ goes into the image.
function hfsPartition(fd, fileSize) {
  const header = Buffer.alloc(512);
  if (fs.readSync(fd, header, 0, 512, 0) !== 512 || header.readUInt16BE(0) !== 0x4552) throw new Error('Missing Apple disk descriptor');
  const blockSize = header.readUInt16BE(2);
  if (![512, 2048].includes(blockSize)) throw new Error('Unsupported partition block size');
  let count = 1, found;
  for (let i = 1; i <= count; i++) {
    if (fs.readSync(fd, header, 0, 512, blockSize * i) !== 512 || header.readUInt16BE(0) !== 0x504d) throw new Error('Invalid Apple partition map');
    count = header.readUInt32BE(4);
    if (count < 1 || count > 64) throw new Error('Invalid partition count');
    const type = header.subarray(48, 80).toString('ascii').replace(/\0.*$/, '');
    if (type !== 'Apple_HFS') continue;
    const start = header.readUInt32BE(8) * blockSize, size = header.readUInt32BE(12) * blockSize;
    if (found || size < 2048 || start < (count + 1) * blockSize || start + size > fileSize) throw new Error('Invalid HFS+ partition bounds');
    found = { start, size };
  }
  if (!found) throw new Error('No HFS+ partition');
  const magic = Buffer.alloc(2);
  fs.readSync(fd, magic, 0, 2, found.start + 1024);
  if (!['H+', 'HX'].includes(magic.toString('ascii'))) throw new Error('Invalid HFS+ volume');
  return found;
}

function extractHfs(source, destination) {
  const fd = fs.openSync(source, 'r');
  try {
    const { start, size } = hfsPartition(fd, fs.fstatSync(fd).size);
    const out = fs.openSync(destination, 'wx'), buffer = Buffer.alloc(1024 * 1024);
    try {
      for (let copied = 0; copied < size;) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - copied), start + copied);
        if (!count) throw new Error('Truncated HFS+ partition');
        let written = 0;
        while (written < count) written += fs.writeSync(out, buffer, written, count - written);
        copied += count;
      }
    } finally { fs.closeSync(out); }
  } finally { fs.closeSync(fd); }
}

// Both HFS+ volume headers (at 1024 and 1024 bytes before the end of the volume):
// the folder Finder opens on mount (finderInfo[2] at offset 88, the root is CNID 2),
// a fresh nonzero volume ID (finderInfo[6..7] at 104; xorriso leaves it all zero, so
// every build would claim the same identity), and the write counter (68). Only ever
// run on the image being built here.
function openHfsRoot(file, volumeId = crypto.randomBytes(8)) {
  if (!Buffer.isBuffer(volumeId) || volumeId.length !== 8 || volumeId.equals(Buffer.alloc(8))) throw new Error('Invalid HFS+ volume ID');
  const fd = fs.openSync(file, 'r+');
  try {
    const header = Buffer.alloc(512), backup = Buffer.alloc(512);
    fs.readSync(fd, header, 0, 512, 1024);
    const size = header.readUInt32BE(40) * header.readUInt32BE(44);
    if (!['H+', 'HX'].includes(header.toString('ascii', 0, 2)) || size < 4096 || size > fs.fstatSync(fd).size) throw new Error('Invalid HFS+ header');
    fs.readSync(fd, backup, 0, 512, size - 1024);
    if (!header.subarray(0, 4).equals(backup.subarray(0, 4))) throw new Error('Invalid alternate HFS+ header');
    const rootId = Buffer.alloc(4); rootId.writeUInt32BE(2);
    const writes = Buffer.alloc(4); writes.writeUInt32BE((header.readUInt32BE(68) + 1) >>> 0);
    for (const base of [1024, size - 1024]) {
      fs.writeSync(fd, writes, 0, 4, base + 68);
      fs.writeSync(fd, rootId, 0, 4, base + 88);
      fs.writeSync(fd, volumeId, 0, 8, base + 104);
    }
  } finally { fs.closeSync(fd); }
}

function layoutPython(args) {
  const cached = path.join(TOOLS, 'python');
  const env = { ...process.env };
  if (fs.existsSync(cached)) env.PYTHONPATH = [cached, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  return run(process.env.DMG_PYTHON || 'python3', args, env);
}

// Compiles scripts/hfs-layout-meta.c against libdmg-hfsplus and runs it on the
// volume: it reports the catalog IDs and dates the background alias must name and,
// with clean, blanks the Finder info xorriso gives every regular file.
function linuxLayoutMetadata(hfs, temp, clean = false) {
  const source = process.env.HFSPLUS_SOURCE || path.join(TOOLS, 'libdmg-hfsplus');
  const helper = path.join(temp, 'hfs-layout-meta');
  if (!fs.existsSync(helper)) {
    run(process.env.CC || 'cc', ['-O2', '-fno-strict-aliasing', '-I' + path.join(source, 'includes'),
      path.join(__dirname, 'hfs-layout-meta.c'), '-L' + path.join(source, 'build/hfs'), '-lhfs',
      '-L' + path.join(source, 'build/common'), '-lcommon', '-lz', '-o', helper]);
  }
  return JSON.parse(run(helper, [hfs, ...(clean ? ['--clean-finder-info'] : [])]));
}

function checkUdif(image) {
  const fd = fs.openSync(image, 'r'), trailer = Buffer.alloc(512);
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 512 || fs.readSync(fd, trailer, 0, 512, size - 512) !== 512 || trailer.toString('ascii', 0, 4) !== 'koly') throw new Error('Invalid UDIF disk image');
  } finally { fs.closeSync(fd); }
}

function createMacDmg(folder, arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Unsupported Mac architecture');
  const app = path.join(folder, APP_NAME + '.app');
  if (!fs.statSync(app).isDirectory()) throw new Error('Packaged app is missing');
  const output = path.join(path.dirname(folder), `Claude-Console-mac-${arch}.dmg`);
  // next to the output, so the finished image is renamed into place in one step and a
  // failed build leaves the previous image alone
  const temp = fs.mkdtempSync(path.join(path.dirname(folder), '.mac-dmg-'));
  let mounted = null;
  try {
    if (process.platform === 'darwin') {
      run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    } else if (process.platform === 'linux') {
      const signer = tool('RCODESIGN', 'rcodesign', 'rcodesign-0.29.0/apple-codesign-0.29.0-x86_64-unknown-linux-musl/rcodesign');
      run(signer, ['sign', '--config-file', '/dev/null', '--timestamp-url', 'none', app]);
    } else throw new Error('Build the disk image on macOS or Linux');
    const stage = path.join(temp, 'volume'); fs.mkdirSync(stage);
    // verbatimSymlinks keeps Electron Framework's relative links as they are
    fs.cpSync(app, path.join(stage, path.basename(app)), { recursive: true, verbatimSymlinks: true });
    fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
    // the template only reserves the space; the real layout replaces it below
    fs.copyFileSync(path.join(ASSETS, 'mac-dmg.DS_Store'), path.join(stage, '.DS_Store'));
    fs.mkdirSync(path.join(stage, '.background'));
    fs.copyFileSync(path.join(ASSETS, 'mac-dmg-background.png'), path.join(stage, '.background/background.png'));
    const image = path.join(temp, 'installer.dmg');
    if (process.platform === 'darwin') {
      const writable = path.join(temp, 'writable.dmg'), mount = path.join(temp, 'mounted');
      fs.mkdirSync(mount);
      run('/usr/bin/hdiutil', ['create', '-volname', APP_NAME, '-srcfolder', stage, '-fs', 'HFS+', '-format', 'UDRW', writable]);
      run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-mountpoint', mount, writable]); mounted = mount;
      layoutPython([path.join(__dirname, 'make-mac-layout.py'), '--output', path.join(mount, '.DS_Store'), '--mounted-root', mount]);
      run('/usr/sbin/bless', ['--folder', mount, '--openfolder', mount]);
      run('/usr/bin/hdiutil', ['detach', mount]); mounted = null;
      run('/usr/bin/hdiutil', ['convert', writable, '-format', 'UDZO', '-o', image]);
      run('/usr/bin/hdiutil', ['verify', image]);
    } else {
      const hybrid = path.join(temp, 'hybrid.img'), hfs = path.join(temp, 'volume.hfs');
      run(process.env.XORRISO || 'xorriso', ['-as', 'mkisofs', '-quiet', '-R', '-D', '-hfsplus',
        '-apm-block-size', '512', '-hfsplus-block-size', '2048', '-hfs-bless-by', 'show_folder', '/',
        '-V', APP_NAME, '-o', hybrid, stage]);
      // keep only the HFS+ volume: no ISO renamed to .dmg, no second volume on the Mac
      extractHfs(hybrid, hfs);
      const hfsTool = tool('HFSPLUS_TOOL', 'hfsplus', 'libdmg-hfsplus/build/hfs/hfsplus');
      const metadata = path.join(temp, 'layout-meta.json'), layout = path.join(temp, '.DS_Store');
      // xorriso gives every file the Finder type and creator "????????", which the Mac
      // shows as com.apple.FinderInfo; codesign --strict then rejects the bundle
      // ("resource fork, Finder information, or similar detritus not allowed")
      fs.writeFileSync(metadata, JSON.stringify(linuxLayoutMetadata(hfs, temp, true)));
      layoutPython([path.join(__dirname, 'make-mac-layout.py'), '--output', layout, '--metadata', metadata]);
      // the volume has no free blocks to spare, so the layout must fit the template's
      // space exactly; if the layout grows, regenerate the template (make-mac-layout.py)
      if (fs.statSync(layout).size !== fs.statSync(path.join(stage, '.DS_Store')).size) throw new Error('Finder layout exceeded its reserved space');
      run(hfsTool, [hfs, 'add', layout, '/.DS_Store']);
      openHfsRoot(hfs);
      run(tool('DMG_TOOL', 'dmg', 'libdmg-hfsplus/build/dmg/dmg'), ['-c', 'zlib', 'build', hfs, image]);
    }
    checkUdif(image);
    fs.renameSync(image, output);
    return output;
  } finally {
    // never remove a filesystem that is still mounted
    if (mounted) run('/usr/bin/hdiutil', ['detach', mounted]);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { APP_NAME, TOOLS, hfsPartition, extractHfs, openHfsRoot, createMacDmg, linuxLayoutMetadata, layoutPython };

if (require.main === module) {
  const [folder, arch = 'arm64'] = process.argv.slice(2);
  if (!folder) { console.error('usage: node scripts/mac-dmg.js <packaged app folder> [arm64|x64]'); process.exit(2); }
  try { console.log(createMacDmg(path.resolve(folder), arch)); }
  catch (error) { console.error(error.message); process.exit(1); }
}

'use strict';
// node --test test/   The disk image's own logic, on made-up images: no tools needed.
// test/mac-dmg-roundtrip.js checks a real image built by scripts/build-mac.sh.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { APP_NAME, hfsPartition, extractHfs, openHfsRoot, createMacDmg } = require('../scripts/mac-dmg');

// an Apple partition map with the map itself and one Apple_HFS partition at 8192
function image(blockSize = 512) {
  const data = Buffer.alloc(24576), start = 8192, size = 8192;
  data.writeUInt16BE(0x4552); data.writeUInt16BE(blockSize, 2);
  for (let i = 1; i <= 2; i++) {
    const p = blockSize * i;
    data.writeUInt16BE(0x504d, p); data.writeUInt32BE(2, p + 4);
    data.write(i === 1 ? 'Apple_partition_map' : 'Apple_HFS', p + 48, 'ascii');
    if (i === 2) { data.writeUInt32BE(start / blockSize, p + 8); data.writeUInt32BE(size / blockSize, p + 12); }
  }
  data.fill(0x72, start, start + size); data.write('H+', start + 1024, 'ascii');
  return data;
}
function fixture(t, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-dmg-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'hybrid.img'); fs.writeFileSync(source, data);
  const fd = fs.openSync(source, 'r'); t.after(() => fs.closeSync(fd));
  return { dir, source, fd };
}

test('takes only the HFS+ partition, from 512- and 2048-byte partition maps', t => {
  for (const blockSize of [512, 2048]) {
    const data = image(blockSize), { dir, source, fd } = fixture(t, data);
    assert.deepEqual(hfsPartition(fd, data.length), { start: 8192, size: 8192 });
    const output = path.join(dir, 'volume.hfs'); extractHfs(source, output);
    assert.deepEqual(fs.readFileSync(output), data.subarray(8192, 16384));
    assert.throws(() => extractHfs(source, output), /EEXIST/);
  }
});

test('refuses a broken map, a partition out of bounds and a volume that is not HFS+', t => {
  const cases = [
    data => data.writeUInt16BE(0, 0), data => data.writeUInt16BE(1024, 2),
    data => data.writeUInt32BE(9999, 512 + 4), data => data.writeUInt32BE(999999, 1024 + 12),
    data => data.writeUInt32BE(1, 1024 + 8), data => data.write('XX', 8192 + 1024),
    data => data.write('Apple_ZZZ', 1024 + 48),
  ];
  for (const mutate of cases) {
    const data = image(); mutate(data); const { fd } = fixture(t, data);
    assert.throws(() => hfsPartition(fd, data.length));
  }
  const { fd } = fixture(t, Buffer.alloc(128)); assert.throws(() => hfsPartition(fd, 128));
});

test('sets the folder to open, the write count and a volume ID in both volume headers', t => {
  const volume = Buffer.alloc(8192);
  for (const start of [1024, 7168]) {
    volume.write('H+', start); volume.writeUInt16BE(4, start + 2);
    volume.writeUInt32BE(2048, start + 40); volume.writeUInt32BE(4, start + 44);
  }
  const { source } = fixture(t, volume), id = Buffer.from('0102030405060708', 'hex'); openHfsRoot(source, id);
  volume.writeUInt32BE(2, 1024 + 88); volume.writeUInt32BE(2, 7168 + 88);
  volume.writeUInt32BE(1, 1024 + 68); volume.writeUInt32BE(1, 7168 + 68);
  id.copy(volume, 1024 + 104); id.copy(volume, 7168 + 104);
  assert.deepEqual(fs.readFileSync(source), volume);
  volume.write('BAD!', 7168); fs.writeFileSync(source, volume);
  assert.throws(() => openHfsRoot(source), /alternate/);
  assert.throws(() => openHfsRoot(source, Buffer.alloc(8)), /volume ID/);
});

test('a failed build keeps the previous image and leaves no temporary folder', { skip: process.platform !== 'linux' }, t => {
  const { dir } = fixture(t, image()), folder = path.join(dir, 'package');
  fs.mkdirSync(path.join(folder, APP_NAME + '.app'), { recursive: true });
  const previous = path.join(dir, 'Claude-Console-mac-arm64.dmg'); fs.writeFileSync(previous, 'previous');
  const before = process.env.RCODESIGN; process.env.RCODESIGN = '/usr/bin/false';
  try { assert.throws(() => createMacDmg(folder, 'arm64'), /failed/); }
  finally { if (before === undefined) delete process.env.RCODESIGN; else process.env.RCODESIGN = before; }
  assert.equal(fs.readFileSync(previous, 'utf8'), 'previous');
  assert.ok(!fs.readdirSync(dir).some(name => name.startsWith('.mac-dmg-')));
});

test('ships the window layout and background, and never clears the quarantine', () => {
  const root = path.resolve(__dirname, '..');
  const layout = fs.readFileSync(path.join(root, 'assets/mac-dmg.DS_Store'));
  assert.equal(layout.toString('ascii', 4, 8), 'Bud1');
  const background = fs.readFileSync(path.join(root, 'assets/mac-dmg-background.png'));
  assert.equal(background.subarray(1, 4).toString(), 'PNG');
  assert.equal(background.readUInt32BE(16), 760);
  assert.equal(background.readUInt32BE(20), 560);
  for (const script of ['scripts/mac-dmg.js', 'scripts/build-mac.sh'])
    assert.doesNotMatch(fs.readFileSync(path.join(root, script), 'utf8'), /xattr|spctl|sudo|--no-sandbox/, script);
  // the zip and its install script that cleared the quarantine are gone for good
  assert.ok(!fs.existsSync(path.join(root, 'scripts/mac-install.sh')));
});

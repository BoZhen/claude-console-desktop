'use strict';
// node --test test/   (plain Node: bundle-pick.js falls back to node:fs outside Electron)
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pickLib = require('../bundle-pick');

const ours = crypto.generateKeyPairSync('ed25519');
const theirs = crypto.generateKeyPairSync('ed25519');
const PUB = ours.publicKey.export({ type: 'spki', format: 'pem' });

function put(dir, version, { key = ours.privateKey, electron = 44, tamper = false } = {}) {
  const data = Buffer.from(`code of ${version}`);
  const m = { version, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'),
    signature: crypto.sign(null, data, key).toString('base64'), electron };
  fs.writeFileSync(path.join(dir, `claude-console-desktop-${version}.asar`), tamper ? Buffer.from(`code of ${version}!`) : data);
  fs.writeFileSync(path.join(dir, `claude-console-desktop-${version}.json`), JSON.stringify(m));
}
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-pick-'));
const bad = (dir, v) => fs.existsSync(path.join(dir, `claude-console-desktop-${v}.json.bad`));

test('versions compare as dates; "dev" is never newer', () => {
  assert.ok(pickLib.newer('2026.10.23.0612', '2026.10.23.0600'));
  assert.ok(!pickLib.newer('2026.10.23.0600', '2026.10.23.0612'));
  assert.ok(!pickLib.newer('2026.10.23.0612', '2026.10.23.0612'));
  assert.ok(pickLib.newer('2026.10.24', '2026.10.23.2359'));
  assert.ok(!pickLib.newer('dev', '2026.1.1') && pickLib.newer('2026.1.1', 'dev'));
});

test('the newest trusted update newer than the built-in code wins', () => {
  const d = fresh();
  put(d, '2026.10.23.0500'); put(d, '2026.10.23.0700'); put(d, '2026.10.23.0600');
  assert.strictEqual(pickLib.pick(d, '2026.10.23.0550', 44, PUB).version, '2026.10.23.0700');
  assert.strictEqual(pickLib.pick(d, '2026.10.23.0700', 44, PUB), null);   // nothing newer than built-in
});

test('signed with another key, or changed after signing: set aside, the next one is used', () => {
  const d = fresh();
  put(d, '2026.10.23.0600');
  put(d, '2026.10.23.0700', { key: theirs.privateKey });
  put(d, '2026.10.23.0800', { tamper: true });
  assert.strictEqual(pickLib.pick(d, '2026.10.23.0500', 44, PUB).version, '2026.10.23.0600');
  assert.ok(bad(d, '2026.10.23.0700') && bad(d, '2026.10.23.0800'));
});

test('an update for a newer Electron waits for a new install', () => {
  const d = fresh();
  put(d, '2026.10.23.0700', { electron: 45 });
  assert.strictEqual(pickLib.pick(d, '2026.10.23.0500', 44, PUB), null);
  assert.ok(!bad(d, '2026.10.23.0700'));   // kept: a newer install can use it
});

test('a version whose last start never finished is set aside; markBad likewise', () => {
  const d = fresh();
  put(d, '2026.10.23.0600'); put(d, '2026.10.23.0700'); put(d, '2026.10.23.0800');
  fs.writeFileSync(pickLib.trying(d, '2026.10.23.0800'), 'x');
  pickLib.markBad(d, '2026.10.23.0700', 'threw on start');
  assert.strictEqual(pickLib.pick(d, '2026.10.23.0500', 44, PUB).version, '2026.10.23.0600');
  assert.ok(bad(d, '2026.10.23.0800') && bad(d, '2026.10.23.0700'));
});

test('the update key in config.json, when there is one, is an Ed25519 public key',
  { skip: !pickLib.PUBLIC_KEY && 'no config.json with an updateKey (scripts/make-update-key.sh)' }, () => {
  assert.match(pickLib.PUBLIC_KEY, /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=]+\n-----END PUBLIC KEY-----$/);
  assert.strictEqual(crypto.createPublicKey(pickLib.PUBLIC_KEY).asymmetricKeyType, 'ed25519');
});

test('without a key no update is trusted, and none is set aside', () => {
  const d = fresh();
  put(d, '2026.10.23.0700');
  assert.strictEqual(pickLib.pick(d, '2026.10.23.0500', 44, null), null);
  assert.ok(!bad(d, '2026.10.23.0700'));
  const data = Buffer.from('x');
  assert.strictEqual(pickLib.trusted(data, { sha256: crypto.createHash('sha256').update(data).digest('hex') }, null), false);
});

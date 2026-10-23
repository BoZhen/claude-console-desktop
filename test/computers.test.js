'use strict';
// The computer list (computers.js): what each kind of settings.json and config.json
// turns into, and the names shown on the rail.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../computers');

const A = 'http://192.168.1.10:7703/';
const B = 'https://console.example.ts.net:7703/';

test('config.json: urls is one computer, computers is several', () => {
  assert.deepEqual(C.configComputers({ urls: ['192.168.1.10:7703', 'nope://x'] }), [{ key: 'default', name: '', urls: [A] }]);
  assert.deepEqual(C.configComputers({ urls: [A], computers: [{ name: 'lab', urls: [B] }, { url: A }, { name: 'lab', urls: [A] }] }),
    [{ key: 'lab', name: 'lab', urls: [B] }, { key: '192.168.1.10', name: '', urls: [A] }]);
  assert.deepEqual(C.configComputers(null), []);
  // CLAUDE_CONSOLE_URLS replaces config.json
  assert.deepEqual(C.configComputers({ urls: [A] }, `${B}, `), [{ key: 'default', name: '', urls: [B] }]);
});

test('names: given, from config.json, from the address', () => {
  const cfg = C.configComputers({ computers: [{ name: 'lab', urls: [A] }] });
  assert.equal(C.displayName({ id: 'x', kind: 'local', name: '' }, cfg), 'This computer');
  assert.equal(C.displayName({ id: 'x', kind: 'remote', name: '', config: 'lab' }, cfg), 'lab');
  assert.equal(C.displayName({ id: 'x', kind: 'remote', name: '', url: B }, cfg), 'console');
  assert.equal(C.displayName({ id: 'x', kind: 'remote', name: 'Office', url: B }, cfg), 'Office');
  assert.equal(C.hostLabel(A), '192.168.1.10');
  assert.equal(C.initials('lab-server2'), 'LS');
  assert.equal(C.initials('laptop'), 'La');
  assert.equal(C.initials('192.168.1.10'), '10');
  assert.equal(C.initials('This computer'), 'TC');
  assert.equal(C.initials(''), '?');
});

test('first start: no settings, no config.json: an empty list', () => {
  const s = {};
  const r = C.loadComputers(s, []);
  assert.deepEqual(r.list, []);
  assert.equal(r.current, '');
  assert.equal(r.changed, true);   // the old keys were looked at; saving an empty list is harmless
});

test('old settings, this computer: one local computer, its pane kept', () => {
  const s = { server: 'local', pane: { open: true, tabs: ['x'] }, fmOrigin: 'http://127.0.0.1:17701', bounds: { width: 1 } };
  const r = C.loadComputers(s, C.configComputers({ urls: [A] }));
  assert.deepEqual(r.list, [{ id: 'local', name: '', kind: 'local' }]);
  assert.equal(r.current, 'local');
  assert.deepEqual(s.panes, { local: { open: true, tabs: ['x'] } });
  assert.deepEqual(s.fmOrigins, { local: 'http://127.0.0.1:17701' });
  assert.deepEqual(s.removedConfig, ['default']);   // config.json's addresses were the same server's
  assert.equal(s.server, undefined); assert.equal(s.pane, undefined);
  assert.deepEqual(s.bounds, { width: 1 });
  assert.deepEqual(s.computers, r.list);
});

test('old settings, a chosen address: one computer at it', () => {
  const s = { server: 'remote', url: '192.168.1.10:7703', pane: { open: false } };
  const r = C.loadComputers(s, C.configComputers({ urls: [B] }));
  assert.deepEqual(r.list, [{ id: 'c1', name: '', kind: 'remote', url: A }]);
  assert.deepEqual(s.panes, { c1: { open: false } });
});

test('old settings, config.json addresses only: the config computer, its pane kept', () => {
  const s = { pane: { open: true } };
  const cfg = C.configComputers({ urls: [A, B] });
  const r = C.loadComputers(s, cfg);
  assert.deepEqual(r.list, [{ id: 'cfg:default', name: '', kind: 'remote', config: 'default' }]);
  assert.deepEqual(C.urlsFor(r.list[0], cfg), [A, B]);
  assert.deepEqual(s.panes, { 'cfg:default': { open: true } });
});

test('a saved list: config.json computers are added once, removed ones stay away', () => {
  const cfg = C.configComputers({ computers: [{ name: 'lab', urls: [A] }, { name: 'home', urls: [B] }] });
  const s = { computers: [{ id: 'local', kind: 'local' }], removedConfig: ['home'], current: 'nope' };
  const r = C.loadComputers(s, cfg);
  assert.deepEqual(r.list.map((c) => c.id), ['local', 'cfg:lab']);
  assert.equal(r.changed, true);
  assert.equal(r.current, 'local');
  const again = C.loadComputers(s, cfg);
  assert.equal(again.changed, false);
  assert.deepEqual(again.list.map((c) => c.id), ['local', 'cfg:lab']);
});

test('a saved list is cleaned: bad entries and a second local go', () => {
  const s = { computers: [{ id: 'a', kind: 'local' }, { id: 'b', kind: 'remote' }, { id: 'c', kind: 'local' }, { id: 'd', kind: 'remote', url: A }, null], current: 'd' };
  const r = C.loadComputers(s, []);
  assert.deepEqual(r.list.map((c) => c.id), ['a', 'd']);
  assert.equal(r.current, 'd');
});

test('the command line wins and is not saved', () => {
  const s = { computers: [{ id: 'local', kind: 'local' }] };
  const r = C.loadComputers(s, [], { url: A });
  assert.deepEqual(r.list, [{ id: 'cli', name: '', kind: 'remote', url: A }]);
  assert.equal(r.transient, true);
  assert.deepEqual(s.computers, [{ id: 'local', kind: 'local' }]);
  assert.equal(C.loadComputers({}, [], { local: true }).list[0].kind, 'local');
});

test('nextId skips taken ids', () => {
  assert.equal(C.nextId([{ id: 'c1' }, { id: 'c3' }]), 'c2');
  assert.equal(C.nextId([]), 'c1');
});

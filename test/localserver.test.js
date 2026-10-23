'use strict';
// node --test test/   localserver.js's helpers, with made-up programs: no network, no
// Python. test/e2e_local.py runs the real servers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('../localserver');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-local-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function program(dir, name, body = 'exit 0') {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

test('reads the environment between the marks, values with newlines too', () => {
  const env = L.parseEnvBlock('motd\nM\nPATH=/a:/b\nMULTI=one\ntwo\nX=\nM\nbye', 'M');
  assert.deepEqual(env, { PATH: '/a:/b', MULTI: 'one\ntwo', X: '' });
  assert.equal(L.parseEnvBlock('no marks here', 'M'), null);
});

test('the login shell gives the environment a terminal would have', async () => {
  const env = await L.loginShellEnv({ shell: '/bin/sh' });
  assert.ok(env && env.PATH, 'PATH from /bin/sh -ilc env');
});

test('the servers get the user environment without Electron or another console set up', () => {
  const env = L.serverEnv({ PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', CLAUDE_CONSOLE_AUTH: 'u:p',
    CLAUDE_CONSOLE_PORT: '1', WEBFM_AUTH: 'x', CLAUDE_CONSOLE_TRANSCRIBE_REMOTE: 'keep', HTTPS_PROXY: 'keep' },
  { PATH: '/opt/x/bin:/usr/bin' }, '/home/u');
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.CLAUDE_CONSOLE_AUTH, undefined);
  assert.equal(env.CLAUDE_CONSOLE_PORT, undefined);
  assert.equal(env.WEBFM_AUTH, undefined);
  assert.equal(env.CLAUDE_CONSOLE_TRANSCRIBE_REMOTE, 'keep');
  assert.equal(env.HTTPS_PROXY, 'keep');
  const dirs = env.PATH.split(':');
  assert.deepEqual(dirs.slice(0, 2), ['/opt/x/bin', '/usr/bin'], "the login shell's PATH first");
  assert.ok(dirs.includes('/home/u/.local/bin') && dirs.includes('/opt/homebrew/bin'));
  assert.equal(dirs.filter((d) => d === '/usr/bin').length, 1);
});

test('finds claude and uv on the PATH, then where installers put them', (t) => {
  const d = tmp(t), home = path.join(d, 'home');
  const onPath = program(path.join(d, 'bin'), 'claude');
  assert.equal(L.findClaude({ PATH: path.join(d, 'bin') }, home), onPath);
  const local = program(path.join(home, '.local/bin'), 'uv');
  assert.equal(L.findUv({ PATH: path.join(d, 'empty') }, home), local);
  const pinned = program(path.join(d, 'pinned'), 'claude');
  assert.equal(L.findClaude({ PATH: path.join(d, 'bin'), CLAUDE_CONSOLE_CLAUDE: pinned }, home), pinned);
});

test('Python 3.10 or newer', () => {
  assert.deepEqual(L.parseVersion('3.12\n'), [3, 12]);
  assert.equal(L.parseVersion('nope'), null);
  assert.ok(L.newEnough([3, 10]) && L.newEnough([3, 13]) && L.newEnough([4, 0]));
  assert.ok(!L.newEnough([3, 9]) && !L.newEnough(null));
});

test('server code: a staged folder first, else the checkouts beside the app', (t) => {
  const d = tmp(t);
  const staged = path.join(d, 'res', 'server');
  for (const f of ['console/claude_console.py', 'webfm/web_file_manager.py', 'requirements.txt']) {
    fs.mkdirSync(path.dirname(path.join(staged, f)), { recursive: true }); fs.writeFileSync(path.join(staged, f), '');
  }
  assert.equal(L.serverFiles({ resourcesPath: path.join(d, 'res'), appDir: path.join(d, 'app'), env: {} }).console,
    path.join(staged, 'console/claude_console.py'));
  const app = path.join(d, 'checkouts', 'claude-console-desktop');
  assert.equal(L.serverFiles({ appDir: app, env: {} }), null);
  for (const f of ['claude-console/claude_console.py', 'web-file-manager/web_file_manager.py', 'claude-console-desktop/server-requirements.txt']) {
    fs.mkdirSync(path.dirname(path.join(d, 'checkouts', f)), { recursive: true }); fs.writeFileSync(path.join(d, 'checkouts', f), '');
  }
  assert.equal(L.serverFiles({ appDir: app, env: {} }).webfm, path.join(d, 'checkouts/web-file-manager/web_file_manager.py'));
});

test('the file manager login is made once, owner-only', (t) => {
  const d = tmp(t);
  const a = L.fmLogin(d), b = L.fmLogin(d);
  assert.equal(a, b);
  assert.match(a, /^claude-console:[A-Za-z0-9_-]{30,}$/);
  assert.equal(fs.statSync(path.join(d, 'webfm-login')).mode & 0o777, 0o600);
});

test('the Python environment is made with uv once, and again when the requirements change', async (t) => {
  const d = tmp(t), home = path.join(d, 'home'), log = path.join(d, 'uv.log');
  // a stand-in uv: "venv DIR" makes DIR/bin/python (which answers 0), "pip install" is noted
  program(path.join(home, '.local/bin'), 'uv', `echo "$*" >> ${log}
if [ "$1" = venv ]; then for a; do v="$a"; done; mkdir -p "$v/bin"; printf '#!/bin/sh\\nexit 0\\n' > "$v/bin/python"; chmod +x "$v/bin/python"; fi`);
  const req = path.join(d, 'requirements.txt');
  fs.writeFileSync(req, 'tornado\n');
  const env = { PATH: [path.join(home, '.local/bin'), '/usr/bin', '/bin'].join(':') };   // the stand-in first
  const steps = [];
  const py = await L.ensureEnv({ dir: path.join(d, 'data'), requirements: req, env, home, onStep: (s) => steps.push(s) });
  assert.equal(py, path.join(d, 'data/venv/bin/python'));
  assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length, 2, 'venv, then pip install');
  assert.ok(steps.some((s) => s.includes('uv')));
  await L.ensureEnv({ dir: path.join(d, 'data'), requirements: req, env, home });
  assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length, 2, 'kept: nothing run again');
  fs.writeFileSync(req, 'tornado\nclaude-agent-sdk\n');
  await L.ensureEnv({ dir: path.join(d, 'data'), requirements: req, env, home });
  assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length, 4, 'made again for new requirements');
});

test('a port in use is seen as taken', async () => {
  const net = require('node:net');
  const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  assert.equal(await L.portFree(port), false);
  await new Promise((r) => s.close(r));
  assert.equal(await L.portFree(port), true);
});

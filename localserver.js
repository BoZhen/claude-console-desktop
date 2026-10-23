'use strict';
/*
 * "This computer": Claude Console and the web file manager run here, for whoever has
 * the claude CLI on this computer rather than on a server. The app carries both
 * servers' code (scripts/stage-server.sh puts it in the package's resources). On the
 * first start it makes a Python environment for them in the app's settings folder,
 * with uv if there is one, else with a Python 3.10 or newer; then it starts both,
 * bound to 127.0.0.1, and stops them when the app quits.
 *
 * Plain Node, no Electron: test/localserver.test.js and scripts/local-check.js use it
 * as it is.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const CONSOLE_PORT = 17703;   // not 7703/7701, so a console the user runs by hand can coexist
const FM_PORT = 17701;
const FM_USER = 'claude-console';
const MIN_PYTHON = [3, 10];

class SetupError extends Error {
  constructor(code, message, detail = '') { super(message); this.code = code; this.detail = detail; }
}

// ------------------------------------------------------------------ environment

/* A program started from the Dock or the menu gets a bare PATH (/usr/bin:/bin on a Mac):
   no Homebrew, no ~/.local/bin, so neither claude nor uv. The login shell knows the
   user's PATH and the rest (proxies, ANTHROPIC_*), so take its environment, the way a
   terminal would. -i as well as -l: many installers write their PATH line into
   .zshrc / config.fish, which only interactive shells read. */
async function loginShellEnv({ shell, timeoutMs = 10000 } = {}) {
  let sh = shell;
  try { sh = sh || os.userInfo().shell; } catch { /* no passwd entry */ }
  sh = sh || process.env.SHELL || '/bin/sh';
  const mark = '__CCD_ENV_' + crypto.randomBytes(6).toString('hex') + '__';
  const r = await capture(sh, ['-ilc', `echo ${mark}; env; echo ${mark}`], {
    timeoutMs, env: { ...process.env, TERM: 'dumb' },
  });
  return parseEnvBlock(r.stdout, mark);
}

/** Runs a command to its end and gives back { status, stdout }, without blocking:
    the app's window stays responsive. Killed after timeoutMs. */
function capture(cmd, args, { env = process.env, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let child, out = '';
    try { child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { resolve({ status: -1, stdout: '' }); return; }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (b) => { out += b; });
    child.on('error', () => { clearTimeout(timer); resolve({ status: -1, stdout: out }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stdout: out }); });
  });
}

/** The KEY=value lines between the two marks; null if the marks are missing. */
function parseEnvBlock(text, mark) {
  const a = text.indexOf(mark), b = text.lastIndexOf(mark);
  if (a < 0 || b <= a) return null;
  const env = {};
  let key = null;
  for (const line of text.slice(a + mark.length, b).split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) { key = m[1]; env[key] = m[2]; } else if (key && line) env[key] += '\n' + line;   // a value with newlines
  }
  return env;
}

/* The environment the servers run in: this process's, the login shell's on top,
   common install folders appended to PATH, and nothing of Electron's or of a
   console the user configured for a server of their own. */
function serverEnv(base = process.env, login = null, home = os.homedir()) {
  const env = { ...base, ...(login || {}) };
  for (const k of Object.keys(env)) {
    if (k.startsWith('ELECTRON_') || /^CLAUDE_CONSOLE_(AUTH|PORT|BIND|WEBFM_URL|URLS?)$/.test(k) || /^WEBFM_/.test(k)) delete env[k];
  }
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of [path.join(home, '.local/bin'), path.join(home, '.claude/local'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
    if (!dirs.includes(d)) dirs.push(d);
  }
  env.PATH = dirs.join(path.delimiter);
  return env;
}

function isExecutable(file) {
  try { return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true); } catch { return false; }
}

function which(cmd, env) {
  for (const d of (env.PATH || '').split(path.delimiter)) {
    if (d && isExecutable(path.join(d, cmd))) return path.join(d, cmd);
  }
  return null;
}

/** The claude CLI: CLAUDE_CONSOLE_CLAUDE, else the PATH, else where installers put it. */
function findClaude(env, home = os.homedir()) {
  if (env.CLAUDE_CONSOLE_CLAUDE && isExecutable(env.CLAUDE_CONSOLE_CLAUDE)) return env.CLAUDE_CONSOLE_CLAUDE;
  return which('claude', env) || [path.join(home, '.local/bin/claude'), path.join(home, '.claude/local/claude'),
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find(isExecutable) || null;
}

function findUv(env, home = os.homedir()) {
  return which('uv', env) || [path.join(home, '.local/bin/uv'), path.join(home, '.cargo/bin/uv'),
    '/opt/homebrew/bin/uv', '/usr/local/bin/uv'].find(isExecutable) || null;
}

/** "3.12" → [3, 12]; anything else → null. */
function parseVersion(text) {
  const m = /^(\d+)\.(\d+)/.exec(String(text || '').trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}
const newEnough = (v) => !!v && (v[0] > MIN_PYTHON[0] || (v[0] === MIN_PYTHON[0] && v[1] >= MIN_PYTHON[1]));

/** A Python 3.10 or newer: the newest name first, on the PATH, then Homebrew's. */
async function findPython(env) {
  const names = ['python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3'];
  const seen = new Set();
  for (const name of names) {
    for (const p of [which(name, env), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]) {
      if (!p || seen.has(p) || !isExecutable(p)) continue;
      seen.add(p);
      const r = await capture(p, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { env, timeoutMs: 10000 });
      if (r.status === 0 && newEnough(parseVersion(r.stdout))) return p;
    }
  }
  return null;
}

// ------------------------------------------------------------------ server files

/* Where the two servers' code is: a staged folder (a package's resources/server, or
   CCD_SERVER_DIR), else the claude-console and web-file-manager checkouts beside
   this one, for running from git. */
function serverFiles({ resourcesPath, appDir, env = process.env }) {
  const staged = [env.CCD_SERVER_DIR, resourcesPath && path.join(resourcesPath, 'server')].filter(Boolean);
  for (const dir of staged) {
    const f = {
      console: path.join(dir, 'console', 'claude_console.py'),
      webfm: path.join(dir, 'webfm', 'web_file_manager.py'),
      requirements: path.join(dir, 'requirements.txt'),
    };
    if (fs.existsSync(f.console) && fs.existsSync(f.webfm) && fs.existsSync(f.requirements)) return f;
  }
  const parent = path.dirname(appDir);
  const f = {
    console: path.join(parent, 'claude-console', 'claude_console.py'),
    webfm: path.join(parent, 'web-file-manager', 'web_file_manager.py'),
    requirements: path.join(appDir, 'server-requirements.txt'),
  };
  return fs.existsSync(f.console) && fs.existsSync(f.webfm) && fs.existsSync(f.requirements) ? f : null;
}

// ------------------------------------------------------------------ processes

/** Runs a command; each output line goes to onLine. Resolves on exit 0, else rejects
    with the last lines. */
function run(cmd, args, { env, onLine = () => {}, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { reject(e); return; }
    const tail = [];
    const feed = (buf) => {
      for (const line of String(buf).split(/\r?\n|\r/)) {
        if (!line.trim()) continue;
        tail.push(line); if (tail.length > 30) tail.shift();
        onLine(line);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve()
      : reject(new SetupError('command', `${path.basename(cmd)} ${args[0] || ''} failed (exit ${code})`, tail.join('\n')))));
  });
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/* The servers' Python environment, in dir/venv: made once, and again when the
   requirements change or it no longer imports (its Python was removed, say). */
async function ensureEnv({ dir, requirements, env, onLine = () => {}, onStep = () => {}, home = os.homedir() }) {
  const venv = path.join(dir, 'venv');
  const py = path.join(venv, 'bin', 'python');
  const want = sha256(fs.readFileSync(requirements, 'utf8'));
  const marker = path.join(venv, '.ccd-requirements');
  let have = '';
  try { have = fs.readFileSync(marker, 'utf8').trim(); } catch { /* not made yet */ }
  if (have === want && isExecutable(py)) {
    const r = await capture(py, ['-c', 'import tornado, claude_agent_sdk'], { env });
    if (r.status === 0) return py;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(venv, { recursive: true, force: true });
  const uv = findUv(env, home);
  if (uv) {
    onStep('Making a Python environment with uv (first start only)…');
    await run(uv, ['venv', '--python', '>=3.10', venv], { env, onLine });
    onStep('Installing tornado and the Claude Agent SDK…');
    await run(uv, ['pip', 'install', '--python', py, '-r', requirements], { env, onLine });
  } else {
    const base = await findPython(env);
    if (!base) {
      throw new SetupError('no-python', 'Claude Console needs uv or Python 3.10 or newer on this computer.',
        'Install uv:  curl -LsSf https://astral.sh/uv/install.sh | sh\n'
        + (process.platform === 'darwin' ? 'or with Homebrew:  brew install uv\n' : '')
        + 'then press Try again.');
    }
    onStep(`Making a Python environment with ${base} (first start only)…`);
    await run(base, ['-m', 'venv', venv], { env, onLine });
    onStep('Installing tornado and the Claude Agent SDK…');
    await run(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirements], { env, onLine });
  }
  fs.writeFileSync(marker, want + '\n');
  return py;
}

/** True if nothing listens on 127.0.0.1:port. */
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function commandOf(pid) {
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

/** SIGTERM to the process group (the server and the claude processes it started),
    SIGKILL after graceMs. */
async function stopGroup(pid, graceMs = 4000) {
  if (!pid || !alive(pid)) return;
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  for (let t = 0; t < graceMs && alive(pid); t += 100) await new Promise((r) => setTimeout(r, 100));
  if (alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
}

/** Resolves once url answers with any HTTP status; rejects after timeoutMs, or at
    once when stillRunning() says the server is gone. */
function waitHttp(url, { timeoutMs = 60000, stillRunning = () => true } = {}) {
  const end = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (!stillRunning()) { reject(new SetupError('exited', 'The server stopped while starting.')); return; }
      const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode); });
      req.setTimeout(2000, () => req.destroy());
      req.on('error', () => {
        if (Date.now() > end) reject(new SetupError('timeout', `No answer from ${url}`));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

function logTail(file, lines = 25) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-lines).join('\n'); } catch { return ''; }
}

/** The file manager's login, made once and kept owner-only: "claude-console:<random>". */
function fmLogin(dir) {
  const file = path.join(dir, 'webfm-login');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.startsWith(FM_USER + ':') && t.length > FM_USER.length + 16) return t;
  } catch { /* not made yet */ }
  fs.mkdirSync(dir, { recursive: true });
  const login = `${FM_USER}:${crypto.randomBytes(24).toString('base64url')}`;
  fs.writeFileSync(file, login + '\n', { mode: 0o600 });
  return login;
}

// ------------------------------------------------------------------ the two servers

/*
 * Events: 'state' with { phase, step, error, detail, url, fmUrl, claude }, where phase is
 * preparing | starting | ready | failed | stopped. 'line' for each line of setup output.
 */
class LocalServer extends EventEmitter {
  constructor({ dataDir, files, consolePort = CONSOLE_PORT, fmPort = FM_PORT, loginEnv = loginShellEnv }) {
    super();
    this.dataDir = dataDir;
    this.files = files;
    this.consolePort = consolePort;
    this.fmPort = fmPort;
    this.loginEnv = loginEnv;
    this.children = {};
    this.stopping = false;
    this.state = { phase: 'stopped' };
    this.url = `http://127.0.0.1:${consolePort}/`;
    this.fmUrl = `http://127.0.0.1:${fmPort}/`;
    this.pidFile = path.join(dataDir, 'servers.json');
  }

  setState(s) {
    this.state = { url: this.url, fmUrl: this.fmUrl, ...s };
    this.emit('state', this.state);
  }

  fmCredentials() {
    const [user, ...rest] = fmLogin(this.dataDir).split(':');
    return { user, pass: rest.join(':') };
  }

  async start() {
    if (this.running) return this.running;
    if (this.state.phase === 'ready' && this.children.console && this.children.webfm) {
      this.setState({ ...this.state });   // already up: say so again
      return this.state;
    }
    this.running = this._start().finally(() => { this.running = null; });
    return this.running;
  }

  async _start() {
    this.stopping = false;
    try {
      if (!this.files) {
        throw new SetupError('no-files', 'This build of the app does not include the server code.',
          'Build it with scripts/build-mac.sh or scripts/build-linux.sh, or run it beside claude-console and web-file-manager checkouts.');
      }
      this.setState({ phase: 'preparing', step: 'Reading your shell environment…' });
      const env = serverEnv(process.env, await this.loginEnv());
      const claude = findClaude(env);
      if (!claude) {
        throw new SetupError('no-claude', 'The claude CLI was not found on this computer.',
          'Install Claude Code (https://claude.com/claude-code), sign in once in a terminal with  claude , then press Try again.');
      }
      const py = await ensureEnv({
        dir: this.dataDir, requirements: this.files.requirements, env,
        onLine: (l) => this.emit('line', l),
        onStep: (step) => this.setState({ phase: 'preparing', step }),
      });
      this.setState({ phase: 'starting', step: 'Starting Claude Console…', claude });
      await this.stopLeftovers();
      for (const port of [this.consolePort, this.fmPort]) {
        if (!(await portFree(port))) {
          throw new SetupError('port', `Port ${port} on 127.0.0.1 is in use by another program.`,
            'Quit that program, or set other ports for this computer in the app\'s settings.json (localPorts), then press Try again.');
        }
      }
      const base = { ...env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' };   // never write into the signed app
      this.spawnServer('webfm', py, this.files.webfm, {
        ...base, WEBFM_PORT: String(this.fmPort), WEBFM_BIND: '127.0.0.1', WEBFM_AUTH: fmLogin(this.dataDir),
      });
      this.spawnServer('console', py, this.files.console, {
        ...base, CLAUDE_CONSOLE_PORT: String(this.consolePort), CLAUDE_CONSOLE_BIND: '127.0.0.1',
        CLAUDE_CONSOLE_WEBFM_URL: this.fmUrl.replace(/\/$/, ''), CLAUDE_CONSOLE_CLAUDE: claude,
      });
      this.writePids();
      await waitHttp(this.url + 'api/models', { stillRunning: () => !!this.children.console });
      await waitHttp(this.fmUrl, { timeoutMs: 30000, stillRunning: () => !!this.children.webfm });
      this.setState({ phase: 'ready', claude });
      return this.state;
    } catch (e) {
      const which = e.code === 'exited' ? (this.children.console ? 'webfm' : 'console') : null;
      await this.stop({ quiet: true });
      const detail = e.detail || (which ? logTail(this.logFile(which)) : '') || String(e.stack || '');
      this.setState({ phase: 'failed', error: e.message, code: e.code || 'error', detail });
      return this.state;
    }
  }

  logFile(name) { return path.join(this.dataDir, 'logs', `${name}.log`); }

  spawnServer(name, py, script, env) {
    const log = this.logFile(name);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    try { fs.renameSync(log, log + '.1'); } catch { /* first start */ }
    const fd = fs.openSync(log, 'a', 0o600);
    // its own process group, so stop() reaches the claude processes it starts too
    const child = spawn(py, [script], { cwd: os.homedir(), env, detached: true, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    this.children[name] = child;
    child.on('exit', (code, signal) => {
      if (this.children[name] !== child) return;
      delete this.children[name];
      if (this.stopping || this.running) return;   // a stop, or start() reports it
      this.stop({ quiet: true }).then(() => this.setState({
        phase: 'failed', code: 'exited', error: `${name === 'console' ? 'Claude Console' : 'The file manager'} stopped (${signal || 'exit ' + code}).`,
        detail: logTail(log),
      }));
    });
  }

  writePids() {
    const pids = {};
    for (const [name, c] of Object.entries(this.children)) pids[name] = c.pid;
    fs.writeFileSync(this.pidFile, JSON.stringify({ pids, consolePort: this.consolePort, fmPort: this.fmPort }));
  }

  /** Servers a previous run left behind (the app was killed, or restarted into an
      update the hard way): stopped if they still are ours. */
  async stopLeftovers() {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(this.pidFile, 'utf8')); } catch { return; }
    for (const [name, pid] of Object.entries(saved.pids || {})) {
      const script = name === 'console' ? this.files.console : this.files.webfm;
      if (alive(pid) && commandOf(pid).includes(path.basename(script))) await stopGroup(pid);
    }
    fs.rmSync(this.pidFile, { force: true });
  }

  async stop({ quiet = false } = {}) {
    this.stopping = true;
    const kids = Object.values(this.children);
    this.children = {};
    await Promise.all(kids.map((c) => stopGroup(c.pid)));
    fs.rmSync(this.pidFile, { force: true });
    if (!quiet) this.setState({ phase: 'stopped' });
  }
}

module.exports = {
  CONSOLE_PORT, FM_PORT, SetupError, LocalServer,
  loginShellEnv, parseEnvBlock, serverEnv, which, findClaude, findUv, findPython, parseVersion, newEnough,
  serverFiles, ensureEnv, portFree, waitHttp, fmLogin, stopGroup, capture,
};

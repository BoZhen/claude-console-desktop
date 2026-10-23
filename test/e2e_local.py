"""End to end, "This computer": the app starts Claude Console and the web file manager
itself, under Xvfb, with the real servers and a throwaway HOME.
  python test/e2e_local.py       (Python with tornado; Electron from node_modules; uv or
                                  Python 3.10+, the network for the first setup, the claude CLI)
A: first start without config.json: the Server dialog offers this computer first; the
   setup screen shows its steps; the console page loads from 127.0.0.1; the file
   manager opens without a sign-in dialog; Settings > About names this computer.
B: quitting stops both servers and the ports are free again.
C: the next start remembers this computer and comes up without the dialog.
D: another computer (a stand-in page) stops the servers here; this computer again
   starts them.
E: without a claude CLI the setup screen says so and offers Try again.
The servers listen on 17703 and 17701, which must be free."""
import asyncio, json, os, shutil, socket, subprocess, tempfile, threading, time, urllib.request
import tornado.web, tornado.ioloop
from tornado.websocket import websocket_connect

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ELECTRON = os.path.join(REPO, "node_modules", "electron", "dist", "electron")
CLAUDE = shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")
W = tempfile.mkdtemp(prefix="ccd-local-")
CPORT, FPORT = 17703, 17701

def free():
    with socket.socket() as s: s.bind(("127.0.0.1", 0)); return s.getsockname()[1]
SPORT, DPORT = free(), free()

def port_free(p):
    """As a server would bind it: SO_REUSEADDR, so connections in TIME_WAIT do not count."""
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try: s.bind(("127.0.0.1", p)); s.listen(); return True
        except OSError: return False

class Page(tornado.web.RequestHandler):
    def get(self, *_):
        self.write("<!doctype html><title>Stand-in console</title><p>stand-in")
def serve():
    asyncio.set_event_loop(asyncio.new_event_loop())
    tornado.web.Application([(r"/(.*)", Page)]).listen(SPORT, address="127.0.0.1")
    tornado.ioloop.IOLoop.current().start()
threading.Thread(target=serve, daemon=True).start()

APP = os.path.join(W, "app")
r = subprocess.run([os.path.join(REPO, "scripts", "stage.sh"), APP, "2026.1.1.0"], capture_output=True, text=True)
assert r.returncode == 0, r.stderr
if os.path.exists(os.path.join(APP, "config.json")): os.remove(os.path.join(APP, "config.json"))
SERVER = os.path.join(W, "server")
r = subprocess.run([os.path.join(REPO, "scripts", "stage-server.sh"), SERVER], capture_output=True, text=True)
assert r.returncode == 0, r.stderr
HOME = os.path.join(W, "home"); os.makedirs(HOME)

xvfb = subprocess.Popen(["Xvfb", ":96", "-screen", "0", "1400x900x24", "-nolisten", "tcp"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

def launch(xdg, claude=CLAUDE, path=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE_CONSOLE")}
    env.update(DISPLAY=":96", XDG_CONFIG_HOME=xdg, HOME=HOME, CCD_SERVER_DIR=SERVER, CLAUDE_CONSOLE_CLAUDE=claude)
    if path is not None: env["PATH"] = path
    return subprocess.Popen([ELECTRON, "--no-sandbox", "--disable-gpu", "--password-store=basic",
                             f"--remote-debugging-port={DPORT}", os.path.join(APP, "main.js")],
                            env=env, stdout=open(os.path.join(W, "app.log"), "a"), stderr=subprocess.STDOUT)

class CDP:
    def __init__(self, ws): self.ws, self.seq, self.pending = ws, 0, {}; asyncio.create_task(self.read())
    async def read(self):
        while (m := await self.ws.read_message()) is not None:
            d = json.loads(m); f = self.pending.pop(d.get("id"), None)
            if f and not f.done(): f.set_result(d)
    async def call(self, method, **p):
        self.seq += 1; f = asyncio.get_running_loop().create_future(); self.pending[self.seq] = f
        await self.ws.write_message(json.dumps({"id": self.seq, "method": method, "params": p}))
        r = await asyncio.wait_for(f, 30)
        if "error" in r: raise RuntimeError(r["error"])
        return r.get("result", {})
    async def js(self, src):
        r = await self.call("Runtime.evaluate", expression=src, returnByValue=True, awaitPromise=True)
        if r.get("exceptionDetails"): raise RuntimeError(r["exceptionDetails"].get("exception", {}).get("description", "?"))
        return r["result"].get("value")

def targets():
    return json.load(urllib.request.urlopen(f"http://127.0.0.1:{DPORT}/json", timeout=2))

async def shell(timeout=40):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            t = next((t for t in targets() if t["type"] == "page" and t["url"].startswith("file:")), None)
            if t:
                c = CDP(await websocket_connect(t["webSocketDebuggerUrl"]))
                if await c.js("document.readyState==='complete'&&!!window.app&&typeof comps!=='undefined'"): return c
        except Exception:
            pass
        await asyncio.sleep(0.5)
    raise RuntimeError("no shell target")

async def webview(prefix, timeout=40, ready="document.readyState==='complete'"):
    """A CDP connection to the webview whose URL starts with prefix, once ready is true."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            t = next((t for t in targets() if t["type"] == "webview" and t["url"].startswith(prefix)), None)
            if t:
                c = CDP(await websocket_connect(t["webSocketDebuggerUrl"]))
                if await c.js(ready): return c
        except Exception:
            pass
        await asyncio.sleep(0.5)
    return None

async def close(p):
    v = json.load(urllib.request.urlopen(f"http://127.0.0.1:{DPORT}/json/version", timeout=2))
    b = CDP(await websocket_connect(v["webSocketDebuggerUrl"]))
    try: await b.call("Browser.close")
    except Exception: pass
    p.wait(timeout=30)

LOCAL = """JSON.stringify({screen:!$('local').hidden, title:$('local-title').textContent, step:$('local-step').textContent,
  buttons:!$('local-buttons').hidden, detail:$('local-detail').textContent, box:!$('urlbox').hidden, mode:cur?cur.kind:''})"""

async def wait_local(sh, phase_text, timeout=600):
    """Polls the setup screen; returns the steps seen and the last view."""
    seen, t0 = [], time.time()
    while time.time() - t0 < timeout:
        v = json.loads(await sh.js(LOCAL))
        if v["step"] and (not seen or seen[-1] != v["step"]): seen.append(v["step"])
        if phase_text(v): return seen, v
        await asyncio.sleep(0.3)
    return seen, json.loads(await sh.js(LOCAL))

def servers_running():
    out = subprocess.run(["pgrep", "-af", SERVER], capture_output=True, text=True).stdout
    return [l for l in out.splitlines() if "claude_console.py" in l or "web_file_manager.py" in l]

async def main():
    checks = {}
    assert port_free(CPORT) and port_free(FPORT), "ports 17703 / 17701 are in use"
    xdg = os.path.join(W, "xdg")
    # A: first start
    p = launch(xdg)
    try:
        sh = await shell(); await asyncio.sleep(1)
        first = json.loads(await sh.js("JSON.stringify({box:!$('urlbox').hidden, local:$('srv-local').checked, cancel:!$('url-cancel').hidden})"))
        await sh.js("$('url-form').requestSubmit()")
        t0 = time.time()
        steps, view = await wait_local(sh, lambda v: not v["screen"] or v["buttons"])
        took = time.time() - t0
        con = await webview(f"http://127.0.0.1:{CPORT}/", ready="document.readyState==='complete'&&!!document.getElementById('settings')")
        about = ""
        if con:
            await con.js("openSettings&&openSettings()"); await asyncio.sleep(0.3)
            await con.js("document.querySelector('[data-pane=about]')&&(typeof renderAboutServer==='function')&&renderAboutServer()")
            await asyncio.sleep(0.8)
            about = await con.js("(document.getElementById('abSrv')&&!document.getElementById('abSrv').hidden?document.getElementById('abSrvWhere').textContent+' | '+document.getElementById('abSrvHint').textContent:'')")
        await sh.js("showFiles()")
        fm = await webview(f"http://127.0.0.1:{FPORT}/", ready="document.readyState==='complete'&&document.body.innerText.length>0")
        fm_title = await fm.js("document.title") if fm else ""
        auth_shown = await sh.js("!$('auth').hidden")
        print("A first:", first, "\n  steps:", steps, f"\n  ready in {took:.1f}s, view:", view, "\n  about:", about, "| fm:", fm_title, "| auth dialog:", auth_shown)
        checks.update({
            "A: the dialog is up, with this computer chosen": first["box"] and first["local"],
            "A: no Cancel before the first choice": not first["cancel"],
            # uv makes the environment in well under the poll interval, so look for either step
            "A: the setup screen showed its steps": any("Python environment" in s or "Installing" in s for s in steps) and any("Starting Claude Console" in s for s in steps),
            "A: the setup screen went away": not view["screen"],
            "A: the console page loaded from 127.0.0.1": con is not None,
            "A: About says This computer, with the CLI": about.startswith("This computer") and CLAUDE in about,
            "A: the file manager opened": fm is not None and bool(fm_title),
            "A: no sign-in dialog for the file manager": not auth_shown,
            "A: both servers run": len(servers_running()) == 2,
        })
        await close(p)
    finally:
        if p.poll() is None: p.kill()
    time.sleep(1)
    # B: quitting stops them
    checks.update({"B: no server left after quitting": not servers_running(),
                   "B: both ports are free again": port_free(CPORT) and port_free(FPORT)})
    # C: next start
    p = launch(xdg)
    try:
        sh = await shell(); t0 = time.time()
        con = await webview(f"http://127.0.0.1:{CPORT}/", ready="!!document.getElementById('settings')")
        took = time.time() - t0
        again = json.loads(await sh.js(LOCAL))
        print(f"C: console in {took:.1f}s,", again)
        checks.update({"C: the next start comes up on this computer without the dialog": con is not None and not again["box"] and again["mode"] == "local",
                       "C: and fast (the Python environment is kept)": took < 20})
        # D: another computer, then this computer again
        await sh.js(f"openBox('edit', cur);$('url-input').value='http://127.0.0.1:{SPORT}/';$('url-form').requestSubmit()")
        await asyncio.sleep(3)
        stand = await webview(f"http://127.0.0.1:{SPORT}/")
        gone = not servers_running()
        await sh.js("openBox('edit', cur);$('srv-local').checked=true;$('url-input').value='';$('url-form').requestSubmit()")
        back = await webview(f"http://127.0.0.1:{CPORT}/", ready="!!document.getElementById('settings')")
        print("D: stand-in:", stand is not None, "| servers stopped:", gone, "| back here:", back is not None)
        checks.update({"D: another computer loads its address": stand is not None,
                       "D: and the servers here stop": gone,
                       "D: this computer again starts them": back is not None and len(servers_running()) == 2})
        await close(p)
    finally:
        if p.poll() is None: p.kill()
    time.sleep(1)
    # E: no claude CLI
    p = launch(os.path.join(W, "xdg-e"), claude="/nonexistent/claude", path="/usr/bin:/bin")
    try:
        sh = await shell(); await asyncio.sleep(1)
        await sh.js("$('url-form').requestSubmit()")
        _, view = await wait_local(sh, lambda v: v["buttons"], timeout=60)
        print("E:", view)
        checks.update({"E: no CLI: the screen says so": "claude CLI was not found" in view["step"],
                       "E: and offers Try again": view["buttons"]})
        await close(p)
    finally:
        if p.poll() is None: p.kill()
    print("\n".join(("PASS " if v else "FAIL ") + k for k, v in checks.items()))
    print("ALL PASS" if all(checks.values()) else "SOME FAILED")

try:
    asyncio.run(main())
finally:
    for line in servers_running():   # never leave a server behind
        subprocess.run(["kill", line.split()[0]])
    xvfb.terminate(); shutil.rmtree(W, ignore_errors=True)

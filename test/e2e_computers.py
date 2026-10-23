"""End to end, several computers in one window, under Xvfb against two stand-in consoles
(A and B), each with a stand-in file manager and an api/notify/stream the test feeds.
  python test/e2e_computers.py        (Python with tornado; Electron from node_modules)
A: the single-server settings of earlier versions become one computer, its pane and
   file tab kept; with one computer the rail shows only + and no stream is opened.
B: adding B (the dialog's Add) shows it at once, leaves A's page running (not
   reloaded) and puts both on the rail; each computer is watched through its stream.
C: a file link in B's console opens in B's pane; Ctrl+1 goes back to A, whose own
   pane and tab come back, B's hidden.
D: an approval waiting on B puts a red dot with its count on B's button while A is
   shown; resolved, it goes; a finished turn leaves a grey dot until B is shown.
E: renaming A in the dialog changes its button.
F: the next start brings back both computers, the one shown, and each one's pane.
G: removing asks first (Cancel keeps it); removing B leaves one computer, only + on the rail.
H: config.json "computers" starts with each of them, without asking."""
import asyncio, json, os, shutil, socket, subprocess, tempfile, threading, time, urllib.parse, urllib.request
import tornado.web, tornado.ioloop
from tornado.websocket import websocket_connect

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ELECTRON = os.path.join(REPO, "node_modules", "electron", "dist", "electron")
W = tempfile.mkdtemp(prefix="ccd-comp-")

def free():
    with socket.socket() as s: s.bind(("127.0.0.1", 0)); return s.getsockname()[1]
DPORT = free()
SITES = {name: {"console": free(), "fm": free(), "streams": 0, "handlers": set()} for name in "AB"}
URL = {n: f"http://127.0.0.1:{s['console']}/" for n, s in SITES.items()}
FM = {n: f"http://127.0.0.1:{s['fm']}" for n, s in SITES.items()}

# ------------------------------------------------------------------ the stand-ins
class Console(tornado.web.RequestHandler):
    def initialize(self, name): self.name = name
    def get(self, *_):
        fm = FM[self.name]
        self.write(f"""<!doctype html><title>Stand-in {self.name}</title>
<header style="background:#f4f1ea;color:#222">Stand-in {self.name}</header>
<p>console {self.name}</p><a id="file" href="{fm}/?open=%7E%2Fnotes-{self.name}.txt" target="_blank">notes</a>
<script>window.marker = Math.random(); function webfmBase() {{ return {json.dumps(fm)}; }}</script>""")

class Stream(tornado.web.RequestHandler):
    def initialize(self, name): self.name = name
    async def get(self):
        site = SITES[self.name]
        site["streams"] += 1
        self.set_header("Content-Type", "text/event-stream")
        self.set_header("Cache-Control", "no-store")
        self.queue = asyncio.Queue()
        site["handlers"].add(self)
        try:
            self.write("data: " + json.dumps({"type": "snapshot", "waiting": [], "sessions": []}) + "\n\n")
            await self.flush()
            while True:
                msg = await self.queue.get()
                self.write("data: " + json.dumps(msg) + "\n\n")
                await self.flush()
        except Exception:
            pass
        finally:
            site["handlers"].discard(self)
    def on_connection_close(self): self.queue.put_nowait({"type": "noop"})

class FileManager(tornado.web.RequestHandler):
    def initialize(self, name): self.name = name
    def get(self, *_):
        self.write(f"<!doctype html><title>FM {self.name}</title><p>file manager {self.name}: {self.request.uri}</p>")

LOOP = {}
def serve():
    asyncio.set_event_loop(asyncio.new_event_loop())
    for n, s in SITES.items():
        tornado.web.Application([(r"/api/notify/stream", Stream, {"name": n}), (r"/(.*)", Console, {"name": n})]).listen(s["console"], address="127.0.0.1")
        tornado.web.Application([(r"/(.*)", FileManager, {"name": n})]).listen(s["fm"], address="127.0.0.1")
    LOOP["io"] = tornado.ioloop.IOLoop.current()
    LOOP["io"].start()
threading.Thread(target=serve, daemon=True).start()

def push(name, msg):
    """An event on every open stream of console `name`."""
    def go():
        for h in list(SITES[name]["handlers"]): h.queue.put_nowait(msg)
    LOOP["io"].add_callback(go)

# ------------------------------------------------------------------ the app
def stage(name, config=None):
    out = os.path.join(W, name)
    r = subprocess.run([os.path.join(REPO, "scripts", "stage.sh"), out, "2026.1.1.0", "--with-loader"], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    cfg = os.path.join(out, "config.json")
    if os.path.exists(cfg): os.remove(cfg)
    if config is not None: json.dump(config, open(cfg, "w"))
    return out

xvfb = subprocess.Popen(["Xvfb", ":95", "-screen", "0", "1400x900x24", "-nolisten", "tcp"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

def settings_file(xdg): return os.path.join(xdg, "Claude Console", "settings.json")

def launch(app, xdg):
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE_CONSOLE")}
    env.update(DISPLAY=":95", XDG_CONFIG_HOME=xdg, HOME=os.path.join(W, "home"))
    return subprocess.Popen([ELECTRON, "--no-sandbox", "--disable-gpu", "--password-store=basic",
                             f"--remote-debugging-port={DPORT}", app],
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
        if r.get("exceptionDetails"): raise RuntimeError(json.dumps(r["exceptionDetails"])[:400])
        return r["result"].get("value")

def targets():
    return json.load(urllib.request.urlopen(f"http://127.0.0.1:{DPORT}/json", timeout=2))

async def attach(kind, prefix, ready="document.readyState==='complete'", timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            t = next((t for t in targets() if t["type"] == kind and t["url"].startswith(prefix)), None)
            if t:
                c = CDP(await websocket_connect(t["webSocketDebuggerUrl"]))
                if await c.js(ready): return c
        except Exception:
            pass
        await asyncio.sleep(0.4)
    return None

async def until(sh, cond, timeout=15):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if await sh.js(cond): return True
        except Exception:
            pass
        await asyncio.sleep(0.25)
    return False

async def close(p):
    v = json.load(urllib.request.urlopen(f"http://127.0.0.1:{DPORT}/json/version", timeout=2))
    b = CDP(await websocket_connect(v["webSocketDebuggerUrl"]))
    try: await b.call("Browser.close")
    except Exception: pass
    p.wait(timeout=30)

VIEW = """JSON.stringify({n: comps.length, cur: cur && cur.id, names: comps.map(c => c.name),
  rail: !$('rail-computers').hidden, buttons: [...document.querySelectorAll('#rail-computers button.computer')].map(b => b.firstChild.textContent),
  dots: comps.map(c => c.btn && c.btn.querySelector('.dot') ? (c.btn.querySelector('.dot').className + ':' + c.btn.querySelector('.dot').textContent) : ''),
  active: comps.map(c => c.view.classList.contains('active')),
  pages: comps.map(c => c.page), answered: comps.map(c => c.answered),
  paneOpen: comps.map(c => c.paneOpen), pane: !$('pane').hidden,
  tabs: comps.map(c => c.tabs.filter(t => !t.fm).map(t => t.title)),
  shownTabs: [...document.querySelectorAll('#tabs .tab')].filter(t => !t.hidden).map(t => t.textContent.replace('×', '')),
  title: document.title, box: !$('urlbox').hidden, confirm: !$('confirm').hidden})"""

async def view(sh): return json.loads(await sh.js(VIEW))

async def key(sh, digit):
    """Ctrl+digit, as typed into the window."""
    for t in ("rawKeyDown", "keyUp"):
        await sh.call("Input.dispatchKeyEvent", type=t, modifiers=2, key=str(digit), code=f"Digit{digit}",
                      windowsVirtualKeyCode=48 + digit, nativeVirtualKeyCode=48 + digit)

async def main():
    checks = {}
    app = stage("app")
    xdg = os.path.join(W, "xdg")
    os.makedirs(os.path.dirname(settings_file(xdg)))
    a_file = FM["A"] + "/?open=%7E%2Fa1.txt"
    json.dump({"server": "remote", "url": URL["A"], "bounds": {"x": 0, "y": 0, "width": 1300, "height": 850},
               "pane": {"open": True, "tabs": [a_file], "active": a_file}}, open(settings_file(xdg), "w"))
    p = launch(app, xdg)
    try:
        # A: the old settings
        sh = await attach("page", "file:", "document.readyState==='complete'&&typeof comps!=='undefined'&&comps.length===1&&cur&&cur.answered")
        await asyncio.sleep(1.5)
        v = await view(sh)
        saved = json.load(open(settings_file(xdg)))
        print("A:", v, "\n   saved:", {k: saved.get(k) for k in ("computers", "current", "panes", "server", "url", "pane")})
        checks.update({
            "A: the old settings are one computer, at their address": v["n"] == 1 and v["pages"] == [URL["A"]] and v["answered"] == [True],
            "A: its pane and file tab are back": v["pane"] and v["tabs"] == [["a1.txt"]],
            "A: one computer: only + on the rail": v["buttons"] == [] and await sh.js("!!$('rail-add')&&!$('rail-computers').hidden"),
            "A: settings.json has the list, without the old keys": saved.get("computers") == [{"id": "c1", "name": "", "kind": "remote", "url": URL["A"]}]
                and "c1" in saved.get("panes", {}) and not any(k in saved for k in ("server", "url", "pane")),
            "A: no stream with one computer": SITES["A"]["streams"] == 0,
        })
        con_a = await attach("webview", URL["A"])
        marker = await con_a.js("window.marker")

        # B: add a computer
        await sh.js(f"openBox('add');$('url-name').value='Beta';$('url-input').value={json.dumps(URL['B'])};$('url-form').requestSubmit()")
        ok = await until(sh, "comps.length===2&&cur.name==='Beta'&&cur.answered")
        await asyncio.sleep(1)
        v = await view(sh)
        same = await con_a.js("window.marker")
        print("B:", v, "| A marker kept:", same == marker, "| streams:", SITES["A"]["streams"], SITES["B"]["streams"])
        checks.update({
            "B: the new computer is shown at once": ok and v["cur"] == "c2" and v["active"] == [False, True],
            "B: A keeps running, not reloaded": same == marker and v["answered"] == [True, True],
            "B: both on the rail, with +": v["rail"] and v["buttons"] == ["1", "Be"] and await sh.js("!!$('rail-add')&&$('rail-add').parentNode.id==='rail-computers'"),
            "B: its own pane, closed": v["paneOpen"] == [True, False] and not v["pane"],
            "B: the window title names it": v["title"].startswith("Beta · "),
        })
        for _ in range(40):
            if SITES["A"]["handlers"] and SITES["B"]["handlers"]: break
            await asyncio.sleep(0.25)
        checks["B: both computers are watched (api/notify/stream)"] = bool(SITES["A"]["handlers"] and SITES["B"]["handlers"])

        # C: a link in B's console, then Ctrl+1
        con_b = await attach("webview", URL["B"])
        await con_b.js("document.getElementById('file').click()")
        await until(sh, "cur.tabs.some(t=>!t.fm)")
        await asyncio.sleep(0.8)
        vb = await view(sh)
        fm_b = await attach("webview", FM["B"] + "/?open=", "document.body&&document.body.innerText.includes('file manager B')")
        await key(sh, 1)
        await until(sh, "cur.id==='c1'")
        await asyncio.sleep(0.6)
        va = await view(sh)
        print("C: on B:", vb["shownTabs"], vb["pane"], "| after Ctrl+1:", va["cur"], va["shownTabs"], va["pane"], va["active"])
        checks.update({
            "C: B's file link opens in B's pane": vb["pane"] and vb["tabs"][1] == ["notes-B.txt"] and fm_b is not None,
            "C: Ctrl+1 shows A": va["cur"] == "c1" and va["active"] == [True, False],
            "C: with A's pane and tab, not B's": va["pane"] and va["shownTabs"] == ["Files", "a1.txt"],
        })

        # D: what waits on B
        push("B", {"type": "waiting", "session": "s1", "aid": "x1", "kind": "approval", "title": "t"})
        got = await until(sh, "!!comps[1].btn.querySelector('.dot:not(.done)')")
        vd = await view(sh)
        push("B", {"type": "resolved", "session": "s1", "aid": "x1"})
        gone = await until(sh, "!comps[1].btn.querySelector('.dot')")
        push("B", {"type": "finished", "session": "s1", "title": "t", "text": "done", "error": False})
        grey = await until(sh, "!!comps[1].btn.querySelector('.dot.done')")
        tip = await sh.js("comps[1].btn.title")
        await sh.js("comps[1].btn.click()")
        cleared = await until(sh, "cur.id==='c2'&&!comps[1].btn.querySelector('.dot')")
        print("D:", vd["dots"], "| resolved:", gone, "| finished:", grey, repr(tip), "| seen:", cleared)
        checks.update({
            "D: an approval waiting on B: a red dot with 1": got and vd["dots"][1] == "dot:1",
            "D: resolved: the dot goes": gone,
            "D: a finished turn: a grey dot": grey and "a turn finished" in tip,
            "D: showing B clears it": cleared,
        })

        # E: rename A
        await sh.js("openBox('edit', comps[0]);$('url-name').value='Alpha';$('url-form').requestSubmit()")
        renamed = await until(sh, "comps[0].name==='Alpha'&&comps[0].btn.firstChild.textContent==='Al'")
        print("E: renamed:", renamed, (await view(sh))["names"])
        checks["E: renaming A changes its button"] = renamed
        await sh.js("switchTo(comps[1])")
        await asyncio.sleep(0.8)
        await close(p)

        # F: the next start
        saved = json.load(open(settings_file(xdg)))
        p = launch(app, xdg)
        sh = await attach("page", "file:", "document.readyState==='complete'&&typeof comps!=='undefined'&&comps.length===2&&comps.every(c=>c.answered)")
        await asyncio.sleep(1)
        v = await view(sh) if sh else {}
        print("F:", v, "\n   saved:", saved.get("current"), sorted(saved.get("panes", {})))
        checks.update({
            "F: both computers come back, both loaded": bool(v) and v["n"] == 2 and v["answered"] == [True, True] and v["names"] == ["Alpha", "Beta"],
            "F: the one shown last is shown": bool(v) and v["cur"] == "c2" and saved.get("current") == "c2",
            "F: each one's pane": bool(v) and v["tabs"] == [["a1.txt"], ["notes-B.txt"]] and v["paneOpen"] == [True, True],
        })

        # G: remove, after asking
        await sh.js("void removeComp(comps[1])")
        asked = await until(sh, "!$('confirm').hidden")
        await sh.js("$('confirm-cancel').click()")
        kept = await until(sh, "$('confirm').hidden&&comps.length===2")
        await sh.js("void removeComp(comps[1])")
        await until(sh, "!$('confirm').hidden")
        await sh.js("$('confirm-form').requestSubmit()")
        removed = await until(sh, "comps.length===1")
        await asyncio.sleep(0.8)
        v = await view(sh)
        saved = json.load(open(settings_file(xdg)))
        print("G: asked:", asked, "| cancel kept:", kept, "| removed:", removed, v)
        checks.update({
            "G: removing asks, and Cancel keeps it": asked and kept,
            "G: removed: one computer, shown, only + on the rail": removed and v["cur"] == "c1" and v["buttons"] == [] and v["active"] == [True],
            "G: settings.json forgets it": [c["id"] for c in saved.get("computers", [])] == ["c1"] and "c2" not in saved.get("panes", {}),
        })
        await close(p)
    finally:
        if p.poll() is None: p.kill()

    # H: config.json with two computers
    app_h = stage("app-h", {"computers": [{"name": "Lab", "urls": [URL["A"]]}, {"name": "Home", "urls": [URL["B"]]}]})
    p = launch(app_h, os.path.join(W, "xdg-h"))
    try:
        sh = await attach("page", "file:", "document.readyState==='complete'&&typeof comps!=='undefined'&&comps.length===2&&comps.every(c=>c.answered)")
        v = await view(sh) if sh else {}
        print("H:", v)
        checks.update({
            "H: config.json's computers, without asking": bool(v) and v["names"] == ["Lab", "Home"] and not v["box"],
            "H: both loaded, the first shown": bool(v) and v["pages"] == [URL["A"], URL["B"]] and v["cur"] == "cfg:Lab",
        })
        await close(p)
    finally:
        if p.poll() is None: p.kill()

    print("\n".join(("PASS " if v else "FAIL ") + k for k, v in checks.items()))
    print("ALL PASS" if all(checks.values()) else "SOME FAILED")

try:
    asyncio.run(main())
finally:
    xvfb.terminate(); shutil.rmtree(W, ignore_errors=True)

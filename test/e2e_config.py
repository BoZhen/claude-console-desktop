"""End to end, the server address with and without config.json, under Xvfb against
a stand-in console page.
  python test/e2e_config.py          (Python with tornado; Electron from node_modules)
A: a build without config.json asks where the console runs on first start (no way
   around the dialog; this computer is offered first; for another computer an empty
   address is refused), connects to the address given and opens it directly at the
   next start.
B: a build whose config.json lists a dead address and then a live one connects to
   the live one by itself; Server address… offers the config.json list."""
import asyncio, json, os, shutil, socket, subprocess, tempfile, threading, time, urllib.request
import tornado.web, tornado.ioloop
from tornado.websocket import websocket_connect

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ELECTRON = os.path.join(REPO, "node_modules", "electron", "dist", "electron")
W = tempfile.mkdtemp(prefix="ccd-cfg-")

def free():
    with socket.socket() as s: s.bind(("127.0.0.1", 0)); return s.getsockname()[1]
SPORT, DPORT, DEAD = free(), free(), free()

class Page(tornado.web.RequestHandler):
    def get(self, *a):
        self.write("<!doctype html><title>Stand-in console</title><p>stand-in")
def serve():
    asyncio.set_event_loop(asyncio.new_event_loop())
    tornado.web.Application([(r"/(.*)", Page)]).listen(SPORT, address="127.0.0.1")
    tornado.ioloop.IOLoop.current().start()
threading.Thread(target=serve, daemon=True).start()

def stage(name, config):
    out = os.path.join(W, name)
    r = subprocess.run([os.path.join(REPO, "scripts", "stage.sh"), out, "2026.1.1.0"], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    has_local = os.path.exists(os.path.join(REPO, "config.json"))
    staged_cfg = os.path.join(out, "config.json")
    copied = os.path.exists(staged_cfg) == has_local   # stage.sh copies the checkout's file when there is one
    if os.path.exists(staged_cfg): os.remove(staged_cfg)
    if config is not None:
        json.dump(config, open(staged_cfg, "w"))
    return out, copied

xvfb = subprocess.Popen(["Xvfb", ":97", "-screen", "0", "1400x900x24", "-nolisten", "tcp"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

def launch(app, xdg):
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE_CONSOLE_URL")}
    env.update(DISPLAY=":97", XDG_CONFIG_HOME=xdg)
    return subprocess.Popen([ELECTRON, "--no-sandbox", "--disable-gpu", "--password-store=basic",
                             f"--remote-debugging-port={DPORT}", os.path.join(app, "main.js")],
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

async def shell(timeout=40):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            ts = json.load(urllib.request.urlopen(f"http://127.0.0.1:{DPORT}/json", timeout=2))
            t = next((t for t in ts if t["type"] == "page" and t["url"].startswith("file:")), None)
            if t:
                c = CDP(await websocket_connect(t["webSocketDebuggerUrl"]))
                if await c.js("document.readyState==='complete'&&!!window.app&&typeof comps!=='undefined'"): return c
        except Exception:
            pass
        await asyncio.sleep(0.5)
    raise RuntimeError("no shell target")

async def console_url(timeout=20):
    """The URL the console webview shows once it is the stand-in page, else ''."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        ts = json.load(urllib.request.urlopen(f"http://127.0.0.1:{DPORT}/json", timeout=2))
        t = next((t for t in ts if t["type"] == "webview" and t.get("title") == "Stand-in console"), None)
        if t: return t["url"]
        await asyncio.sleep(0.5)
    return ""

async def close():
    v = json.load(urllib.request.urlopen(f"http://127.0.0.1:{DPORT}/json/version", timeout=2))
    b = CDP(await websocket_connect(v["webSocketDebuggerUrl"]))
    try: await b.call("Browser.close")
    except Exception: pass

BOX = """JSON.stringify({box:!$('urlbox').hidden, cancel:!$('url-cancel').hidden, defaults:!$('url-defaults').hidden,
  local:$('srv-local').checked,
  placeholder:$('url-input').placeholder, error:$('url-error').hidden?'':$('url-error').textContent,
  src:comps.length?comps[0].view.getAttribute('src')||'':''})"""

async def submit(sh, text):
    """Another computer, at text."""
    await sh.js(f"$('srv-remote').checked=true;$('url-input').value={json.dumps(text)};$('url-form').requestSubmit();")
    await asyncio.sleep(0.8)
    return json.loads(await sh.js(BOX))

async def main():
    checks, stand_in = {}, f"http://127.0.0.1:{SPORT}/"
    # A: no config.json
    app_a, copied = stage("a", None)
    checks["stage.sh copies the checkout's config.json"] = copied
    xdg = os.path.join(W, "xdg-a")
    p = launch(app_a, xdg)
    try:
        sh = await shell(); await asyncio.sleep(1)
        first = json.loads(await sh.js(BOX))
        await sh.js("document.getElementById('urlbox').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
        after_esc = json.loads(await sh.js(BOX))
        empty = await submit(sh, "")
        given = await submit(sh, stand_in)
        url_a = await console_url()
        print("A first start:", first, "\n  after Esc:", after_esc["box"], "| empty:", empty["error"], "| given:", given, "| console:", url_a)
        checks.update({
            "A: the server dialog is up at first start": first["box"],
            "A: it offers this computer first": first["local"],
            "A: no Cancel before the first address": not first["cancel"],
            "A: no config.json hint": not first["defaults"],
            "A: example placeholder": first["placeholder"] == "http://192.168.1.10:7703/",
            "A: nothing loaded yet": first["src"] == "",
            "A: Esc does not close it": after_esc["box"],
            "A: an empty address is refused": empty["box"] and "Enter the address" in empty["error"],
            "A: the given address closes the dialog": not given["box"],
            "A: the console loads the given address": url_a == stand_in,
        })
        await close(); p.wait(timeout=15)
        p = launch(app_a, xdg)
        sh = await shell()
        url_a2 = await console_url()
        again = json.loads(await sh.js(BOX))
        print("A next start:", again, "| console:", url_a2)
        checks.update({"A: next start opens the saved address": url_a2 == stand_in and not again["box"]})
        await close(); p.wait(timeout=15)
    finally:
        if p.poll() is None: p.kill()
    # B: config.json with a dead address first
    app_b, _ = stage("b", {"urls": [f"http://127.0.0.1:{DEAD}/", stand_in]})
    p = launch(app_b, os.path.join(W, "xdg-b"))
    try:
        sh = await shell()
        url_b = await console_url(30)
        start = json.loads(await sh.js(BOX))
        await sh.js("openBox('edit', cur)"); await asyncio.sleep(0.3)
        box = json.loads(await sh.js(BOX))
        back = await submit(sh, "")
        print("B:", start, "| console:", url_b, "\n  dialog:", box, "\n  empty answer:", back)
        checks.update({
            "B: no dialog at start": not start["box"],
            "B: the second address is used when the first is dead": url_b == stand_in,
            "B: the dialog names config.json": box["defaults"],
            "B: with config.json it offers another computer": not box["local"],
            "B: the placeholder lists the addresses": box["placeholder"].startswith("automatic: ") and stand_in in box["placeholder"],
            "B: Cancel is there": box["cancel"],
            "B: an empty answer goes back to the list": not back["box"] and not back["error"],
        })
        await close(); p.wait(timeout=15)
    finally:
        if p.poll() is None: p.kill()
    print("\n".join(("PASS " if v else "FAIL ") + k for k, v in checks.items()))
    print("ALL PASS" if all(checks.values()) else "SOME FAILED")

try:
    asyncio.run(main())
finally:
    xvfb.terminate(); shutil.rmtree(W, ignore_errors=True)

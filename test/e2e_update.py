"""End to end, the packaged Linux app updating itself, under Xvfb against a stand-in
console (the real page and the real api/desktop/* handlers from claude_console.py).
  python test/e2e_update.py <extracted package dir>     (webterminal env: tornado)
Steps: start on the built-in code, publish a newer bundle, check from Settings >
About, restart with the rail's green button, then: a bundle signed with another key
is refused, and a signed bundle that throws on start is set aside by itself."""
import asyncio, json, os, shutil, signal, socket, subprocess, sys, tempfile, threading, time, urllib.request
# the console's code: $CLAUDE_CONSOLE_DIR, else a claude-console checkout beside this repo
sys.path.insert(0, os.environ.get("CLAUDE_CONSOLE_DIR") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "claude-console"))
import claude_console as c
import tornado.web, tornado.websocket, tornado.ioloop
from tornado.websocket import websocket_connect

PKG = os.path.abspath(sys.argv[1])
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W = tempfile.mkdtemp(prefix="ccd-e2e-")
PUB, XDG = os.path.join(W, "pub"), os.path.join(W, "xdg")
UPD = os.path.join(XDG, "Claude Console", "updates")
os.makedirs(PUB)
c.DESKTOP_DIR, c.AUTH = PUB, ""
A, B, C, D = "2026.10.23.1000", "2026.10.23.1100", "2026.10.23.1200", "2026.10.23.1300"
HTML = (c.CONSOLE_HTML.replace("__CLAUDE_CONSOLE_WEBFM_URL__", "null").replace("__CLAUDE_CONSOLE_STAMP__", c.PAGE_STAMP)
        .replace("__CLAUDE_CONSOLE_VERSION__", "test"))

class Page(tornado.web.RequestHandler):
    def get(self, *a):
        if self.request.path.startswith("/static/"): raise tornado.web.HTTPError(404)
        self.write(HTML)
class Api(tornado.web.RequestHandler):
    def get(self, *a): self.write('{"projects":[],"models":[],"sessions":[]}')
    def post(self, *a): self.write("{}")
class WS(tornado.websocket.WebSocketHandler):
    def check_origin(self, o): return True
    def open(self): self.write_message(json.dumps({"type": "hello"}))
    def on_message(self, m): pass
def serve(port):
    tornado.web.Application([(r"/ws/chat", WS), (r"/api/desktop/latest", c.DesktopLatestHandler),
                             (r"/api/desktop/bundle/(latest|\d+(?:\.\d+)*)", c.DesktopBundleHandler),
                             (r"/api/(.*)", Api), (r"/(.*)", Page)]).listen(port, address="127.0.0.1")
    tornado.ioloop.IOLoop.current().start()

def free():
    with socket.socket() as s: s.bind(("127.0.0.1", 0)); return s.getsockname()[1]
SPORT, DPORT = free(), free()
threading.Thread(target=serve, args=(SPORT,), daemon=True).start()
xvfb = subprocess.Popen(["Xvfb", ":98", "-screen", "0", "1500x950x24", "-nolisten", "tcp"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
ENV = {**os.environ, "DISPLAY": ":98", "XDG_CONFIG_HOME": XDG}
def launch():
    return subprocess.Popen([os.path.join(PKG, "app", "claude-console"), "--no-sandbox", "--disable-gpu", "--password-store=basic",
                             f"--remote-debugging-port={DPORT}", f"--url=http://127.0.0.1:{SPORT}/"],
                            env=ENV, stdout=open(os.path.join(W, "app.log"), "a"), stderr=subprocess.STDOUT)
def publish(version, key=None):
    env = {**os.environ, "CCD_VERSION": version, "CLAUDE_CONSOLE_DESKTOP_DIR": PUB}
    if key: env["CCD_UPDATE_KEY"] = key
    out = subprocess.run([os.path.join(REPO, "scripts", "publish.sh"), "test " + version], cwd=REPO, env=env, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr

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

async def attach(kind, timeout=40):
    """The shell page ("shell") or the console webview ("console"), once it is up."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            ts = json.load(urllib.request.urlopen(f"http://127.0.0.1:{DPORT}/json", timeout=2))
            want = ((lambda t: t["type"] == "page" and t["url"].startswith("file:")) if kind == "shell"
                    else (lambda t: t["type"] == "webview" and f":{SPORT}/" in t["url"]))
            t = next((t for t in ts if want(t)), None)
            if t:
                cdp = CDP(await websocket_connect(t["webSocketDebuggerUrl"]))
                ok = await cdp.js("document.readyState==='complete'&&" + ("!!window.app" if kind == "shell" else "typeof openSettings==='function'"))
                if ok: return cdp
        except Exception:
            pass
        await asyncio.sleep(0.5)
    raise RuntimeError(f"no {kind} target")

async def click(shell, el):
    r = json.loads(await shell.js(f"JSON.stringify(document.getElementById('{el}').getBoundingClientRect())"))
    x, y = r["x"] + r["width"] / 2, r["y"] + r["height"] / 2
    for typ in ("mouseMoved", "mousePressed", "mouseReleased"):
        await shell.call("Input.dispatchMouseEvent", type=typ, x=x, y=y, button="left", clickCount=1)

async def browser_close():
    v = json.load(urllib.request.urlopen(f"http://127.0.0.1:{DPORT}/json/version", timeout=2))
    b = CDP(await websocket_connect(v["webSocketDebuggerUrl"]))
    try: await b.call("Browser.close")
    except Exception: pass

ABOUT = """JSON.stringify({ver:document.getElementById('abDeskVer').textContent,state:document.getElementById('abDeskState').textContent,
  update:!document.getElementById('abDeskUpdate').hidden,updateText:document.getElementById('abDeskUpdate').textContent})"""

async def main():
    R = {}
    app = launch()
    shell = await attach("shell"); con = await attach("console")
    R["start"] = await shell.js("window.app.updateInfo()")
    tree = subprocess.run(["xwininfo", "-root", "-tree"], env=ENV, capture_output=True, text=True).stdout
    R["window class"] = next((l.split("(")[1].split(")")[0] for l in tree.splitlines() if '"Claude Console"' in l and "(" in l), "")
    # nothing published yet: About says so after a check from the page
    await con.js("openSettings('about')"); await asyncio.sleep(0.5)
    await con.js("ClaudeConsoleDesktop.check()"); await asyncio.sleep(0.5)
    R["about, nothing published"] = json.loads(await con.js(ABOUT))
    # a newer bundle on the console: Check for updates in About downloads and checks it
    publish(B)
    await con.js("document.getElementById('abDeskCheck').click()")
    for _ in range(40):
        await asyncio.sleep(0.5)
        if (await shell.js("window.app.updateInfo()"))["ready"]: break
    await asyncio.sleep(0.5)
    R["about, update found"] = json.loads(await con.js(ABOUT))
    R["rail button"] = await shell.js("(()=>{const b=document.getElementById('rail-update');return {shown:!b.hidden,title:b.title}})()")
    R["files after download"] = sorted(os.listdir(UPD))
    await con.js("closeSettings()")
    # the green button on the rail: the app restarts into the update
    await click(shell, "rail-update")
    await asyncio.sleep(4)
    shell = await attach("shell"); con = await attach("console")
    await asyncio.sleep(1.5)
    R["after restart"] = await shell.js("window.app.updateInfo()")
    R["files after restart"] = sorted(os.listdir(UPD))
    # signed with another key: refused, nothing kept
    other = os.path.join(W, "other-key.pem")
    subprocess.run(["openssl", "genpkey", "-algorithm", "ed25519", "-out", other], check=True, capture_output=True)
    publish(C, key=other)
    R["forged"] = await con.js("ClaudeConsoleDesktop.check()")
    R["files after forged"] = sorted(os.listdir(UPD))
    # a correctly signed update that throws on start, already downloaded: set aside by itself
    stage = os.path.join(W, "boom")
    subprocess.run([os.path.join(REPO, "scripts", "stage.sh"), stage, D], check=True)
    with open(os.path.join(stage, "main.js"), "w") as fh: fh.write("throw new Error('boom: a broken update');\n")
    subprocess.run([os.path.join(REPO, "node_modules", ".bin", "asar"), "pack", stage, os.path.join(UPD, f"claude-console-desktop-{D}.asar")], check=True)
    subprocess.run(["node", "-e", f"""const fs=require('fs'),crypto=require('crypto');const f={json.dumps(os.path.join(UPD, f"claude-console-desktop-{D}.asar"))};
      const d=fs.readFileSync(f);fs.writeFileSync(f.replace(/\\.asar$/,'.json'),JSON.stringify({{version:{json.dumps(D)},size:d.length,
      sha256:crypto.createHash('sha256').update(d).digest('hex'),signature:crypto.sign(null,d,fs.readFileSync(process.env.HOME+'/.config/claude-console-desktop/update-signing-key.pem')).toString('base64'),electron:44}}));"""], check=True)
    await browser_close(); await asyncio.sleep(3)
    launch()
    await asyncio.sleep(6)   # D throws, is set aside, the app relaunches on its own
    shell = await attach("shell", timeout=60)
    R["after the broken update"] = await shell.js("window.app.updateInfo()")
    R["broken set aside"] = sorted(n for n in os.listdir(UPD) if D in n)
    why = os.path.join(UPD, f"claude-console-desktop-{D}.json.why")
    R["why"] = open(why).read().strip() if os.path.exists(why) else None
    await browser_close(); await asyncio.sleep(2)

    for k, v in R.items(): print(f"{k:24} {v}")
    s, af, ab = R["start"], R["about, update found"], R["after restart"]
    checks = {
        "the window class is claude-console (taskbar groups it with the menu entry)": '"claude-console" "claude-console"' in R["window class"],
        "starts on the built-in code": s["running"] == A and s["source"] == "builtin" and s["packaged"] and not s["ready"],
        "About, nothing published: up to date": R["about, nothing published"]["ver"] == A and "Up to date" in R["about, nothing published"]["state"],
        "About, Check for updates: downloaded and checked, Restart button": B in af["state"] and "downloaded and checked" in af["state"] and af["update"] and B in af["updateText"],
        "the rail shows the green button": R["rail button"]["shown"] and B in R["rail button"]["title"],
        "the bundle and its manifest are kept": R["files after download"] == [f"claude-console-desktop-{B}.asar", f"claude-console-desktop-{B}.json"],
        "after the button: runs the update": ab["running"] == B and ab["source"] == "update" and not ab["ready"],
        "its start is confirmed (no .trying left)": not any(n.startswith(".trying") for n in R["files after restart"]),
        "a bundle signed with another key is refused": "does not match its signature" in (R["forged"]["error"] or "") and not R["forged"]["ready"],
        "...and nothing of it is kept": not any(C in n for n in R["files after forged"]),
        "a broken signed update: the app comes back by itself on the last good one": R["after the broken update"]["running"] == B and R["after the broken update"]["source"] == "update",
        "...the broken one is set aside, with the reason": f"claude-console-desktop-{D}.json.bad" in R["broken set aside"] and "threw on start" in (R["why"] or ""),
    }
    print("\n".join(("PASS " if v else "FAIL ") + k for k, v in checks.items()))
    print("ALL PASS" if all(checks.values()) else "SOME FAILED")

try:
    asyncio.run(main())
finally:
    xvfb.terminate()
    print("work dir:", W)

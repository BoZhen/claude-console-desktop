"""The README's screenshot of the app's own screen, figs/first-start.png: the first
start of a build without config.json, asking where the console runs. The app runs
under Xvfb with a throwaway settings folder, so it shows no page of any console.
(The README's picture of the console itself comes from Claude Console's README.)
  python test/readme_shots.py [outdir]        (default: figs/)
Needs Python with tornado, Xvfb, ImageMagick's import, and Electron from node_modules."""
import asyncio, json, os, shutil, socket, subprocess, sys, tempfile, time, urllib.request
from tornado.websocket import websocket_connect

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ELECTRON = os.path.join(REPO, "node_modules", "electron", "dist", "electron")
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, "figs"))
WIDTH, HEIGHT = 860, 540
W = tempfile.mkdtemp(prefix="ccd-shots-")

def free():
    with socket.socket() as s: s.bind(("127.0.0.1", 0)); return s.getsockname()[1]
DPORT = free()

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

async def shell(ready, timeout=40):
    """A CDP connection to the app's window (shell/index.html), once ready is true."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            t = next((t for t in targets() if t["type"] == "page" and t["url"].startswith("file:")), None)
            if t:
                con = CDP(await websocket_connect(t["webSocketDebuggerUrl"]))
                if await con.js(ready): return con
        except Exception:
            pass
        await asyncio.sleep(0.5)
    raise RuntimeError("the window did not come up: " + json.dumps([(t["type"], t["url"]) for t in targets()]))

async def main():
    os.makedirs(OUT, exist_ok=True)
    app_dir = os.path.join(W, "app")
    r = subprocess.run([os.path.join(REPO, "scripts", "stage.sh"), app_dir, "2026.1.1.0", "--with-loader"],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    if os.path.exists(os.path.join(app_dir, "config.json")): os.remove(os.path.join(app_dir, "config.json"))
    # a settings folder with only the window's place and size: the first start
    xdg = os.path.join(W, "config")
    os.makedirs(os.path.join(xdg, "Claude Console"))
    with open(os.path.join(xdg, "Claude Console", "settings.json"), "w") as f:
        json.dump({"bounds": {"x": 0, "y": 0, "width": WIDTH, "height": HEIGHT}}, f)
    display = next(n for n in range(90, 200) if not os.path.exists(f"/tmp/.X11-unix/X{n}"))
    xvfb = subprocess.Popen(["Xvfb", f":{display}", "-screen", "0", f"{WIDTH}x{HEIGHT}x24", "-nolisten", "tcp"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE_CONSOLE")}
    env.update(DISPLAY=f":{display}", XDG_CONFIG_HOME=xdg, HOME=os.path.join(W, "home"))
    app = subprocess.Popen([ELECTRON, "--no-sandbox", "--disable-gpu", "--password-store=basic", "--lang=en-US",
                            f"--remote-debugging-port={DPORT}", app_dir],   # as a package: package.json names the settings folder
                           env=env, stdout=open(os.path.join(W, "app.log"), "w"), stderr=subprocess.STDOUT)
    try:
        await shell("document.readyState==='complete'&&!!window.app&&!document.getElementById('urlbox').hidden")
        await asyncio.sleep(1.0)
        pages = [t["url"] for t in targets() if t["type"] == "webview" and t["url"].startswith("http")]
        assert not pages, "the app shows a page: " + ", ".join(pages)
        path = os.path.join(OUT, "first-start.png")
        subprocess.run(["import", "-display", f":{display}", "-window", "root", "-strip", path], check=True)
        print("wrote", path)
    finally:
        v = json.load(urllib.request.urlopen(f"http://127.0.0.1:{DPORT}/json/version", timeout=2))
        b = CDP(await websocket_connect(v["webSocketDebuggerUrl"]))
        try: await b.call("Browser.close")
        except Exception: pass
        app.wait(timeout=30)
        xvfb.terminate()

try:
    asyncio.run(main())
finally:
    shutil.rmtree(W, ignore_errors=True)

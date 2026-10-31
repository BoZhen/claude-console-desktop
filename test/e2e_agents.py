"""End to end, the rail's Agents button, under Xvfb: the real console page (from the
claude-console checkout beside this one, or CLAUDE_CONSOLE_DIR) against a stand-in
server whose session has subagents, and a stand-in older console without an Agents tab.
  python test/e2e_agents.py [outdir]   (Python with tornado and what claude_console.py
                                        imports; Electron from node_modules; with outdir,
                                        a picture of the window, by ImageMagick's import)
A: the console's own rail is hidden in the app; the window's rail has Agents under
   Side chats, with the page's badge (how many subagents still run in the session
   shown, in the page's colours) and tooltip.
B: a press opens the drawer on the Agents tab and lights the button; a second closes
   it. Side chats lights its own button instead.
C: the count follows the page: an agent that finishes lowers it, none running hides
   the badge, a session without agents has none, and a reload brings it back.
D: with the pane open (one computer) the rail goes; the pane's tab bar has the same
   button, with the badge, and it opens the tab too.
E: an older console without an Agents tab: no button; back on the first, it is there."""
import asyncio, json, os, shutil, socket, subprocess, sys, tempfile, threading, time, urllib.request
import tornado.web, tornado.websocket, tornado.ioloop
from tornado.websocket import websocket_connect

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONSOLE = os.path.abspath(os.environ.get("CLAUDE_CONSOLE_DIR") or os.path.join(REPO, "..", "claude-console"))
sys.path.insert(0, CONSOLE)
import claude_console as cc   # noqa: E402

ELECTRON = os.path.join(REPO, "node_modules", "electron", "dist", "electron")
W = tempfile.mkdtemp(prefix="ccd-agents-")
HTML = (cc.CONSOLE_HTML.replace("__CLAUDE_CONSOLE_WEBFM_URL__", "null").replace("__CLAUDE_CONSOLE_STAMP__", cc.PAGE_STAMP)
        .replace("__CLAUDE_CONSOLE_VERSION__", "test"))

def free():
    with socket.socket() as s: s.bind(("127.0.0.1", 0)); return s.getsockname()[1]
APORT, BPORT, DPORT = free(), free(), free()
URL_A, URL_B = f"http://127.0.0.1:{APORT}/", f"http://127.0.0.1:{BPORT}/"

# ------------------------------------------------------------------ the stand-ins
def agent(tid, desc):
    return {"kind": "tool_use", "tool": "Agent", "toolId": tid, "batch": "msgA",
            "input": {"description": desc, "subagent_type": "general-purpose", "prompt": "Please " + desc + "."}}
LAUNCH = "Async agent launched successfully. agentId: x"
EVENTS = [
    {"kind": "user_text", "text": "Survey the three repos."},
    agent("A1", "repo one"), agent("A2", "repo two"), agent("A3", "repo three"),
    {"kind": "tool_result", "toolId": "A1", "content": "Report: 12 papers.", "isError": False},
    {"kind": "tool_result", "toolId": "A2", "content": LAUNCH, "isError": False},
    {"kind": "tool_result", "toolId": "A3", "content": LAUNCH, "isError": False},
    {"kind": "tool_use", "tool": "Bash", "toolId": "x1", "input": {"command": "git log --oneline"}, "parent": "A2"},
    {"kind": "assistant_text", "text": "One is back; two run in the background."},
]

def attached(sid, cc_id, title, events, busy):
    return {"type": "attached", "id": sid, "cwd": "/w", "name": "w", "cc": cc_id, "title": title, "model": "opus",
            "mode": "default", "account": "main", "busy": busy, "ended": False, "events": events, "events_delta": False,
            "event_seq": len(events), "effort": "", "compacting": False, "tasks": [], "plan_hist": [], "ctx": None}

class Page(tornado.web.RequestHandler):
    def get(self, *a): self.set_header("Content-Type", "text/html; charset=utf-8"); self.write(HTML)
class Api(tornado.web.RequestHandler):
    def get(self, *a): self.write({"projects": [], "models": [], "sessions": []})
    def post(self, *a): self.write({})
SOCKS = []
class WS(tornado.websocket.WebSocketHandler):
    def check_origin(self, o): return True
    def open(self): SOCKS.append(self); self.write_message(json.dumps({"type": "hello"}))
    def on_close(self):
        if self in SOCKS: SOCKS.remove(self)
    def on_message(self, raw):
        m = json.loads(raw)
        if m.get("type") == "attach" and m.get("id") == "s1":
            self.write_message(json.dumps(attached("s1", "7f3c2a10-4b1e-4c5d-9a8e-1f2b3c4d5e6f", "Survey", EVENTS, True)))
        elif m.get("type") == "attach" and m.get("id") == "s2":
            self.write_message(json.dumps(attached("s2", "8a4d3b21-5c2f-4d6e-8b9f-2a3b4c5d6e7f", "Other",
                [{"kind": "user_text", "text": "hi"}, {"kind": "assistant_text", "text": "Hello."}], False)))
class Old(tornado.web.RequestHandler):   # a console from before the Agents tab
    def get(self, *a):
        self.write("<!doctype html><title>Old console</title><header style='background:#f4f1ea;color:#222'>Old</header>"
                   "<p>an older console</p>")

LOOP = {}
def serve():
    asyncio.set_event_loop(asyncio.new_event_loop())
    tornado.web.Application([(r"/ws/chat", WS), (r"/api/(.*)", Api),
                             (r"/static/(.*)", tornado.web.StaticFileHandler, {"path": os.path.join(CONSOLE, "static")}),
                             (r"/(.*)", Page)]).listen(APORT, address="127.0.0.1")
    tornado.web.Application([(r"/(.*)", Old)]).listen(BPORT, address="127.0.0.1")
    LOOP["io"] = tornado.ioloop.IOLoop.current()
    LOOP["io"].start()
threading.Thread(target=serve, daemon=True).start()

def send(o):
    """A message on every console socket; events go into the log, so a reload has them."""
    if o.get("type") == "events": EVENTS.extend(o["events"])
    def go():
        for s in list(SOCKS):
            try: s.write_message(json.dumps(o))
            except Exception: pass
    LOOP["io"].add_callback(go)

def done(tid, status="completed"):
    return {"type": "events", "events": [{"kind": "agent_done", "toolId": tid, "status": status, "summary": "Finished.",
                                          "agent": {"up": 1000, "out": 200, "ntools": 3}}]}

# ------------------------------------------------------------------ the app
def stage(name, config):
    out = os.path.join(W, name)
    r = subprocess.run([os.path.join(REPO, "scripts", "stage.sh"), out, "2026.1.1.0", "--with-loader"], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    json.dump(config, open(os.path.join(out, "config.json"), "w"))
    return out

xvfb = subprocess.Popen(["Xvfb", ":96", "-screen", "0", "1400x900x24", "-nolisten", "tcp"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

def launch(app, xdg):
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE_CONSOLE")}
    env.update(DISPLAY=":96", XDG_CONFIG_HOME=xdg, HOME=os.path.join(W, "home"))
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

async def until(sh, cond, timeout=10):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if await sh.js(cond): return True
        except Exception:
            pass
        await asyncio.sleep(0.2)
    return False

async def close(p):
    v = json.load(urllib.request.urlopen(f"http://127.0.0.1:{DPORT}/json/version", timeout=2))
    b = CDP(await websocket_connect(v["webSocketDebuggerUrl"]))
    try: await b.call("Browser.close")
    except Exception: pass
    p.wait(timeout=30)

# the window's buttons: shown, lit, badge, tooltip
RAIL = """JSON.stringify(Object.assign(Object.fromEntries(['rail-agents', 'pane-agents', 'rail-side', 'pane-side'].map(id => {
  const b = $(id), n = b.querySelector('.badge');
  return [id, {shown: !b.hidden && b.offsetParent !== null, on: b.classList.contains('on'),
               badge: n ? (n.hidden ? '' : n.textContent) : null, title: b.title,
               bg: n ? getComputedStyle(n).backgroundColor : ''}];
})), {rail: !$('rail').hidden, after: $('rail-side').nextElementSibling.id, cur: cur && cur.id}))"""
PAGE = """JSON.stringify({tab: drawerTab(), badge: (b => b.hidden ? '' : b.textContent)($('#prAgents .rbadge')),
  bg: getComputedStyle($('#prAgents .rbadge')).backgroundColor, prail: getComputedStyle($('#prail')).display,
  title: $('#prAgents').title})"""

async def main():
    checks = {}
    app = stage("app", {"computers": [{"name": "Lab", "urls": [URL_A]}]})
    p = launch(app, os.path.join(W, "xdg"))
    try:
        sh = await attach("page", "file:", "document.readyState==='complete'&&typeof comps!=='undefined'&&comps.length===1&&cur&&cur.answered")
        assert sh, "the window"
        await sh.js("setPane(false);true")
        con = await attach("webview", URL_A, "typeof wsSend==='function'&&typeof ws==='object'&&!!ws&&ws.readyState===1")
        assert con, "the console page"
        await con.js("switchSession('s1');true")
        assert await until(con, "agentCards().length===3"), "the session"
        await until(sh, "!$('rail-agents').hidden&&$('rail-agents').querySelector('.badge').textContent==='2'")
        r, pg = json.loads(await sh.js(RAIL)), json.loads(await con.js(PAGE))
        print("A:", r["rail-agents"], r["after"], "| page:", pg)
        a = r["rail-agents"]
        if len(sys.argv) > 1:   # a picture of the window: python test/e2e_agents.py OUTDIR
            os.makedirs(sys.argv[1], exist_ok=True)
            subprocess.run(["import", "-display", ":96", "-window", "root", os.path.join(sys.argv[1], "agents-rail.png")])
        checks.update({
            "A: the page's own rail is hidden in the app": pg["prail"] == "none",
            "A: Agents sits on the window's rail, under Side chats": a["shown"] and r["after"] == "rail-agents",
            "A: its badge: 2 running, as the page's": a["badge"] == "2" == pg["badge"],
            "A: in the page's colours, with the page's tooltip": a["bg"] == pg["bg"] and a["title"] == pg["title"] and "2 running, 3 in this session" in a["title"],
        })

        # B: open, close; Side chats
        await sh.js("$('rail-agents').click()")
        opened = await until(con, "drawerTab()==='agents'") and await until(sh, "$('rail-agents').classList.contains('on')")
        lit = json.loads(await sh.js(RAIL))
        await sh.js("$('rail-agents').click()")
        shut = await until(con, "drawerTab()===''") and await until(sh, "!$('rail-agents').classList.contains('on')")
        await sh.js("$('rail-side').click()")
        side = await until(con, "drawerTab()==='side'") and await until(sh, "$('rail-side').classList.contains('on')")
        rs = json.loads(await sh.js(RAIL))
        await sh.js("$('rail-side').click()")
        await until(con, "drawerTab()===''")
        print("B: open", opened, "close", shut, "side", side, rs["rail-agents"]["on"])
        checks.update({
            "B: a press opens the Agents tab and lights the button": opened and lit["rail-agents"]["on"] and not lit["rail-side"]["on"],
            "B: a second press closes the drawer": shut,
            "B: Side chats lights its own button, not Agents": side and not rs["rail-agents"]["on"],
        })

        # C: the count follows the page
        send(done("A2"))
        one = await until(sh, "$('rail-agents').querySelector('.badge').textContent==='1'&&!$('rail-agents').querySelector('.badge').hidden")
        send(done("A3", "failed"))
        none = await until(sh, "$('rail-agents').querySelector('.badge').hidden&&!$('rail-agents').hidden")
        tip = await sh.js("$('rail-agents').title")
        await con.js("switchSession('s2');true")
        other = await until(con, "agentCards().length===0") and await until(sh, "$('rail-agents').querySelector('.badge').hidden&&!$('rail-agents').hidden")
        EVENTS.extend([agent("A4", "repo four"), {"kind": "tool_result", "toolId": "A4", "content": LAUNCH, "isError": False}])
        await con.js("switchSession('s1');true")
        back = await until(sh, "$('rail-agents').querySelector('.badge').textContent==='1'&&!$('rail-agents').querySelector('.badge').hidden")
        await con.js("location.reload();true")
        con = await attach("webview", URL_A, "typeof wsSend==='function'&&typeof ws==='object'&&!!ws&&ws.readyState===1")
        await con.js("switchSession('s1');true")
        reloaded = await until(sh, "$('rail-agents').querySelector('.badge').textContent==='1'&&!$('rail-agents').querySelector('.badge').hidden&&!$('rail-agents').hidden")
        print("C:", one, none, repr(tip), other, back, reloaded)
        checks.update({
            "C: a finished agent lowers the count": one,
            "C: none running: no badge, the button stays": none and "0 running, 3 in this session" in tip,
            "C: a session without agents: no badge": other,
            "C: back on a session with one running: 1": back,
            "C: after a reload of the page, the same": reloaded,
        })

        # D: the pane open, one computer: the rail goes, the pane's tab bar has the button
        await sh.js("setPane(true);true")
        await until(sh, "$('rail').hidden&&!$('pane').hidden")
        await asyncio.sleep(0.4)
        rp = json.loads(await sh.js(RAIL))
        await sh.js("$('pane-agents').click()")
        popen = await until(con, "drawerTab()==='agents'") and await until(sh, "$('pane-agents').classList.contains('on')")
        await sh.js("$('pane-agents').click()")
        await until(con, "drawerTab()===''")
        await sh.js("setPane(false);true")
        print("D:", rp["rail"], rp["pane-agents"], popen)
        checks.update({
            "D: the pane open: no rail, Agents in the pane's tab bar with the badge": not rp["rail"] and rp["pane-agents"]["shown"] and rp["pane-agents"]["badge"] == "1",
            "D: and it opens the Agents tab too": popen,
        })

        # E: an older console
        await sh.js(f"openBox('add');$('url-name').value='Old';$('url-input').value={json.dumps(URL_B)};$('url-form').requestSubmit()")
        added = await until(sh, "comps.length===2&&cur.name==='Old'&&cur.answered")
        await asyncio.sleep(1.2)
        ro = json.loads(await sh.js(RAIL))
        await sh.js("switchTo(comps[0])")
        again = await until(sh, "!$('rail-agents').hidden&&$('rail-agents').querySelector('.badge').textContent==='1'")
        print("E:", added, ro["rail-agents"], again)
        checks.update({
            "E: an older console without an Agents tab: no button": added and not ro["rail-agents"]["shown"] and ro["rail"],
            "E: back on the first computer, the button and its count": again,
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

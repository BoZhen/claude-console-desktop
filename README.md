# Claude Console desktop

A desktop window for [Claude Console](https://github.com/BoZhen/claude-console) with the
[web file manager](https://github.com/BoZhen/web-file-manager) built in, instead of a browser tab for the
console and one more for every file the chat links to. Electron 44, for Linux
(KDE, X11) and macOS.

The console can run on another computer, a server the app connects to, or on this
computer: then the app starts Claude Console and the file manager itself, with this
computer's `claude` CLI, and stops them when it quits (see [This computer](#this-computer)).

```
┌──────────────────────────────┬─┬────────────────────────────────┐
│ Claude Console               │ │ Files │ main.js × │ README.md ×│
│                              │ │                                │
│  chat …                      │◂▸│  the file, in the file manager │
│  see /path/main.js  ───────────▶│                                │
│                              │ │                                │
│  [ Type a message… ]         │ │                                │
└──────────────────────────────┴─┴────────────────────────────────┘
```

## Download

The [latest release](https://github.com/BoZhen/claude-console-desktop/releases/latest)
has the packages:

- `Claude-Console-mac-arm64.dmg`, macOS on Apple silicon: open it and drag Claude
  Console onto Applications. The first start needs one approval, see [macOS](#macos).
- `Claude-Console-linux-x64.tar.gz`, Linux on x86-64: unpack it and run
  `claude-console-linux-x64/install.sh`, see [Linux: another computer](#linux-another-computer).
- `SHA256SUMS`, their checksums (`shasum -a 256 -c SHA256SUMS` on macOS,
  `sha256sum -c SHA256SUMS` on Linux).

On first start the app asks [where the console runs](#where-the-console-runs). These
packages carry no update key, so they do not update themselves: a newer version comes
as a new release. An Intel Mac build is `ARCHS=x64 scripts/build-mac.sh` from a checkout.

## What goes where

- **File paths in the chat** (and 📂 Open folder, and image thumbnails) open in the
  **side pane** on the right, one tab per file. Clicking the same path again shows
  that tab and reloads it, since Claude may have changed the file. Keyboard focus
  stays in the console.
- The pane's first tab, **Files**, is the file manager itself. It cannot be closed.
- The **rail** on the right edge, shown while the pane is closed: Files opens the
  pane; the chat bubble opens the console's **Side chats** in its drawer; the gear
  at the foot opens the console's **Settings** (Appearance, Accounts, About). A
  second press closes either. While the pane is open the rail is hidden and the
  pane's tab bar has the same Side chats and Settings buttons, and **Close all**
  while any file tab is open (Files stays).
- **Links to other sites** open in the system browser.
- **Downloads** (session export, the file manager's download button) go straight to
  Downloads, never over an existing file (`name (1).ext`); a note at the bottom
  offers to show the file in its folder.
- **HTTP login** (the file manager's Basic Auth): a sign-in dialog. "Remember on this
  computer" stores the login encrypted with the system keyring (KWallet on KDE,
  Keychain on macOS). If no keyring is available, the box is disabled and the login
  lasts until the app quits.
- The console and the file manager are often plain `http` on a private network. The
  app treats those two origins as secure (Chromium switch
  `unsafely-treat-insecure-origin-as-secure`), so the console's 🎙 voice input and
  clipboard buttons work, which they do not in a browser tab on a plain `http`
  address. The switch is set at start, so an address entered for the first time gets
  it from the next start on.
- The pane's tab bar and borders take the colours of the console's header and follow
  its theme setting.
- If the console cannot be reached, a screen with the error retries every 5 s and has
  **Server…**.

The window size, the pane width, whether it is open and its tabs are restored at the
next start; restored tabs load when first shown.

## Keys

| Key | Does |
|---|---|
| Ctrl+\\ (⌘\\) | show / hide the side pane |
| Ctrl+F (⌘F) | find in the console or in the pane tab, whichever was clicked last; Enter / Shift+Enter: next / previous; Esc closes |
| Ctrl+W (⌘W) | close the pane tab (never the window) |
| Ctrl+Tab, Ctrl+Shift+Tab | next / previous pane tab |
| Ctrl+R, F5 (⌘R) | reload the console or the pane tab; with Shift, without cache |
| Ctrl+= / Ctrl+- / Ctrl+0 | zoom that page |
| Alt+← / Alt+→ (⌘[ ⌘]), mouse back / forward | history of that page |
| F12, Ctrl+Shift+I | developer tools for that page |

Esc is never taken by the app: in the console, Esc interrupts a running turn.
Middle-click closes a pane tab; right-click on a tab: reload, open in browser, copy
address, close, close the others, close all file tabs. Right-click in a page: open a link in the pane or
the browser, copy, paste, save an image, inspect.

## Where the console runs

On first start the app asks: **This computer** or **Another computer** (an address).
The choice can be changed in the console's **Settings → About → Server → Change…**,
from the menu **File → Server…** (Alt shows the menu bar on Linux), or with the
button on the "cannot reach" and "did not start" screens.

Another computer: a build can carry addresses in `config.json` (see below), tried in
order until one answers: for example the console over a VPN first, then the same
console over another network, so a laptop on either network connects without setup.
Such a build starts on them without asking. Tabs restored from the other address
move to the one in use. An empty address in the dialog goes back to trying the ones
in `config.json`. `--url=http://host:port/` (also `CLAUDE_CONSOLE_URL`) fixes one
for a single run, `CLAUDE_CONSOLE_URLS` (comma-separated) replaces the list. The file
manager address is the console's own (`CLAUDE_CONSOLE_WEBFM_URL`, else the console
host on port 7701).

Settings and stored logins: `~/.config/Claude Console/` (`settings.json`,
`logins.json`); on macOS `~/Library/Application Support/Claude Console/`.

## This computer

For whoever has the `claude` CLI on the computer the app runs on. The app carries
the code of Claude Console and of the web file manager (`scripts/stage-server.sh`
copies it into the package from [claude-console](https://github.com/BoZhen/claude-console)
and [web-file-manager](https://github.com/BoZhen/web-file-manager) checked out beside this
repository, or from `CLAUDE_CONSOLE_DIR` and `WEBFM_DIR`), and runs both on 127.0.0.1:

- **What it needs**: the `claude` CLI, signed in once in a terminal, and
  [uv](https://docs.astral.sh/uv/) or Python 3.10 or newer. The first start makes a
  Python environment in `<settings folder>/server/venv` with tornado, the Claude
  Agent SDK and `mcp` below 2 (`server-requirements.txt`). With uv this takes about
  20 s, and uv fetches a Python if the computer has none recent enough. Later starts
  take a second or two. The environment is made again when the requirements change,
  or when it stops working (its Python was removed).
- **Its environment** is the one a terminal would have: the app reads it from the
  login shell (`$SHELL -ilc env`), since a program started from the Dock or a menu
  gets a bare PATH without Homebrew or `~/.local/bin`.
- **Ports** 17703 (console) and 17701 (file manager), so a console you run yourself
  on 7703 can stay. `"localPorts": {"console": …, "fm": …}` in `settings.json` moves
  them.
- **The file manager** gets a login made up on first start
  (`<settings folder>/server/webfm-login`, owner-only); the app signs in itself.
- **Quitting the app stops both**, and with them any Claude session still running.
  Servers left over from a run that was killed are stopped at the next start.
- **When it does not start**, a screen says why (no `claude` CLI, no uv or Python, a
  port in use) with **Try again**. The servers' output is in
  `<settings folder>/server/logs/console.log` and `webfm.log`, the previous run's in
  `.log.1`.
- The console keeps its state in `~/.claude`, like a console you start yourself; run
  only one of them on the same account at a time.

## Updates

An installed app (a package, below) updates its own code from the console; the
Electron runtime inside it stays. On this computer:

```bash
scripts/publish.sh ["what changed"]   # the code as an update, on the console
```

It packs the app's code (`main.js`, `updater.js`, `bundle-pick.js`, `localserver.js`, the preloads,
`shell/`, the icon; `scripts/stage.sh` lists them) into an asar archive with
`bundle.json` naming its version, the date and minute (`2026.10.23.0612`), signs it
with an Ed25519 key and puts it in `~/.local/share/claude-console/desktop`. The
console serves it at `api/desktop/latest` (version, size, SHA-256, signature, the
Electron it needs) and `api/desktop/bundle/<version>`. An app that runs the console
on [this computer](#this-computer) asks that console, which offers what was published
on this same computer, usually nothing: such an install updates by installing a newer
package.

The app asks 15 s after it starts and every 6 hours, or from the console's
**Settings → About → Check for updates**. A newer version is downloaded into
`<settings folder>/updates`, and kept only if its size, SHA-256 and signature check
out. Then a green arrow in a circle appears on the rail above the gear (and in the
pane's tab bar); a click restarts the app into it, as does **Restart to update** in
About. `loader.js`, the app's entry point, starts the newest such update at every
start and the built-in code otherwise.

- **The key**: `scripts/make-update-key.sh` makes it once, in
  `~/.config/claude-console-desktop/update-signing-key.pem` (owner-only), and writes
  its public half into `config.json` as `updateKey`, from where it goes into every
  package built from this checkout. The installed app reads it from its own package,
  never from an update, and refuses a bundle signed with any other key, so a bundle
  is only as trusted as this computer. Keep a copy of the key: without it no
  installed app accepts an update, and each would need the next package installed
  by hand. A build without `updateKey`, a `--public` one for instance, takes no
  updates; About says so.
- **A broken update** cannot lock the app out. A version that throws while loading
  is set aside at once and the app restarts on the built-in code; a version whose
  start never reaches the window is set aside at the next start. Set-aside versions
  are not downloaded again.
- **A new Electron** (a new `electron` in `package.json`) comes only with a new
  package: About says so, and the code waits.
- **Run from this checkout** (`npm start`, the menu entry from
  `scripts/install-linux.sh`) the app runs the checkout's own code and never updates.

Tests: `npm test` (which update is run and trusted); `test/e2e_update.py <unpacked
package>` runs a packaged app under Xvfb against a stand-in console and updates it
once, with a forged and a broken bundle (Python with tornado, the console's tests).

## Linux: another computer

```bash
scripts/build-linux.sh            # dist/Claude-Console-linux-x64.tar.gz (x86-64)
```

On the other computer, in a terminal:

```bash
tar xzf Claude-Console-linux-x64.tar.gz
claude-console-linux-x64/install.sh      # ./install.sh --remove takes it away again
```

It installs the app in `~/.local/opt/claude-console`, a menu entry and icons, and on
Ubuntu 23.10 and later an AppArmor profile for `~/.local/opt/claude-console/claude-console`
(sudo asks for the password; see below for why). Installing a newer package replaces
the app and keeps the settings. The computer must reach the console (the same
network, or a VPN); from then on it updates itself.

## Linux: this computer (from the checkout)

```bash
npm install                       # Electron and the packager (a registry mirror, if you need one, goes in your .npmrc)
npm run fetch-electron            # the Electron binary itself (newer Electron fetches it on first use)
scripts/install-linux.sh          # menu entry "Claude Console", icons, AppArmor profile (sudo once)
```

`scripts/install-linux.sh` writes `~/.local/share/applications/claude-console.desktop`
and the icons under `~/.local/share/icons/hicolor/`. On Ubuntu 23.10 and later it also
installs `/etc/apparmor.d/claude-console-desktop`, an unconfined profile with `userns`
for `node_modules/electron/dist/electron`, the same kind Ubuntu ships for VS Code.
Ubuntu lets a program create user namespaces only with such a profile, and Chromium's
sandbox needs them; without it Electron stops at start ("The SUID sandbox helper binary
was found, but is not configured correctly"). `--no-sudo` skips the profile; `--remove`
takes everything away again.

`npm start` runs the app from a terminal.

## macOS

```bash
scripts/mac-tools.sh              # once: the tools for the disk image, see below
scripts/build-mac.sh              # dist/Claude-Console-mac-arm64.dmg (Apple silicon)
```

This builds the app on Linux with `@electron/packager` (Electron for macOS from
`ELECTRON_MIRROR` or `config.json`'s `electronMirror`, else Electron's default), for Apple silicon only (`ARCHS="arm64 x64"` adds an Intel
build), signs it ad hoc and puts it in a disk image.

On the Mac, open the `.dmg`. The window shows Claude Console, an arrow and the
Applications folder: drag the app onto Applications (choose **Replace** if an older
copy is there), eject the disk, and open Claude Console from Applications.

The first start of a downloaded copy needs one approval, because the app is signed
ad hoc and not notarized by Apple. macOS says it cannot verify the app: click
**Done** (not Move to Trash). Then in **System Settings → Privacy & Security** click
**Open Anyway** and confirm in the dialog that follows. Close the first alert before
clicking Open Anyway, or the confirmation stays hidden behind it. Later starts and
the app's own updates need no approval. The background of the disk image window
says the same in Chinese and English.

The Mac must reach the console. Updates then come from the console like on Linux;
they live in `~/Library/Application Support/Claude Console/updates`, outside the app,
so the installed app and its signature are never touched.

### The disk image

`scripts/mac-dmg.js` makes it on Linux, where Apple's `hdiutil` and `codesign` do not
exist (on a Mac it uses those instead):

1. `rcodesign` signs the app ad hoc.
2. `xorriso` writes the app, a link to `/Applications`, the background and a
   placeholder Finder layout into an HFS+ volume; only that volume is kept.
3. `hfs-layout-meta.c` (compiled against libdmg-hfsplus at build time) clears the
   Finder type and creator xorriso gives every file. The Mac shows them as
   `com.apple.FinderInfo`, and `codesign --verify --strict` then rejects the app.
   It also reads the catalog IDs and dates of the background file.
4. `make-mac-layout.py` writes the real `.DS_Store` from them: icon view, window
   size, icon places, and the background as a Finder alias, which must name this
   volume's own IDs to show.
5. The volume gets a random volume ID and opens at its root. `dmg` from
   libdmg-hfsplus compresses it to a UDIF image, which replaces the previous one
   only when every step succeeded.

Nothing in the build clears the quarantine or touches Gatekeeper.

`scripts/mac-tools.sh` fetches and builds the tools into
`~/.cache/claude-console-desktop/mac-tools` (`MAC_TOOLS` moves it):
- rcodesign 0.29.0, checked against its SHA-256;
- libdmg-hfsplus at a fixed commit;
- the Python packages `ds-store` and `mac-alias`.

It needs git, cmake, a C compiler with the zlib, bzip2 and OpenSSL headers, and a
Python with pip (`DMG_PYTHON`, else `python3`). `xorriso` comes from apt.
`RCODESIGN`, `XORRISO`, `HFSPLUS_TOOL`, `DMG_TOOL` and `HFSPLUS_SOURCE` point the build
at other copies.

The window's look:
- `scripts/mac-dmg-background.html` is rendered to `assets/mac-dmg-background.png`
  (760 × 560) by `scripts/make-mac-background.sh` with headless Chrome. It stops if a
  line of text is wider than the window.
- `scripts/make-mac-layout.py` with no arguments rewrites `assets/mac-dmg.DS_Store`,
  the template that reserves the layout's space in the volume.

Run them after changing the page or the layout, then rebuild.

Checks:
- `npm test` covers the image logic on made-up volumes.
- `node test/mac-dmg-roundtrip.js` unpacks the built image and compares it with the
  signed app: every file, mode and symlink, the layout against the volume's catalog,
  the volume headers and the signature hashes.

On a Mac, the authority is
`hdiutil verify` and `codesign --verify --deep --strict` on the mounted image, and a
look at the window.

## Local settings: `config.json` and your own icon

Settings of your own do not belong in the repository. They go in `config.json` at the
top of the checkout, which git ignores (`config.example.json` is the template):

```json
{
  "urls": ["http://192.168.1.10:7703/", "https://console.example.ts.net:7703/"],
  "updateKey": "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----",
  "electronMirror": "https://npmmirror.com/mirrors/electron/"
}
```

- `urls`: the console addresses the app tries in order when none was chosen in
  **Server…**.
- `updateKey`: the public key updates must be signed with; `scripts/make-update-key.sh`
  writes it (see Updates).
- `electronMirror`: where the build scripts download Electron from, when
  `ELECTRON_MIRROR` is not set.

npm's own settings, such as a registry mirror, go in `.npmrc`, which git ignores too. Running from the
checkout reads the file directly; `scripts/stage.sh` copies it into every package
and update built from this checkout. A build without the file has no addresses and
asks on first start where the console runs, offering this computer first.

Your own icon: an `icon.png` (1024 px) and an `icon.icns` in `assets/local/`, which git
also ignores, replace the repository's icon in packages and updates built from this
checkout, in the menu entry of `scripts/install-linux.sh`, and in the window when the
app runs from the checkout.

To hand a package to someone else, build it with `--public`:
`scripts/build-mac.sh --public` or `scripts/build-linux.sh --public` leave
`config.json` and your own icon out, whatever the checkout has, and write to
`dist/public/`. Such a package has no server addresses and no update key.

## Files

| File | Holds |
|---|---|
| `config.json` | your server addresses; local, ignored by git (template: `config.example.json`) |
| `loader.js` | the entry point: starts the newest trusted update, else the built-in code |
| `bundle-pick.js` | which update to run, and whether it may be trusted (the public key) |
| `updater.js` | checks the console, downloads and checks an update, restarts into it |
| `localserver.js` | "This computer": the Python environment, starting and stopping the console and file manager |
| `server-requirements.txt` | the Python packages for them; `scripts/stage-server.sh` copies their code into a package |
| `main.js` | window, link routing, logins, downloads, permissions, context menu, keys, menu |
| `shell/index.html`, `shell.css`, `shell.js` | the window's own page: console `<webview>`, side pane with tabs, splitter, find bar, dialogs |
| `preload-shell.js` | the calls the window's page may make to `main.js` |
| `preload-guest.js` | runs in the console and file manager pages: reports the header colours, mouse back / forward; `window.ClaudeConsoleDesktop` for Settings → About |
| `assets/icon.png`, `icon.icns` | the app icon, a pixel C and a cursor as clay blocks, rendered in 3D by `scripts/make-icons.py` (numpy, Pillow) |
| `assets/local/` | your own icon for your own builds; local, ignored by git |
| `scripts/install-linux.sh`, `build-mac.sh`, `mac-Info.plist` | install and packaging |
| `scripts/mac-dmg.js`, `hfs-layout-meta.c`, `make-mac-layout.py`, `mac-tools.sh` | the macOS disk image |
| `scripts/mac-dmg-background.html`, `make-mac-background.sh`; `assets/mac-dmg-*` | the disk image window: background page and image, layout template |
| `scripts/build-linux.sh`, `linux-install.sh` | the Linux package and its `install.sh` |
| `scripts/stage.sh`, `publish.sh`, `make-update-key.sh` | the app's code as an update, signed, on the console |
| `test/` | `npm test`; `e2e_update.py`, `e2e_config.py`, `e2e_local.py` (this computer, with the real servers); `mac-dmg-roundtrip.js` (with `mac-layout-check.py`, `mac-signatures.py`) |

`CCD_DEBUG=1` prints the keys `main.js` handles and the context menus it opens.

## License

MIT, see [LICENSE](LICENSE). The packages also carry Electron, and the code of
Claude Console and of the web file manager with the libraries they use, each under
its own license: see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

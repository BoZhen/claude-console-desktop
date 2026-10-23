#!/usr/bin/env bash
# Publishes the app's current code on the console as an update: an asar archive,
# signed with the key from scripts/make-update-key.sh, in
# ~/.local/share/claude-console/desktop (the console serves api/desktop/latest and
# api/desktop/bundle/<version>). Installed apps pick it up at their next check.
#   scripts/publish.sh ["what changed"]     the note defaults to the last commit's subject
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP"
KEY="${CCD_UPDATE_KEY:-$HOME/.config/claude-console-desktop/update-signing-key.pem}"
DEST="${CLAUDE_CONSOLE_DESKTOP_DIR:-$HOME/.local/share/claude-console/desktop}"
[ -f "$KEY" ] || { echo "no signing key: run scripts/make-update-key.sh" >&2; exit 1; }
VERSION="${CCD_VERSION:-$(date +%Y.%m.%d.%H%M)}"   # CCD_VERSION: tests only
NOTES="${1:-$(git log -1 --format=%s 2>/dev/null || true)}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
scripts/stage.sh "$TMP/app" "$VERSION"
node_modules/.bin/asar pack "$TMP/app" "$TMP/bundle.asar"
mkdir -p "$DEST"
# The bundle first, then latest.json, each under a temporary name and renamed, so
# the console never offers a bundle that is not completely there.
cp "$TMP/bundle.asar" "$DEST/.claude-console-desktop-$VERSION.asar.part"
mv "$DEST/.claude-console-desktop-$VERSION.asar.part" "$DEST/claude-console-desktop-$VERSION.asar"
KEY="$KEY" DEST="$DEST" VERSION="$VERSION" NOTES="$NOTES" APP="$APP" node -e '
const fs = require("fs"), crypto = require("crypto"), path = require("path"), e = process.env;
const file = path.join(e.DEST, `claude-console-desktop-${e.VERSION}.asar`);
const data = fs.readFileSync(file);
const electron = Number(require(path.join(e.APP, "node_modules/electron/package.json")).version.split(".")[0]);
const m = { version: e.VERSION, size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex"),
  signature: crypto.sign(null, data, fs.readFileSync(e.KEY)).toString("base64"), electron, notes: e.NOTES,
  published: new Date().toISOString().replace(/\.\d+Z$/, "+00:00") };
fs.writeFileSync(path.join(e.DEST, ".latest.json.part"), JSON.stringify(m, null, 1));
console.log(`published ${m.version} (${(data.length / 1024).toFixed(0)} KB, sha256 ${m.sha256.slice(0, 12)}…, Electron ${electron})`);'
mv "$DEST/.latest.json.part" "$DEST/latest.json"
# only the newest bundle is served; older ones here are build output
find "$DEST" -maxdepth 1 -name 'claude-console-desktop-*.asar' ! -name "claude-console-desktop-$VERSION.asar" -delete

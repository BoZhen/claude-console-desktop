#!/usr/bin/env bash
# Builds the Linux packages for x86-64 computers, the same app in both:
#   dist/Claude-Console-linux-x64.tar.gz    the app (Electron and its code) with install.sh
#     and icons. On the other computer:
#     tar xzf Claude-Console-linux-x64.tar.gz && claude-console-linux-x64/install.sh
#   dist/claude-console_<version>_amd64.deb for Ubuntu, Debian and the like
#     (scripts/linux-deb.sh): sudo apt install ./claude-console_<version>_amd64.deb
# After that it updates its code from the console (scripts/publish.sh).
#   scripts/build-linux.sh --public    to hand out: without config.json (your server
#                                      addresses), in dist/public
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP"
DIST=dist
if [ "${1:-}" = "--public" ]; then export CCD_PUBLIC=1; DIST=dist/public; fi
# where Electron is downloaded from: ELECTRON_MIRROR, else config.json's "electronMirror",
# else Electron's own default
if [ -z "${ELECTRON_MIRROR:-}" ] && [ -f config.json ]; then
  ELECTRON_MIRROR="$(node -p 'require("./config.json").electronMirror || ""')"
  if [ -n "$ELECTRON_MIRROR" ]; then export ELECTRON_MIRROR; else unset ELECTRON_MIRROR; fi
fi
VERSION="${CCD_VERSION:-$(date +%Y.%m.%d.%H%M)}"   # CCD_VERSION: tests only
ELECTRON="$(node -p 'require("./node_modules/electron/package.json").version')"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
scripts/stage.sh "$TMP/app" "$VERSION" --with-loader
# the console and file manager the app runs on "This computer" (localserver.js)
scripts/stage-server.sh "$TMP/server"
npx electron-packager "$TMP/app" "Claude Console" \
  --platform=linux --arch=x64 --executable-name=claude-console \
  --electron-version="$ELECTRON" --app-version="$(node -p 'require("./package.json").version')" \
  --extra-resource="$TMP/server" \
  --asar --overwrite --out="$TMP/out" --quiet
# the app icon: assets/local/ (your own, git-ignored) if there is one, except in a
# public build; else the repository's (scripts/make-icons.py)
ICONS=assets
if [ -z "${CCD_PUBLIC:-}" ] && [ -f assets/local/icon.png ]; then ICONS=assets/local; fi
PKG="$TMP/claude-console-linux-x64"
mkdir -p "$PKG/icons"
mv "$TMP/out/Claude Console-linux-x64" "$PKG/app"
cp scripts/linux-install.sh "$PKG/install.sh"
for s in 16 24 32 48 64 128 256 512; do convert "$ICONS/icon.png" -resize "${s}x${s}" "$PKG/icons/claude-console-$s.png"; done
mkdir -p "$DIST"
tar czf "$DIST/Claude-Console-linux-x64.tar.gz" -C "$TMP" claude-console-linux-x64
echo "built $DIST/Claude-Console-linux-x64.tar.gz ($(du -h "$DIST/Claude-Console-linux-x64.tar.gz" | cut -f1)), code $VERSION, Electron $ELECTRON"
deb="$(scripts/linux-deb.sh "$PKG" "$DIST" "$(node -p 'require("./package.json").version')")"
echo "built ${deb#"$APP/"} ($(du -h "$deb" | cut -f1))"

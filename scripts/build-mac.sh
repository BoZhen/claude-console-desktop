#!/usr/bin/env bash
# Builds "Claude Console.app" for Apple silicon Macs on this Linux machine, signs it
# ad hoc and puts it in a disk image to drag into Applications:
# dist/Claude-Console-mac-arm64.dmg
#
#   scripts/build-mac.sh
#   scripts/build-mac.sh --public              to hand out: without config.json (your
#                                              server addresses), in dist/public
#   ARCHS="arm64 x64" scripts/build-mac.sh     also an Intel build
#
# Electron for macOS is downloaded as ELECTRON_MIRROR or config.json says. The disk image needs
# xorriso and the tools scripts/mac-tools.sh builds once (see scripts/mac-dmg.js).
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
VERSION="$(node -p 'require("./package.json").version')"
ELECTRON="$(node -p 'require("./node_modules/electron/package.json").version')"
# the app's code with the loader, as scripts/stage.sh lays it out; it updates itself
# from the console afterwards (scripts/publish.sh)
CODE_VERSION="${CCD_VERSION:-$(date +%Y.%m.%d.%H%M)}"   # CCD_VERSION: tests only
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
scripts/stage.sh "$STAGE/app" "$CODE_VERSION" --with-loader
# the console and file manager the app runs on "This computer" (localserver.js)
scripts/stage-server.sh "$STAGE/server"
# the app icon: assets/local/ (your own, git-ignored) if there is one, except in a
# public build; else the repository's (scripts/make-icons.py)
ICONS=assets
if [ -z "${CCD_PUBLIC:-}" ] && [ -f assets/local/icon.png ]; then ICONS=assets/local; fi
mkdir -p "$DIST"
for arch in ${ARCHS:-arm64}; do
  npx electron-packager "$STAGE/app" "Claude Console" \
    --platform=darwin --arch="$arch" \
    --electron-version="$ELECTRON" \
    --icon="$ICONS/icon.icns" \
    --app-bundle-id=com.bozhen.claudeconsole \
    --app-version="$VERSION" \
    --extend-info=scripts/mac-Info.plist \
    --extra-resource="$STAGE/server" \
    --asar --overwrite --out="$DIST" --quiet
  dmg="$(node scripts/mac-dmg.js "$DIST/Claude Console-darwin-$arch" "$arch")"
  echo "built ${dmg#"$APP/"} ($(du -h "$dmg" | cut -f1)), code $CODE_VERSION"
done

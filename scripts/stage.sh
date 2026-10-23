#!/usr/bin/env bash
# Copies the app's own code into OUT with bundle.json naming VERSION. That copy is
# what an update carries (scripts/publish.sh) and what a package installs as its
# built-in code (build-linux.sh, build-mac.sh, with --with-loader).
#   scripts/stage.sh OUT VERSION [--with-loader]
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$1"; VERSION="$2"; WITH_LOADER="${3:-}"
ELECTRON_MAJOR="$(node -p 'require(process.argv[1]).version.split(".")[0]' "$APP/node_modules/electron/package.json")"
rm -rf "$OUT"; mkdir -p "$OUT/assets"
# the app's code: what main.js loads, and the update logic
cp "$APP"/{main.js,updater.js,bundle-pick.js,localserver.js,preload-guest.js,preload-shell.js} "$OUT/"
cp -r "$APP/shell" "$OUT/shell"
# the local server addresses (git-ignored; see config.example.json): a build without
# the file has none and asks on first start where the console runs. CCD_PUBLIC=1
# (build-mac.sh / build-linux.sh --public, a build to hand out) leaves it out.
if [ -n "${CCD_PUBLIC:-}" ]; then
  echo "stage: public build, without config.json" >&2
elif [ -f "$APP/config.json" ]; then
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$APP/config.json"
  cp "$APP/config.json" "$OUT/"
  echo "stage: includes config.json (local server addresses)" >&2
fi
# the window icon: your own (assets/local, git-ignored) unless this is a public build
if [ -z "${CCD_PUBLIC:-}" ] && [ -f "$APP/assets/local/icon.png" ]; then
  cp "$APP/assets/local/icon.png" "$OUT/assets/icon.png"
  echo "stage: your own icon (assets/local)" >&2
else
  cp "$APP/assets/icon.png" "$OUT/assets/icon.png"
fi
printf '{"version": "%s", "electron": %s}\n' "$VERSION" "$ELECTRON_MAJOR" > "$OUT/bundle.json"
if [ "$WITH_LOADER" = "--with-loader" ]; then
  # a package: the loader is its entry point (package.json "main")
  cp "$APP/loader.js" "$APP/package.json" "$OUT/"
fi

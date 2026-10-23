#!/usr/bin/env bash
# Copies the code of the two servers the app runs on "This computer" (localserver.js)
# into OUT, which build-mac.sh and build-linux.sh put in the package's resources:
#
#   OUT/console/   claude_console.py, faster_whisper_worker.py, static/   (claude-console)
#   OUT/webfm/     web_file_manager.py, pdfjs/, mathjax/                (web-file-manager)
#   OUT/requirements.txt   the Python packages (server-requirements.txt)
#   OUT/SOURCE.json        the commit of each, and whether it had changes
#
#   scripts/stage-server.sh OUT
#
# From the checkouts beside this one, or CLAUDE_CONSOLE_DIR and WEBFM_DIR. Only files
# git tracks are copied (as they are in the working tree), so no caches or settings.
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$1"
CONSOLE="${CLAUDE_CONSOLE_DIR:-$APP/../claude-console}"
WEBFM="${WEBFM_DIR:-$APP/../web-file-manager}"
for f in "$CONSOLE/claude_console.py" "$WEBFM/web_file_manager.py"; do
  [ -f "$f" ] || { echo "stage-server: $f is missing (set CLAUDE_CONSOLE_DIR / WEBFM_DIR)" >&2; exit 1; }
done
rm -rf "$OUT"; mkdir -p "$OUT/console" "$OUT/webfm"

# copy the tracked files under the given paths, keeping their folders
copy() {   # repo, destination, paths…
  local repo="$1" dest="$2"; shift 2
  # tar rather than cp --parents, which macOS's cp does not have
  git -C "$repo" ls-files -z -- "$@" | tar -C "$repo" --null -T - -cf - | tar -C "$dest" -xf -
}
copy "$CONSOLE" "$OUT/console" claude_console.py faster_whisper_worker.py static LICENSE
copy "$WEBFM" "$OUT/webfm" web_file_manager.py pdfjs mathjax LICENSE
cp "$APP/server-requirements.txt" "$OUT/requirements.txt"

state() {   # repo → {"commit": "...", "changes": true|false}
  local changes=false
  [ -n "$(git -C "$1" status --porcelain --untracked-files=no)" ] && changes=true
  printf '{"commit": "%s", "changes": %s}' "$(git -C "$1" rev-parse --short HEAD)" "$changes"
}
printf '{"console": %s, "webfm": %s}\n' "$(state "$CONSOLE")" "$(state "$WEBFM")" > "$OUT/SOURCE.json"
echo "stage-server: console $(state "$CONSOLE"), webfm $(state "$WEBFM"), $(du -sh "$OUT" | cut -f1)" >&2

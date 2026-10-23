#!/usr/bin/env bash
# Installs Claude Console for this user from the folder this script is in:
# the app in ~/.local/opt/claude-console, a menu entry and icons, and where Ubuntu
# restricts user namespaces (23.10 and later) an AppArmor profile, which needs sudo.
#   ./install.sh            install, or replace an older install
#   ./install.sh --remove   uninstall (your settings in ~/.config/Claude Console stay)
# The app then updates its own code from the console.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.local/opt/claude-console"
BIN="$DEST/claude-console"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
DESKTOP="$DATA/applications/claude-console.desktop"
ICONS="$DATA/icons/hicolor"
PROFILE=/etc/apparmor.d/claude-console
as_root() { if [ -n "${SUDO_ASKPASS:-}" ] && [ -x "${SUDO_ASKPASS:-}" ]; then sudo -A "$@"; else sudo "$@"; fi; }
refresh_menu() {
  update-desktop-database "$DATA/applications" 2>/dev/null || true
  gtk-update-icon-cache -q -t "$ICONS" 2>/dev/null || true
  if command -v kbuildsycoca6 >/dev/null; then kbuildsycoca6 >/dev/null 2>&1 || true; fi
}
if [ "${1:-}" = "--remove" ]; then
  rm -rf "$DEST" "$DESKTOP" "$ICONS/scalable/apps/claude-console.svg"
  for s in 16 24 32 48 64 128 256 512; do rm -f "$ICONS/${s}x${s}/apps/claude-console.png"; done
  refresh_menu
  if [ -f "$PROFILE" ]; then as_root sh -c "apparmor_parser -R '$PROFILE' 2>/dev/null; rm -f '$PROFILE'"; fi
  echo "removed"; exit 0
fi
[ -x "$HERE/app/claude-console" ] || { echo "the app is not next to this script" >&2; exit 1; }
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST.new"; cp -a "$HERE/app" "$DEST.new"; rm -rf "$DEST"; mv "$DEST.new" "$DEST"
# an earlier package installed an SVG icon, which the desktop would prefer to these
rm -f "$ICONS/scalable/apps/claude-console.svg"
for s in 16 24 32 48 64 128 256 512; do install -Dm644 "$HERE/icons/claude-console-$s.png" "$ICONS/${s}x${s}/apps/claude-console.png"; done
mkdir -p "$(dirname "$DESKTOP")"
cat > "$DESKTOP" <<DESK
[Desktop Entry]
Type=Application
Name=Claude Console
Comment=Claude Console and the web file manager in one window
Exec="$BIN" %U
Icon=claude-console
Terminal=false
Categories=Development;Utility;
StartupWMClass=claude-console
StartupNotify=true
DESK
refresh_menu
echo "installed $DEST; menu entry $DESKTOP"
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" != 1 ]; then exit 0; fi
if [ -f "$PROFILE" ] && grep -qF "$BIN" "$PROFILE"; then exit 0; fi
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
cat > "$tmp" <<PROF
# Written by Claude Console's install.sh. Lets the app (Electron) create the user
# namespaces Chromium's sandbox uses; like /etc/apparmor.d/code, it allows the rest.
abi <abi/4.0>,
include <tunables/global>

profile claude-console $BIN flags=(unconfined) {
  userns,
  include if exists <local/claude-console>
}
PROF
echo "This Linux restricts user namespaces: installing $PROFILE (sudo asks for your password)"
as_root sh -c "install -m644 '$tmp' '$PROFILE' && apparmor_parser -r '$PROFILE'"
echo "AppArmor profile loaded"

#!/usr/bin/env bash
# Adds Claude Console to this user's desktop menu (KDE, GNOME, …) and lets Chromium's
# sandbox run on Ubuntu 23.10+.
#
#   scripts/install-linux.sh             menu entry, icons, AppArmor profile (asks for sudo once)
#   scripts/install-linux.sh --no-sudo   menu entry and icons only
#   scripts/install-linux.sh --remove    take them away again
#
# Why the AppArmor profile: Ubuntu lets a program create user namespaces only if an
# AppArmor profile allows it (kernel.apparmor_restrict_unprivileged_userns = 1).
# Chromium's sandbox needs them; without the profile Electron stops at start with
# "The SUID sandbox helper binary was found, but is not configured correctly".
# The profile is the same kind Ubuntu ships for VS Code (/etc/apparmor.d/code):
# unconfined, plus `userns`, for this one Electron binary.
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON="$APP/node_modules/electron/dist/electron"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
DESKTOP="$DATA/applications/claude-console.desktop"
ICONS="$DATA/icons/hicolor"
PROFILE=/etc/apparmor.d/claude-console-desktop
export SUDO_ASKPASS="${SUDO_ASKPASS:-/usr/bin/ksshaskpass}"

refresh_menu() {
  update-desktop-database "$DATA/applications" 2>/dev/null || true
  gtk-update-icon-cache -q -t "$ICONS" 2>/dev/null || true
  if command -v kbuildsycoca6 >/dev/null; then kbuildsycoca6 >/dev/null 2>&1 || true; fi
}

if [ "${1:-}" = "--remove" ]; then
  rm -f "$DESKTOP" "$ICONS/scalable/apps/claude-console.svg"
  for s in 16 24 32 48 64 128 256 512; do rm -f "$ICONS/${s}x${s}/apps/claude-console.png"; done
  refresh_menu
  if [ -f "$PROFILE" ]; then
    sudo -A sh -c "apparmor_parser -R '$PROFILE' 2>/dev/null; rm -f '$PROFILE'"
  fi
  echo "removed"
  exit 0
fi

if [ ! -x "$ELECTRON" ]; then
  echo "Electron is not downloaded yet. In $APP run:" >&2
  echo "  npm install && node node_modules/electron/install.js" >&2
  exit 1
fi

# icons: PNGs in the sizes menus and taskbars ask for, from your own icon
# (assets/local, git-ignored) if there is one. An earlier version installed an SVG,
# which the desktop would prefer to these.
ICON_SRC="$APP/assets/icon.png"
if [ -f "$APP/assets/local/icon.png" ]; then ICON_SRC="$APP/assets/local/icon.png"; fi
rm -f "$ICONS/scalable/apps/claude-console.svg"
for s in 16 24 32 48 64 128 256 512; do
  mkdir -p "$ICONS/${s}x${s}/apps"
  convert "$ICON_SRC" -resize "${s}x${s}" "$ICONS/${s}x${s}/apps/claude-console.png"
done

# menu entry; StartupWMClass matches the window's WM_CLASS so the taskbar groups it
mkdir -p "$(dirname "$DESKTOP")"
cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Claude Console
Comment=Claude Console and the web file manager in one window
Exec="$ELECTRON" "$APP" %U
Icon=claude-console
Terminal=false
Categories=Development;Utility;
StartupWMClass=claude-console
StartupNotify=true
EOF
refresh_menu
echo "menu entry: $DESKTOP"

if [ "${1:-}" = "--no-sudo" ]; then exit 0; fi
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" != 1 ]; then
  echo "user namespaces are not restricted here: no AppArmor profile needed"
  exit 0
fi
if [ -f "$PROFILE" ] && grep -qF "$ELECTRON" "$PROFILE"; then
  echo "AppArmor profile already in place: $PROFILE"
  exit 0
fi
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
cat > "$tmp" <<EOF
# Written by $APP/scripts/install-linux.sh.
# Lets the Claude Console desktop app (Electron) create the user namespaces
# Chromium's sandbox uses. Like /etc/apparmor.d/code, it allows everything else.

abi <abi/4.0>,
include <tunables/global>

profile claude-console-desktop $ELECTRON flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/claude-console-desktop>
}
EOF
echo "installing $PROFILE (sudo asks for your password in a dialog)"
sudo -A sh -c "install -m644 '$tmp' '$PROFILE' && apparmor_parser -r '$PROFILE'"
echo "AppArmor profile loaded"

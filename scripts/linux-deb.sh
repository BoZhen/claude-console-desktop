#!/usr/bin/env bash
# Makes the Debian package (Ubuntu, Debian, KDE neon, Linux Mint and the like) from
# the folder build-linux.sh puts together:
#
#   scripts/linux-deb.sh PKG OUT VERSION
#
# PKG holds app/ (the packaged app) and icons/claude-console-<size>.png; the result is
# OUT/claude-console_VERSION_amd64.deb, with
#   /opt/claude-console/              the app. chrome-sandbox is setuid root (Chrome's and
#                                     VS Code's packages do the same): where Ubuntu
#                                     restricts user namespaces, Chromium's sandbox runs
#                                     through it.
#   /usr/bin/claude-console           a link to the app
#   /usr/share/applications/claude-console.desktop, icons under /usr/share/icons/hicolor
#
#   sudo apt install ./claude-console_VERSION_amd64.deb      install or upgrade
#   sudo apt remove claude-console                           uninstall (settings in
#                                                            ~/.config/Claude Console stay)
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$1"; OUT="$2"; VERSION="$3"
[ -x "$PKG/app/claude-console" ] || { echo "linux-deb: no app in $PKG/app" >&2; exit 1; }
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT
chmod 755 "$ROOT"
install -d -m755 "$ROOT/DEBIAN" "$ROOT/opt" "$ROOT/usr/bin" "$ROOT/usr/share/applications" \
  "$ROOT/usr/share/doc/claude-console"
cp -a "$PKG/app" "$ROOT/opt/claude-console"
# the packager leaves its own modes (a 700 top folder, group-writable folders): folders
# 755, programs 755, the rest 644
find "$ROOT/opt/claude-console" -type d -exec chmod 755 {} +
find "$ROOT/opt/claude-console" -type f -perm /111 -exec chmod 755 {} +
find "$ROOT/opt/claude-console" -type f ! -perm /111 -exec chmod 644 {} +
find "$ROOT/opt/claude-console" -maxdepth 1 -type f -name '*.so*' -exec chmod 644 {} +   # loaded, not run
chmod 4755 "$ROOT/opt/claude-console/chrome-sandbox"
ln -s /opt/claude-console/claude-console "$ROOT/usr/bin/claude-console"
for s in 16 24 32 48 64 128 256 512; do
  install -D -m644 "$PKG/icons/claude-console-$s.png" "$ROOT/usr/share/icons/hicolor/${s}x${s}/apps/claude-console.png"
done
cat > "$ROOT/usr/share/applications/claude-console.desktop" <<'DESK'
[Desktop Entry]
Type=Application
Name=Claude Console
Comment=Claude Console and the web file manager in one window
Exec=/opt/claude-console/claude-console %U
Icon=claude-console
Terminal=false
Categories=Development;Utility;
StartupWMClass=claude-console
StartupNotify=true
DESK
chmod 644 "$ROOT/usr/share/applications/claude-console.desktop"
{
  echo "Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/"
  echo "Upstream-Name: claude-console-desktop"
  echo "Source: https://github.com/BoZhen/claude-console-desktop"
  echo
  echo "Files: *"
  echo "License: MIT"
  sed 's/^$/./; s/^/ /' "$APP/LICENSE"
  echo
  echo "Comment: Electron and Chromium, in /opt/claude-console, come with their own"
  echo " licenses: /opt/claude-console/LICENSE and LICENSES.chromium.html. Claude Console"
  echo " and the web file manager (MIT) are in /opt/claude-console/resources/server."
} > "$ROOT/usr/share/doc/claude-console/copyright"
printf 'claude-console (%s) stable; urgency=medium\n\n  * Release notes: https://github.com/BoZhen/claude-console-desktop/releases\n\n -- BoZhen <8426452+BoZhen@users.noreply.github.com>  %s\n' \
  "$VERSION" "$(date -R)" | gzip -9n > "$ROOT/usr/share/doc/claude-console/changelog.gz"
chmod 644 "$ROOT/usr/share/doc/claude-console/copyright" "$ROOT/usr/share/doc/claude-console/changelog.gz"

# Depends: the libraries the app links against (objdump -p: NEEDED), by the package
# names Debian 12 and Ubuntu 22.04 use; Ubuntu 24.04's "t64" packages provide them.
# ALSA is named with its version: liboss4-salsa-asound2 also provides libasound2,
# without a version and without the ALSA functions the app needs, and on a bare
# Ubuntu 24.04 apt picks it for a plain "libasound2".
# xdg-utils opens links in the browser. Recommends: python3-venv for "This computer"
# without uv, libsecret for the stored logins, libnotify for notifications.
cat > "$ROOT/DEBIAN/control" <<CTRL
Package: claude-console
Version: $VERSION
Architecture: amd64
Maintainer: BoZhen <8426452+BoZhen@users.noreply.github.com>
Installed-Size: $(du -sk --exclude=DEBIAN "$ROOT" | cut -f1)
Depends: libasound2t64 | libasound2 (>= 1.0.17), libatk-bridge2.0-0, libatk1.0-0, libatspi2.0-0, libc6 (>= 2.25), libcairo2, libcups2, libdbus-1-3, libexpat1, libgbm1, libgcc-s1, libglib2.0-0, libgtk-3-0, libnspr4, libnss3, libpango-1.0-0, libudev1, libx11-6, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxkbcommon0, libxrandr2, xdg-utils
Recommends: python3-venv, libsecret-1-0, libnotify4
Section: devel
Priority: optional
Homepage: https://github.com/BoZhen/claude-console-desktop
Description: Claude Console and the web file manager in one window
 A desktop window for Claude Console, with the web file manager built in: file
 paths in the chat open in a side pane. The console runs on another computer,
 or on this one with its claude CLI, started and stopped by the app.
CTRL
mkdir -p "$OUT"
deb="$OUT/claude-console_${VERSION}_amd64.deb"
dpkg-deb --root-owner-group -Zxz --build "$ROOT" "$deb" >/dev/null
echo "$deb"

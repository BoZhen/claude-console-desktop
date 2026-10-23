#!/usr/bin/env bash
# Fetches and builds what scripts/mac-dmg.js needs to make the macOS disk image on
# Linux, into ~/.cache/claude-console-desktop/mac-tools (MAC_TOOLS moves it).
# Run once; it skips whatever is already there.
#
#   rcodesign 0.29.0        signs the app ad hoc (Linux cannot run Apple's codesign)
#   libdmg-hfsplus          hfsplus (edits the HFS+ volume) and dmg (compresses it to UDIF),
#                           and the libraries scripts/hfs-layout-meta.c links against
#   ds-store, mac-alias     Python, writes the Finder window layout (.DS_Store)
#
# Needs git, cmake, a C compiler, zlib, bzip2 and OpenSSL headers, and a Python with
# pip (DMG_PYTHON, else python3). xorriso, the other tool, comes from apt.
set -euo pipefail
T="${MAC_TOOLS:-$HOME/.cache/claude-console-desktop/mac-tools}"
PY="${DMG_PYTHON:-python3}"
mkdir -p "$T"

RC_VERSION=0.29.0
RC_DIR="$T/rcodesign-$RC_VERSION"
RC_NAME="apple-codesign-$RC_VERSION-x86_64-unknown-linux-musl"
RC_SHA256=dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002
if [ ! -x "$RC_DIR/$RC_NAME/rcodesign" ]; then
  mkdir -p "$RC_DIR"
  curl -fL --retry 3 -o "$RC_DIR/archive.tar.gz" \
    "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F$RC_VERSION/$RC_NAME.tar.gz"
  echo "$RC_SHA256  $RC_DIR/archive.tar.gz" | sha256sum -c --quiet
  tar xzf "$RC_DIR/archive.tar.gz" -C "$RC_DIR"
fi
echo "rcodesign: $("$RC_DIR/$RC_NAME/rcodesign" --version)"

HFS_COMMIT=e18579b391950589b9ed16ee630c54ce4319bb29
HFS="$T/libdmg-hfsplus"
if [ ! -x "$HFS/build/dmg/dmg" ] || [ ! -x "$HFS/build/hfs/hfsplus" ]; then
  [ -d "$HFS/.git" ] || git clone -q https://github.com/mozilla/libdmg-hfsplus.git "$HFS"
  git -C "$HFS" -c advice.detachedHead=false checkout -q "$HFS_COMMIT"
  cmake -S "$HFS" -B "$HFS/build" -DCMAKE_BUILD_TYPE=Release >/dev/null
  # the compiler warns a lot about this code; show it only if the build fails
  make -C "$HFS/build" -j"$(nproc)" >"$HFS/build/make.log" 2>&1 || { tail -20 "$HFS/build/make.log" >&2; exit 1; }
fi
echo "libdmg-hfsplus: $(git -C "$HFS" rev-parse --short HEAD)"

if ! PYTHONPATH="$T/python" "$PY" -c 'import ds_store, mac_alias' 2>/dev/null; then
  "$PY" -m pip install -q --target "$T/python" ds-store==1.3.3 mac-alias==2.2.3
fi
echo "ds-store, mac-alias: in $T/python"
command -v xorriso >/dev/null || echo "xorriso is missing: sudo apt install xorriso" >&2

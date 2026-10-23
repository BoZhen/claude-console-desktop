#!/usr/bin/env bash
# Renders scripts/mac-dmg-background.html to assets/mac-dmg-background.png (760 x 560)
# with headless Chrome. Run it after changing the page; the build only copies the PNG.
# Needs google-chrome (CHROME_BIN) and the Noto Sans CJK font.
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROME="${CHROME_BIN:-google-chrome}"
OUT="$APP/assets/mac-dmg-background.png"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --user-data-dir="$TMP/profile" --window-size=760,560 --virtual-time-budget=3000 \
  --screenshot="$TMP/bg.png" "file://$APP/scripts/mac-dmg-background.html" 2>/dev/null
python3 - "$TMP/bg.png" <<'EOF'
import struct, sys, zlib
data = open(sys.argv[1], 'rb').read()
assert data[:8] == b'\x89PNG\r\n\x1a\n', 'not a PNG'
w, h = struct.unpack('>II', data[16:24])
assert (w, h) == (760, 560), 'rendered at %dx%d, not 760x560' % (w, h)
# the page frames itself in red when a line is too wide; look at the top-left pixel
pos, idat = 8, b''
while pos < len(data):
    n, kind = struct.unpack('>I4s', data[pos:pos + 8])
    if kind == b'IHDR': depth, ctype = data[pos + 16], data[pos + 17]
    if kind == b'IDAT': idat += data[pos + 8:pos + 8 + n]
    pos += 12 + n
px = 4 if ctype == 6 else 3
row = zlib.decompress(idat)[1:1 + px]
assert depth == 8 and not (row[0] > 200 and row[1] < 60 and row[2] < 60), 'a line of text is wider than the window'
EOF
mv "$TMP/bg.png" "$OUT"
echo "$OUT"

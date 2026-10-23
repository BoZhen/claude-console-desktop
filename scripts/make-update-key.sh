#!/usr/bin/env bash
# Makes the Ed25519 key that signs the app's update bundles, once. The private key
# stays on this computer (owner-only), never in the repo or in a bundle. The public
# key goes into config.json as "updateKey" (git-ignored, copied into the packages you
# build), and the app loads only bundles signed with it. Prints the public key. Run
# again: writes and prints the existing one.
set -euo pipefail
KEY="${CCD_UPDATE_KEY:-$HOME/.config/claude-console-desktop/update-signing-key.pem}"
if [ ! -f "$KEY" ]; then
  mkdir -p "$(dirname "$KEY")"; chmod 700 "$(dirname "$KEY")"
  (umask 077; openssl genpkey -algorithm ed25519 -out "$KEY")
  echo "made $KEY" >&2
fi
PUB="$(openssl pkey -in "$KEY" -pubout)"
CONFIG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/config.json"
node -e '
  const fs = require("fs"), [file, key] = process.argv.slice(1);
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  cfg.updateKey = key;
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
' "$CONFIG" "$PUB"
echo "updateKey written to $CONFIG" >&2
echo "$PUB"

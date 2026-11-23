#!/bin/sh
# Install the reference emulator inside this project's private directory on macOS.
set -eu
cd "$(dirname "$0")/.."
mkdir -p private
dmg=private/dolphin-2609b-universal.dmg
app=private/Dolphin.app
if [ ! -x "$app/Contents/MacOS/Dolphin" ]; then
  curl --fail --location --retry 3 --output "$dmg" https://dl.dolphin-emu.org/releases/2609b/dolphin-2609b-universal.dmg
  echo "d7a3464ae2b71106e9bce9f53dfdbf5a6a3df2637ee8f3f78234f77653eb0a64  $dmg" | shasum -a 256 -c -
  mount=$(mktemp -d)
  trap 'hdiutil detach "$mount" -quiet; rmdir "$mount"' EXIT
  hdiutil attach -readonly -nobrowse -mountpoint "$mount" "$dmg" -quiet
  ditto "$mount/Dolphin.app" "$app"
fi
if [ "${1:-}" = "--install" ]; then exit 0; fi
"$app/Contents/MacOS/Dolphin" --user "$PWD/private/native-user" --exec "$PWD/private/reference.iso" "$@"

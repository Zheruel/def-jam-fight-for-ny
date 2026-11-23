#!/bin/sh
# Verify the staged PS2 reference without starting the emulator.
set -eu
cd "$(dirname "$0")/.."

base=private/verification/ps2
app="$base/armsx2-macos-arm64-sha[c9b6e89f34].app"
profile="$base/profile/ARMSX2"
bios=ps2-0200a-20040614.bin
config="$profile/inis/PCSX2.ini"

shasum -a 256 -c <<EOF
676ec0c5a313184b0cd476fc2d322cb0b02d6a7cec7d883743a92f3ffbdeca46  private/ps2/reference.iso
6d23d001daf2a0fa8b381a5d49f51753c36e3622d0f04be46af1a0c548be4744  $profile/bios/$bios
EOF

codesign --verify --deep --strict "$app"
printf 'Verified the ARMSX2 app signature.\n'

for setting in \
  'SetupWizardIncomplete = false' \
  "BIOS = $bios" \
  'Slot1_Enable = false' \
  'Slot2_Enable = false' \
  'EnableCheats = false' \
  'EnableWideScreenPatches = false' \
  'EnableNoInterlacingPatches = false' \
  'LoadTextureReplacements = false'; do
  if ! rg -Fqx -- "$setting" "$config"; then
    printf 'Missing reference setting %s in %s\n' "$setting" "$config" >&2
    exit 1
  fi
done
printf 'Verified the isolated emulator profile.\n'

for marker in 'BIOS Found: USA' 'Serial: SLUS-21004' 'Game CRC = 4538436F' 'PerfLog: 59.9 fps'; do
  rg -Fm1 -- "$marker" "$base/retail.log"
done

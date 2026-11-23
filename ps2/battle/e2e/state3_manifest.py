"""Test-only manifest: the Battle patch plus a boot that jumps to intro state 3.

Retail only reaches state 3 (front end restarted at the main menu) from Story screens
(Game.StartMainMenu(3) in story/charDec and story/crib). This edits the boot screen's
Game.StartMainMenu( 0 ) to ( 3 ) so the guarded path can be exercised from a cold boot:

    python3 -I ps2/battle/e2e/state3_manifest.py private/ps2-battle/state3-patch.json [--without-guard]
    node ps2/battle/e2e/explore.mjs --manifest private/ps2-battle/state3-patch.json ...

Never ship this manifest.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import battle_patch as bp  # noqa: E402

BOOT_TO_STATE_3 = bp.VivStringPatch(
    id="test-boot-to-state-3",
    file=bp.SCREENS_PATH,
    entry="screens/intMain/bootLoad.big",
    entry_sha256="",
    edits=((b"Game.StartMainMenu( 0 )", b"Game.StartMainMenu( 3 )"),),
    patched_entry_sha256="",
    description="TEST ONLY: boot straight into intro state 3.",
)

if __name__ == "__main__":
    disc = bp.Disc(str(bp.DEFAULT_ISO))
    offset, size = disc.viv_entry(BOOT_TO_STATE_3.file, BOOT_TO_STATE_3.entry)
    blob = disc.read(BOOT_TO_STATE_3.file, offset, size)
    patch = bp.VivStringPatch(**{**BOOT_TO_STATE_3.__dict__, "entry_sha256": bp.sha256(blob)})
    disc.close()
    bp.PATCHES.append(patch)
    if "--without-guard" in sys.argv:  # baseline: show where retail lands
        bp.PATCHES[:] = [p for p in bp.PATCHES if p.id != "front-end-restart-at-match-type"]
    data = bp.manifest(str(bp.DEFAULT_ISO))
    data["testOnly"] = True
    with open(sys.argv[1], "w") as f:
        json.dump(data, f, indent=2)
    print(sys.argv[1], [p["id"] for p in data["patches"]])

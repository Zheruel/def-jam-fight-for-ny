# PlayStation 2 retail reference

Run `sh verification/check-ps2-reference.sh` on macOS to validate the staged disc, firmware, signed emulator, and isolated profile without opening any windows.

The USA retail ISO is `private/ps2/reference.iso`. The native boot used ARMSX2 build `c9b6e89f34`, a PCSX2 fork with an Apple Silicon recompiler, and the USA v2.00 BIOS. The boot log identifies `SLUS-21004`, game ELF CRC `4538436F`, and 59.9 FPS. Both memory card slots, cheats, widescreen patches, deinterlacing patches, and texture replacements are disabled in the isolated profile. [ARMSX2 build](https://github.com/ARMSX2/ARMSX2/releases/tag/nightly-20261122) · [PCSX2 game record](https://wiki.pcsx2.net/SLPM-66463)

The boot log and startup screenshot are in `private/verification/ps2/`. The screenshot shows the original game’s memory card prompt. Battle footage and a `.p2m2` replay were pending when native GUI capture was stopped.

## Headless two-player match

Run `npm run setup` and `node verification/ps2-match.mjs` on a Mac with Chrome, Xcode command-line tools, and the verified disc installed. Add `--retail-menus` to run the original menus with the launcher’s disc overlays omitted for that test. The harness starts its own loopback server and two headless Chrome contexts. It saves screenshots and `report.json` under `private/verification/ps2-match/`.

The harness assigns both human players, selects Blaze and Doc, and starts a standard One on One match at Foundation. It waits for both player names and the live match clock before sending movement and attacks. The report separates Play!'s emulated VBlank counter, its sampled GS frame counter, and the guest's WebRTC `framesDecoded`. Input readback times include the harness polling delay.

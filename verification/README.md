# Headless two-player match verification

Run `npm run setup` and `node verification/ps2-match.mjs` on a Mac with Chrome, Xcode command-line tools, and the packaged `game-assets/` directory. The harness starts its own loopback server and two headless Chrome contexts. The host opens the game automatically, and the guest opens the room form at `/?join=1`. The harness checks the package manifest hash and rejects ISO requests, file pickers, and browser dialogs.

The default run requires the title to open Battle directly. Use `--retail-menus` to follow the original menu flow with the runtime overlays disabled. The harness assigns both humans, reads the fighter cards to select Blaze and Doc, and verifies Foundation before starting a standard One on One match. It waits for both player names and the live clock before sending movement and attacks.

Screen captures and the JSON report are stored under `private/verification/ps2-match/`. The report gives separate counts for emulated VBlanks, sampled GS frames, and frames decoded by the WebRTC guest. Input readback times include the harness polling delay.

## Native retail reference

The optional `sh verification/check-ps2-reference.sh` checks the archived PS2 ISO, firmware, signed ARMSX2 build, and its isolated profile without opening a window. The prior native boot reached the game’s memory card prompt at 59.9 FPS and identified `SLUS-21004`, game ELF CRC `4538436F`, and the USA v2.00 BIOS. Its log and screenshot are in `private/verification/ps2/`. [ARMSX2 build](https://github.com/ARMSX2/ARMSX2/releases/tag/nightly-20261122) · [PCSX2 game record](https://wiki.pcsx2.net/SLPM-66463)

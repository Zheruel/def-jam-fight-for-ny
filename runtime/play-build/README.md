# Play! browser runtime

The WebAssembly runtime is [Play! 0.77-17-g1f272327](https://github.com/jpd002/Play-/tree/1f27232772e484bfb79364b751b84f41f4c87481) plus the [browser netplay patch](browser-netplay.patch). Play! uses its built-in PS2 BIOS implementation. [Play! license](LICENSE).

The patch exposes two independent DualShock 2 ports and an audio stream tapped from the emulator's OpenAL output. The browser passes each player's Standard Gamepad button bitmap and four stick axes to `_setPad(port, buttons, lX, lY, rX, rY)`. Ports are zero-based and axes range from −1 to 1. `_getPadReadback(port)` reports the button bitmap applied by the emulation thread. After initialization, `getPlayAudioStream()` exposes audio to WebRTC, `resumePlayAudio()` unlocks playback after user interaction, and `setPlayAudioMuted(true)` mutes local speakers.

## Rebuild

Activate Emscripten SDK 4.0.1 and install CMake and Ninja. Run `runtime/play-build/rebuild.sh` to check out the pinned source, apply the recorded patch, and build under `private/play-build`. The build writes `Play.js` and `Play.wasm` in `private/play-build/cmake/Source/ui_js`. Copy both files to this directory to install a rebuilt runtime.

The checked-in WASM SHA-256 is `27413601bf265e4d96658daf2a7c79ab818c911729b8e4053618545a05114dbd`.

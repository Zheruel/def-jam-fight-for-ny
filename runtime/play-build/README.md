# Play! browser runtime

The WebAssembly runtime is [Play! 0.77-17-g1f272327](https://github.com/jpd002/Play-/tree/1f27232772e484bfb79364b751b84f41f4c87481) plus patches for [browser netplay](browser-netplay.patch), [disc read caching](browser-disc-cache.patch), [WebGL sampler compatibility](browser-webgl-samplers.patch), and a [shorter disc-ready delay for this US release](../../ps2/diagnostics/browser-disk-ready.patch). Play! uses its built-in PS2 BIOS implementation. [Play! license](LICENSE).

The browser runtime exposes two independent DualShock 2 ports and an audio stream tapped from the emulator's OpenAL output. The disc reader caches 512 KiB blocks inside WebAssembly to reduce main-thread reads. The browser passes each player's Standard Gamepad button bitmap and four stick axes to `_setPad(port, buttons, lX, lY, rX, rY)`. Ports are zero-based and axes range from −1 to 1. `_getPadReadback(port)` reports the button bitmap applied by the emulation thread. `_getVblanks()` reports the VM’s own vertical blank count. After initialization, `getPlayAudioStream()` exposes audio to WebRTC, `resumePlayAudio()` unlocks playback after user interaction, and `setPlayAudioMuted(true)` mutes local speakers.

## Rebuild

Activate Emscripten SDK 4.0.1 and install CMake and Ninja. Run `runtime/play-build/rebuild.sh` to check out the pinned source, apply the recorded patches, and build under `private/play-build`. The build writes `Play.js` and `Play.wasm` in `private/play-build/cmake/Source/ui_js`. Copy both files to this directory to install a rebuilt runtime.

| Runtime file | SHA-256 |
| --- | --- |
| `Play.js` | `c0a08f61a22acc4c191a7d0feb6aee5928ad3e2c7ac0cbad155a038205c9e630` |
| `Play.wasm` | `5bf3feca75a1fc1573a44dfbde3a3063d2db6cca4ac0a359ab15e4e7818973c6` |

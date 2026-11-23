# Dolphin browser runtime

The browser executes the original GameCube game with [wasm-dolphin v0.1.1](https://github.com/dougchansan/wasm-dolphin/tree/72759cbb512b9a8e3aaaae3b6617bf28a61d3a65). The core is based on [Dolphin `e22551e`](https://github.com/dolphin-emu/dolphin/tree/e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1) with the wasm-dolphin patch series plus the [second-controller patch](patches/second-controller.patch). The patch connects a second standard controller and gives it an independent input state.

The upstream [corresponding source archive](https://github.com/dougchansan/wasm-dolphin/releases/download/v0.1.1/wasm-dolphin-corresponding-source-v0.1.1.tar.gz) and the project patch provide the C++ and Rust sources. [GPL license](LICENSE).

## Rebuild

Activate Emscripten SDK 5.0.7 and install CMake, Ninja, Rustup, and the Rust toolchain:

```sh
rustup toolchain install nightly-2026-07-10 --profile minimal --component rust-src
rustup target add --toolchain nightly-2026-07-10 wasm32-unknown-emscripten
runtime/dolphin/rebuild.sh
```

The script validates and extracts the corresponding source archive, applies the controller patch, builds the Naga shader translator, and writes the resulting JavaScript and WebAssembly in `build/dolphin/output`. To install a new build, copy both artifacts to `runtime/dolphin/cores/dolphin` and update `DEFAULT_UPSTREAM_CORE_SHA256` in `src/upstream-worker-protocol.js` with the printed WASM digest.

The game uses the WebGPU renderer and the cached interpreter. If the browser has no WebGPU implementation, the launcher uses Dolphin's software renderer. To select software rendering manually, open the launcher with `?video=software`.

#!/usr/bin/env bash
set -euo pipefail

runtime_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
build_dir=${1:-"$runtime_dir/../../build/dolphin"}
mkdir -p "$build_dir"
build_dir=$(cd -- "$build_dir" && pwd)
source_dir="$build_dir/source"
output_dir="$build_dir/output"
archive="$build_dir/wasm-dolphin-corresponding-source-v0.1.1.tar.gz"
archive_sha=c177aaa1b4df85b2aa5ba85462463ada4c3b55a154b7582016f5e9ad018e359c
archive_url=https://github.com/dougchansan/wasm-dolphin/releases/download/v0.1.1/wasm-dolphin-corresponding-source-v0.1.1.tar.gz

emcc_version=$(emcc --version)
if [[ "$emcc_version" != *"5.0.7 (263db4cffa6f9fc2ec514a70abac81362ea41849)"* ]]; then
  echo "Activate Emscripten SDK 5.0.7 before rebuilding Dolphin." >&2
  exit 1
fi
if [[ ! -f "$archive" ]]; then
  curl --fail --location --retry 2 --output "$archive.part" "$archive_url"
  mv -- "$archive.part" "$archive"
fi
printf '%s  %s\n' "$archive_sha" "$archive" | shasum -a 256 -c

mkdir -p "$source_dir" "$output_dir"
if [[ ! -f "$source_dir/upstream/dolphin_web_core.cpp" ]]; then
  tar -xzf "$archive" --strip-components=1 -C "$source_dir"
fi
patch_file="$runtime_dir/patches/second-controller.patch"
if patch --dry-run -R -s -d "$source_dir" -p1 < "$patch_file"; then
  echo "Two-controller patch is already applied."
else
  patch -s -d "$source_dir" -p1 < "$patch_file"
fi

rust_toolchain=nightly-2026-07-10
rust_target=wasm32-unknown-emscripten
(
  cd -- "$source_dir/naga-spirv-wgsl"
  cargo "+$rust_toolchain" build --locked --release --target "$rust_target"
)
naga_library="$source_dir/naga-spirv-wgsl/target/$rust_target/release/libnaga_spirv_wgsl.a"

compile_flags="-O3 -pthread -msimd128 -flto -DXXH_VECTOR=0 -DDOLPHIN_WEB_HOT_COUNTERS=0"
compile_flags+=" -DDOLPHIN_WEB_INLINE_FAST_BRANCH=1 -DDOLPHIN_WEB_FALLBACK_MAP_DIAGNOSTICS=0"
compile_flags+=" -DDOLPHIN_WEB_FALLBACK_MAP_BITS=16 -DDOLPHIN_WEB_DIRECT_WASM_BLOCK_DISPATCH=0"
disabled_options=(
  USE_SYSTEM_LIBS ENABLE_QT ENABLE_NOGUI ENABLE_CLI_TOOL ENABLE_HEADLESS
  ENABLE_ALSA ENABLE_PULSEAUDIO ENABLE_CUBEB ENABLE_X11 ENABLE_EGL ENABLE_SDL
  ENABLE_VULKAN ENABLE_LLVM ENABLE_TESTS USE_UPNP USE_DISCORD_PRESENCE USE_MGBA
  USE_RETRO_ACHIEVEMENTS ENABLE_AUTOUPDATE ENABLE_ANALYTICS ENCODE_FRAMEDUMPS
  WITH_OPTIM WITH_SSE2 WITH_SSSE3 WITH_SSE41 WITH_SSE42 WITH_PCLMULQDQ
  WITH_AVX2 WITH_AVX512 WITH_AVX512VNNI WITH_VPCLMULQDQ
)
cmake_options=()
for option in "${disabled_options[@]}"; do
  cmake_options+=("-D$option=OFF")
done

emcmake cmake -S "$source_dir" -B "$build_dir/cmake" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_TRY_COMPILE_CONFIGURATION=Debug \
  -DENABLE_GENERIC=ON "${cmake_options[@]}" \
  "-DCMAKE_C_FLAGS:STRING=$compile_flags" "-DCMAKE_CXX_FLAGS:STRING=$compile_flags" \
  "-DCMAKE_C_FLAGS_DEBUG:STRING=-O0 -fno-lto" "-DCMAKE_CXX_FLAGS_DEBUG:STRING=-O0 -fno-lto" \
  "-DDOLPHIN_WASM_NAGA_WGSL_LIB=$naga_library" "-DDOLPHIN_WASM_MEMORY_PAGES=24576" \
  "-DDOLPHIN_WASM_JIT_CACHE_PRE_JS=$source_dir/jit-cache-prejs.js" \
  "-DDOLPHIN_WASM_BRIDGE_SOURCE=$source_dir/upstream/dolphin_web_discio.cpp" \
  "-DDOLPHIN_WASM_SHARED_SOURCE_DIR=$source_dir/upstream" \
  "-DDOLPHIN_WASM_CORE_SOURCE=$source_dir/upstream/dolphin_web_core.cpp" \
  "-DDOLPHIN_WASM_OUTPUT_DIR=$output_dir"

cmake --build "$build_dir/cmake" --target dolphin_web_core --parallel "${DOLPHIN_BUILD_JOBS:-8}"
shasum -a 256 "$output_dir/dolphin-core-upstream.js" "$output_dir/dolphin-core-upstream.wasm"
printf 'Core artifacts built in %s\n' "$output_dir"

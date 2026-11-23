#!/usr/bin/env bash
set -euo pipefail

runtime_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
build_dir=${1:-"$runtime_dir/../../private/play-build"}
mkdir -p "$build_dir"
build_dir=$(cd -- "$build_dir" && pwd)
source_dir="$build_dir/source"
commit=1f27232772e484bfb79364b751b84f41f4c87481

emcc_version=$(emcc --version)
if [[ "$emcc_version" != *"4.0.1 (89ce854a99238d04116a3d9b5afe241eec90c6c3)"* ]]; then
  echo "Activate Emscripten SDK 4.0.1 before rebuilding Play!." >&2
  exit 1
fi
if [[ ! -d "$source_dir/.git" ]]; then
  git clone --filter=blob:none --no-checkout https://github.com/jpd002/Play-.git "$source_dir"
  git -C "$source_dir" checkout --detach "$commit"
fi
if [[ "$(git -C "$source_dir" rev-parse HEAD)" != "$commit" ]]; then
  echo "The build source must be at Play! commit $commit." >&2
  exit 1
fi
git -C "$source_dir" submodule update --init --recursive --depth 1

for patch_name in browser-netplay.patch browser-disc-cache.patch; do
  patch_file="$runtime_dir/$patch_name"
  if git -C "$source_dir" apply --reverse --check "$patch_file" 2>/dev/null; then
    echo "$patch_name is already applied."
  else
    git -C "$source_dir" apply "$patch_file"
  fi
done

emcmake cmake -S "$source_dir" -B "$build_dir/cmake" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTS=OFF -DBUILD_PLAY=ON \
  -DBUILD_PSFPLAYER=OFF -DUSE_QT=OFF
cmake --build "$build_dir/cmake" --target Play --parallel "${PLAY_BUILD_JOBS:-8}"
shasum -a 256 "$build_dir/cmake/Source/ui_js/Play.js" "$build_dir/cmake/Source/ui_js/Play.wasm"

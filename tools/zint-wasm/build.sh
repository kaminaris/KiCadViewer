#!/usr/bin/env bash
set -euo pipefail

output_dir="${1:?pass the mounted output directory}"
source_dir="/workspace/kicad/thirdparty/zint"
build_dir="/workspace/build"

rm -rf "$build_dir"
emcmake cmake -S "$source_dir" -B "$build_dir" -DCMAKE_BUILD_TYPE=Release
cmake --build "$build_dir" --target zint --parallel

mkdir -p "$output_dir"
em++ /workspace/bindings.cpp "$build_dir/libzint.a" \
  -I"$source_dir" \
  -O3 \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=ZintModule \
  -sENVIRONMENT=web \
  -sFILESYSTEM=0 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_zint_encode"]' \
  -o "$output_dir/zint.mjs"

cp "$source_dir/LICENSE.GPLv3" "$output_dir/LICENSE.zint-GPLv3"

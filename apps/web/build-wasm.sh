#!/usr/bin/env bash
# Rebuild apps/web/static/irisu-wasm.{js,wasm}: the Metsu-mode portable
# simulator module. Requires the Emscripten SDK (emsdk) on PATH.
set -euo pipefail

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
if ! command -v em++ >/dev/null 2>&1; then
  echo "em++ not found; install the Emscripten SDK and source emsdk_env.sh" >&2
  exit 1
fi

cd "$root"
em++ -std=c++20 -O2 \
  -DIRISU_SINGLE_THREADED_C_API \
  -Iclone/include -Ithird_party/box2d_legacy/Include \
  -include third_party/box2d_legacy/compat/cstring_compat.h \
  --no-entry \
  -sALLOW_MEMORY_GROWTH=1 \
  -sDISABLE_EXCEPTION_CATCHING=0 \
  -sENVIRONMENT=web \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createIrisuModule \
  -sFILESYSTEM=0 \
  -sMODULARIZE=1 \
  "-sEXPORTED_FUNCTIONS=['_irisu_web_create','_irisu_web_create_mode','_irisu_web_destroy','_irisu_web_reset','_irisu_web_step','_irisu_web_step_ex']" \
  "-sEXPORTED_RUNTIME_METHODS=['cwrap']" \
  clone/core/config.cpp \
  clone/core/config_io.cpp \
  clone/core/dx_random.cpp \
  clone/core/metsu_rules.cpp \
  clone/core/normal_rules.cpp \
  clone/core/physics.cpp \
  clone/core/simulator.cpp \
  clone/bindings/c_api.cpp \
  clone/bindings/web_api.cpp \
  $(find third_party/box2d_legacy/Source -name '*.cpp') \
  -o apps/web/static/irisu-wasm.js
echo "built apps/web/static/irisu-wasm.js and irisu-wasm.wasm"

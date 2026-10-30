#!/usr/bin/env bash
# 构建全部原生组件与 TypeScript 产物
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$(pwd)"
mkdir -p bin data web logs

echo "==> [1/3] C 内核 (core/engine.c)"
gcc -O2 -std=c11 -Wall -Wextra -DNDEBUG -o bin/engine core/engine.c

echo "==> [2/3] C++ 日志服务 (journal/journald.cpp)"
g++ -O2 -std=c++17 -Wall -Wextra -DNDEBUG -o bin/journald journal/journald.cpp

echo "==> [3/3] TypeScript (server + web)"
TSC=""
if [ -x "$ROOT/node_modules/.bin/tsc" ]; then
  TSC="$ROOT/node_modules/.bin/tsc"
elif command -v tsc >/dev/null 2>&1; then
  TSC="$(command -v tsc)"
fi

if [ -z "$TSC" ]; then
  echo "!! 找不到 tsc，请先执行: npm install" >&2
  exit 1
fi

"$TSC" -p server/tsconfig.json
"$TSC" --module none --target ES2020 --lib ES2020,DOM --strict --skipLibCheck \
      --outFile web/app.js web/src/app.ts

echo "==> 构建完成"
ls -lh bin | sed 's/^/    /'

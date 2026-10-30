#!/usr/bin/env bash
# 一键启动：构建（缺失时）+ 拉起 C / C++ / Python 三个子服务 + TypeScript 网关
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -x bin/engine ] || [ ! -x bin/journald ] || [ ! -f server/dist/index.js ] || [ ! -f web/app.js ]; then
  echo "==> 首次运行，先构建"
  bash scripts/build.sh
fi

export PORT="${PORT:-3000}"
export HOST="${HOST:-0.0.0.0}"
export ANALYTICS_PORT="${ANALYTICS_PORT:-7102}"

mkdir -p data logs
exec node server/dist/index.js

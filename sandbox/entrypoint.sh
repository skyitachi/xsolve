#!/bin/bash
# CubeSandbox entrypoint wrapper
# 1. 后台启动 envd（如果存在且未运行）
# 2. exec 用户的 CMD

set -e

ENVD_PORT="${ENVD_PORT:-49983}"
ENVD_BIN="${ENVD_BIN:-/usr/bin/envd}"

# 如果系统安装了 envd 且当前端口没被占用，在后台启动 envd
if [ -x "$ENVD_BIN" ]; then
  if ! ss -tlnp | grep -q ":${ENVD_PORT} "; then
    echo "[entrypoint] Starting envd on :${ENVD_PORT}"
    "$ENVD_BIN" -port "$ENVD_PORT" >/var/log/envd.log 2>&1 &
    # 等 envd 就绪
    for i in $(seq 1 30); do
      if curl -s -o /dev/null "http://127.0.0.1:${ENVD_PORT}/health"; then
        echo "[entrypoint] envd is ready on :${ENVD_PORT}"
        break
      fi
      sleep 0.2
    done
  else
    echo "[entrypoint] envd already running on :${ENVD_PORT}"
  fi
else
  echo "[entrypoint] envd not found at ${ENVD_BIN}, skipping"
fi

# 确保数据目录存在
mkdir -p "$(dirname "${DB_PATH:-/data/xsolve.db}")"

# 执行 CMD
exec "$@"

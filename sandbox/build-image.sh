#!/bin/bash
# 构建 sandbox Docker 镜像
# 用法: ./sandbox/build-image.sh
# 类似 docker-compose 的 env_file 机制，将 .env 注入镜像
set -e

cd "$(dirname "$0")/.."

# 将 .env 复制到 sandbox/.env.docker（绕过 .dockerignore）
cp .env sandbox/.env.docker
trap 'rm -f sandbox/.env.docker' EXIT

# 构建镜像
docker build -f sandbox/Dockerfile -t localhost:5000/xsolve-sandbox:v1 .

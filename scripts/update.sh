#!/bin/bash
set -e

echo "=== xsolve 更新脚本 ==="
echo "时间: $(date "+%Y-%m-%d %H:%M:%S")"
echo ""

# 1. 停止并删除容器（named volume 不会删除，数据安全）
echo "[1/4] 停止正在运行的容器..."
docker compose down

# 2. 拉取最新代码
echo "[2/4] 拉取最新代码..."
git pull origin main

# 3. 重新构建镜像（--no-cache 确保完全重新构建）
echo "[3/4] 构建新镜像..."
docker compose build

# 4. 启动新容器
echo "[4/4] 启动新容器..."
docker compose up -d

echo ""
echo "=== 更新完成 ==="
echo "验证: curl http://localhost:8765/healthz"

# 等待几秒后自动验证
sleep 3
echo ""
echo "健康检查结果:"
curl -s http://localhost:8765/healthz 2>/dev/null || echo "⚠️  服务暂未就绪，请稍后手动检查"
echo ""
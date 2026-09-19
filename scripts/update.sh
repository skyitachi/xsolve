#!/bin/bash
set -e

echo "=== xsolve 更新脚本 ==="
echo "时间: $(date "+%Y-%m-%d %H:%M:%S")"
echo ""

# 1. 停止并删除容器（named volume 不会删除，数据安全）
echo "[1/5] 停止正在运行的容器..."
docker compose down

# 2. 拉取最新代码
echo "[2/5] 拉取最新代码..."
git pull origin main

# 3. 若启用了 HTTPS，刷新服务器证书（把最新的局域网 IP 写进 SAN）
#    必须排在 build 之前 —— 脚本会顺带把 CA 副本写进 frontend/，而 frontend/ 是 build 时
#    COPY 进镜像的；顺序反了手机就下载不到 CA，装不上证书链。
#    证书刷新失败不阻断部署（服务仍会起来，只是 HTTPS 可能不受信）。
if grep -qE '^[[:space:]]*HTTPS_ENABLED[[:space:]]*=[[:space:]]*(true|1|yes|on)[[:space:]]*$' .env 2>/dev/null; then
  echo "[3/5] 刷新 HTTPS 证书..."
  if command -v node >/dev/null 2>&1; then
    node backend/scripts/setup-lan-https.mjs --quiet || echo "⚠️  证书刷新失败，将继续使用旧证书"
  else
    echo "⚠️  未找到 node，跳过证书刷新（可改用 docker run 或手动跑该脚本）"
  fi
else
  echo "[3/5] 未启用 HTTPS（.env 里没有 HTTPS_ENABLED=true），跳过证书刷新"
fi

# 4. 重新构建镜像
echo "[4/5] 构建新镜像..."
docker compose build

# 5. 启动新容器
echo "[5/5] 启动新容器..."
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
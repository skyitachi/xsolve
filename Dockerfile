# 单阶段构建：减少内存压力，适合资源受限环境
FROM node:22

WORKDIR /app

# 配置 npm 使用国内镜像并增加超时/重试
# 若 npmmirror 不稳定可改为 https://registry.npmmirror.com
RUN npm config set registry https://registry.npmmirror.com \
    && npm config set fetch-retries 5 \
    && npm config set fetch-retry-mintimeout 30000 \
    && npm config set fetch-retry-maxtimeout 180000

# 安装编译依赖（better-sqlite3 需要）和运行时依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 限制 Node 内存，避免 npm 安装时被 OOM kill
ENV NODE_OPTIONS=--max-old-space-size=1024

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 清理编译依赖，减小镜像体积
RUN apt-get purge -y python3 make g++ \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY backend/ ./backend/
COPY frontend/ ./frontend/

VOLUME ["/data"]
ENV DB_PATH=/data/xsolve.db

# 告知 Claude Code CLI 处于沙箱环境（容器内 root 运行需要此变量）
ENV IS_SANDBOX=1

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:8765/healthz').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "backend/server.js"]

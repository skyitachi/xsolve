# =============================================================================
# 单阶段构建: 基于 cube-node22-sandbox:dev，编译并打包 xsolve
# =============================================================================

FROM cube-node22-sandbox:dev

WORKDIR /app

# 安装 better-sqlite3 需要的编译工具链（如果镜像里没有的话）
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# 先复制 package 文件，利用 Docker 缓存层
COPY package.json package-lock.json ./

# 安装依赖（better-sqlite3 会在这一步编译）
RUN npm ci --omit=dev && npm cache clean --force

# 复制 .env 配置（从 build 脚本预先放到 sandbox/.env.docker）
COPY sandbox/.env.docker ./.env

# 复制项目源码
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY sandbox/entrypoint.sh /usr/local/bin/sandbox-entrypoint.sh
RUN chmod +x /usr/local/bin/sandbox-entrypoint.sh

# 持久化数据库
VOLUME ["/data"]
ENV DB_PATH=/data/xsolve.db

# 沙箱模式标记（Claude Code CLI 在容器内 root 运行需要）
ENV IS_SANDBOX=1

# 暴露端口
# 49983: envd（Cube 就绪探测）
# 8765:  Express server
EXPOSE 49983 8765

# 入口脚本: 自动后台启动 envd，然后 exec CMD
ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint.sh"]
CMD ["node", "backend/server.js"]

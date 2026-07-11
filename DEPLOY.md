# 云端部署指南

本项目使用 `@anthropic-ai/claude-agent-sdk`，这是一个独立的 npm 包，**不依赖本地安装的 Claude Code CLI**。只要有 Node.js 环境和 API Key，就可以在任何地方运行。

## 重要前提：API 协议说明

SDK 只支持 **Anthropic Messages API 格式**（`/v1/messages`），不支持 OpenAI Chat Completions 格式。这意味着：

- 使用 Anthropic 官方 API（`https://api.anthropic.com`）→ 开箱即用
- 使用国内代理/中转 → 代理必须支持 Anthropic 协议（大多数 Claude 代理都支持）
- 视觉模块默认也走 Anthropic 协议，和主对话共用同一个 API 地址和密钥

## 配置方式：.env 文件

最简单的配置方式是使用 `.env` 文件。应用启动时会**自动读取项目根目录下的 `.env` 和 `.env.local`** 文件（不需要额外的 `--env-file` 参数或 dotenv 依赖）。

```bash
# 1. 复制示例文件
cp .env.example .env

# 2. 编辑 .env，填入你的配置
# 至少需要填 ANTHROPIC_API_KEY，用代理还需要填 ANTHROPIC_BASE_URL 和 CLAUDE_MODEL

# 3. 启动
npm start           # 本地直接运行
# 或
docker compose up -d    # Docker Compose（自动读取 .env）
```

**环境变量优先级**：命令行 `-e` 参数 / `export` 设置的变量 > `.env.local` > `.env` > 代码内默认值。即：已通过 CLI 设置的变量不会被 `.env` 文件覆盖。

注意：`.env` 文件**不会**被打包进 Docker 镜像（安全考虑），所以：
- `docker run` 时需要用 `--env-file .env` 参数
- `docker compose` 已在 `docker-compose.yml` 中配置了 `env_file: .env`，会自动读取

## 最小配置（Docker 部署）

### 方式 A：使用 .env 文件（推荐）

```bash
# 1. 准备配置
cp .env.example .env
# 编辑 .env，填入 ANTHROPIC_API_KEY、ANTHROPIC_BASE_URL、CLAUDE_MODEL

# 2. 一键启动
docker compose up -d
```

### 方式 B：命令行参数

```bash
docker build -t xsolve .

docker run -d \
  --name xsolve \
  -p 8765:8765 \
  -e ANTHROPIC_API_KEY=sk-ant-你的密钥 \
  -e CLAUDE_MODEL=claude-sonnet-4-20250514 \
  -e ANTHROPIC_BASE_URL=https://你的代理地址 \
  -v xsolve-data:/data \
  --restart unless-stopped \
  xsolve
```

或者使用 `--env-file`：
```bash
docker run -d --name xsolve -p 8765:8765 --env-file .env -v xsolve-data:/data --restart unless-stopped xsolve
```

**关键**：如果使用自定义代理（`ANTHROPIC_BASE_URL`），**必须同时设置 `CLAUDE_MODEL`**，否则 SDK 会用默认模型名 `claude-sonnet-4-6`，在你的代理上可能不存在。设置了 `CLAUDE_MODEL` 后，视觉识别会自动复用同一个模型（Claude 原生支持视觉）。

## 环境变量完整列表

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `ANTHROPIC_API_KEY` | **是** | - | API 密钥 |
| `ANTHROPIC_BASE_URL` | 否 | `https://api.anthropic.com` | 自定义 API 代理地址（必须支持 Anthropic 协议） |
| `CLAUDE_MODEL` | 自定义代理时**强烈建议** | SDK 默认 (`claude-sonnet-4-6`) | 主对话模型。设置后视觉也自动复用。常用值：`claude-sonnet-4-20250514`、`claude-sonnet-4-6`、`claude-opus-4-20250514` |
| `VISION_MODEL` | 否 | 自动选择 | 视觉模型。默认自动选择：官方 API 用 Claude Sonnet，设了 CLAUDE_MODEL 就复用。只有需要用非 Claude 视觉模型（如 Qwen-VL）时才单独设置 |
| `VISION_API_KEY` | 否 | 继承主对话模型 | 视觉子代理独立 API Key。设置后视觉调用优先使用，未设置则回退到 `ANTHROPIC_API_KEY` |
| `VISION_BASE_URL` | 否 | 继承主对话模型 | 视觉子代理独立 API 地址。设置后视觉调用优先使用，未设置则回退到 `ANTHROPIC_BASE_URL`。若指向 OpenAI 兼容接口需同时设 `VISION_API_FORMAT=openai` |
| `VISION_API_FORMAT` | 否 | `anthropic` | 视觉 API 格式：`anthropic`（默认）或 `openai`。设为 `openai` 时必须同时设置 `VISION_MODEL` 和视觉的 API Key/Base URL（`VISION_API_KEY`/`VISION_BASE_URL`，或 `OPENAI_API_KEY`/`OPENAI_BASE_URL`） |
| `VISION_MAX_TURNS` | 否 | `2` | 视觉子代理最大轮次 |
| `PORT` | 否 | `8765` | HTTP 服务端口 |
| `DB_PATH` | 否 | `./xsolve.db` | SQLite 数据库路径（Docker 中默认 `/data/xsolve.db`） |

## 启动日志说明

启动后会打印配置摘要，帮你确认配置是否正确：

```
[selflearning] http://localhost:8765
[selflearning] auth: ANTHROPIC_API_KEY (env)
[selflearning] api base: https://your-proxy.com (custom proxy)
[selflearning] chat model: claude-sonnet-4-20250514
[selflearning] vision model: claude-sonnet-4-20250514 (复用主对话模型) [anthropic format]
```

如果有配置问题，会看到警告或错误：
- `⚠️ 检测到自定义 ANTHROPIC_BASE_URL，但未设置 CLAUDE_MODEL` → 建议加上 CLAUDE_MODEL
- `❌ 未找到 API Key` → 必须设置 ANTHROPIC_API_KEY
- `❌ 使用 OpenAI 兼容格式时必须设置 VISION_MODEL` → 设了 VISION_API_FORMAT=openai 但没设模型

## 方式一：Docker 部署（推荐）

### 构建镜像

```bash
docker build -t xsolve .
```

### 运行容器

**直连 Anthropic 官方 API**（服务器能直接访问 api.anthropic.com）：

```bash
docker run -d \
  --name xsolve \
  -p 8765:8765 \
  -e ANTHROPIC_API_KEY=sk-ant-你的密钥 \
  -v xsolve-data:/data \
  --restart unless-stopped \
  xsolve
```

**使用自定义代理**（国内服务器）：

```bash
docker run -d \
  --name xsolve \
  -p 8765:8765 \
  -e ANTHROPIC_API_KEY=你的密钥 \
  -e ANTHROPIC_BASE_URL=https://你的代理地址 \
  -e CLAUDE_MODEL=claude-sonnet-4-20250514 \
  -v xsolve-data:/data \
  --restart unless-stopped \
  xsolve
```

### 验证

```bash
curl http://localhost:8765/healthz
# 返回: {"ok":true,"uptime":...,"sessions":0,"problems":...,"version":"0.1.0"}
```

浏览器打开 `http://服务器IP:8765` 即可使用。

### 使用 docker-compose（最简单）

项目已包含 [`docker-compose.yml`](computer:///Users/skyitachi/lab/xsolve/docker-compose.yml)，直接使用：

```bash
cp .env.example .env
# 编辑 .env 填入配置
docker compose up -d
```

## 方式二：直接 Node.js 运行（云主机/VPS）

### 环境要求

- Node.js >= 20
- Python 3 + make + g++（编译 better-sqlite3）

Ubuntu/Debian:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs python3 make g++
```

### 部署

```bash
cd /path/to/xsolve
npm ci --omit=dev

# 设置环境变量
export ANTHROPIC_API_KEY=sk-ant-你的密钥
# export ANTHROPIC_BASE_URL=https://你的代理地址
# export CLAUDE_MODEL=claude-sonnet-4-20250514
export PORT=8765

# 启动
node backend/server.js
```

### 使用 pm2 守护

```bash
npm install -g pm2
pm2 start backend/server.js --name xsolve \
  --env ANTHROPIC_API_KEY=sk-ant-你的密钥
# 如有代理：
# pm2 start backend/server.js --name xsolve \
#   --env ANTHROPIC_API_KEY=sk-ant-你的密钥 \
#   --env ANTHROPIC_BASE_URL=https://你的代理地址 \
#   --env CLAUDE_MODEL=claude-sonnet-4-20250514
pm2 save && pm2 startup
```

或创建 `ecosystem.config.js`：

```javascript
module.exports = {
  apps: [{
    name: 'xsolve',
    script: 'backend/server.js',
    env: {
      ANTHROPIC_API_KEY: 'sk-ant-你的密钥',
      ANTHROPIC_BASE_URL: 'https://你的代理地址',
      CLAUDE_MODEL: 'claude-sonnet-4-20250514',
      PORT: 8765
    }
  }]
};
```

## 方式三：PaaS 平台（Fly.io / Render / Railway）

### Fly.io

`fly.toml`:
```toml
app = "xsolve"
primary_region = "hkg"

[http_service]
  internal_port = 8765
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1

[env]
  PORT = "8765"
  DB_PATH = "/data/xsolve.db"
  CLAUDE_MODEL = "claude-sonnet-4-20250514"
  # ANTHROPIC_BASE_URL = "https://你的代理地址"

[mounts]
  source = "xsolve_data"
  destination = "/data"
```

```bash
fly secrets set ANTHROPIC_API_KEY=sk-ant-你的密钥
fly deploy
```

### Render / Railway

- Build Command: `npm install`
- Start Command: `node backend/server.js`
- Environment Variables:
  - `ANTHROPIC_API_KEY`: 你的密钥
  - `ANTHROPIC_BASE_URL`: 代理地址（如需）
  - `CLAUDE_MODEL`: 模型名（如用代理必须设置）
  - `PORT`: 平台自动注入，无需手动设置
- 注意：免费层文件系统是临时的，SQLite 数据重启后会丢失。需挂载持久化磁盘。

## Nginx 反向代理（HTTPS）

```nginx
server {
    listen 443 ssl http2;
    server_name xsolve.example.com;

    ssl_certificate     /etc/letsencrypt/live/xsolve.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/xsolve.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE 流式响应必需
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        chunked_transfer_encoding on;
    }
}
```

**关键**：`proxy_buffering off` 必须设置，否则 SSE 实时对话会积压。

## 常见问题

**Q: 启动报错"better_sqlite3.node was compiled against a different Node.js version"？**
A: 运行 `npm rebuild better-sqlite3` 重新编译原生模块。

**Q: 对话报错"鉴权失败"？**
A: 检查 `ANTHROPIC_API_KEY` 是否正确。用 `docker exec xsolve env | grep ANTHROPIC` 验证容器内的环境变量。

**Q: 对话报错"model not found"？**
A: 你使用了自定义代理但没设 `CLAUDE_MODEL`，SDK 用了默认模型名而代理上没有这个模型。设置 `CLAUDE_MODEL=你的代理支持的模型名`。

**Q: 图片识别报错"模型不存在"或"不支持图片"？**
A: 如果设置了 `CLAUDE_MODEL`，视觉会复用该模型（Claude 模型都支持视觉）。如果单独设置了 `VISION_MODEL`，确认该模型支持图片输入。

**Q: 为什么不支持 OpenAI 格式的代理？**
A: 主对话 SDK 只支持 Anthropic 协议。你的代理需要兼容 Anthropic Messages API 格式（大多数 Claude 中转代理都支持）。视觉模块可以单独配置 OpenAI 格式（通过 `VISION_API_FORMAT=openai`），但主对话必须用 Anthropic 格式。

**Q: 数据会丢失吗？**
A: Docker 方式挂载了 volume，数据持久化。Node 直接运行时数据在 SQLite 文件中。

**Q: 支持多用户吗？**
A: 支持。每个浏览器标签页创建独立 session，互不干扰。

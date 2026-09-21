#!/usr/bin/env bash
#
# 用「DNS-01 挑战 + deSEC 免费子域名」签发 Let's Encrypt 公信证书
#
# ─── 为什么需要这个 ────────────────────────────────────────────────────
# 默认的 setup-lan-https.mjs 生成的是**自签** CA：它签的是局域网 IP，浏览器不认，
# 所以每台设备都要手动装一次 Root CA；一旦换 Wi-Fi / 路由器重发 IP / 重刷证书，
# 又会失效（刷证书还会顺带让既有的 SPKI 白名单作废）。
#
# DNS-01 一次绕开全部：Let's Encrypt 只校验一条 DNS TXT 记录 ——
#   · 服务器不需要公网可达、不需要开 80/443、不需要公网 IP
#   · A 记录可以直接指向内网 IP（如 192.168.0.112），流量不出局域网
#   · 客户端什么都不用装，系统信任库天然信任 Let's Encrypt
#
# ─── 为什么证书放 certs/acme/ 子目录（关键设计）──────────────────────
# setup-lan-https.mjs 只写 certs/ 顶层（xsolve-key.pem / xsolve.pem）与
# frontend/xsolve-ca.*，从不下探子目录。把真证书放 certs/acme/ 即实现路径隔离：
# scripts/update.sh 里那句「build 前刷新自签证书」照旧执行，但**碰不到真证书**，
# 因此部署脚本一行都不用改。docker-compose.yml 挂载的是整个 ./certs，子目录自动可见。
#
# ─── 用法 ─────────────────────────────────────────────────────────────
#   1) 到 https://desec.io 注册（免费），建一个子域名，如 xsolve-abc.dedyn.io，
#      在 TOKEN MANAGEMENT 生成 API token，并给该域名加一条 A 记录指向 NAS 内网 IP
#      （192.168.0.112）。A 记录填内网 IP 是刻意为之，不影响 DNS-01 验证。
#   2) 在 NAS 的仓库根目录执行：
#        export DEDYN_DOMAIN=xsolve-abc.dedyn.io
#        export DEDYN_TOKEN=<你的 deSEC API token>
#        bash backend/scripts/setup-acme-cert.sh
#   3) 按脚本末尾输出的提示，把 HTTPS_KEY / HTTPS_CERT 写进 .env 并重启容器。
#
# 环境变量：
#   DEDYN_DOMAIN  必需，已解析到本机内网 IP 的域名
#   DEDYN_TOKEN   必需，deSEC API token
#   ACME_EMAIL    可选，证书到期提醒邮箱
#   ACME_DNS      可选，acme.sh 的 dnsapi 插件名，默认 dns_desec
#   CONTAINER_NAME 可选，默认 xsolve
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ACME_HOME="${ACME_HOME:-$HOME/.acme.sh}"
CERT_DIR="$REPO_ROOT/certs/acme"
CONTAINER_NAME="${CONTAINER_NAME:-xsolve}"
ACME_DNS="${ACME_DNS:-dns_desec}"
ACME_EMAIL="${ACME_EMAIL:-}"

DOMAIN="${DEDYN_DOMAIN:-}"
TOKEN="${DEDYN_TOKEN:-}"

say() { printf '%s\n' "$*"; }
die() { printf '\n✖ %s\n' "$*" >&2; exit 1; }

say "=== xsolve 公信证书签发（DNS-01）==="
say "仓库根目录：$REPO_ROOT"
say "证书输出到：$CERT_DIR"
say ""

# ── 1. 前置校验 ──────────────────────────────────────────────────────
[ -n "$DOMAIN" ] || die "缺少 DEDYN_DOMAIN。先 export DEDYN_DOMAIN=xsolve-xxx.dedyn.io"
[ -n "$TOKEN" ]  || die "缺少 DEDYN_TOKEN。到 deSEC 的 TOKEN MANAGEMENT 生成后 export DEDYN_TOKEN=…"

command -v docker >/dev/null 2>&1 || die "找不到 docker，本脚本需在 NAS 宿主机上运行"

# 确认域名真的解析到本机（解析不到说明 A 记录漏配，或路由器 DNS 重绑定保护拦了）
if command -v dig >/dev/null 2>&1; then
  RESOLVED="$(dig +short "$DOMAIN" A 2>/dev/null | head -1 || true)"
  if [ -z "$RESOLVED" ]; then
    say "⚠️  $DOMAIN 解析不到 A 记录 —— 证书仍可签发（DNS-01 只看 TXT），"
    say "    但签好后手机访问会失败。请到 deSEC 补一条 A 记录指向 NAS 内网 IP。"
  else
    say "✔ A 记录：$DOMAIN → $RESOLVED"
    if [ "$RESOLVED" = "127.0.0.1" ] || printf '%s' "$RESOLVED" | grep -qE '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)'; then
      say "  （内网地址，符合预期：只在家用、不暴露公网）"
    else
      say "  ⚠️ 解析到的是公网地址。若你只想在家用，A 记录填内网 IP 即可，"
      say "     否则流量会绕到公网、且涉及端口转发与备案。"
    fi
  fi
  say ""
fi

# ── 2. 安装 / 定位 acme.sh ───────────────────────────────────────────
if [ ! -x "$ACME_HOME/acme.sh" ]; then
  say "[1/4] 未检测到 acme.sh，开始安装…"
  if [ -n "$ACME_EMAIL" ]; then
    curl -fsS https://get.acme.sh | sh -s email="$ACME_EMAIL"
  else
    curl -fsS https://get.acme.sh | sh -s
  fi
  [ -x "$ACME_HOME/acme.sh" ] || die "acme.sh 安装后仍找不到，请检查 $ACME_HOME"
  say "✔ acme.sh 已安装到 $ACME_HOME"
else
  say "[1/4] acme.sh 已就绪：$ACME_HOME/acme.sh"
  "$ACME_HOME/acme.sh" --upgrade --auto-upgrade >/dev/null 2>&1 || true
fi
say ""

# ── 3. 签发（DNS-01）──────────────────────────────────────────────────
# 显式 --server letsencrypt：acme.sh 3.0 起默认 CA 变成了 ZeroSSL，
# 不指定的话拿到的是 ZeroSSL 证书（也受信，但与预期不符）。
export DEDYN_TOKEN="$TOKEN"
export DEDYN_NAME="$DOMAIN"   # 旧版 dns_desec 需要它，新版只用 token；都给上更稳

say "[2/4] 通过 $ACME_DNS 做 DNS-01 验证并签发…"
say "      域名：$DOMAIN"
say ""

"$ACME_HOME/acme.sh" --issue \
  --dns "$ACME_DNS" \
  -d "$DOMAIN" \
  --server letsencrypt \
  --keylength ec-256 \
  --log

say ""
say "[3/4] 安装证书到 $CERT_DIR"

mkdir -p "$CERT_DIR"
chmod 700 "$CERT_DIR" 2>/dev/null || true

# reloadcmd 在**每次续期成功后**执行。容器可能还没起来，
# 所以失败不阻断（下次容器重启就会读到新证书）。
"$ACME_HOME/acme.sh" --install-cert -d "$DOMAIN" --ecc \
  --key-file       "$CERT_DIR/privkey.pem" \
  --fullchain-file "$CERT_DIR/fullchain.pem" \
  --reloadcmd      "docker restart $CONTAINER_NAME >/dev/null 2>&1 || true"

# ── 4. 校验 + 输出后续步骤 ────────────────────────────────────────────
say ""
say "[4/4] 校验签发的证书"
if command -v openssl >/dev/null 2>&1; then
  openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -subject -issuer -dates 2>/dev/null \
    | sed 's/^/      /'
  ISSUER="$(openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -issuer 2>/dev/null || true)"
  case "$ISSUER" in
    *"xsolve Local CA"*)
      die "拿到的仍是自签证书，签发流程有问题" ;;
    *"Let's Encrypt"*|*"R11"*|*"R12"*|*"E5"*|*"E6"*)
      say "      ✔ 公信证书（Let's Encrypt），客户端无需安装任何 CA" ;;
    *)
      say "      ⚠️ 签发者不在预期列表，请人工确认：$ISSUER" ;;
  esac
fi

say ""
say "=== 签发完成，还差最后一步：让服务用上新证书 ==="
say ""
say "在 $REPO_ROOT/.env 中加入（注意是**容器内**路径）："
say ""
say "    HTTPS_ENABLED=true"
say "    HTTPS_PORT=8443"
say "    HTTPS_KEY=/app/certs/acme/privkey.pem"
say "    HTTPS_CERT=/app/certs/acme/fullchain.pem"
say ""
say "然后重启容器："
say ""
say "    cd $REPO_ROOT && docker compose up -d"
say ""
say "验证（应返回 200 且证书链是 Let's Encrypt）："
say ""
say "    curl -sS -o /dev/null -w 'verify=%{ssl_verify_result} code=%{http_code}\\n' https://$DOMAIN/healthz"
say "    echo | openssl s_client -connect $DOMAIN:8443 -servername $DOMAIN 2>/dev/null | openssl x509 -noout -issuer"
say ""
say "浏览器侧（决定性证据，不需要任何 SPKI 白名单参数）："
say ""
say "    node scripts/check-sw.mjs https://$DOMAIN/"
say ""
say "续期：acme.sh 已自动装好 cron（每天检查，剩余 30 天内自动续），"
say "     续期后会执行 reloadcmd 重启容器 —— 客户端全程无感知。"
say ""
say "提示：NAS 的 IP 建议在路由器上做 DHCP 静态绑定。A 记录写死的是内网 IP，"
say "     若 NAS 换了地址，手机就会访问不到（证书本身不受影响）。"

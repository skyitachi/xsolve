// 局域网 HTTPS 支持（PWA 的前置条件）
//
// 为什么需要这个：
//   PWA 依赖 Service Worker，而 navigator.serviceWorker 是 [SecureContext] 成员 —— 浏览器只在
//   「安全上下文」里才暴露它。安全上下文 = https:// 或 localhost。明文 http://<局域网 IP> 不是，
//   所以那种地址下 PWA 必然无效（且失败是静默的：注册代码整个被跳过，连警告都不打）。
//
// 本模块只负责「读配置 + 给 createServer 喂 key/cert」，不在这里起服务；
// 证书用 `node backend/scripts/setup-lan-https.mjs` 生成。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// 用 Node 内置的 X509Certificate 读 SAN —— 不依赖 openssl，容器里也能跑
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/** 默认证书目录（<repo>/certs，已被 .gitignore 的 *.pem / *.key 覆盖） */
export const DEFAULT_CERT_DIR = path.join(ROOT, 'certs');
export const DEFAULT_KEY_PATH = path.join(DEFAULT_CERT_DIR, 'xsolve-key.pem');
export const DEFAULT_CERT_PATH = path.join(DEFAULT_CERT_DIR, 'xsolve.pem');

/** 本地 Root CA 目录。刻意放在仓库外，避免 CA 私钥误入库 */
export function getCaDir() {
  return process.env.XSOVE_CA_DIR || path.join(os.homedir(), '.xsolve-ca');
}

export function getCaCertPath() {
  return path.join(getCaDir(), 'rootCA.pem');
}

/** 暴露给前端供手机下载的 CA 副本（可为空：脚本还没跑过） */
export function getCaDownloadCopy() {
  return path.join(ROOT, 'frontend', 'xsolve-ca.crt');
}

/** 默认 HTTPS 端口。刻意与 HTTP 的 8765 分开，避免影响既有访问方式 */
export const DEFAULT_HTTPS_PORT = 8443;

function truthy(v) {
  return /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
}

/**
 * 读取 HTTPS 相关配置（惰性读 process.env，便于 DB settings 覆盖或测试注入）
 * @returns {{enabled:boolean, port:number, keyPath:string, certPath:string}}
 */
export function getTlsConfig() {
  return {
    enabled: truthy(process.env.HTTPS_ENABLED),
    port: Number(process.env.HTTPS_PORT) || DEFAULT_HTTPS_PORT,
    keyPath: process.env.HTTPS_KEY || DEFAULT_KEY_PATH,
    certPath: process.env.HTTPS_CERT || DEFAULT_CERT_PATH,
  };
}

/**
 * 加载 TLS 证书。任何一步不满足都返回 tls:null + 可读原因，绝不抛错
 * （HTTPS 是可选增强，缺证书不应让整个服务起不来）
 * @returns {{enabled:boolean, port:number, keyPath:string, certPath:string,
 *            tls:{key:Buffer,cert:Buffer}|null, reason:string|null}}
 */
export function loadTlsOptions() {
  const cfg = getTlsConfig();

  if (!cfg.enabled) {
    return { ...cfg, tls: null, reason: 'HTTPS_ENABLED 未开启' };
  }
  if (!fs.existsSync(cfg.keyPath)) {
    return { ...cfg, tls: null, reason: `私钥不存在：${cfg.keyPath}` };
  }
  if (!fs.existsSync(cfg.certPath)) {
    return { ...cfg, tls: null, reason: `证书不存在：${cfg.certPath}` };
  }
  try {
    return {
      ...cfg,
      tls: {
        key: fs.readFileSync(cfg.keyPath),
        cert: fs.readFileSync(cfg.certPath),
      },
      reason: null,
    };
  } catch (e) {
    return { ...cfg, tls: null, reason: `证书读取失败：${e.message}` };
  }
}

/** 列出所有非回环 IPv4（局域网可访问地址） */
export function listLanIPv4() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

/** mDNS 名（<LocalHostName>.local）。IP 会随 DHCP 变，这个名字相对稳定 */
export function getMdnsHostname() {
  const h = os.hostname() || 'localhost';
  return /\.local$/i.test(h) ? h : `${h}.local`;
}

/**
 * 按优先级列出可用于访问本机的主机名（启动日志用）
 * @returns {string[]} 去重后的主机名/IP 列表
 */
export function listAccessHosts() {
  const hosts = ['localhost', getMdnsHostname()];
  for (const { address } of listLanIPv4()) hosts.push(address);
  return [...new Set(hosts)];
}

/**
 * 读取证书里的 SAN 列表（不需要 openssl —— Node 15+ 的 X509Certificate 直接解析）
 * @returns {string[]|null} 形如 ['DNS:localhost', 'IP Address:192.168.0.112']；读不出来返回 null
 */
export function getCertSans(certPath) {
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
    return (cert.subjectAltName || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * 检查证书 SAN 是否覆盖当前全部局域网 IPv4。
 *
 * 为什么要在启动时查：换 Wi-Fi / 路由器重发 IP 后，旧证书对新 IP 是「不受信任」的。
 * 而用户点过证书警告页的「继续访问」之后，Chrome 会把该 origin 标记为危险并**继续禁用
 * Service Worker** —— 表现就是「上了 HTTPS，PWA 还是无效」。这种失效是静默的，
 * 所以在启动日志里主动喊出来，比事后排查划算得多。
 *
 * @returns {{checked:boolean, ok:boolean, missing:string[], certIps:string[]}}
 */
export function checkCertCoverage(certPath) {
  const sans = getCertSans(certPath);
  if (sans === null) return { checked: false, ok: false, missing: [], certIps: [] };
  const certIps = sans
    .filter((s) => /^IP Address:/i.test(s))
    .map((s) => s.replace(/^IP Address:/i, '').trim());
  const missing = listLanIPv4()
    .map((x) => x.address)
    .filter((ip) => !certIps.includes(ip));
  return { checked: true, ok: missing.length === 0, missing, certIps };
}

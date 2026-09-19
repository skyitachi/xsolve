#!/usr/bin/env node
// 局域网 HTTPS 一键配置：生成「本地 Root CA + 服务器证书」，让浏览器把 http://<局域网IP> 之外的
// https://<局域网IP> 认成安全上下文，从而让 PWA（Service Worker / 装到主屏 / 离线）真正可用。
//
// 用法：
//   node backend/scripts/setup-lan-https.mjs            # 生成/刷新服务器证书（自动带上当前局域网 IP）
//   node backend/scripts/setup-lan-https.mjs --rotate-ca # 连 Root CA 一起重造（会让已装 CA 的设备失效）
//   node backend/scripts/setup-lan-https.mjs --show      # 只查看当前证书覆盖了哪些地址
//   node backend/scripts/setup-lan-https.mjs --quiet     # 只做不说，供 update.sh / CI 调用
//
// 这个脚本跑在**服务端**（Mac 或 NAS 都行），证书内容取的是服务端自己的 IP/主机名；
//   而「信任 CA」必须在**客户端设备**（手机 / 平板 / 另一台电脑）上做，两者是分开的两件事。
//
// 为什么不用 -addext：macOS 自带的是 LibreSSL 3.3.6，不支持 openssl req/x509 的 -addext 参数，
// 所以 SAN 必须写进配置文件再通过 -config / -extfile 传入。（Linux 上的真 OpenSSL 支持，但
// 统一写法更省事，也保证两个平台产出完全一致。）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DEFAULT_CERT_DIR,
  DEFAULT_KEY_PATH,
  DEFAULT_CERT_PATH,
  getCaDir,
  getCaCertPath,
  getCaDownloadCopy,
  getTlsConfig,
  listLanIPv4,
  getMdnsHostname,
} from '../tls.js';

const argv = process.argv.slice(2);
const ROTATE_CA = argv.includes('--rotate-ca');
const SHOW_ONLY = argv.includes('--show');
// --quiet：只做不说。给 update.sh 这类自动流程用，避免每次部署刷一屏操作指引
const QUIET = argv.includes('--quiet') || argv.includes('-q');

/** 仓库根目录（= 证书目录的上一级），用来判断是不是 Docker 部署 */
const REPO_ROOT = path.resolve(DEFAULT_CERT_DIR, '..');
const HAS_COMPOSE = fs.existsSync(path.join(REPO_ROOT, 'docker-compose.yml'));

// iOS 要求用户自装根 CA 签发的服务器证书有效期 ≤ 825 天；这里取 397 天，顺带满足所有现代浏览器的上限
const CA_DAYS = 3650;
const SERVER_DAYS = 397;

const CA_DIR = getCaDir();
const CA_KEY = path.join(CA_DIR, 'rootCA.key');
const CA_CERT = getCaCertPath();
const CA_SRL = path.join(CA_DIR, 'rootCA.srl');
const SERVER_KEY = DEFAULT_KEY_PATH;
const SERVER_CERT = DEFAULT_CERT_PATH;
const SERVER_CSR = path.join(DEFAULT_CERT_DIR, 'xsolve.csr');
const TMP_CNF_DIR = path.join(DEFAULT_CERT_DIR, '.openssl');

function log(msg = '') { process.stdout.write(msg + '\n'); }
function ok(msg) { process.stdout.write('  ✔ ' + msg + '\n'); }
function warn(msg) { process.stdout.write('  ⚠️  ' + msg + '\n'); }
// 只在非 --quiet 时输出（说明性、指引性内容用这个；✔ / ⚠️ 结果行始终打印）
function say(msg = '') { if (!QUIET) process.stdout.write(msg + '\n'); }

function openssl(args, label) {
  const r = spawnSync('openssl', args, { encoding: 'utf8' });
  if (r.error) throw new Error(`openssl 执行失败（${label}）：${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(
      `openssl 失败（${label}），退出码 ${r.status}\n--- stderr ---\n${(r.stderr || '').trim()}\n--- stdout ---\n${(r.stdout || '').trim()}`,
    );
  }
  return r;
}

/** 收集需要写进 SAN 的主机名与 IP */
function collectSans() {
  // 注意：不要把 IP 再加进 DNS 列表 —— 客户端是按 IP SAN 匹配 IP 的，重复只会让输出难读
  const dns = ['localhost', getMdnsHostname()];
  const lan = listLanIPv4();
  const ips = ['127.0.0.1', '::1', ...lan.map((x) => x.address)];
  return { dns: [...new Set(dns)], ips: [...new Set(ips)], lan };
}

function writeCaConfig(file) {
  fs.writeFileSync(
    file,
    `[req]
prompt = no
distinguished_name = dn
x509_extensions = v3_ca

[dn]
C  = CN
O  = xsolve local development
CN = xsolve Local CA

[v3_ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
`,
  );
}

function writeServerConfig(file, sans) {
  const lines = [
    '[req]',
    'prompt = no',
    'distinguished_name = dn',
    'req_extensions = v3_req',
    '',
    '[dn]',
    'C  = CN',
    'O  = xsolve local development',
    `CN = ${getMdnsHostname()}`,
    '',
    '[v3_req]',
    'basicConstraints = critical,CA:FALSE',
    'keyUsage = critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage = serverAuth',
    'subjectAltName = @alt',
    'subjectKeyIdentifier = hash',
    // 刻意不写 authorityKeyIdentifier：LibreSSL 在 CSR 阶段解析 'keyid,issuer' 会直接报
    // "Error Loading extension section"。该扩展是可选的，Chrome / iOS / Android 都不要求。
    '',
    '[alt]',
  ];
  sans.dns.forEach((d, i) => lines.push(`DNS.${i + 1} = ${d}`));
  sans.ips.forEach((ip, i) => lines.push(`IP.${i + 1} = ${ip}`));
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

/** 打印证书里的 SAN，用于自检 */
function printCertSans(certPath, label) {
  const r = spawnSync('openssl', ['x509', '-in', certPath, '-noout', '-text'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    warn(`${label} 读取失败`);
    return null;
  }
  const m = r.stdout.match(/X509v3 Subject Alternative Name:[\s\S]*?\n\s{8}([^\n]+)/);
  if (!m) {
    warn(`${label} 未找到 SAN`);
    return null;
  }
  const sans = m[1].trim();
  log(`  ${label} SAN: ${sans}`);
  return sans;
}

function certNotAfter(certPath) {
  const r = spawnSync('openssl', ['x509', '-in', certPath, '-noout', '-enddate'], {
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.trim().replace('notAfter=', '') : '(未知)';
}

// ============ --show：只看现状 ============
if (SHOW_ONLY) {
  log('=== 当前证书状态 ===');
  log(`CA 证书：${CA_CERT} ${fs.existsSync(CA_CERT) ? '存在' : '不存在'}`);
  log(`服务器证书：${SERVER_CERT} ${fs.existsSync(SERVER_CERT) ? '存在' : '不存在'}`);
  if (fs.existsSync(SERVER_CERT)) {
    printCertSans(SERVER_CERT, '服务器');
    log(`  到期：${certNotAfter(SERVER_CERT)}`);
  }
  const cur = listAccessHostsSafe();
  log(`当前本机地址：${cur.join(' / ')}`);
  process.exit(0);
}

function listAccessHostsSafe() {
  return ['localhost', getMdnsHostname(), ...listLanIPv4().map((x) => x.address)];
}

// ============ 主流程 ============
const sans = collectSans();
say('=== 局域网 HTTPS 配置 ===');
say(`CA 目录      ：${CA_DIR}`);
say(`证书目录     ：${DEFAULT_CERT_DIR}`);
say(`部署方式     ：${HAS_COMPOSE ? '检测到 docker-compose.yml（Docker 部署需注意 build 顺序）' : '直接跑 node'}`);
say();
say('将把以下地址写入证书 SAN：');
for (const d of sans.dns) say(`  · ${d}`);
for (const ip of sans.ips) say(`  · ${ip}`);
say();

fs.mkdirSync(CA_DIR, { recursive: true });
fs.mkdirSync(DEFAULT_CERT_DIR, { recursive: true });
fs.mkdirSync(TMP_CNF_DIR, { recursive: true });
const caCnf = path.join(TMP_CNF_DIR, 'ca.cnf');
const srvCnf = path.join(TMP_CNF_DIR, 'server.cnf');
writeCaConfig(caCnf);
writeServerConfig(srvCnf, sans);

// ---- 1. Root CA（已存在则复用，避免让手机重装）----
const caExists = fs.existsSync(CA_KEY) && fs.existsSync(CA_CERT);
if (caExists && ROTATE_CA) {
  warn('--rotate-ca：删除旧 CA，已安装过旧 CA 的设备需要重新安装');
  for (const f of [CA_KEY, CA_CERT, CA_SRL]) fs.rmSync(f, { force: true });
}
if (!caExists || ROTATE_CA) {
  log('1. 生成 Root CA');
  openssl(['genrsa', '-out', CA_KEY, '4096'], 'CA 私钥');
  openssl(
    ['req', '-x509', '-new', '-nodes', '-key', CA_KEY, '-sha256', '-days', String(CA_DAYS),
      '-out', CA_CERT, '-config', caCnf, '-extensions', 'v3_ca'],
    'CA 自签证书',
  );
  fs.chmodSync(CA_KEY, 0o600);
  ok(`CA 已生成，有效期 ${CA_DAYS} 天（${CA_DIR}）`);
} else {
  log('1. Root CA 已存在，直接复用（换网络只需刷新服务器证书）');
  ok(`${CA_CERT}`);
}

// ---- 2. 服务器证书（每次都重签，把最新 IP 覆盖进去）----
log('2. 生成服务器证书');
openssl(['genrsa', '-out', SERVER_KEY, '2048'], '服务器私钥');
openssl(['req', '-new', '-key', SERVER_KEY, '-out', SERVER_CSR, '-config', srvCnf], 'CSR');
openssl(
  ['x509', '-req', '-in', SERVER_CSR, '-CA', CA_CERT, '-CAkey', CA_KEY, '-CAcreateserial',
    '-out', SERVER_CERT, '-days', String(SERVER_DAYS), '-sha256',
    '-extfile', srvCnf, '-extensions', 'v3_req'],
  '签发服务器证书',
);
fs.chmodSync(SERVER_KEY, 0o600);
fs.rmSync(SERVER_CSR, { force: true });
ok(`证书有效 ${SERVER_DAYS} 天，到期 ${certNotAfter(SERVER_CERT)}`);

// ---- 3. 自检：链是否通、SAN 是否含当前 IP ----
say('3. 自检');
openssl(['verify', '-CAfile', CA_CERT, SERVER_CERT], '证书链校验');
ok('证书链校验通过（装 CA 后浏览器即会信任）');
const sansText = printCertSans(SERVER_CERT, '服务器') || '';
// 只核对 IPv4：openssl 会把 ::1 打印成展开形式 0:0:0:0:0:0:0:1，直接字符串比对必然误报，
// 而局域网访问真正依赖的就是 IPv4
const needV4 = sans.ips.filter((ip) => /^\d+\./.test(ip));
const missing = needV4.filter((ip) => !sansText.includes(ip));
if (missing.length) warn(`SAN 里似乎缺少：${missing.join(', ')}`);
else ok(`SAN 覆盖了当前全部局域网 IPv4：${needV4.join(', ')}`);

// ---- 4. 导出给手机下载的 CA ----
// 同一张证书导出两种编码，因为各平台「安装 CA」的入口对格式的宽容度不一样：
//   · DER（.crt）：iOS / iPadOS、macOS、Windows 的原生格式，也是浏览器双击安装最顺的
//   · PEM（.pem）：部分 Android（尤其国产 ROM）在「安装证书 → CA 证书」时只认 PEM，
//                  给 DER 会直接提示「无法安装」；有 PEM 兜底可以少跑一趟
const caCopy = getCaDownloadCopy();
const caPemCopy = caCopy.replace(/\.crt$/, '.pem');
openssl(['x509', '-in', CA_CERT, '-outform', 'der', '-out', caCopy], '导出 DER');
openssl(['x509', '-in', CA_CERT, '-outform', 'pem', '-out', caPemCopy], '导出 PEM');
ok(`已导出手机用 CA：${path.basename(caCopy)}（DER）、${path.basename(caPemCopy)}（PEM）`);

// ---- 5. 指引 ----
const port = getTlsConfig().port;
const ip = sans.lan[0]?.address || '<本机IP>';
const mdns = getMdnsHostname();
// CA 必须走**明文 HTTP** 下载（下载时客户端还没信任 CA，走 HTTPS 会先撞证书错误）
const httpPort = process.env.PORT || 8765;
const caUrl = `http://${ip}:${httpPort}/xsolve-ca.crt`;
const caPemUrl = `http://${ip}:${httpPort}/xsolve-ca.pem`;

if (QUIET) {
  log(`[https] 证书已刷新：SAN 覆盖 ${sans.ips.join(', ')}（HTTPS 端口 ${port}）`);
  process.exit(0);
}

log();
log('============ 接下来做什么 ============');
log();
log('① 让服务端用上这张证书（写进 .env）');
log('   HTTPS_ENABLED=true');
log(`   HTTPS_PORT=${port}`);
if (HAS_COMPOSE) {
  log();
  log('   ⚠️  Docker 部署的顺序不能反 —— 脚本还要把 CA 副本写进 frontend/，');
  log('      而 frontend/ 是 build 时 COPY 进镜像的，所以必须先跑脚本再 build：');
  log('         node backend/scripts/setup-lan-https.mjs');
  log('         docker compose up -d --build');
  log('      （./certs 已按只读挂载到容器 /app/certs，路径与 tls.js 默认值一致，');
  log('        无需另外配置 HTTPS_KEY / HTTPS_CERT）');
} else {
  log('   改完重启服务即可。');
}
log();
log('② 让「访问它的设备」信任这个 CA —— 每台要访问的设备各做一次');
log('   ⚠️  装上的是「你要访问的那台服务器」的 CA，别装错：每台跑本脚本的机器都会生成');
log('      **自己的一张** Root CA，subject 同名（CN=xsolve Local CA）但指纹不同。');
log('   ⚠️  这是必需项，不是优化项：点证书警告页的「继续访问」，Chrome 会把这个地址');
log('      标记为不安全，并**继续禁用 Service Worker** —— 表现就是「上了 HTTPS 也还是没效果」。');
log(`   · iOS / iPadOS：手机浏览器打开 ${caUrl} 下载（DER 格式）`);
log('       设置 → 通用 → VPN与设备管理 → 安装描述文件');
log('       → 再到 设置 → 通用 → 关于本机 → 证书信任设置 → 打开该 CA 的完全信任');
log('       （最后这一步最容易漏，漏了就等于没装）');
log('   · Android：下载后 → 设置 → 安全 → 加密与凭据 → 安装证书 → 选「CA 证书」');
log('       注意别选成「VPN 和应用用户证书」；部分厂商在 设置 → 安全 → 更多安全设置');
log(`       若上面那个 .crt 提示「无法安装」，换 PEM 版再试：${caPemUrl}`);
log('   · macOS 客户端：免 sudo，加到**登录**钥匙串（注意不要加 -d ——');
log('       -d 是「写入 admin cert store」，需要 root，和「免 sudo」自相矛盾）');
log('       -p ssl 很值得加：把信任限定在 SSL，这张 CA 就不能被用来签代码/邮件冒充');
log(`       security add-trusted-cert -r trustRoot -p ssl -k ~/Library/Keychains/login.keychain-db <该服务器下载来的 .pem>`);
log('       验证：security find-certificate -a -c "xsolve Local CA" -Z ~/Library/Keychains/login.keychain-db');
log('             security dump-trust-settings   # 应看到 Cert 0 且 Policy OID: SSL');
log('       撤销：security delete-certificate -c "xsolve Local CA" ~/Library/Keychains/login.keychain-db');
log('   · Windows 客户端：');
log(`       certutil -addstore -user Root "${getCaDownloadCopy()}"`);
log();
log(`③ 设备上访问（注意是 https + 端口 ${port}）`);
log(`   https://${ip}:${port}/        ← 用 IP 最稳，各浏览器都认`);
log(`   https://${mdns}:${port}/      ← 用 mDNS 主机名，换 IP 也不用重装 CA`);
log('   打开后顶栏应出现安装按钮，或 Chrome 菜单里出现「安装应用」');
log();
log('④ 验证是否真的生效');
log('   地址栏出现锁图标 → 安全上下文成立；');
log('   装到主屏后从主屏图标打开，地址栏消失（standalone 模式）→ PWA 生效；');
log('   桌面浏览器可看 DevTools → Application → Service Workers / Manifest。');
log();
log('⚠️  换了 Wi-Fi / 路由器重发 IP 后，重跑本脚本刷新服务器证书即可：');
log('   node backend/scripts/setup-lan-https.mjs');
log('   （Root CA 不变，客户端无需重装；服务启动时也会自动比对 SAN 与当前 IP 并告警）');
log();
log('💡 建议在路由器里给这台机器绑定静态 IP（DHCP 保留），一劳永逸。');

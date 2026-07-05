// 简易 .env 文件加载器（无第三方依赖）
// 被 import 时自动执行，将 .env 中的键值对加载到 process.env
// 已存在的环境变量优先级更高（不会覆盖已通过 -e/export 设置的变量）
import fs from 'node:fs';
import path from 'node:path';

function loadDotEnv() {
  // 优先加载 .env.local（本地开发覆盖），然后是 .env
  // 查找路径：从 process.cwd() 开始（通常是项目根目录）
  const candidates = ['.env.local', '.env'];
  for (const name of candidates) {
    const filePath = path.resolve(process.cwd(), name);
    if (!fs.existsSync(filePath)) continue;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      let loaded = 0;
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        let key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        // 不覆盖已存在的环境变量（CLI -e 参数优先级更高）
        if (key && !(key in process.env)) {
          process.env[key] = val;
          loaded++;
        }
      }
      if (loaded > 0) {
        console.log(`[env] loaded ${loaded} vars from ${name}`);
      }
    } catch (e) {
      console.warn(`[env] failed to load ${name}: ${e.message}`);
    }
  }
}

// 模块被 import 时自动执行
loadDotEnv();

export { loadDotEnv };

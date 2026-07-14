#!/usr/bin/env node
// 小学 AI 做题助手 后端入口
import "./env.js"; // 必须最先导入：加载 .env 文件到 process.env
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PORT, VISION_MODEL, CLAUDE_MODEL } from "./config.js";
import { getVisionApiConfig, resolveApiFormat } from "./vision.js";
import { sessions, destroySession } from "./session.js";
import { createApp } from "./app.js";
import { runStartupChecks } from "./startup-check.js";

// ---------- 启动配置校验 ----------
function validateConfig() {
  const warnings = [];
  const errors = [];

  const apiKey =
    process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  const baseUrl = process.env.ANTHROPIC_BASE_URL || "";
  const isCustomBase = (() => {
    if (!baseUrl) return false;
    try {
      const u = new URL(
        baseUrl.startsWith("http") ? baseUrl : "https://" + baseUrl,
      );
      return !/anthropic\.com$/i.test(u.hostname);
    } catch {
      return true;
    }
  })();
  const hasClaudeSettings = (() => {
    try {
      return fs.existsSync(path.join(os.homedir(), ".claude", "settings.json"));
    } catch {
      return false;
    }
  })();

  // 1. API Key 检查
  if (!apiKey && !hasClaudeSettings) {
    errors.push("未找到 API Key。请设置环境变量 ANTHROPIC_API_KEY=sk-ant-...");
  }

  // 2. 自定义 base_url 时建议指定模型（不阻断启动，但给出警告）
  if (isCustomBase && !CLAUDE_MODEL && !process.env.VISION_MODEL) {
    warnings.push(
      "检测到自定义 ANTHROPIC_BASE_URL，但未设置 CLAUDE_MODEL。\n" +
        "  SDK 将使用默认 Claude 模型名，在你的代理上可能不存在。\n" +
        "  建议设置：CLAUDE_MODEL=你的代理支持的Claude模型名\n" +
        `  当前 API 地址: ${baseUrl}`,
    );
  }

  // 3. OpenAI 格式视觉必须设置 VISION_MODEL
  const visionFormat = resolveApiFormat();
  if (visionFormat === "openai" && !process.env.VISION_MODEL) {
    errors.push(
      "使用 OpenAI 兼容格式时必须设置 VISION_MODEL。\n" +
        "  例如：VISION_MODEL=Pro/Qwen/Qwen2.5-VL-7B-Instruct",
    );
  }

  return {
    warnings,
    errors,
    isCustomBase,
    baseUrl: baseUrl || "https://api.anthropic.com",
    apiKeySet: !!apiKey,
  };
}

// 创建 Express app
const app = createApp();

// 启动 HTTP 服务器
const server = app.listen(PORT, async () => {
  const cfg = validateConfig();

  console.log(`[selflearning] http://localhost:${PORT}`);
  console.log(
    `[selflearning] auth: ${cfg.apiKeySet ? "ANTHROPIC_API_KEY (env)" : "checking ~/.claude/settings.json"}`,
  );
  console.log(
    `[selflearning] api base: ${cfg.baseUrl}${cfg.isCustomBase ? " (custom proxy)" : " (default)"}`,
  );

  if (CLAUDE_MODEL) {
    console.log(`[selflearning] chat model: ${CLAUDE_MODEL}`);
  } else {
    console.log(`[selflearning] chat model: SDK default (claude-sonnet-4-6)`);
  }

  // 视觉模型信息
  let visionModelDisplay = VISION_MODEL;
  const visionCfg = getVisionApiConfig();
  const visionBase = visionCfg.baseUrl;
  const visionSeparate =
    !!process.env.VISION_BASE_URL || !!process.env.VISION_API_KEY;
  let isAnthropicOfficial = false;
  try {
    isAnthropicOfficial = /anthropic\.com$/i.test(
      new URL(visionBase).hostname,
    );
  } catch {
    isAnthropicOfficial = false;
  }
  const visionFormat = resolveApiFormat();

  if (!process.env.VISION_MODEL) {
    if (visionFormat === "anthropic") {
      if (CLAUDE_MODEL) {
        visionModelDisplay = `${CLAUDE_MODEL} (复用主对话模型)`;
      } else if (isAnthropicOfficial) {
        visionModelDisplay = "claude-sonnet-4-20250514 (自动选择)";
      } else {
        visionModelDisplay =
          "(未设置，视觉功能调用时会报错，请设置 VISION_MODEL 或 CLAUDE_MODEL)";
      }
    } else {
      visionModelDisplay = "(未设置，请设置 VISION_MODEL)";
    }
  }
  console.log(
    `[selflearning] vision model: ${visionModelDisplay} [${visionFormat} format]`,
  );
  console.log(
    `[selflearning] vision api base: ${visionBase}${visionSeparate ? " (separate from chat)" : " (inherited from chat)"}`,
  );

  // 打印警告
  for (const w of cfg.warnings) {
    console.log("[selflearning] ⚠️  " + w.replace(/\n/g, "\n           "));
  }
  for (const e of cfg.errors) {
    console.log("[selflearning] ❌ " + e.replace(/\n/g, "\n           "));
  }
  if (cfg.errors.length > 0) {
    console.log("[selflearning] ❌ 以上配置错误需要修复后才能正常使用。");
  }

  // 各 AI 模块接入探测（不阻断启动，不通过打 error 日志）
  await runStartupChecks().catch((e) => {
    console.error("[startup-check] 检查过程异常:", e.message || e);
  });
});

process.on("SIGINT", async () => {
  console.log("shutting down...");
  server.close();
  for (const s of sessions.values()) await destroySession(s);
  process.exit(0);
});

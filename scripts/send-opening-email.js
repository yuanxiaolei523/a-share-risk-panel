import { existsSync, readFileSync } from "node:fs";
import nodemailer from "nodemailer";
import { analyzeEmotionCycle, analyzeStock } from "../server.js";

const DRY_RUN = process.argv.includes("--dry-run");

function loadEnvFile(file = ".env.local") {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function requireEnv(names) {
  const missing = names.filter((name) => !env(name));
  if (missing.length) {
    throw new Error(`缺少邮件环境变量：${missing.join(", ")}。请参考 .env.example 配置。`);
  }
}

function fmt(value, suffix = "") {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return `${Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${suffix}`;
}

function money(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return Number(value).toLocaleString("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: 0
  });
}

function paramsFor(code, overrides = {}) {
  return new URLSearchParams({
    code,
    capital: env("CAPITAL", "100000"),
    holdingCost: env("HOLDING_COST", "27.723"),
    riskPct: env("RISK_PCT", "1"),
    maxPositionPct: env("MAX_POSITION_PCT", "20"),
    style: "swing",
    ...overrides
  });
}

async function safeAnalyze(code, overrides) {
  try {
    return await analyzeStock(paramsFor(code, overrides));
  } catch (error) {
    return { error: error.message || "分析失败", code };
  }
}

function lineForStock(data) {
  if (data.error) return `- ${data.code}：读取失败，${data.error}`;
  const op = data.operation;
  return [
    `- ${data.quote.name} ${data.quote.code}`,
    `现价 ${fmt(data.quote.price)}`,
    `结论：${op?.headline || data.analysis.verdict}`,
    `仓位：${data.plan.suggestedShares} 股`,
    `止损：${fmt(data.plan.stop)}`,
    op?.summary ? `说明：${op.summary}` : ""
  ].filter(Boolean).join("；");
}

function htmlEscape(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function toHtml(text) {
  return htmlEscape(text)
    .split("\n")
    .map((line) => line.trim() ? `<p>${line}</p>` : "<br>")
    .join("\n");
}

function formatDate() {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date());
}

async function buildReport() {
  const holdingCode = env("HOLDING_CODE", "600900");
  const watchCodes = env("WATCH_CODES", "600900,600036,000651,000333,601398")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);

  const [emotion, holding, ...watchResults] = await Promise.all([
    analyzeEmotionCycle().catch((error) => ({ error: error.message || "情绪读取失败" })),
    safeAnalyze(holdingCode),
    ...watchCodes.filter((code) => code !== holdingCode).map((code) => safeAnalyze(code, { holdingCost: "" }))
  ]);

  const subjectDate = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());

  const subject = `${env("MAIL_SUBJECT_PREFIX", "A股开盘提醒")} ${subjectDate}`;
  const lines = [
    `A 股开盘前观察 | ${formatDate()}`,
    "",
    "这是一份风控和复盘清单，不构成投资建议。开盘前只做计划，盘中不要因为情绪临时追涨。",
    "",
    "【大盘环境】",
    emotion.error
      ? `- 市场情绪读取失败：${emotion.error}`
      : `- ${emotion.stage}，情绪分 ${emotion.score}。${emotion.marketOutlook?.summary || emotion.action}`,
    emotion.error
      ? ""
      : `- 上证：${fmt(emotion.indices?.[0]?.price)}（${fmt(emotion.indices?.[0]?.pctChange, "%")}）；上涨家数 ${emotion.breadth?.up}/${emotion.breadth?.total}；策略：${emotion.marketOutlook?.strategy || emotion.action}`,
    emotion.error
      ? ""
      : `- 后市观察：${emotion.marketOutlook?.next || "先看指数能否守住关键支撑。"}`,
    "",
    "【你的持仓】",
    lineForStock(holding),
    "",
    "【今日候选观察】",
    ...watchResults.map(lineForStock),
    "",
    "【执行纪律】",
    "- 只买计划内的票；如果开盘大幅高开，不追，等回踩。",
    "- 单股仓位不要超过面板给出的上限。",
    "- 跌破计划止损位，先认错，再复盘。"
  ].filter((line) => line !== "");

  return {
    subject,
    text: lines.join("\n"),
    html: toHtml(lines.join("\n"))
  };
}

async function sendMail(report) {
  requireEnv(["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_TO"]);
  const secure = env("SMTP_SECURE", env("SMTP_PORT") === "465" ? "true" : "false") === "true";
  const transporter = nodemailer.createTransport({
    host: env("SMTP_HOST"),
    port: Number(env("SMTP_PORT")),
    secure,
    auth: {
      user: env("SMTP_USER"),
      pass: env("SMTP_PASS")
    }
  });

  const info = await transporter.sendMail({
    from: env("MAIL_FROM", env("SMTP_USER")),
    to: env("MAIL_TO"),
    subject: report.subject,
    text: report.text,
    html: report.html
  });

  return info;
}

loadEnvFile();

const report = await buildReport();
if (DRY_RUN) {
  console.log(report.subject);
  console.log(report.text);
} else {
  const info = await sendMail(report);
  console.log(`开盘邮件已发送：${info.messageId || "ok"}`);
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import nodemailer from "nodemailer";
import { analyzeStock } from "../server.js";

const DRY_RUN = process.argv.includes("--dry-run");
const STATE_FILE = ".cost-alert-state.json";

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
  return `${Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 3 })}${suffix}`;
}

function parseHoldings() {
  const configured = env("HOLDINGS");
  if (configured) {
    return configured
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const [code, cost] = item.split(":").map((part) => part?.trim());
        return { code, cost: Number(cost) };
      })
      .filter((item) => item.code && Number.isFinite(item.cost) && item.cost > 0);
  }

  const code = env("HOLDING_CODE", "600900");
  const cost = Number(env("HOLDING_COST", "27.723"));
  return Number.isFinite(cost) && cost > 0 ? [{ code, cost }] : [];
}

function paramsFor(holding) {
  return new URLSearchParams({
    code: holding.code,
    capital: env("CAPITAL", "100000"),
    holdingCost: String(holding.cost),
    riskPct: env("RISK_PCT", "1"),
    maxPositionPct: env("MAX_POSITION_PCT", "20"),
    style: "swing"
  });
}

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function shouldSendAlert(state, code, alertKey, cooldownMinutes) {
  const key = `${code}:${alertKey}`;
  const lastSent = Number(state[key] || 0);
  const elapsedMinutes = (Date.now() - lastSent) / 60000;
  return elapsedMinutes >= cooldownMinutes;
}

function markSent(state, code, alertKey) {
  state[`${code}:${alertKey}`] = Date.now();
}

async function analyzeHolding(holding) {
  try {
    const data = await analyzeStock(paramsFor(holding));
    const price = Number(data.quote.price);
    const distancePct = ((price - holding.cost) / holding.cost) * 100;
    const bufferPct = Number(env("ALERT_COST_BUFFER_PCT", "0.3"));
    const alertKey = distancePct < 0 ? "below-cost" : "near-cost";
    const shouldAlert = distancePct <= bufferPct;
    return {
      holding,
      data,
      price,
      distancePct,
      bufferPct,
      alertKey,
      shouldAlert
    };
  } catch (error) {
    return {
      holding,
      error: error.message || "分析失败",
      shouldAlert: true,
      alertKey: "read-failed"
    };
  }
}

function formatAlert(item) {
  if (item.error) {
    return `- ${item.holding.code}：读取失败，${item.error}`;
  }
  const { data, holding, price, distancePct } = item;
  const op = data.operation;
  const status = distancePct < 0 ? "已跌破成本" : "接近成本线";
  return [
    `- ${data.quote.name} ${data.quote.code}：${status}`,
    `现价 ${fmt(price)}`,
    `成本 ${fmt(holding.cost)}`,
    `距离成本 ${fmt(distancePct, "%")}`,
    `结论：${op?.headline || data.analysis.verdict}`,
    `利润保护线：${op?.zones?.find((zone) => zone.label === "利润保护线")?.value || fmt(holding.cost)}`,
    `纪律止损线：${fmt(data.plan.stop)}`,
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

  return transporter.sendMail({
    from: env("MAIL_FROM", env("SMTP_USER")),
    to: env("MAIL_TO"),
    subject: report.subject,
    text: report.text,
    html: report.html
  });
}

loadEnvFile();

const holdings = parseHoldings();
if (!holdings.length) {
  console.log("没有配置有效持仓，跳过成本线预警。");
  process.exit(0);
}

const state = loadState();
const cooldownMinutes = Number(env("ALERT_COOLDOWN_MINUTES", "60"));
const results = await Promise.all(holdings.map(analyzeHolding));
const alerts = results.filter((item) => (
  item.shouldAlert && shouldSendAlert(state, item.holding.code, item.alertKey, cooldownMinutes)
));

if (!alerts.length) {
  console.log("没有触发成本线预警，跳过发送。");
  process.exit(0);
}

const subject = `${env("MAIL_SUBJECT_PREFIX", "A股成本线预警")} ${alerts.map((item) => item.holding.code).join(",")}`;
const text = [
  `A 股盘中成本线预警 | ${formatDate()}`,
  "",
  "这不是投资建议，只是持仓风控提醒。先按纪律处理风险，再决定是否重新买回。",
  "",
  "【触发标的】",
  ...alerts.map(formatAlert),
  "",
  "【处理规则】",
  "- 跌破成本线后如果 10-15 分钟收不回，先减仓或退出一部分。",
  "- 跌破纪律止损线，不补仓摊平。",
  "- 如果只是快速下探后收回成本线，继续观察量能和指数承接。"
].join("\n");

const report = { subject, text, html: toHtml(text) };

if (DRY_RUN) {
  console.log(report.subject);
  console.log(report.text);
} else {
  const info = await sendMail(report);
  for (const item of alerts) markSent(state, item.holding.code, item.alertKey);
  saveState(state);
  console.log(`成本线预警邮件已发送：${info.messageId || "ok"}`);
}

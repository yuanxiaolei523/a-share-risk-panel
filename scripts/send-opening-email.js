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
    holdingCost: "",
    riskPct: env("RISK_PCT", "1"),
    maxPositionPct: env("MAX_POSITION_PCT", "20"),
    style: "swing",
    ...overrides
  });
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
        return { code, cost };
      })
      .filter((item) => item.code);
  }

  return [{
    code: env("HOLDING_CODE", "600900"),
    cost: env("HOLDING_COST", "27.723")
  }];
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

async function fetchYahooQuote(symbol, label) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  const response = await fetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": "Mozilla/5.0 AShareRiskPanel/1.0"
    }
  });
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  const body = await response.json();
  const result = body?.chart?.result?.[0];
  const meta = result?.meta || {};
  const close = result?.indicators?.quote?.[0]?.close?.filter((value) => Number.isFinite(value)) || [];
  const price = Number(meta.regularMarketPrice ?? close.at(-1));
  const previous = Number(meta.previousClose ?? close.at(-2));
  const pctChange = previous ? ((price - previous) / previous) * 100 : null;
  return {
    label,
    symbol,
    price,
    pctChange: Number.isFinite(pctChange) ? Number(pctChange.toFixed(2)) : null
  };
}

async function buildGlobalEnvironment() {
  const targets = [
    ["^GSPC", "标普500"],
    ["^IXIC", "纳斯达克"],
    ["CL=F", "WTI原油"],
    ["GC=F", "COMEX黄金"],
    ["USDCNH=X", "美元/离岸人民币"]
  ];
  const results = await Promise.allSettled(targets.map(([symbol, label]) => fetchYahooQuote(symbol, label)));
  const quotes = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);

  if (!quotes.length) {
    return {
      summary: "外围市场读取失败，今天只按 A 股盘面信号执行。",
      lines: ["- 外围市场读取失败，关注开盘后的指数承接和量能。"]
    };
  }

  const lineItems = quotes.map((item) => (
    `- ${item.label}：${fmt(item.price)}${item.pctChange === null ? "" : `（${fmt(item.pctChange, "%")}）`}`
  ));
  const oil = quotes.find((item) => item.symbol === "CL=F");
  const gold = quotes.find((item) => item.symbol === "GC=F");
  const nasdaq = quotes.find((item) => item.symbol === "^IXIC");
  const cnh = quotes.find((item) => item.symbol === "USDCNH=X");
  const notes = [];

  if (oil?.pctChange !== null) {
    if (oil.pctChange <= -1) notes.push("原油走弱，通常对应地缘风险缓和或需求预期降温，对风险偏好偏正面。");
    else if (oil.pctChange >= 1) notes.push("原油走强，需防地缘风险或通胀预期扰动。");
  }
  if (gold?.pctChange !== null) {
    if (gold.pctChange <= -1) notes.push("黄金回落，避险情绪降温。");
    else if (gold.pctChange >= 1) notes.push("黄金走强，避险资金仍活跃。");
  }
  if (nasdaq?.pctChange !== null) {
    if (nasdaq.pctChange >= 0.8) notes.push("纳指偏强，对 A 股科技成长方向有情绪支撑。");
    else if (nasdaq.pctChange <= -0.8) notes.push("纳指偏弱，A 股高位科技股要降低追涨预期。");
  }
  if (cnh?.pctChange !== null) {
    if (cnh.pctChange <= -0.2) notes.push("离岸人民币偏强，利于外资风险偏好。");
    else if (cnh.pctChange >= 0.2) notes.push("离岸人民币偏弱，注意外资和指数承压。");
  }

  return {
    summary: notes[0] || "外围市场没有明显单边信号，主要看 A 股自身量能和板块轮动。",
    lines: [...lineItems, ...notes.slice(1).map((note) => `- ${note}`)]
  };
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
  const holdings = parseHoldings();
  const holdingCodes = holdings.map((item) => item.code);
  const watchCodes = unique(env("WATCH_CODES", "600900,600036,000651,000333,601398")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean));

  const [emotion, globalEnvironment, holdingResults, watchResults] = await Promise.all([
    analyzeEmotionCycle().catch((error) => ({ error: error.message || "情绪读取失败" })),
    buildGlobalEnvironment().catch((error) => ({
      summary: `外围市场读取失败：${error.message || "未知错误"}`,
      lines: ["- 外围市场读取失败，今天主要看 A 股盘面。"]
    })),
    Promise.all(holdings.map((item) => safeAnalyze(item.code, { holdingCost: item.cost || "" }))),
    Promise.all(watchCodes.filter((code) => !holdingCodes.includes(code)).map((code) => safeAnalyze(code)))
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
    "【国际环境】",
    `- ${globalEnvironment.summary}`,
    ...globalEnvironment.lines,
    "",
    "【你的持仓】",
    ...holdingResults.map(lineForStock),
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

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 5174);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon"
};

const STEADY_WATCHLIST = [
  { code: "600900", name: "长江电力", role: "稳健防守", note: "低波动、现金流属性强，适合练仓位纪律。" },
  { code: "600036", name: "招商银行", role: "低估值金融", note: "估值偏低，适合中线观察，不适合追涨。" },
  { code: "000651", name: "格力电器", role: "低估值消费", note: "分红属性强，但要确认趋势重新走稳。" },
  { code: "000333", name: "美的集团", role: "消费龙头", note: "家电龙头，成长稳定性比纯周期更好。" },
  { code: "601398", name: "工商银行", role: "防守金融", note: "大盘低波动品种，适合少折腾。" }
];

const KNOWN_STOCKS = [
  ...STEADY_WATCHLIST,
  { code: "600519", name: "贵州茅台" },
  { code: "000001", name: "平安银行" },
  { code: "601899", name: "紫金矿业" },
  { code: "601088", name: "中国神华" },
  { code: "300750", name: "宁德时代" },
  { code: "600276", name: "恒瑞医药" },
  { code: "300760", name: "迈瑞医疗" },
  { code: "601318", name: "中国平安" },
  { code: "002594", name: "比亚迪" },
  { code: "002475", name: "立讯精密" },
  { code: "601138", name: "工业富联" },
  { code: "300308", name: "中际旭创" },
  { code: "600941", name: "中国移动" },
  { code: "002415", name: "海康威视" },
  { code: "601225", name: "陕西煤业" },
  { code: "600690", name: "海尔智家" }
];

const SNAPSHOT_QUOTES = {
  "600900": {
    name: "长江电力",
    price: 27.89,
    open: 27.69,
    high: 27.95,
    low: 27.6,
    previousClose: 27.69,
    amount: 2759360000,
    volume: 991250,
    marketCap: 682419000000,
    floatMarketCap: 682419000000,
    pe: 25.23,
    pb: 2.99,
    turnover: 0.41,
    pctChange: 0.72,
    amplitude: 1.26,
    volumeRatio: 1.01,
    snapshotAt: "2026-06-11 收盘参考"
  }
};

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function normalizeCode(input) {
  const raw = String(input || "").trim().toUpperCase();
  const match = raw.match(/(\d{6})/);
  if (!match) return null;
  const code = match[1];
  const market = code.startsWith("6") ? 1 : 0;
  const suffix = market === 1 ? "SH" : "SZ";
  return { code, market, secid: `${market}.${code}`, secucode: `${code}.${suffix}`, query: raw };
}

function suffixFromSearchResult(result) {
  const typeName = String(result.SecurityTypeName || "");
  if (typeName.includes("沪")) return "SH";
  if (typeName.includes("深")) return "SZ";
  if (typeName.includes("京")) return "BJ";
  return String(result.QuoteID || "").startsWith("1.") ? "SH" : "SZ";
}

async function resolveStockInput(input) {
  const raw = String(input || "").trim();
  const normalized = normalizeCode(raw);
  if (normalized) return normalized;

  if (!raw) return null;
  const known = KNOWN_STOCKS.find((item) => item.name === raw || item.name.includes(raw) || raw.includes(item.name));
  if (known) {
    return {
      ...normalizeCode(known.code),
      query: raw,
      resolvedName: known.name
    };
  }

  const searchUrl = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(raw)}&type=14&token=D43BF722C8E33E4ADC6C5D7E3B11E2D2`;
  let body;
  try {
    body = await fetchJson(searchUrl);
  } catch {
    const err = new Error("股票名称搜索接口暂时不可用，请先输入 6 位股票代码。");
    err.status = 503;
    throw err;
  }
  const candidates = body?.QuotationCodeTable?.Data || [];
  const aShares = candidates.filter((item) => item.Classify === "AStock" && /^\d\.\d{6}$/.test(item.QuoteID || ""));
  if (!aShares.length) return null;

  const exact = aShares.find((item) => item.Name === raw || item.Code === raw);
  const contains = aShares.find((item) => String(item.Name || "").includes(raw));
  const chosen = exact || contains || aShares[0];
  const [market, code] = chosen.QuoteID.split(".");
  const suffix = suffixFromSearchResult(chosen);
  return {
    code,
    market: Number(market),
    secid: chosen.QuoteID,
    secucode: `${code}.${suffix}`,
    query: raw,
    resolvedName: chosen.Name
  };
}

function scale(value, digits = 2) {
  if (value === undefined || value === null || value === "-" || Number.isNaN(Number(value))) return null;
  return Number(value) / 10 ** digits;
}

function rawNumber(value) {
  if (value === undefined || value === null || value === "-" || Number.isNaN(Number(value))) return null;
  return Number(value);
}

function fundCode(input) {
  const match = String(input || "").trim().match(/(\d{6})/);
  return match ? match[1] : null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, timeoutMs = 10000, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "accept": "application/json,text/plain,*/*",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          "referer": "https://quote.eastmoney.com/",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 AShareRiskPanel/1.0"
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const body = text.replace(/^[^(]*\(/, "").replace(/\);?$/, "");
      return JSON.parse(body);
    } catch (error) {
      lastError = error;
      if (attempt < retries) await wait(350 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function fetchText(url, timeoutMs = 10000, retries = 2, encoding = "utf-8", referer = "https://gu.qq.com/") {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "accept": "text/plain,*/*",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          "referer": referer,
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 AShareRiskPanel/1.0"
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      return new TextDecoder(encoding).decode(buffer);
    } catch (error) {
      lastError = error;
      if (attempt < retries) await wait(350 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function fetchFundEstimate(code) {
  const text = await fetchText(
    `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`,
    5000,
    1,
    "utf-8",
    "https://fund.eastmoney.com/"
  );
  const match = text.match(/jsonpgz\((.*)\);?/);
  if (!match) throw new Error("基金估算接口返回异常");
  const data = JSON.parse(match[1]);
  if (!data?.fundcode) throw new Error("没有找到这只基金，请确认基金代码。");
  return {
    code: data.fundcode,
    name: data.name || code,
    latestNetValue: rawNumber(data.dwjz),
    latestNetValueDate: data.jzrq || null,
    estimateValue: rawNumber(data.gsz),
    estimatePct: rawNumber(data.gszzl),
    estimateTime: data.gztime || null
  };
}

function marketPrefix(code) {
  if (code.startsWith("6")) return "sh";
  if (code.startsWith("8") || code.startsWith("4")) return "bj";
  return "sz";
}

function displayName(normalized) {
  return normalized.resolvedName || KNOWN_STOCKS.find((item) => item.code === normalized.code)?.name || normalized.code;
}

async function fetchTencentQuote(normalized) {
  const prefix = marketPrefix(normalized.code);
  const text = await fetchText(`https://qt.gtimg.cn/q=${prefix}${normalized.code}`, 5000, 1, "gbk");
  const match = text.match(/"(.*)"/);
  if (!match) throw new Error("备用行情接口返回异常");
  const parts = match[1].split("~");
  const price = rawNumber(parts[3]);
  if (!price) throw new Error("备用行情接口未返回有效价格");
  return {
    code: parts[2] || normalized.code,
    name: parts[1] || normalized.resolvedName || normalized.code,
    price,
    open: rawNumber(parts[5]),
    high: rawNumber(parts[33]) || rawNumber(parts[41]),
    low: rawNumber(parts[34]) || rawNumber(parts[42]),
    previousClose: rawNumber(parts[4]),
    amount: rawNumber(parts[37]) ? rawNumber(parts[37]) * 10000 : null,
    volume: rawNumber(parts[36]),
    marketCap: rawNumber(parts[44]) ? rawNumber(parts[44]) * 100000000 : null,
    floatMarketCap: rawNumber(parts[45]) ? rawNumber(parts[45]) * 100000000 : null,
    pe: rawNumber(parts[52]),
    pb: rawNumber(parts[46]),
    turnover: rawNumber(parts[38]),
    pctChange: rawNumber(parts[32]),
    amplitude: rawNumber(parts[43]),
    volumeRatio: rawNumber(parts[49])
  };
}

async function fetchSinaRaw(symbols) {
  const list = Array.isArray(symbols) ? symbols.join(",") : symbols;
  const text = await fetchText(
    `https://hq.sinajs.cn/list=${list}`,
    5000,
    1,
    "gbk",
    "https://finance.sina.com.cn/"
  );
  return text.split(/\r?\n/).filter(Boolean);
}

async function fetchSinaQuote(normalized) {
  const prefix = marketPrefix(normalized.code);
  const [text] = await fetchSinaRaw(`${prefix}${normalized.code}`);
  const match = text.match(/="([^"]*)"/);
  if (!match || !match[1]) throw new Error("新浪备用行情接口返回异常");
  const parts = match[1].split(",");
  const price = rawNumber(parts[3]);
  const previousClose = rawNumber(parts[2]);
  const high = rawNumber(parts[4]);
  const low = rawNumber(parts[5]);
  if (!price) throw new Error("新浪备用行情接口未返回有效价格");
  return {
    code: normalized.code,
    name: parts[0] || displayName(normalized),
    price,
    open: rawNumber(parts[1]),
    high,
    low,
    previousClose,
    amount: rawNumber(parts[9]),
    volume: rawNumber(parts[8]) ? rawNumber(parts[8]) / 100 : null,
    marketCap: null,
    floatMarketCap: null,
    pe: null,
    pb: null,
    turnover: null,
    pctChange: previousClose ? Number((((price - previousClose) / previousClose) * 100).toFixed(2)) : null,
    amplitude: previousClose && high && low ? Number((((high - low) / previousClose) * 100).toFixed(2)) : null,
    volumeRatio: null
  };
}

async function fetchSinaIndexQuote(symbol, label) {
  const [text] = await fetchSinaRaw(symbol);
  const match = text?.match(/="([^"]*)"/);
  if (!match || !match[1]) throw new Error("新浪指数接口返回异常");
  const parts = match[1].split(",");
  const price = rawNumber(parts[3]);
  const previousClose = rawNumber(parts[2]);
  const high = rawNumber(parts[4]);
  const low = rawNumber(parts[5]);
  const code = symbol.slice(2);
  return {
    label,
    code,
    name: parts[0] || label,
    price,
    pctChange: previousClose ? Number((((price - previousClose) / previousClose) * 100).toFixed(2)) : null,
    amplitude: previousClose && high && low ? Number((((high - low) / previousClose) * 100).toFixed(2)) : null,
    previousClose
  };
}

function buildReferenceQuote(normalized, input) {
  const snapshot = SNAPSHOT_QUOTES[normalized.code];
  const price = input.entryPrice || snapshot?.price;
  if (!price) return null;
  const previousClose = snapshot?.previousClose || price;
  const high = snapshot?.high || price;
  const low = snapshot?.low || price;
  return {
    code: normalized.code,
    name: snapshot?.name || displayName(normalized),
    price,
    open: snapshot?.open || price,
    high,
    low,
    previousClose,
    amount: snapshot?.amount || null,
    volume: snapshot?.volume || null,
    marketCap: snapshot?.marketCap || null,
    floatMarketCap: snapshot?.floatMarketCap || null,
    pe: snapshot?.pe || null,
    pb: snapshot?.pb || null,
    turnover: snapshot?.turnover || null,
    pctChange: snapshot?.pctChange ?? (previousClose ? Number((((price - previousClose) / previousClose) * 100).toFixed(2)) : null),
    amplitude: snapshot?.amplitude ?? (previousClose ? Number((((high - low) / previousClose) * 100).toFixed(2)) : null),
    volumeRatio: snapshot?.volumeRatio || null,
    isReferenceOnly: true,
    referenceNote: snapshot?.snapshotAt || "按用户输入买入价生成参考分析"
  };
}

function safeDecodePathname(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function fallbackTrendStats(quote) {
  const range = quote.high && quote.low ? quote.high - quote.low : quote.price * 0.025;
  return {
    ma5: null,
    ma20: null,
    ma60: null,
    recentLow20: quote.low || Number((quote.price * 0.97).toFixed(2)),
    recentHigh20: quote.high || Number((quote.price * 1.03).toFixed(2)),
    atr14: Math.max(range, quote.price * 0.015),
    volumeRatio: quote.volumeRatio,
    distanceMa20: null,
    latestDate: null
  };
}

function parseKlines(rows = []) {
  return rows.map((line) => {
    const [date, open, close, high, low, volume, amount, amplitude, pct, change, turnover] = String(line).split(",");
    return {
      date,
      open: Number(open),
      close: Number(close),
      high: Number(high),
      low: Number(low),
      volume: Number(volume),
      amount: Number(amount),
      amplitude: Number(amplitude),
      pct: Number(pct),
      change: Number(change),
      turnover: Number(turnover)
    };
  }).filter((item) => Number.isFinite(item.close));
}

function avg(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function last(items, count) {
  return items.slice(Math.max(0, items.length - count));
}

function calcAtr(klines, period = 14) {
  const rows = last(klines, period + 1);
  if (rows.length < 2) return null;
  const trs = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prevClose = rows[i - 1].close;
    trs.push(Math.max(
      rows[i].high - rows[i].low,
      Math.abs(rows[i].high - prevClose),
      Math.abs(rows[i].low - prevClose)
    ));
  }
  return avg(trs);
}

function trendStats(klines, price) {
  const closes = klines.map((item) => item.close);
  const lows = klines.map((item) => item.low);
  const highs = klines.map((item) => item.high);
  const ma5 = avg(last(closes, 5));
  const ma20 = avg(last(closes, 20));
  const ma60 = avg(last(closes, 60));
  const recentLow20 = Math.min(...last(lows, 20));
  const recentHigh20 = Math.max(...last(highs, 20));
  const atr14 = calcAtr(klines, 14);
  const latest = klines.at(-1);
  const previous = klines.at(-2);
  const volumeRatio = previous?.volume ? latest.volume / previous.volume : null;
  const distanceMa20 = ma20 ? ((price - ma20) / ma20) * 100 : null;

  return {
    ma5,
    ma20,
    ma60,
    recentLow20: Number.isFinite(recentLow20) ? recentLow20 : null,
    recentHigh20: Number.isFinite(recentHigh20) ? recentHigh20 : null,
    atr14,
    volumeRatio,
    distanceMa20,
    latestDate: latest?.date || null
  };
}

function scoreAnalysis({ quote, finance, trend, input }) {
  const positives = [];
  const warnings = [];
  const checklist = [];
  let total = 0;
  const parts = {
    fundamentals: 0,
    valuation: 0,
    trend: 0,
    risk: 0
  };

  const add = (bucket, points, text, good = true) => {
    parts[bucket] += points;
    total += points;
    checklist.push({ bucket, points, text, good });
    (good ? positives : warnings).push(text);
  };

  if (finance) {
    if (finance.revenueGrowth > 10) add("fundamentals", 12, "营收增速较好，说明业务仍有扩张。");
    else if (finance.revenueGrowth > 0) add("fundamentals", 7, "营收仍在增长，但速度一般。");
    else add("fundamentals", -8, "营收同比下滑，需要警惕基本面压力。", false);

    if (finance.netProfitGrowth > 10) add("fundamentals", 12, "归母净利润增速较好。");
    else if (finance.netProfitGrowth > 0) add("fundamentals", 7, "归母净利润小幅增长。");
    else add("fundamentals", -10, "归母净利润同比下滑，短线反弹也要控制仓位。", false);

    if (finance.roe > 15) add("fundamentals", 10, "ROE 高于 15%，盈利质量较强。");
    else if (finance.roe > 8) add("fundamentals", 6, "ROE 处在可接受区间。");
    else add("fundamentals", -5, "ROE 偏低，资金效率一般。", false);

    if (finance.cashToRevenue > 0.08) add("fundamentals", 6, "经营现金流/营收为正，回款情况相对健康。");
    else if (finance.cashToRevenue > 0) add("fundamentals", 3, "经营现金流为正，但并不突出。");
    else add("fundamentals", -8, "经营现金流为负，财务质量要重点复查。", false);
  } else {
    warnings.push("财务数据未取到，本次判断会明显降低可信度。");
  }

  if (quote.pe && quote.pe > 0) {
    if (quote.pe < 18) add("valuation", 10, "市盈率处在偏低区间。");
    else if (quote.pe < 35) add("valuation", 6, "市盈率处在中等区间。");
    else if (quote.pe < 60) add("valuation", 1, "市盈率偏高，需要确认增长能否支撑估值。", false);
    else add("valuation", -8, "市盈率很高，追高风险较大。", false);
  } else {
    add("valuation", -7, "市盈率为负或缺失，可能亏损或口径不可用。", false);
  }

  if (quote.pb && quote.pb > 0) {
    if (quote.pb < 2.5) add("valuation", 8, "市净率较低，估值保护相对好。");
    else if (quote.pb < 6) add("valuation", 4, "市净率中等。");
    else add("valuation", -5, "市净率偏高，对回撤更敏感。", false);
  }

  if (trend.ma20 && trend.ma60) {
    if (quote.price > trend.ma20 && trend.ma20 > trend.ma60) add("trend", 18, "价格在 20 日线之上且 20 日线高于 60 日线，趋势较顺。");
    else if (quote.price > trend.ma20) add("trend", 8, "价格站上 20 日线，但中期趋势还不够确认。");
    else add("trend", -10, "价格低于 20 日线，短线趋势偏弱。", false);
  }

  if (trend.distanceMa20 !== null) {
    if (trend.distanceMa20 > 12) add("risk", -12, "价格离 20 日线过远，短线容易回撤。", false);
    else if (trend.distanceMa20 > 6) add("risk", -5, "价格离 20 日线略远，不适合重仓追。", false);
    else if (trend.distanceMa20 > -5) add("risk", 6, "价格没有明显脱离 20 日线，入场位置相对克制。");
  }

  if (quote.pctChange !== null) {
    if (quote.pctChange > 7) add("risk", -10, "当日涨幅过大，追涨风险明显。", false);
    else if (quote.pctChange < -5) add("risk", -5, "当日跌幅较大，需确认是否有利空。", false);
  }

  if (quote.turnover !== null) {
    if (quote.turnover > 15) add("risk", -8, "换手率过高，筹码波动大。", false);
    else if (quote.turnover > 1 && quote.turnover < 8) add("risk", 4, "换手率没有异常失控。");
  }

  if (input.style === "short") {
    total -= 4;
    warnings.push("你选择短线模式，系统默认收紧仓位，防止连续交易扩大亏损。");
  }

  const normalized = Math.max(0, Math.min(100, Math.round(total + 35)));
  let verdict = "回避";
  let tone = "danger";
  let multiplier = 0;
  if (normalized >= 76) {
    verdict = "可小仓试仓";
    tone = "good";
    multiplier = 0.75;
  } else if (normalized >= 62) {
    verdict = "观察后轻仓";
    tone = "watch";
    multiplier = 0.45;
  } else if (normalized >= 48) {
    verdict = "只观察";
    tone = "caution";
    multiplier = 0.15;
  }

  if (warnings.length >= 5 && multiplier > 0.45) multiplier = 0.45;
  return { score: normalized, verdict, tone, multiplier, positives, warnings, checklist, parts };
}

function buildOperationGuide({ quote, trend, analysis, plan, input }) {
  const entry = plan.entry || quote.price;
  const holdingCost = input.holdingCost;
  const hasHolding = Number.isFinite(holdingCost) && holdingCost > 0;
  const pnlPerShare = hasHolding ? Number((quote.price - holdingCost).toFixed(3)) : null;
  const pnlPct = hasHolding ? Number((((quote.price - holdingCost) / holdingCost) * 100).toFixed(2)) : null;
  const atr = trend.atr14 || quote.price * 0.015;
  const ma20 = trend.ma20 || entry;
  const recentHigh = trend.recentHigh20 || quote.high || entry;
  const pullbackLow = Number(Math.max(plan.stop, ma20 - atr * 0.25).toFixed(2));
  const pullbackHigh = Number(Math.max(pullbackLow, ma20 + atr * 0.45).toFixed(2));
  const chaseLine = Number((recentHigh + atr * 0.35).toFixed(2));
  const takeProfit1 = Number((recentHigh + atr * 1.0).toFixed(2));
  const takeProfit2 = Number((recentHigh + atr * 2.4).toFixed(2));
  const reduceLine = Number(Math.max(plan.stop, ma20).toFixed(2));
  const protectLine = hasHolding ? Number(Math.max(holdingCost, reduceLine - atr * 0.25).toFixed(3)) : reduceLine;
  const isExtended = trend.distanceMa20 !== null && trend.distanceMa20 > 3;
  const isStrong = quote.price >= ma20 && (!trend.ma60 || ma20 >= trend.ma60);

  let headline = "等回踩，不追高";
  let stance = "watch";
  let summary = "趋势仍可观察，但现价离短线支撑不算近，新仓更适合等回踩确认。";
  if (analysis.tone === "danger") {
    headline = "先观察，不开新仓";
    stance = "danger";
    summary = "综合信号偏弱，先等价格重新站稳关键均线，再考虑仓位。";
  } else if (isStrong && !isExtended) {
    headline = "可按计划小仓试";
    stance = "good";
    summary = "价格站在短中期趋势上方，若仓位轻，可以按面板仓位分批，不一次买满。";
  } else if (isStrong && isExtended) {
    headline = "强势但不追";
    stance = "caution";
    summary = "趋势偏强，但短线已经离支撑较远，追涨的盈亏比一般。";
  }
  if (hasHolding) {
    if (pnlPct >= 1.5) {
      headline = "已有浮盈，守利润";
      stance = isExtended ? "caution" : "good";
      summary = `你的成本 ${holdingCost}，当前每股浮盈约 ${pnlPerShare} 元，浮盈 ${pnlPct}%。重点从买入切换到保护利润。`;
    } else if (pnlPct >= 0) {
      headline = "接近成本，先守住";
      stance = "watch";
      summary = `你的成本 ${holdingCost}，当前小幅浮盈 ${pnlPct}%。先看能否站稳成本上方，不急加仓。`;
    } else {
      headline = "浮亏中，先控风险";
      stance = "danger";
      summary = `你的成本 ${holdingCost}，当前浮亏 ${Math.abs(pnlPct)}%。不要急着补仓，先等重新站回成本或关键均线。`;
    }
  }

  const maxShares = plan.suggestedShares;
  const firstBatch = Math.max(0, Math.floor((maxShares * 0.5) / 100) * 100);
  const secondBatch = Math.max(0, maxShares - firstBatch);

  return {
    stance,
    headline,
    summary,
    zones: [
      ...(hasHolding ? [{ label: "你的持仓成本", value: holdingCost.toFixed(3), tone: pnlPct >= 0 ? "good" : "danger" }] : []),
      ...(hasHolding ? [{ label: "浮盈/浮亏", value: `${pnlPerShare}元 / ${pnlPct}%`, tone: pnlPct >= 0 ? "good" : "danger" }] : []),
      { label: "回踩观察区", value: `${pullbackLow}-${pullbackHigh}`, tone: "watch" },
      { label: "强势确认线", value: chaseLine, tone: "good" },
      { label: hasHolding ? "利润保护线" : "减仓警戒线", value: hasHolding ? protectLine.toFixed(3) : reduceLine, tone: "caution" },
      { label: "纪律止损线", value: plan.stop, tone: "danger" },
      { label: "第一止盈区", value: takeProfit1, tone: "good" },
      { label: "强势目标区", value: takeProfit2, tone: "watch" }
    ],
    steps: [
      {
        label: "没持仓",
        text: `不在大涨后追。等回踩 ${pullbackLow}-${pullbackHigh} 附近不破，再考虑第一笔 ${firstBatch || 100} 股以内。`,
        tone: "watch"
      },
      {
        label: "已持仓",
        text: hasHolding
          ? `只要收盘不跌破 ${protectLine}，先拿；若冲到 ${takeProfit1} 附近涨不动，可先落袋一部分。`
          : `只要收盘不跌破 ${reduceLine}，先拿；若冲到 ${takeProfit1} 附近涨不动，可先落袋一部分。`,
        tone: "good"
      },
      {
        label: "想加仓",
        text: `只有放量站稳 ${chaseLine} 或回踩不破 20 日线时再加，第二笔不超过 ${secondBatch || 100} 股。`,
        tone: "caution"
      },
      {
        label: "必须认错",
        text: hasHolding
          ? `跌破 ${protectLine} 不要补仓摊平，先退出复盘；盈利单不要拖成亏损单。`
          : `跌破 ${plan.stop} 不要补仓摊平，先退出复盘；这是为了防止小亏变大亏。`,
        tone: "danger"
      }
    ],
    note: input.style === "short" ? "短线模式下，止盈和止损都要更快执行。" : "波段模式下，重点看收盘价是否守住关键区间。"
  };
}

function calcPlan({ quote, trend, analysis, input }) {
  const entry = input.entryPrice || quote.price;
  const levels = [];
  if (trend.atr14) levels.push({ label: "2ATR 波动止损", value: entry - trend.atr14 * 2 });
  if (trend.ma20) levels.push({ label: "20 日线下方 2%", value: trend.ma20 * 0.98 });
  if (trend.recentLow20) levels.push({ label: "20 日低点下方 1.5%", value: trend.recentLow20 * 0.985 });
  levels.push({ label: "固定 7% 防守线", value: entry * 0.93 });

  const valid = levels
    .map((item) => ({ ...item, value: Number(item.value.toFixed(2)) }))
    .filter((item) => item.value > 0 && item.value < entry);

  let stop = valid.length ? Math.max(...valid.map((item) => item.value)) : entry * 0.93;
  if ((entry - stop) / entry < 0.025) stop = entry * 0.975;
  stop = Number(stop.toFixed(2));

  const riskPerShare = Math.max(entry - stop, 0);
  const riskBudget = input.capital * (input.riskPct / 100);
  const positionCap = input.capital * (input.maxPositionPct / 100);
  const byRisk = riskPerShare > 0 ? Math.floor(riskBudget / riskPerShare) : 0;
  const byCapital = entry > 0 ? Math.floor(positionCap / entry) : 0;
  const baseShares = Math.min(byRisk, byCapital);
  const suggestedShares = Math.max(0, Math.floor((baseShares * analysis.multiplier) / 100) * 100);
  const suggestedCapital = suggestedShares * entry;
  const plannedRisk = suggestedShares * riskPerShare;
  const lossPct = entry ? ((entry - stop) / entry) * 100 : 0;

  const reasons = [];
  if (suggestedShares === 0) reasons.push("当前分数或资金/风险预算不足，不建议系统生成买入仓位。");
  if (lossPct > 9) reasons.push("止损距离偏大，除非等待更好买点，否则仓位应继续压低。");
  if (analysis.tone === "danger") reasons.push("综合信号偏弱，先复盘逻辑，不急于交易。");

  return {
    entry: Number(entry.toFixed(2)),
    stop,
    lossPct: Number(lossPct.toFixed(2)),
    riskPerShare: Number(riskPerShare.toFixed(2)),
    riskBudget: Number(riskBudget.toFixed(2)),
    maxPositionValue: Number(positionCap.toFixed(2)),
    suggestedShares,
    suggestedCapital: Number(suggestedCapital.toFixed(2)),
    plannedRisk: Number(plannedRisk.toFixed(2)),
    levels: valid,
    reasons
  };
}

async function fetchIndexQuote(secid, label) {
  const fields = "f43,f57,f58,f60,f170,f171,f152";
  const body = await fetchJson(`https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}`, 5000, 1);
  const data = body?.data || {};
  const decimals = rawNumber(data.f152) ?? 2;
  return {
    label,
    code: data.f57,
    name: data.f58 || label,
    price: scale(data.f43, decimals),
    pctChange: scale(data.f170, 2),
    amplitude: scale(data.f171, 2),
    previousClose: scale(data.f60, decimals)
  };
}

async function fetchIndexQuoteSafe(secid, label, sinaSymbol) {
  try {
    return await fetchIndexQuote(secid, label);
  } catch {
    return fetchSinaIndexQuote(sinaSymbol, label);
  }
}

async function fetchMarketRows() {
  const base = "https://push2.eastmoney.com/api/qt/clist/get";
  const fields = "f12,f14,f2,f3,f8,f9,f23,f20,f21,f62,f100";
  const fs = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23";
  const firstUrl = `${base}?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${fs}&fields=${fields}`;
  const first = await fetchJson(firstUrl, 5000, 1);
  const total = Math.min(rawNumber(first?.data?.total) || 0, 6000);
  const pageCount = Math.max(1, Math.min(60, Math.ceil(total / 100)));
  const urls = Array.from({ length: pageCount }, (_, index) => (
    `${base}?pn=${index + 1}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${fs}&fields=${fields}`
  ));
  const results = await Promise.allSettled(urls.map((url) => fetchJson(url, 5000, 1)));
  const rows = results.flatMap((result) => (
    result.status === "fulfilled" ? (result.value?.data?.diff || []) : []
  ));
  return rows.length ? rows : (first?.data?.diff || []);
}

async function fetchMarketRowsSafe() {
  try {
    return await fetchMarketRows();
  } catch {
    return [];
  }
}

function buildMarketOutlook({ indices, breadth, score, label }) {
  const sh = indices[0];
  const support = sh?.price >= 4000 ? "4000 点" : "前低区域";
  const pressure = sh?.price >= 4000 ? "4050-4060 点" : "4000 点";
  const upRatio = breadth.upRatio ?? 0;
  let bias = "震荡修复";
  let summary = `涨跌家数偏均衡，先按 ${support} 上方震荡修复看。`;
  if (score >= 78 || upRatio >= 68) {
    bias = "反弹升温";
    summary = `上涨家数占比约 ${fmtPercent(upRatio)}，三大指数同步收红，短线情绪明显回暖。`;
  } else if (score <= 35 || upRatio <= 35) {
    bias = "防守等待";
    summary = `上涨家数占比约 ${fmtPercent(upRatio)}，市场承接不足，先降低交易频率。`;
  }

  return {
    bias,
    summary,
    next: `后市先看上证能否守住 ${support}；若放量站稳 ${pressure}，反弹有机会延续，否则容易回到震荡。`,
    strategy: label.action,
    levels: [
      { label: "上证防守线", value: support },
      { label: "上方压力区", value: pressure },
      { label: "交易节奏", value: score >= 78 ? "不追高，等回踩" : "轻仓试错" }
    ]
  };
}

function fmtPercent(value) {
  if (!Number.isFinite(Number(value))) return "--";
  return `${Number(value).toFixed(1)}%`;
}

function emotionLabel(score) {
  if (score >= 78) return { stage: "情绪高潮", tone: "danger", action: "不追高，先保护利润；新仓只看回踩，不做满仓。" };
  if (score >= 62) return { stage: "情绪升温", tone: "good", action: "可以小仓试错，但只买有计划、有止损的票。" };
  if (score >= 45) return { stage: "震荡试错", tone: "watch", action: "轻仓观察，等板块和个股信号更一致。" };
  if (score >= 30) return { stage: "情绪退潮", tone: "caution", action: "降低交易频率，优先防守股，不接高位票。" };
  return { stage: "冰点防守", tone: "cold", action: "先别急着买，等止跌和放量修复。" };
}

export async function analyzeEmotionCycle() {
  const [sh, sz, cy, rows] = await Promise.all([
    fetchIndexQuoteSafe("1.000001", "上证指数", "sh000001"),
    fetchIndexQuoteSafe("0.399001", "深证成指", "sz399001"),
    fetchIndexQuoteSafe("0.399006", "创业板指", "sz399006"),
    fetchMarketRowsSafe()
  ]);

  const valid = rows.filter((item) => Number.isFinite(Number(item.f3)) && Number.isFinite(Number(item.f2)));
  const up = valid.filter((item) => item.f3 > 0).length;
  const down = valid.filter((item) => item.f3 < 0).length;
  const flat = Math.max(0, valid.length - up - down);
  const strongUp = valid.filter((item) => item.f3 >= 9.5).length;
  const strongDown = valid.filter((item) => item.f3 <= -9.5).length;
  const hotCount = valid.filter((item) => item.f3 >= 5).length;
  const coldCount = valid.filter((item) => item.f3 <= -5).length;
  const activeTurnover = valid.filter((item) => Number(item.f8) >= 10).length;
  const avgIndexPct = avg([sh.pctChange, sz.pctChange, cy.pctChange]) || 0;
  const breadth = valid.length ? up / valid.length : 0.5;

  const industryMap = new Map();
  for (const item of valid) {
    const industry = item.f100 || "其他";
    if (!industryMap.has(industry)) industryMap.set(industry, { industry, count: 0, totalPct: 0, up: 0 });
    const target = industryMap.get(industry);
    target.count += 1;
    target.totalPct += Number(item.f3);
    if (item.f3 > 0) target.up += 1;
  }
  const industries = Array.from(industryMap.values())
    .filter((item) => item.count >= 8)
    .map((item) => ({
      industry: item.industry,
      count: item.count,
      avgPct: Number((item.totalPct / item.count).toFixed(2)),
      upRatio: Number(((item.up / item.count) * 100).toFixed(1))
    }))
    .sort((a, b) => b.avgPct - a.avgPct)
    .slice(0, 8);

  let score = 50;
  score += (breadth - 0.5) * 80;
  score += Math.max(-18, Math.min(18, avgIndexPct * 8));
  score += Math.min(12, hotCount / 18);
  score -= Math.min(12, coldCount / 18);
  score += Math.min(8, strongUp / 12);
  score -= Math.min(8, strongDown / 12);
  score += activeTurnover > 420 ? 4 : activeTurnover < 180 ? -4 : 0;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const label = emotionLabel(score);
  const breadthData = {
    total: valid.length,
    up,
    down,
    flat,
    upRatio: Number((breadth * 100).toFixed(1)),
    strongUp,
    strongDown,
    hotCount,
    coldCount,
    activeTurnover
  };
  return {
    updatedAt: new Date().toISOString(),
    source: "东方财富公开接口",
    score,
    ...label,
    indices: [sh, sz, cy],
    breadth: breadthData,
    marketOutlook: buildMarketOutlook({ indices: [sh, sz, cy], breadth: breadthData, score, label }),
    hotIndustries: industries,
    steadyWatchlist: STEADY_WATCHLIST
  };
}

function parseFundItems(rawItems, params) {
  const items = String(rawItems || "")
    .split(/[\n,;]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [code, cost, shares] = item.split(":").map((part) => part?.trim());
      return {
        code: fundCode(code),
        cost: rawNumber(cost),
        shares: rawNumber(shares)
      };
    })
    .filter((item) => item.code);

  if (items.length) return items;
  const code = fundCode(params.get("code"));
  if (!code) return [];
  return [{
    code,
    cost: rawNumber(params.get("cost")),
    shares: rawNumber(params.get("shares"))
  }];
}

function fundAdvice(row) {
  if (row.error) return { tone: "danger", headline: "读取失败", text: row.error };
  const hasHolding = Number.isFinite(row.cost) && Number.isFinite(row.shares) && row.shares > 0;
  if (!hasHolding) {
    return {
      tone: "watch",
      headline: "仅观察估算",
      text: "未填写成本和份额，本次只展示估算涨幅，不计算持仓盈亏。"
    };
  }
  if (row.totalPnlPct >= 10) {
    return {
      tone: "good",
      headline: "已有较多浮盈",
      text: "可以继续持有，但要考虑分批止盈规则，避免估算回撤吞掉利润。"
    };
  }
  if (row.totalPnlPct >= 3) {
    return {
      tone: "good",
      headline: "浮盈中",
      text: "持有观察，若对应板块连续冲高，避免继续追买。"
    };
  }
  if (row.totalPnlPct <= -8) {
    return {
      tone: "danger",
      headline: "亏损偏大",
      text: "先控制仓位，不建议盲目补仓；等净值企稳或分批规则触发再处理。"
    };
  }
  if (row.estimatePct < -1.5) {
    return {
      tone: "caution",
      headline: "今日估算偏弱",
      text: "先等晚上正式净值确认，短线不要因为盘中估算波动频繁操作。"
    };
  }
  return {
    tone: "watch",
    headline: "接近成本区",
    text: "以观察为主；场外基金更适合按周/月复盘，不按分钟级波动交易。"
  };
}

export async function analyzeFunds(params) {
  const items = parseFundItems(params.get("items"), params);
  if (!items.length) {
    const err = new Error("请输入基金代码，或按“代码:成本:份额”格式输入多只基金。");
    err.status = 400;
    throw err;
  }

  const results = await Promise.all(items.slice(0, 20).map(async (item) => {
    try {
      const quote = await fetchFundEstimate(item.code);
      const estimateValue = quote.estimateValue ?? quote.latestNetValue;
      const hasHolding = Number.isFinite(item.cost) && Number.isFinite(item.shares) && item.shares > 0 && Number.isFinite(estimateValue);
      const marketValue = hasHolding ? estimateValue * item.shares : null;
      const costValue = hasHolding ? item.cost * item.shares : null;
      const totalPnl = hasHolding ? marketValue - costValue : null;
      const totalPnlPct = hasHolding && costValue ? (totalPnl / costValue) * 100 : null;
      const todayEstimatedPnl = hasHolding && Number.isFinite(quote.latestNetValue)
        ? (estimateValue - quote.latestNetValue) * item.shares
        : null;
      const row = {
        ...quote,
        cost: item.cost,
        shares: item.shares,
        marketValue: marketValue === null ? null : Number(marketValue.toFixed(2)),
        totalPnl: totalPnl === null ? null : Number(totalPnl.toFixed(2)),
        totalPnlPct: totalPnlPct === null ? null : Number(totalPnlPct.toFixed(2)),
        todayEstimatedPnl: todayEstimatedPnl === null ? null : Number(todayEstimatedPnl.toFixed(2)),
        isEstimated: true
      };
      return {
        ...row,
        advice: fundAdvice(row)
      };
    } catch (error) {
      const row = { code: item.code, cost: item.cost, shares: item.shares, error: error.message || "基金估算失败" };
      return { ...row, advice: fundAdvice(row) };
    }
  }));

  const totalMarketValue = results.reduce((sum, item) => sum + (Number(item.marketValue) || 0), 0);
  const totalPnl = results.reduce((sum, item) => sum + (Number(item.totalPnl) || 0), 0);
  const todayEstimatedPnl = results.reduce((sum, item) => sum + (Number(item.todayEstimatedPnl) || 0), 0);

  return {
    updatedAt: new Date().toISOString(),
    source: "东方财富基金估算接口",
    warning: "场外基金盘中为估算净值，不是最终收益；晚上正式净值更新后才是准确涨跌幅。",
    totals: {
      marketValue: Number(totalMarketValue.toFixed(2)),
      totalPnl: Number(totalPnl.toFixed(2)),
      todayEstimatedPnl: Number(todayEstimatedPnl.toFixed(2))
    },
    funds: results
  };
}

export async function analyzeStock(params) {
  const normalized = await resolveStockInput(params.get("code"));
  if (!normalized) {
    const err = new Error("请输入 6 位 A 股代码或股票名称，例如 600519、贵州茅台。");
    err.status = 400;
    throw err;
  }

  const input = {
    capital: Math.max(0, Number(params.get("capital") || 100000)),
    riskPct: Math.min(5, Math.max(0.1, Number(params.get("riskPct") || 1))),
    maxPositionPct: Math.min(80, Math.max(1, Number(params.get("maxPositionPct") || 20))),
    entryPrice: Number(params.get("entryPrice") || 0) || null,
    holdingCost: Number(params.get("holdingCost") || 0) || null,
    style: params.get("style") === "short" ? "short" : "swing"
  };

  const quoteFields = "f43,f44,f45,f46,f47,f48,f57,f58,f60,f116,f117,f162,f167,f168,f170,f171,f173,f152";
  const quoteUrl = `https://push2.eastmoney.com/api/qt/stock/get?secid=${normalized.secid}&fields=${quoteFields}`;
  const klineUrl = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${normalized.secid}&ut=fa5fd1943c7b386f172d6893dbfba10b&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=120`;
  const financeUrl = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=REPORT_DATE&sortTypes=-1&pageSize=1&pageNumber=1&reportName=RPT_F10_FINANCE_MAINFINADATA&columns=ALL&filter=(SECUCODE%3D%22${normalized.secucode}%22)`;

  const [quoteResult, klineResult, financeResult] = await Promise.allSettled([
    fetchJson(quoteUrl, 5000, 1),
    fetchJson(klineUrl, 5000, 1),
    fetchJson(financeUrl, 5000, 1)
  ]);

  const dataWarnings = [];
  let quoteBody = quoteResult.status === "fulfilled" ? quoteResult.value : null;
  let quote;
  if (!quoteBody?.data?.f57) {
    dataWarnings.push("主行情接口暂时不稳定，本次尝试备用行情源。");
    try {
      quote = await fetchTencentQuote(normalized);
      dataWarnings.push("本次行情来自腾讯备用源，PE/PB 等估值口径可能与主源不同。");
    } catch {
      try {
        quote = await fetchSinaQuote(normalized);
        dataWarnings.push("本次行情来自新浪备用源，PE/PB 和换手率可能缺失。");
      } catch {
        quote = buildReferenceQuote(normalized, input);
        if (quote) {
          dataWarnings.push("实时行情源全部暂时不可用，本次使用参考价兜底，只能用于仓位和止损演示，不能直接下单。");
        }
      }
    }
  }

  if (!quoteBody?.data?.f57 && !quote?.code) {
    const err = new Error("实时行情源暂时不可用，系统还没有足够价格数据生成仓位和止损。请稍后重试，或先填写你的计划买入价。");
    err.status = 503;
    throw err;
  }

  if (!quote) {
    const decimals = rawNumber(quoteBody.data.f152) ?? 2;
    quote = {
      code: quoteBody.data.f57,
      name: quoteBody.data.f58,
      price: scale(quoteBody.data.f43, decimals),
      open: scale(quoteBody.data.f46, decimals),
      high: scale(quoteBody.data.f44, decimals),
      low: scale(quoteBody.data.f45, decimals),
      previousClose: scale(quoteBody.data.f60, decimals),
      amount: rawNumber(quoteBody.data.f48),
      volume: rawNumber(quoteBody.data.f47),
      marketCap: rawNumber(quoteBody.data.f116),
      floatMarketCap: rawNumber(quoteBody.data.f117),
      pe: scale(quoteBody.data.f162, 2),
      pb: scale(quoteBody.data.f167, 2),
      turnover: scale(quoteBody.data.f168, 2),
      pctChange: scale(quoteBody.data.f170, 2),
      amplitude: scale(quoteBody.data.f171, 2),
      volumeRatio: rawNumber(quoteBody.data.f173)
    };
  }

  if (!quote.price) {
    const err = new Error("行情源没有返回有效价格，暂时无法计算仓位和止损。请稍后重试，或先填写你的计划买入价。");
    err.status = 503;
    throw err;
  }

  const klineBody = klineResult.status === "fulfilled" ? klineResult.value : null;
  const klines = parseKlines(klineBody?.data?.klines || []);
  if (klines.length < 30) {
    dataWarnings.push("日 K 数据接口暂时不稳定，趋势与止损使用降级算法。");
  }

  const financeBody = financeResult.status === "fulfilled" ? financeResult.value : null;
  if (!financeBody?.result?.data?.[0]) dataWarnings.push("财务接口暂时不稳定，本次财务评分可能偏保守。");
  const latestFinance = financeBody?.result?.data?.[0];
  const finance = latestFinance ? {
    reportName: latestFinance.REPORT_DATE_NAME,
    noticeDate: latestFinance.NOTICE_DATE?.slice(0, 10) || null,
    eps: rawNumber(latestFinance.EPSJB),
    roe: rawNumber(latestFinance.ROEJQ),
    grossMargin: rawNumber(latestFinance.XSMLL),
    netMargin: rawNumber(latestFinance.XSJLL),
    revenue: rawNumber(latestFinance.TOTALOPERATEREVE),
    netProfit: rawNumber(latestFinance.PARENTNETPROFIT),
    revenueGrowth: rawNumber(latestFinance.TOTALOPERATEREVETZ),
    netProfitGrowth: rawNumber(latestFinance.PARENTNETPROFITTZ),
    cashToRevenue: rawNumber(latestFinance.JYXJLYYSR)
  } : null;

  const trend = klines.length >= 30 ? trendStats(klines, quote.price) : fallbackTrendStats(quote);
  const analysis = scoreAnalysis({ quote, finance, trend, input });
  if (dataWarnings.length) {
    analysis.warnings.unshift(...dataWarnings);
    analysis.checklist.unshift(...dataWarnings.map((text) => ({
      bucket: "risk",
      points: 0,
      text,
      good: false
    })));
  }
  const plan = calcPlan({ quote, trend, analysis, input });
  const operation = buildOperationGuide({ quote, trend, analysis, plan, input });

  return {
    updatedAt: new Date().toISOString(),
    source: dataWarnings.length ? "东方财富公开接口 / 备用行情源" : "东方财富公开接口",
    dataWarnings,
    resolved: {
      query: normalized.query,
      code: normalized.code,
      name: normalized.resolvedName || quote.name
    },
    quote,
    finance,
    trend,
    analysis,
    plan,
    operation,
    klines: last(klines, 80)
  };
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : safeDecodePathname(url.pathname);
  if (!pathname) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Bad request");
    return;
  }
  const fullPath = path.normalize(path.join(publicDir, pathname));
  if (!fullPath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const body = await readFile(fullPath);
    const type = MIME[path.extname(fullPath)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

export function clientErrorMessage(error, fallback) {
  const message = error?.message || "";
  if (/fetch failed|aborted|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|HTTP 5\d\d/i.test(message)) {
    return "行情源暂时不稳定，请稍后重试；如果急着看仓位，可以填写 6 位股票代码和计划买入价。";
  }
  return message || fallback;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/emotion") {
    try {
      const data = await analyzeEmotionCycle();
      json(res, 200, data);
    } catch (error) {
      json(res, error.status || 500, {
        error: clientErrorMessage(error, "情绪周期分析失败，请稍后再试。")
      });
    }
    return;
  }

  if (url.pathname === "/api/analyze") {
    try {
      const data = await analyzeStock(url.searchParams);
      json(res, 200, data);
    } catch (error) {
      json(res, error.status || 500, {
        error: clientErrorMessage(error, "分析失败，请稍后再试。")
      });
    }
    return;
  }

  if (url.pathname === "/api/funds") {
    try {
      const data = await analyzeFunds(url.searchParams);
      json(res, 200, data);
    } catch (error) {
      json(res, error.status || 500, {
        error: clientErrorMessage(error, "基金估算失败，请稍后再试。")
      });
    }
    return;
  }
  await serveStatic(req, res);
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, () => {
    console.log(`A-share risk panel running at http://localhost:${PORT}`);
  });
}

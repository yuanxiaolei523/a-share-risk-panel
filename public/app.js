const form = document.querySelector("#analysisForm");
const statusBox = document.querySelector("#status");
const summary = document.querySelector("#summary");
const metrics = document.querySelector("#metrics");
const operationBox = document.querySelector("#operationBox");
const plan = document.querySelector("#plan");
const checklist = document.querySelector("#checklist");
const riskBox = document.querySelector("#riskBox");
const submitButton = form.querySelector("button");
const tabButtons = document.querySelectorAll(".tab-button");
const tabPages = document.querySelectorAll(".tab-page");
const refreshEmotionButton = document.querySelector("#refreshEmotion");
const fundForm = document.querySelector("#fundForm");
const fundSubmitButton = document.querySelector("#fundSubmit");
const fundStatus = document.querySelector("#fundStatus");
const fundTotals = document.querySelector("#fundTotals");
const fundList = document.querySelector("#fundList");
let emotionLoaded = false;
let fundsLoaded = false;

const yuan = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  maximumFractionDigits: 0
});

const num = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 2
});

function fmt(value, suffix = "") {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return `${num.format(Number(value))}${suffix}`;
}

function displayValue(value, suffix = "") {
  if (typeof value === "string") return value;
  return fmt(value, suffix);
}

function money(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return yuan.format(Number(value));
}

function signedMoney(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  const prefix = Number(value) > 0 ? "+" : "";
  return `${prefix}${money(value)}`;
}

function bigMoney(value) {
  if (!Number.isFinite(Number(value))) return "--";
  const n = Number(value);
  if (Math.abs(n) >= 1e8) return `${fmt(n / 1e8)} 亿`;
  if (Math.abs(n) >= 1e4) return `${fmt(n / 1e4)} 万`;
  return money(n);
}

function setText(id, value) {
  document.querySelector(`#${id}`).textContent = value;
}

function showLoading(text) {
  statusBox.className = "status";
  statusBox.textContent = text;
  submitButton.disabled = true;
}

function showError(text) {
  statusBox.className = "status error";
  statusBox.textContent = text;
}

function reveal() {
  [summary, metrics, operationBox, plan, checklist, riskBox].forEach((el) => el.classList.remove("hidden"));
}

function metric(label, value) {
  return `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`;
}

function renderMetrics(data) {
  const { quote, finance, trend } = data;
  metrics.innerHTML = [
    metric("现价 / 涨跌幅", `${fmt(quote.price)} / ${fmt(quote.pctChange, "%")}`),
    metric("PE / PB", `${fmt(quote.pe)} / ${fmt(quote.pb)}`),
    metric("换手率 / 量比", `${fmt(quote.turnover, "%")} / ${fmt(quote.volumeRatio)}`),
    metric("20 日线 / 60 日线", `${fmt(trend.ma20)} / ${fmt(trend.ma60)}`),
    metric("营收增速", finance ? fmt(finance.revenueGrowth, "%") : "--"),
    metric("净利增速", finance ? fmt(finance.netProfitGrowth, "%") : "--")
  ].join("");
}

function renderSummary(data) {
  const { quote, analysis, updatedAt, source } = data;
  summary.className = `summary ${analysis.tone}`;
  setText("stockName", `${quote.name} ${quote.code} · ${source}`);
  setText("verdict", analysis.verdict);
  setText("score", analysis.score);
  setText(
    "summaryText",
    `更新时间 ${new Date(updatedAt).toLocaleString("zh-CN")}。这个结论偏风控：分数高代表可以继续研究，分数低代表先别急着下单。`
  );
}

function renderPlan(data) {
  const { plan: p } = data;
  setText("entry", fmt(p.entry));
  setText("stop", fmt(p.stop));
  setText("lossPct", fmt(p.lossPct, "%"));
  setText("shares", `${p.suggestedShares} 股`);
  setText("capitalUsed", money(p.suggestedCapital));
  setText("plannedRisk", money(p.plannedRisk));
  document.querySelector("#planHint").textContent = `单笔风险预算 ${money(p.riskBudget)}`;

  const levels = p.levels.map((item) => `
    <div class="level">
      <span>${item.label}</span>
      <strong>${fmt(item.value)}</strong>
    </div>
  `);

  if (p.reasons.length) {
    levels.push(...p.reasons.map((text) => `
      <div class="level">
        <span>${text}</span>
        <strong>注意</strong>
      </div>
    `));
  }

  document.querySelector("#stopLevels").innerHTML = levels.join("");
}

function renderOperation(data) {
  const operation = data.operation;
  if (!operation) return;
  operationBox.className = `panel operation-box ${operation.stance || "watch"}`;
  setText("operationHeadline", operation.headline);
  setText("operationSummary", operation.summary);
  setText("operationNote", operation.note);
  document.querySelector("#operationLevels").innerHTML = operation.zones.map((item) => `
    <div class="operation-level ${item.tone}">
      <span>${item.label}</span>
      <strong>${displayValue(item.value)}</strong>
    </div>
  `).join("");
  document.querySelector("#operationSteps").innerHTML = operation.steps.map((item) => `
    <div class="operation-step ${item.tone}">
      <strong>${item.label}</strong>
      <span>${item.text}</span>
    </div>
  `).join("");
}

function renderChecklist(data) {
  const checks = data.analysis.checklist
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
    .slice(0, 9)
    .map((item) => `
      <div class="check ${item.good ? "good" : "bad"}">
        <b>${item.good ? "✓" : "!"}</b>
        <span>${item.text}</span>
        <small>${item.points > 0 ? "+" : ""}${item.points}</small>
      </div>
    `);

  document.querySelector("#checks").innerHTML = checks.join("");

  const risks = data.analysis.warnings.length
    ? data.analysis.warnings
    : ["暂未发现特别突出的风险，但仍需要结合公告、行业消息和自己的交易计划复核。"];
  document.querySelector("#risks").innerHTML = risks.map((text) => `<li>${text}</li>`).join("");
}

function switchTab(tabId) {
  tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabId);
  });
  tabPages.forEach((page) => {
    page.classList.toggle("hidden", page.id !== tabId);
    page.classList.toggle("active", page.id === tabId);
  });
  if (tabId === "emotionTab" && !emotionLoaded) {
    loadEmotion();
  }
  if (tabId === "fundTab" && !fundsLoaded) {
    loadFunds();
  }
}

function pctClass(value) {
  if (Number(value) > 0) return "pct-up";
  if (Number(value) < 0) return "pct-down";
  return "";
}

function renderEmotion(data) {
  const hero = document.querySelector(".emotion-hero");
  hero.className = `emotion-hero ${data.tone}`;
  setText("emotionStage", data.stage);
  setText("emotionScore", data.score);
  setText("emotionAction", data.action);
  setText("emotionTime", `${new Date(data.updatedAt).toLocaleString("zh-CN")} · ${data.source}`);

  document.querySelector("#indexList").innerHTML = data.indices.map((item) => `
    <div class="index-item">
      <div>
        <strong>${item.name}</strong>
        <span>${fmt(item.price)} · 振幅 ${fmt(item.amplitude, "%")}</span>
      </div>
      <strong class="${pctClass(item.pctChange)}">${fmt(item.pctChange, "%")}</strong>
    </div>
  `).join("");

  const b = data.breadth;
  document.querySelector("#breadthGrid").innerHTML = [
    ["上涨家数", `${b.up} / ${b.total}`],
    ["下跌家数", b.down],
    ["上涨占比", `${b.upRatio}%`],
    ["强涨家数", b.strongUp],
    ["强跌家数", b.strongDown],
    ["高换手家数", b.activeTurnover]
  ].map(([label, value]) => `
    <div class="breadth-item">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `).join("");

  if (data.marketOutlook) {
    setText("marketBias", data.marketOutlook.bias);
    setText("marketSummary", data.marketOutlook.summary);
    setText("marketNext", data.marketOutlook.next);
    document.querySelector("#marketLevels").innerHTML = data.marketOutlook.levels.map((item) => `
      <div class="market-level">
        <span>${item.label}</span>
        <strong>${item.value}</strong>
      </div>
    `).join("");
  }

  document.querySelector("#hotIndustries").innerHTML = data.hotIndustries.map((item) => `
    <div class="industry-item">
      <div>
        <strong>${item.industry}</strong>
        <span>${item.count} 只 · 上涨占比 ${item.upRatio}%</span>
      </div>
      <strong class="${pctClass(item.avgPct)}">${fmt(item.avgPct, "%")}</strong>
    </div>
  `).join("");

  document.querySelector("#steadyList").innerHTML = data.steadyWatchlist.map((item) => `
    <div class="watch-item">
      <div>
        <strong>${item.name} ${item.code}</strong>
        <span>${item.role} · ${item.note}</span>
      </div>
      <button class="secondary use-stock" type="button" data-code="${item.code}">查看</button>
    </div>
  `).join("");

  document.querySelectorAll(".use-stock").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelector("#code").value = button.dataset.code;
      switchTab("steadyTab");
      analyze();
    });
  });
}

async function loadEmotion() {
  refreshEmotionButton.disabled = true;
  setText("emotionAction", "正在拉取指数、涨跌家数和行业温度...");
  try {
    const response = await fetch("/api/emotion");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "情绪周期分析失败");
    renderEmotion(data);
    emotionLoaded = true;
  } catch (error) {
    setText("emotionStage", "读取失败");
    setText("emotionScore", "--");
    setText("emotionAction", error.message || "情绪周期分析失败，请稍后再试。");
  } finally {
    refreshEmotionButton.disabled = false;
  }
}

async function analyze() {
  const params = new URLSearchParams(new FormData(form));
  const code = params.get("code")?.trim();
  if (!code) {
    showError("请先输入股票代码或名称。");
    return;
  }

  showLoading("正在拉取行情、日 K 和财务数据...");
  try {
    const response = await fetch(`/api/analyze?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "分析失败");
    renderSummary(data);
    renderMetrics(data);
    renderOperation(data);
    renderPlan(data);
    renderChecklist(data);
    reveal();
    statusBox.className = "status";
    statusBox.textContent = "检查完成。下单前请再核对公告、业绩预告、行业消息和你的止损纪律。";
  } catch (error) {
    showError(error.message || "分析失败，请稍后再试。");
  } finally {
    submitButton.disabled = false;
  }
}

function renderFunds(data) {
  fundTotals.classList.remove("hidden");
  fundList.classList.remove("hidden");
  fundTotals.innerHTML = [
    metric("估算市值", money(data.totals.marketValue)),
    metric("总浮盈亏", signedMoney(data.totals.totalPnl)),
    metric("今日预计盈亏", signedMoney(data.totals.todayEstimatedPnl)),
    metric("更新时间", new Date(data.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }))
  ].join("");

  fundList.innerHTML = data.funds.map((item) => {
    if (item.error) {
      return `
        <article class="fund-card danger">
          <div class="fund-card-head">
            <div><strong>${item.code}</strong><span>读取失败</span></div>
            <b>--</b>
          </div>
          <p>${item.error}</p>
        </article>
      `;
    }
    const tone = item.advice?.tone || "watch";
    return `
      <article class="fund-card ${tone}">
        <div class="fund-card-head">
          <div>
            <strong>${item.name} ${item.code}</strong>
            <span>${item.estimateTime || "--"} · ${item.latestNetValueDate || "--"} 净值 ${fmt(item.latestNetValue)}</span>
          </div>
          <b class="${pctClass(item.estimatePct)}">${fmt(item.estimatePct, "%")}</b>
        </div>
        <div class="fund-metrics">
          <div><span>估算净值</span><strong>${fmt(item.estimateValue)}</strong></div>
          <div><span>成本 / 份额</span><strong>${fmt(item.cost)} / ${fmt(item.shares)}</strong></div>
          <div><span>估算市值</span><strong>${money(item.marketValue)}</strong></div>
          <div><span>总浮盈亏</span><strong>${signedMoney(item.totalPnl)}</strong></div>
          <div><span>总收益率</span><strong>${fmt(item.totalPnlPct, "%")}</strong></div>
          <div><span>今日预计盈亏</span><strong>${signedMoney(item.todayEstimatedPnl)}</strong></div>
        </div>
        <div class="fund-advice">
          <strong>${item.advice?.headline || "观察"}</strong>
          <span>${item.advice?.text || data.warning}</span>
        </div>
      </article>
    `;
  }).join("");
}

async function loadFunds() {
  fundSubmitButton.disabled = true;
  fundStatus.className = "status";
  fundStatus.textContent = "正在拉取基金估算净值...";
  try {
    const params = new URLSearchParams(new FormData(fundForm));
    const response = await fetch(`/api/funds?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "基金估算失败");
    renderFunds(data);
    fundsLoaded = true;
    fundStatus.className = "status";
    fundStatus.textContent = data.warning;
  } catch (error) {
    fundStatus.className = "status error";
    fundStatus.textContent = error.message || "基金估算失败，请稍后再试。";
  } finally {
    fundSubmitButton.disabled = false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  analyze();
});

fundForm.addEventListener("submit", (event) => {
  event.preventDefault();
  fundsLoaded = false;
  loadFunds();
});

tabButtons.forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.tab));
});

refreshEmotionButton.addEventListener("click", () => {
  emotionLoaded = false;
  loadEmotion();
});

analyze();

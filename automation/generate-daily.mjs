import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = process.env.OPENAI_MODEL || "gpt-5";
const MIN_NEWS_ITEMS = Number(process.env.MIN_NEWS_ITEMS || 8);
const MAX_NEWS_ITEMS = 30;
const TIME_ZONE = "Asia/Shanghai";

const segmentDefinitions = [
  { label: "政策与贸易", id: "policy-trade" },
  { label: "上游镍钴锂", id: "upstream" },
  { label: "正极与前驱体", id: "cathode" },
  { label: "电池与装机", id: "battery" },
  { label: "终端电车", id: "ev" },
  { label: "终端储能", id: "storage" },
];

const researchGroups = [
  {
    name: "政策与上游",
    segments: ["政策与贸易", "上游镍钴锂"],
    focus: "各国电动车、储能、电池、关键矿产政策及贸易措施；镍、钴、锂矿山、冶炼、资源交易、产能和供应事件。优先政府原文、SMM、Reuters及公司公告。",
  },
  {
    name: "正极与电池",
    segments: ["正极与前驱体", "电池与装机"],
    focus: "瑞翔、EcoPro及主要正极/前驱体厂商的订单、合作、投扩产和客户认证；电池厂供货、装机、工厂、技术量产和行业数据。优先SMM、中国汽车动力电池产业创新联盟、公司公告及Reuters。",
  },
  {
    name: "电车与储能",
    segments: ["终端电车", "终端储能"],
    focus: "具体车企的新车型、产销、工厂、供应商、召回、出口和市场进入退出；具体储能项目的业主、集成商、电芯供应商、MW/MWh规模、地点、阶段和投运时间。优先Reuters、盖世汽车、中汽协、项目方及政府公告。",
  },
];

const responseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["coverage_note", "events"],
  properties: {
    coverage_note: { type: "string" },
    events: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "segment",
          "headline",
          "info_date",
          "event_details",
          "background",
          "cathode_impact",
          "country_region",
          "companies",
          "themes",
          "main_source_label",
          "main_url",
          "background_sources",
        ],
        properties: {
          segment: { type: "string" },
          headline: { type: "string" },
          info_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          event_details: { type: "string" },
          background: { type: "string" },
          cathode_impact: { type: "string" },
          country_region: { type: "string" },
          companies: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
          themes: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
          main_source_label: { type: "string" },
          main_url: { type: "string" },
          background_sources: {
            type: "array",
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "url"],
              properties: {
                label: { type: "string" },
                url: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

function shanghaiDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shanghaiTime(date = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function extractOutputText(response) {
  return (response.output || [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text)
    .join("");
}

function researchPrompt(group, reportDate, cutoff) {
  return `你是锂电产业链日报的资深研究编辑。请使用 web search 对“${group.name}”进行实时检索，为 ${reportDate}（Asia/Shanghai，资料截止 ${cutoff}）整理可核实的公司或机构事件。

本轮只允许以下板块：${group.segments.join("、")}。
重点：${group.focus}

硬性要求：
1. 先查最近24-72小时，必要时扩大到7天。没有重要新闻的板块返回0条，不得凑数；本轮最多10条。
2. 新闻必须是具体主体做了具体事情。排除泛泛综述、股价波动、无新事实的评论、学术论文和搜索摘要。
3. 每条必须打开并核实正文或原始公告，main_url必须是可直接访问的https/http原文URL，禁止填写搜索结果页或虚构URL。
4. 优先SMM、Reuters、盖世汽车、中国汽车动力电池产业创新联盟、中汽协、政府/监管机构、公司新闻稿、交易所公告。重大事件尽量用第二来源交叉核实。
5. 合作、供货、投资、合资和项目里程碑必须查询双方此前关系；有可靠历史时写入background并附background_sources，说明这次相较此前有什么变化。无可靠历史时background填空字符串。
6. event_details用中文讲清谁、何时、在哪里、与谁、做了什么、项目阶段及已披露的金额/产能/数量/期限/产品/投产交付时间；未披露就明确写“未披露”。
7. 只有正极与前驱体新闻可填写cathode_impact，而且必须说明对化学路线、原料需求、客户认证、产能或区域供应的具体影响；其他板块填空字符串。
8. headline必须是“主体+动作+对象/关键数字”，不得使用“布局、发力、值得关注、影响深远”等空话。
9. info_date使用YYYY-MM-DD；每条填写板块、国家/地区、公司和主题标签。coverage_note简要说明本轮检索到的重点来源和缺口。
10. 同一事件即使多家媒体报道也只能保留一次。只输出符合JSON schema的结果。`;
}

async function callOpenAI(group, reportDate, cutoff) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing. Add it in GitHub repository Settings > Secrets and variables > Actions.");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      store: false,
      tools: [
        {
          type: "web_search",
          search_context_size: "high",
          user_location: {
            type: "approximate",
            country: "CN",
            timezone: TIME_ZONE,
          },
        },
      ],
      input: researchPrompt(group, reportDate, cutoff),
      text: {
        format: {
          type: "json_schema",
          name: "lithium_daily_events",
          strict: true,
          schema: responseSchema,
        },
      },
      max_output_tokens: 12000,
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`OpenAI API ${response.status}: ${payload.error?.message || JSON.stringify(payload)}`);
  }

  const outputText = extractOutputText(payload);
  if (!outputText) {
    throw new Error(`OpenAI returned no structured text for ${group.name}`);
  }

  const parsed = JSON.parse(outputText);
  const allowed = new Set(group.segments);
  parsed.events = parsed.events.filter((event) => allowed.has(event.segment));
  return parsed;
}

async function researchWithRetry(group, reportDate, cutoff) {
  let finalError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      console.log(`Researching ${group.name} (${attempt}/2) with ${MODEL}`);
      return await callOpenAI(group, reportDate, cutoff);
    } catch (error) {
      finalError = error;
      console.error(`${group.name} attempt ${attempt} failed: ${error.message}`);
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  throw finalError;
}

function normalizedUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || key === "ref" || key === "source") url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function prepareEvents(results) {
  const seenUrls = new Set();
  const seenHeadlines = new Set();
  const validSegments = new Set(segmentDefinitions.map((segment) => segment.label));
  const events = [];

  for (const result of results) {
    for (const event of result.events || []) {
      const mainUrl = normalizedUrl(event.main_url);
      const headlineKey = event.headline.replace(/\s+/g, "").toLowerCase();
      if (!mainUrl || !validSegments.has(event.segment) || !event.headline || !event.event_details) continue;
      if (seenUrls.has(mainUrl) || seenHeadlines.has(headlineKey)) continue;

      seenUrls.add(mainUrl);
      seenHeadlines.add(headlineKey);
      events.push({
        ...event,
        main_url: mainUrl,
        background_sources: (event.background_sources || [])
          .map((source) => ({ ...source, url: normalizedUrl(source.url) }))
          .filter((source) => source.url),
      });
    }
  }

  events.sort((left, right) => {
    const segmentOrder = segmentDefinitions.findIndex((segment) => segment.label === left.segment)
      - segmentDefinitions.findIndex((segment) => segment.label === right.segment);
    return segmentOrder || right.info_date.localeCompare(left.info_date);
  });
  return events.slice(0, MAX_NEWS_ITEMS);
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderTags(event) {
  const tags = [
    `板块 · ${event.segment}`,
    `国家/地区 · ${event.country_region}`,
    ...event.companies.map((company) => `公司 · ${company}`),
    ...event.themes.map((theme) => `主题 · ${theme}`),
  ];
  return tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("\n              ");
}

function renderCard(event, index) {
  const background = event.background
    ? `<p><strong>背景补充：</strong>${escapeHtml(event.background)}</p>`
    : "";
  const cathodeImpact = event.segment === "正极与前驱体" && event.cathode_impact
    ? `<p class="impact"><strong>正极相关影响：</strong>${escapeHtml(event.cathode_impact)}</p>`
    : "";
  const backgroundLinks = event.background_sources.map((source) =>
    `<p><strong>背景链接：</strong><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.label)} · ${escapeHtml(source.url)}</a></p>`,
  ).join("\n                ");

  return `          <article class="card">
            <div class="card-topline"><span>${String(index).padStart(2, "0")}</span><time datetime="${escapeHtml(event.info_date)}">信息日期 · ${escapeHtml(event.info_date)}</time></div>
            <h3>${escapeHtml(event.headline)}</h3>
            <p><strong>本次事件：</strong>${escapeHtml(event.event_details)}</p>
            ${background}
            ${cathodeImpact}
            <div class="tags" aria-label="新闻标签">
              ${renderTags(event)}
            </div>
            <div class="links">
              <p><strong>新闻链接：</strong><a href="${escapeHtml(event.main_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(event.main_source_label)} · ${escapeHtml(event.main_url)}</a></p>
              ${backgroundLinks}
            </div>
          </article>`;
}

function siteNavigation(currentPage) {
  return `    <nav class="site-nav" aria-label="日报导航">
      <a class="brand" href="./">Lithium Industry Daily</a>
      <div class="nav-links">
        <a${currentPage === "latest" ? ' class="current" aria-current="page"' : ""} href="./">最新日报</a>
        <a${currentPage === "archive" ? ' class="current" aria-current="page"' : ""} href="archive.html">历史日报</a>
      </div>
    </nav>`;
}

function renderReport({ reportDate, cutoff, events, coverageNote, currentPage }) {
  const presentSegments = segmentDefinitions.filter((segment) => events.some((event) => event.segment === segment.label));
  const jumpLinks = presentSegments.map((segment) => `<a href="#${segment.id}">${segment.label}</a>`).join("\n        ");
  let cardIndex = 0;
  const sections = presentSegments.map((segment) => {
    const segmentEvents = events.filter((event) => event.segment === segment.label);
    const cards = segmentEvents.map((event) => renderCard(event, ++cardIndex)).join("\n");
    return `    <section class="segment" id="${segment.id}">
      <div class="segment-heading"><h2 class="segment-title">${segment.label} · ${segmentEvents.length}条</h2></div>
      <div class="card-grid">
${cards}
      </div>
    </section>`;
  }).join("\n\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${reportDate} 锂电产业链政策、镍钴锂、正极、电池、电车与储能新闻日报">
  <title>锂电产业链新闻日报 | ${reportDate}</title>
  <style>
    :root { --ink:#17324a; --muted:#5b7185; --blue:#1769aa; --blue-deep:#0d4f86; --blue-pale:#eaf6ff; --paper:#fbfdff; --line:#87bce5; --yellow:#ffe998; --coral:#ffad9f; --mint:#d9f3e4; --shadow:rgba(23,50,74,.09); }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; background:#eef7fd; }
    body { margin:0; color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; line-height:1.72; letter-spacing:0; background:repeating-linear-gradient(0deg,rgba(23,105,170,.025) 0,rgba(23,105,170,.025) 1px,transparent 1px,transparent 28px),var(--paper); }
    a { color:#0a62ad; text-decoration-thickness:1px; text-underline-offset:3px; overflow-wrap:anywhere; }
    .page { width:min(1120px,calc(100% - 32px)); margin:0 auto; padding:28px 0 52px; }
    .site-nav { display:flex; align-items:center; justify-content:space-between; gap:20px; margin-bottom:18px; padding:0 3px 12px; border-bottom:2px dashed var(--line); }
    .site-nav a { color:var(--blue-deep); font-weight:800; text-decoration:none; }
    .site-nav a:hover,.site-nav a:focus-visible,.site-nav .current { text-decoration:underline; }
    .site-nav .brand { color:var(--blue); }
    .nav-links { display:flex; align-items:center; gap:18px; }
    .masthead { position:relative; padding:26px 28px; border:2px dashed var(--line); border-radius:8px; background:#f5fbff; box-shadow:0 12px 28px var(--shadow); }
    .masthead::before { content:""; display:block; width:94px; height:8px; margin-bottom:14px; border-radius:4px; background:repeating-linear-gradient(90deg,var(--coral) 0 10px,var(--yellow) 10px 20px,var(--blue) 20px 30px); }
    .kicker { margin:0 0 6px; color:var(--blue-deep); font-size:.9rem; font-weight:800; text-transform:uppercase; }
    h1,h2,h3 { letter-spacing:0; }
    h1 { margin:0; color:var(--blue); font-size:2.35rem; line-height:1.2; }
    .meta { display:flex; flex-wrap:wrap; gap:8px; margin:18px 0 0; }
    .meta span { padding:4px 9px; border:1px solid #b7d6ee; border-radius:999px; background:#fff; color:#355b78; font-size:.88rem; font-weight:700; }
    .source-note { margin:18px 0 0; padding:13px 15px; border-left:5px solid var(--blue); border-radius:6px; background:#fff; color:#34546c; font-size:.94rem; }
    .segment-jump { display:flex; align-items:center; gap:14px; margin:20px 0 4px; padding:12px 14px; border:1px dashed var(--line); border-radius:8px; background:#f5fbff; }
    .segment-jump strong { flex:0 0 auto; color:var(--blue-deep); font-size:.9rem; }
    .segment-jump-links { display:flex; flex-wrap:wrap; gap:8px; }
    .segment-jump a { display:inline-flex; align-items:center; min-height:34px; padding:5px 10px; border:1px solid #a8cee9; border-radius:6px; background:#fff; color:var(--blue-deep); font-size:.86rem; font-weight:800; text-decoration:none; }
    .segment-jump a:hover,.segment-jump a:focus-visible { border-color:var(--blue); background:var(--blue-pale); }
    .report-head { display:flex; align-items:baseline; justify-content:space-between; gap:16px; margin:30px 0 12px; padding-bottom:8px; border-bottom:2px dashed var(--line); }
    .report-head h2 { margin:0; color:var(--blue-deep); font-size:1.35rem; }
    .report-head span { color:var(--muted); font-size:.9rem; }
    .segment { scroll-margin-top:18px; margin-top:28px; }
    .segment-heading { margin-bottom:12px; }
    .segment-title { display:inline-block; margin:0; padding:6px 12px; border:2px dashed var(--line); border-radius:7px; background:var(--blue-pale); color:var(--blue-deep); font-size:1.18rem; }
    .card-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
    .card { min-width:0; padding:18px; border:1px dashed #9fc7e5; border-radius:8px; background:#fff; box-shadow:0 7px 18px var(--shadow); }
    .card-topline { display:flex; align-items:center; justify-content:space-between; gap:12px; color:var(--muted); font-size:.82rem; }
    .card-topline span { display:grid; place-items:center; width:30px; height:30px; border-radius:50%; background:var(--yellow); color:var(--blue-deep); font-weight:900; }
    .card-topline time { font-weight:750; }
    .card h3 { margin:12px 0 10px; color:var(--blue-deep); font-size:1.07rem; line-height:1.5; }
    .card p { margin:9px 0; font-size:.94rem; }
    .impact { padding:10px 12px; border-left:4px solid #59b88a; background:#f1fbf6; }
    .tags { display:flex; flex-wrap:wrap; gap:6px; margin-top:13px; }
    .tags span { padding:3px 8px; border:1px solid #bfdaed; border-radius:999px; background:#f6fbff; color:#3d607a; font-size:.77rem; font-weight:700; }
    .links { margin-top:14px; padding-top:10px; border-top:1px dashed #bad5e9; }
    .links p { margin:6px 0; font-size:.82rem; }
    footer { margin-top:34px; padding-top:16px; border-top:2px dashed var(--line); color:var(--muted); font-size:.86rem; }
    @media (max-width:720px) { .page{width:min(100% - 20px,1120px);padding-top:14px}.site-nav{align-items:flex-start}.site-nav .brand{max-width:150px}.nav-links{gap:12px}.masthead{padding:20px}h1{font-size:1.85rem}.segment-jump{align-items:flex-start}.report-head{align-items:flex-start;flex-direction:column;gap:4px}.card-grid{grid-template-columns:1fr}.card{padding:16px} }
  </style>
</head>
<body>
  <main class="page">
${siteNavigation(currentPage)}
    <header class="masthead">
      <p class="kicker">Lithium Industry Daily</p>
      <h1>锂电产业链新闻日报</h1>
      <div class="meta"><span>${reportDate}</span><span>${TIME_ZONE}</span><span>资料截止 ${cutoff}</span><span>${events.length} 条新闻</span></div>
      <p class="source-note"><strong>来源覆盖：</strong>${escapeHtml(coverageNote)}</p>
    </header>
    <nav class="segment-jump" aria-label="板块直达">
      <strong>板块直达</strong>
      <div class="segment-jump-links">
        ${jumpLinks}
      </div>
    </nav>
    <div class="report-head"><h2>新闻罗列</h2><span>按政策、上游、正极、电池、电车、储能排序；无重要新闻的板块不展示</span></div>
${sections}
    <footer>自动更新时间：每天 19:00（Asia/Shanghai）。内容仅作行业信息整理，请以链接所示原始公告与报道为准。</footer>
  </main>
</body>
</html>
`;
}

async function updateArchive(reportDate, events) {
  const reportsPath = path.join(ROOT, "reports.json");
  const archivePath = path.join(ROOT, "archive.html");
  const reportsFile = JSON.parse(await readFile(reportsPath, "utf8"));
  const segments = segmentDefinitions
    .filter((segment) => events.some((event) => event.segment === segment.label))
    .map((segment) => segment.label);
  const reportEntry = {
    date: reportDate,
    title: "锂电产业链新闻日报",
    file: `daily-${reportDate}.html`,
    news_count: events.length,
    segments,
  };
  const reports = [reportEntry, ...reportsFile.reports.filter((report) => report.date !== reportDate)]
    .sort((left, right) => right.date.localeCompare(left.date));
  const rows = reports.map((report) => `      <article class="archive-row">
        <time datetime="${report.date}">${report.date}</time>
        <div>
          <h2>${escapeHtml(report.title)}</h2>
          <p>${report.news_count} 条新闻 · ${escapeHtml(report.segments.join("、"))}</p>
        </div>
        <a class="open-link" href="${report.file}">查看日报 →</a>
      </article>`).join("\n");
  const archive = await readFile(archivePath, "utf8");
  const markerPattern = /      <!-- REPORT_LIST_START -->[\s\S]*?      <!-- REPORT_LIST_END -->/;
  if (!markerPattern.test(archive)) throw new Error("Archive report-list markers were not found");
  const updatedArchive = archive.replace(
    markerPattern,
    `      <!-- REPORT_LIST_START -->\n${rows}\n      <!-- REPORT_LIST_END -->`,
  );
  await Promise.all([
    writeFile(archivePath, updatedArchive),
    writeFile(reportsPath, `${JSON.stringify({ updated_at: new Date().toISOString(), reports }, null, 2)}\n`),
  ]);
}

async function main() {
  const requestedDate = process.argv[2];
  const reportDate = requestedDate || shanghaiDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) throw new Error("Optional report date must be YYYY-MM-DD");
  const cutoff = `${reportDate} ${shanghaiTime()} (${TIME_ZONE})`;
  const results = [];

  for (const group of researchGroups) {
    results.push(await researchWithRetry(group, reportDate, cutoff));
  }

  const events = prepareEvents(results);
  if (events.length < MIN_NEWS_ITEMS) {
    throw new Error(`Only ${events.length} verified events survived validation; minimum is ${MIN_NEWS_ITEMS}. Existing site was not changed.`);
  }

  const coverageNote = `检索窗口以最近24-72小时为主，必要时扩大至7天；重点扫描SMM、Reuters、盖世汽车、中国汽车动力电池产业创新联盟、中汽协、政府及公司原始公告。${results.map((result) => result.coverage_note).filter(Boolean).join(" ")}`;
  const latestHtml = renderReport({ reportDate, cutoff, events, coverageNote, currentPage: "latest" });
  const datedHtml = renderReport({ reportDate, cutoff, events, coverageNote, currentPage: "archive" });

  await Promise.all([
    writeFile(path.join(ROOT, "index.html"), latestHtml),
    writeFile(path.join(ROOT, `daily-${reportDate}.html`), datedHtml),
  ]);
  await updateArchive(reportDate, events);

  console.log(`Prepared ${reportDate}: ${events.length} verified events across ${new Set(events.map((event) => event.segment)).size} segments.`);
}

await main();

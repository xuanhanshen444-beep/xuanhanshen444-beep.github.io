import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildSubjectIndex } from "./build-subject-index.mjs";
import { extractReportEvents, findLikelyDuplicate, normalizeUrl } from "./duplicate-guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = process.env.OPENAI_MODEL || "gpt-5";
const MIN_NEWS_ITEMS = Number(process.env.MIN_NEWS_ITEMS || 16);
const MAX_NEWS_ITEMS = 60;
const TIME_ZONE = "Asia/Shanghai";
const DEFAULT_PUBLISH_TIME = "16:30";

const designatedWechatSources = [
  "崔东树",
  "电动车公社",
  "电池中国",
  "电池社",
  "电车汇",
  "低空经济网",
  "汽车产业前线观察",
  "起点锂电",
  "氢锂荟",
  "SEVEN调研纪要",
  "数说新能源",
  "SMM锂电",
  "鑫椤锂电",
  "新能源情报局",
  "则言咨询",
  "芝能汽车",
  "中国汽车报",
  "中国汽车动力电池产业创新联盟",
  "中国汽车工业协会",
  "中汽数研",
  "中汽协会数据",
];

const segmentDefinitions = [
  { label: "政策与贸易", id: "policy-trade" },
  { label: "上游镍钴锂", id: "upstream" },
  { label: "正极与前驱体", id: "cathode" },
  { label: "电池与装机", id: "battery" },
  { label: "终端电车", id: "ev" },
];

const researchGroups = [
  {
    name: "政策与上游",
    segments: ["政策与贸易", "上游镍钴锂"],
    maxItems: 18,
    focus: "各国电动车、电池、关键矿产政策及贸易措施；镍、钴、锂矿山、冶炼、资源交易、产能和供应事件；以及有署名、有原文、有论据的政策或资源市场分析。优先政府原文、SMM、Reuters及公司公告。政策需充分覆盖不同国家与地区；上游事实动态通常不超过3条，但可加入少量能解释供需、政策执行或价格机制的独立行业观点。",
  },
  {
    name: "正极与电池",
    segments: ["正极与前驱体", "电池与装机"],
    maxItems: 20,
    focus: "瑞翔、EcoPro及主要正极/前驱体厂商的订单、合作、投扩产和客户认证；电池厂供货、装机、工厂、技术量产和行业数据；以及有署名、有数据或产业访谈依据的技术路线、排产、库存和需求分析。优先SMM、中国汽车动力电池产业创新联盟、公司公告、Reuters和指定公众号原文。",
  },
  {
    name: "终端电车",
    segments: ["终端电车"],
    maxItems: 24,
    focus: "广泛检索具体车企的新车型、交付、产销、工厂、供应商、召回、出口、充换电合作和市场进入退出，并纳入有署名、有原文、有依据的车型竞争、渠道反馈、需求变化和车企策略分析。优先Reuters、盖世汽车、中汽协、车企、政府公告和指定公众号原文；终端电车是本简报重点。观点必须明确标注，不能替代事实核验。完全排除储能项目新闻。",
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
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "segment",
          "content_type",
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
          "official_source_status",
          "background_sources",
        ],
        properties: {
          segment: { type: "string" },
          content_type: { type: "string", enum: ["事实动态", "行业观点"] },
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
          official_source_status: {
            type: "string",
            enum: [
              "已找到公司官网或官方公告原文",
              "公司官网未检索到原文",
              "不适用（政府或行业机构原文）",
              "不适用（观点内容）",
            ],
          },
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

export function extractPublicationCutoff(html, reportDate) {
  const cutoff = html.match(/资料截止\s*([^<]+)<\/span>/)?.[1]?.trim();
  return cutoff || `${reportDate} ${DEFAULT_PUBLISH_TIME} (${TIME_ZONE})`;
}

async function publicationContext(reportDate) {
  const reportsFile = JSON.parse(await readFile(path.join(ROOT, "reports.json"), "utf8"));
  const previousReport = reportsFile.reports
    .filter((report) => report.date < reportDate)
    .sort((left, right) => right.date.localeCompare(left.date))[0];
  const fallbackStart = new Date(`${reportDate}T08:30:00.000Z`);
  fallbackStart.setUTCDate(fallbackStart.getUTCDate() - 7);
  const previousHtml = previousReport
    ? await readFile(path.join(ROOT, previousReport.file), "utf8")
    : "";
  const windowStart = previousReport
    ? extractPublicationCutoff(previousHtml, previousReport.date)
    : `${shanghaiDate(fallbackStart)} 00:00 (${TIME_ZONE})`;
  const excludedUrls = [];
  const historicalEvents = [];

  for (const report of reportsFile.reports.slice(0, 12)) {
    const html = await readFile(path.join(ROOT, report.file), "utf8");
    historicalEvents.push(...extractReportEvents(html, report.date, report.file));
    for (const match of html.matchAll(/href="(https?:\/\/[^"#]+)"/g)) {
      excludedUrls.push(match[1].replaceAll("&amp;", "&"));
    }
  }

  return { windowStart, excludedUrls: [...new Set(excludedUrls)], historicalEvents };
}

function extractOutputText(response) {
  return (response.output || [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text)
    .join("");
}

function researchPrompt(group, reportDate, cutoff, windowStart, excludedUrls, historicalEvents) {
  const excluded = excludedUrls.length
    ? `\n以下链接已在历史报告中使用，不得作为新事件重复收录：\n${excludedUrls.slice(0, 120).join("\n")}`
    : "";
  const priorHeadlines = historicalEvents.length
    ? `\n以下事件已经发布。即使换了媒体或URL，只要主体、动作、日期或关键数字指向同一事件，也不得重复收录：\n${historicalEvents.slice(0, 100).map((event) => `- ${event.info_date} | ${event.headline}`).join("\n")}`
    : "";
  return `你是锂电产业链新闻简报的资深研究编辑。请使用 web search 对“${group.name}”进行实时检索，为 ${reportDate}（Asia/Shanghai）整理事实动态和有署名的行业观点。

本期新闻窗口：${windowStart} 至 ${cutoff}。只收录在该区间内首次发布或发生实质进展的事件；更早内容只能作为背景，不得独立成条。

本轮只允许以下板块：${group.segments.join("、")}。
重点：${group.focus}

指定微信公众号线索池：${designatedWechatSources.join("、")}。这些账号既用于发现事实候选，也用于发现作者明确、原文可打开、论据清楚的行业观点。

硬性要求：
1. 严格覆盖上述增量窗口。扩大候选池，正常一期整体目标18-30条内容，其中可有4-10条行业观点；这是研究深度目标，不能靠重复、传闻或空话凑数。本轮最多${group.maxItems}条。
2. 对指定公众号逐项执行“账号名+窗口日期+本板块公司/动作/观点关键词”检索，优先打开mp.weixin.qq.com原文。公众号原文可以直接作为main_url。搜索摘要、无署名转载、匿名调研传闻和无法打开的文章不得收录。
3. content_type只能填“事实动态”或“行业观点”。事实动态必须是窗口内新的签约、投产、获批、交付、数据披露或其他实质动作。行业观点允许没有新公司动作，但必须是窗口内发布的原创分析，写明作者/账号、中心观点、依据、适用范围和不确定性。不要把“观点不等同于事实”的固定提示写入event_details，页面会统一添加。
4. 区分文章发布日期和事件日期。窗口内复盘、转载或重发的旧事件不得作为事实动态；若文章本身提供了新的独立分析，可仅作为行业观点收录，不得把预测改写成事实。
5. 每条必须打开并核实正文，main_url必须是可直接访问的https/http原文URL，允许公司官网、监管公告、可靠媒体原创或mp.weixin.qq.com公众号原文，禁止填写搜索结果页或虚构URL。
6. 优先SMM、Reuters、盖世汽车、中国汽车动力电池产业创新联盟、中汽协、政府/监管机构、公司新闻稿、交易所公告。重大事件尽量用第二来源交叉核实。
7. 对每条事实类公司新闻检索公司官网、投资者关系页和交易所公告。找到对应原文时official_source_status填“已找到公司官网或官方公告原文”，并在main_url或background_sources中提供；没有找到时填“公司官网未检索到原文”，不得虚构官网链接。政府或行业机构原文填“不适用（政府或行业机构原文）”。纯行业观点填“不适用（观点内容）”，但观点中引用的关键事实仍需明确来源。
8. 合作、供货、投资、合资和项目里程碑必须查询双方此前关系；有可靠历史时写入background并附background_sources，说明这次相较此前有什么变化。无可靠历史时background填空字符串。
9. 事实动态的event_details用中文讲清谁、何时、在哪里、与谁、做了什么、项目阶段及已披露的金额/产能/数量/期限/产品/投产交付时间；未披露就明确写“未披露”。行业观点的event_details写作者/账号、观点、所用数据或观察、适用范围和不确定性。
10. 只有正极与前驱体新闻可填写cathode_impact，而且必须说明对化学路线、原料需求、客户认证、产能或区域供应的具体影响；其他板块填空字符串。
11. 事实动态headline必须是“主体+动作+对象/关键数字”；行业观点headline必须是“作者/账号+对象+明确观点”。不得使用“布局、发力、值得关注、影响深远”等空话。
12. info_date使用YYYY-MM-DD；事实动态填事件或公告日期，行业观点填原文发布日期。每条填写板块、国家/地区、公司和主题标签。公司标签使用集团规范名，子公司或品牌可在正文说明；例如广汽、广汽国际、广汽能源、广汽埃安统一标记为“广汽集团”。
13. coverage_note说明本轮检索到的重点来源、哪些指定公众号提供了事实候选、哪些提供了观点候选以及无法访问的来源，不得笼统声称“已扫描”却没有逐项检索。
14. 同一事件即使多家媒体报道、标题不同或URL不同也只能保留一次；同一作者或不同作者对相同材料作出的近似观点也只保留信息量最高的一条。事实后续必须有新增动作和日期；观点后续必须有新数据或新推理。只输出符合JSON schema的结果。${excluded}${priorHeadlines}`;
}

async function callOpenAI(group, reportDate, cutoff, windowStart, excludedUrls, historicalEvents) {
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
      input: researchPrompt(group, reportDate, cutoff, windowStart, excludedUrls, historicalEvents),
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

async function researchWithRetry(group, reportDate, cutoff, windowStart, excludedUrls, historicalEvents) {
  let finalError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      console.log(`Researching ${group.name} (${attempt}/2) with ${MODEL}`);
      return await callOpenAI(group, reportDate, cutoff, windowStart, excludedUrls, historicalEvents);
    } catch (error) {
      finalError = error;
      console.error(`${group.name} attempt ${attempt} failed: ${error.message}`);
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  throw finalError;
}

function prepareEvents(results, excludedUrls = [], historicalEvents = []) {
  const seenUrls = new Set(excludedUrls.map(normalizeUrl).filter(Boolean));
  const seenHeadlines = new Set();
  const acceptedEventSummaries = [];
  const validSegments = new Set(segmentDefinitions.map((segment) => segment.label));
  const events = [];

  for (const result of results) {
    for (const event of result.events || []) {
      const mainUrl = normalizeUrl(event.main_url);
      const headlineKey = event.headline.replace(/\s+/g, "").toLowerCase();
      if (!mainUrl || !validSegments.has(event.segment) || !event.headline || !event.event_details) continue;
      if (seenUrls.has(mainUrl) || seenHeadlines.has(headlineKey)) continue;
      const eventSummary = {
        headline: event.headline,
        main_url: mainUrl,
        companies: event.companies || [],
        info_date: event.info_date,
      };
      const duplicate = findLikelyDuplicate(eventSummary, [...historicalEvents, ...acceptedEventSummaries]);
      if (duplicate) {
        console.warn(`Skipped duplicate event: ${event.headline} -> ${duplicate.prior.headline} (${duplicate.reason})`);
        continue;
      }

      seenUrls.add(mainUrl);
      seenHeadlines.add(headlineKey);
      acceptedEventSummaries.push(eventSummary);
      events.push({
        ...event,
        content_type: event.content_type === "行业观点" ? "行业观点" : "事实动态",
        main_url: mainUrl,
        background_sources: (event.background_sources || [])
          .map((source) => ({ ...source, url: normalizeUrl(source.url) }))
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
    `内容类型 · ${event.content_type || "事实动态"}`,
    `板块 · ${event.segment}`,
    `国家/地区 · ${event.country_region}`,
    ...event.companies.map((company) => `公司 · ${company}`),
    ...event.themes.map((theme) => `主题 · ${theme}`),
  ];
  return tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("\n              ");
}

export function renderCard(event, index) {
  const isViewpoint = event.content_type === "行业观点";
  const eventDetails = isViewpoint
    ? event.event_details.replace(/阅读提示：(?:以上|以下)为作者观点，不等同于已发生事实。?\s*$/u, "").trim()
    : event.event_details;
  const background = event.background
    ? `<p><strong>背景补充：</strong>${escapeHtml(event.background)}</p>`
    : "";
  const cathodeImpact = event.segment === "正极与前驱体" && event.cathode_impact
    ? `<p class="impact"><strong>正极相关影响：</strong>${escapeHtml(event.cathode_impact)}</p>`
    : "";
  const backgroundLinks = event.background_sources.map((source) =>
    `<p><strong>背景链接：</strong><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.label)} · ${escapeHtml(source.url)}</a></p>`,
  ).join("\n                ");
  const officialSourceNote = event.official_source_status === "公司官网未检索到原文"
    ? `<p class="source-status"><strong>官网核验：</strong>公司官网未检索到原文</p>`
    : "";

  return `          <article class="card" id="news-${index}">
            <div class="card-topline"><span>${String(index).padStart(2, "0")}</span><time datetime="${escapeHtml(event.info_date)}">信息日期 · ${escapeHtml(event.info_date)}</time></div>
            <h3>${escapeHtml(event.headline)}</h3>
            <p><strong>${isViewpoint ? "观点摘要" : "本次事件"}：</strong>${escapeHtml(eventDetails)}</p>
            ${isViewpoint ? '<p class="viewpoint-note"><strong>阅读提示：</strong>以上为作者观点，不等同于已发生事实。</p>' : ""}
            ${background}
            ${cathodeImpact}
            <div class="tags" aria-label="新闻标签">
              ${renderTags(event)}
            </div>
            <div class="links">
              ${officialSourceNote}
              <p><strong>${isViewpoint ? "观点原文" : "新闻链接"}：</strong><a href="${escapeHtml(event.main_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(event.main_source_label)} · ${escapeHtml(event.main_url)}</a></p>
              ${backgroundLinks}
            </div>
          </article>`;
}

function siteNavigation(currentPage) {
  return `    <nav class="site-nav" aria-label="报告导航">
      <a class="brand" href="./">Lithium Industry Briefing</a>
      <div class="nav-links">
        <a${currentPage === "latest" ? ' class="current" aria-current="page"' : ""} href="./">最新报告</a>
        <a${currentPage === "archive" ? ' class="current" aria-current="page"' : ""} href="archive.html">历史报告</a>
        <a href="subjects.html">企业动态</a>
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
  <meta name="description" content="${reportDate} 锂电产业链政策、镍钴锂、正极、电池与电车新闻简报">
  <title>锂电产业链新闻简报 | ${reportDate}</title>
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
    .nav-links { display:flex; flex-wrap:wrap; align-items:center; gap:18px; }
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
    .card { min-width:0; scroll-margin-top:18px; padding:18px; border:1px dashed #9fc7e5; border-radius:8px; background:#fff; box-shadow:0 7px 18px var(--shadow); }
    .card:target { outline:3px solid #f2c94c; outline-offset:4px; }
    .card-topline { display:flex; align-items:center; justify-content:space-between; gap:12px; color:var(--muted); font-size:.82rem; }
    .card-topline span { display:grid; place-items:center; width:30px; height:30px; border-radius:50%; background:var(--yellow); color:var(--blue-deep); font-weight:900; }
    .card-topline time { font-weight:750; }
    .card h3 { margin:12px 0 10px; color:var(--blue-deep); font-size:1.07rem; line-height:1.5; }
    .card p { margin:9px 0; font-size:.94rem; }
    .impact { padding:10px 12px; border-left:4px solid #59b88a; background:#f1fbf6; }
    .viewpoint-note { padding:9px 11px; border-left:4px solid #f2c94c; background:#fffcef; color:#62552b; }
    .tags { display:flex; flex-wrap:wrap; gap:6px; margin-top:13px; }
    .tags span { padding:3px 8px; border:1px solid #bfdaed; border-radius:999px; background:#f6fbff; color:#3d607a; font-size:.77rem; font-weight:700; }
    .links { margin-top:14px; padding-top:10px; border-top:1px dashed #bad5e9; }
    .links p { margin:6px 0; font-size:.82rem; }
    .links .source-status { padding:6px 8px; border-left:3px solid var(--coral); background:#fff7f5; color:#6c433c; }
    footer { margin-top:34px; padding-top:16px; border-top:2px dashed var(--line); color:var(--muted); font-size:.86rem; }
    @media (max-width:720px) { .page{width:min(100% - 20px,1120px);padding-top:14px}.site-nav{align-items:flex-start}.site-nav .brand{max-width:150px}.nav-links{gap:12px}.masthead{padding:20px}h1{font-size:1.85rem}.segment-jump{align-items:flex-start}.report-head{align-items:flex-start;flex-direction:column;gap:4px}.card-grid{grid-template-columns:1fr}.card{padding:16px} }
  </style>
</head>
<body>
  <main class="page">
${siteNavigation(currentPage)}
    <header class="masthead">
      <p class="kicker">Lithium Industry Briefing</p>
      <h1>锂电产业链新闻简报</h1>
      <div class="meta"><span>${reportDate}</span><span>${TIME_ZONE}</span><span>资料截止 ${cutoff}</span><span>${events.length} 条内容</span></div>
      <p class="source-note"><strong>来源覆盖：</strong>${escapeHtml(coverageNote)}</p>
    </header>
    <nav class="segment-jump" aria-label="板块直达">
      <strong>板块直达</strong>
      <div class="segment-jump-links">
        ${jumpLinks}
      </div>
    </nav>
    <div class="report-head"><h2>事实与观点</h2><span>按政策、上游、正极、电池、电车排序；观点均单独标注</span></div>
${sections}
    <footer>自动更新时间：每周一、周三、周五 16:30（Asia/Shanghai）。内容仅作行业信息整理，请以链接所示原始公告与报道为准。</footer>
  </main>
</body>
</html>
`.replace(/[ \t]+$/gm, "");
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
    title: "锂电产业链新闻简报",
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
          <p>${report.news_count} 条内容 · ${escapeHtml(report.segments.join("、"))}</p>
        </div>
        <a class="open-link" href="${report.file}">查看报告 →</a>
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
  const publication = await publicationContext(reportDate);
  const windowStart = process.env.LITHIUM_DAILY_WINDOW_START || publication.windowStart;
  const { excludedUrls, historicalEvents } = publication;
  let results;

  if (process.env.LITHIUM_DAILY_FIXTURE) {
    const fixture = JSON.parse(await readFile(process.env.LITHIUM_DAILY_FIXTURE, "utf8"));
    results = fixture.results;
    console.log(`Using verified local research fixture: ${process.env.LITHIUM_DAILY_FIXTURE}`);
  } else {
    results = [];
    for (const group of researchGroups) {
      results.push(await researchWithRetry(group, reportDate, cutoff, windowStart, excludedUrls, historicalEvents));
    }
  }

  const events = prepareEvents(
    results,
    process.env.LITHIUM_DAILY_FIXTURE ? [] : excludedUrls,
    process.env.LITHIUM_DAILY_FIXTURE ? [] : historicalEvents,
  );
  if (events.length < MIN_NEWS_ITEMS) {
    throw new Error(`Only ${events.length} verified facts/viewpoints survived validation; minimum is ${MIN_NEWS_ITEMS}. Existing site was not changed.`);
  }

  const coverageNote = `本期增量窗口为${windowStart}至${cutoff}；重点扫描SMM、Reuters、盖世汽车、中国汽车动力电池产业创新联盟、中汽协、指定行业公众号线索池、政府及公司原始公告。${results.map((result) => result.coverage_note).filter(Boolean).join(" ")}`;
  const latestHtml = renderReport({ reportDate, cutoff, events, coverageNote, currentPage: "latest" });
  const datedHtml = renderReport({ reportDate, cutoff, events, coverageNote, currentPage: "archive" });

  await Promise.all([
    writeFile(path.join(ROOT, "index.html"), latestHtml),
    writeFile(path.join(ROOT, `daily-${reportDate}.html`), datedHtml),
  ]);
  await updateArchive(reportDate, events);
  await buildSubjectIndex();

  console.log(`Prepared ${reportDate}: ${events.length} verified facts/viewpoints across ${new Set(events.map((event) => event.segment)).size} segments.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

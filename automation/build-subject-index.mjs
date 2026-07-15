import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const COMPANY_ALIASES = new Map([
  ["比亚迪半导体", "比亚迪"],
  ["海洋网", "比亚迪"],
  ["腾势汽车", "比亚迪"],
  ["四川国城锂业", "国城矿业"],
  ["马尔康金鑫矿业", "国城矿业"],
  ["海南星之海", "海南矿业"],
  ["Gigafactory Malaysia", "NanoMalaysia"],
  ["零跑国际", "零跑汽车"],
  ["广汽", "广汽集团"],
  ["广汽集团股份有限公司", "广汽集团"],
  ["广汽国际", "广汽集团"],
  ["GAC International", "广汽集团"],
  ["广汽能源", "广汽集团"],
  ["GAC Energy", "广汽集团"],
  ["广汽埃安", "广汽集团"],
  ["GAC Aion", "广汽集团"],
  ["GAC", "广汽集团"],
  ["GAC Group", "广汽集团"],
]);

function decodeHtml(value = "") {
  return value
    .replace(/<[^>]+>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function subjectId(name) {
  let hash = 2166136261;
  for (const character of name) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `subject-${(hash >>> 0).toString(36)}`;
}

function extractCompanies(card) {
  const companies = [];
  for (const match of card.matchAll(/<span[^>]*>\s*公司\s*[·：:]\s*([^<]+)<\/span>/g)) {
    const raw = decodeHtml(match[1]);
    companies.push(...raw.split(/[、，,]/).map((name) => name.trim()));
  }
  return [...new Set(companies)].filter((name) =>
    name.length >= 2
    && name.length <= 60
    && !/^\d+$/.test(name)
    && !/^(公司|企业|车企|未披露|外部电池初创企业)$/.test(name)
    && !/余家|多家|若干|等客户/.test(name),
  );
}

export function canonicalCompany(name) {
  return COMPANY_ALIASES.get(name) || name;
}

export function canonicalCompanies(names) {
  return [...new Set(names.map(canonicalCompany))];
}

function parseReport(html, report) {
  const items = [];
  const sections = [...html.matchAll(/<section class="segment"[^>]*>[\s\S]*?<\/section>/g)];
  for (const sectionMatch of sections) {
    const section = sectionMatch[0];
    const segment = decodeHtml(section.match(/<h2 class="segment-title">([^<]+)<\/h2>/)?.[1] || "其他")
      .replace(/\s*[·•]\s*\d+\s*条?\s*$/, "");
    for (const cardMatch of section.matchAll(/<article class="card"[^>]*>[\s\S]*?<\/article>/g)) {
      const card = cardMatch[0];
      const headline = decodeHtml(card.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] || "");
      if (!headline) continue;
      const date = card.match(/<time[^>]*datetime="(\d{4}-\d{2}-\d{2})"/)?.[1]
        || card.match(/信息日期[： ·]*(\d{4}-\d{2}-\d{2})/)?.[1]
        || report.date;
      const reportAnchor = card.match(/\sid="([^"]+)"/)?.[1];
      const companies = canonicalCompanies(extractCompanies(card));
      for (const company of companies) {
        items.push({
          subject: company,
          date,
          report_date: report.date,
          report_file: report.file,
          report_anchor: reportAnchor,
          headline,
          segment,
        });
      }
    }
  }
  return items;
}

function ensureSubjectNavigation(html) {
  let updated = html
    .replaceAll("Lithium Industry Daily", "Lithium Industry Briefing")
    .replaceAll("GII · Lithium Industry Briefing", "Lithium Industry Briefing")
    .replaceAll(">GII<", ">Lithium Industry Briefing<")
    .replaceAll("锂电产业链新闻日报", "锂电产业链新闻简报")
    .replace(/<title>GII 锂电产业链新闻简报 \| ([^<]+)<\/title>/, "<title>锂电产业链新闻简报 | $1</title>")
    .replace("<title>GII | 历史报告</title>", "<title>历史报告 | 锂电产业链新闻简报</title>")
    .replaceAll(">最新日报<", ">最新报告<")
    .replaceAll(">历史日报<", ">历史报告<")
    .replaceAll("查看日报", "查看报告")
    .replaceAll("历史日报列表", "历史报告列表")
    .replace(/自动更新时间：(?:每天|每周一、周三、周五)\s*19:00（Asia\/Shanghai）。/g, "自动更新时间：每周一、周三、周五 16:30（Asia/Shanghai）。")
    .replace(/计划更新时间：(?:每天|每周一、周三、周五)\s*19:00（Asia\/Shanghai）。/g, "计划更新时间：每周一、周三、周五 16:30（Asia/Shanghai）。")
    .replaceAll("主体归纳", "企业动态")
    .replaceAll('aria-label="日报导航"', 'aria-label="报告导航"');
  if (!updated.includes('href="subjects.html"')) {
    updated = updated.replace(
      /(<div class="nav-links">[\s\S]*?<a[^>]*href="archive\.html"[^>]*>历史报告<\/a>)/,
      '$1\n        <a href="subjects.html">企业动态</a>',
    );
  }
  return updated;
}

function ensureNewsAnchors(html) {
  const anchorCss = `    /* NEWS_ANCHORS */
    .card { scroll-margin-top: 18px; }
    .card:target { outline: 3px solid #f2c94c; outline-offset: 4px; }`;
  let cardIndex = 0;
  const updated = html.replace(/<article class="card"([^>]*)>/g, (match, attributes) => {
    cardIndex += 1;
    if (/\sid="[^"]+"/.test(match)) return match;
    return `<article class="card" id="news-${cardIndex}"${attributes}>`;
  });
  if (cardIndex === 0) return updated;
  if (updated.includes("/* NEWS_ANCHORS */")) {
    return updated.replace(/    \/\* NEWS_ANCHORS \*\/[\s\S]*?\.card(?::target)? \{[^}]+\}(?:\s*\.card:target \{[^}]+\})?/, anchorCss);
  }
  return updated.replace("</style>", `${anchorCss}\n  </style>`);
}

function renderSubjects(subjects) {
  const totalReferences = subjects.reduce((sum, subject) => sum + subject.count, 0);
  const buttons = subjects.map((subject, index) =>
    `<a class="company-link${index === 0 ? " is-active" : ""}" data-company-name="${escapeHtml(subject.name.toLowerCase())}" href="#${subject.id}"${index === 0 ? ' aria-current="true"' : ""}><span>${escapeHtml(subject.name)}</span><strong>${subject.count}</strong></a>`,
  ).join("\n          ");
  const sections = subjects.map((subject, index) => {
    const rows = subject.items.map((item) => `        <article class="news-row">
          <div class="news-meta"><time datetime="${item.date}">${item.date}</time><span>${escapeHtml(item.segment)}</span></div>
          <h3>${escapeHtml(item.headline)}</h3>
          <a class="report-link" href="${escapeHtml(item.report_file)}${item.report_anchor ? `#${escapeHtml(item.report_anchor)}` : ""}">查看对应新闻</a>
        </article>`).join("\n");
    return `      <section class="company-section" id="${subject.id}" data-company-name="${escapeHtml(subject.name.toLowerCase())}"${index === 0 ? "" : " hidden"}>
        <div class="company-heading"><div><p>动态记录</p><h2>${escapeHtml(subject.name)}</h2></div><span>${subject.count} 条相关新闻</span></div>
${rows}
      </section>`;
  }).join("\n\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="按公司和机构查看锂电产业链历次报告中的相关新闻">
  <title>企业动态 | 锂电产业链新闻简报</title>
  <style>
    :root { --ink:#17324a; --muted:#5b7185; --blue:#1769aa; --blue-deep:#0d4f86; --blue-pale:#eaf6ff; --paper:#fbfdff; --line:#87bce5; --yellow:#ffe998; --shadow:rgba(23,50,74,.09); }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; background:#eef7fd; }
    body { margin:0; color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; line-height:1.65; letter-spacing:0; background:repeating-linear-gradient(0deg,rgba(23,105,170,.025) 0,rgba(23,105,170,.025) 1px,transparent 1px,transparent 28px),var(--paper); }
    a { color:var(--blue-deep); text-underline-offset:3px; }
    .page { width:min(1120px,calc(100% - 32px)); margin:0 auto; padding:28px 0 56px; }
    .site-nav { display:flex; align-items:center; justify-content:space-between; gap:20px; margin-bottom:18px; padding:0 3px 12px; border-bottom:2px dashed var(--line); }
    .site-nav a { color:var(--blue-deep); font-weight:800; text-decoration:none; }
    .site-nav a:hover,.site-nav a:focus-visible,.site-nav .current { text-decoration:underline; }
    .site-nav .brand { color:var(--blue); }
    .nav-links { display:flex; flex-wrap:wrap; gap:18px; }
    .masthead { padding:24px 28px; border-top:2px dashed var(--line); border-bottom:2px dashed var(--line); background:#f5fbff; }
    .kicker { margin:0 0 6px; color:var(--blue-deep); font-size:.9rem; font-weight:800; text-transform:uppercase; }
    h1,h2,h3 { letter-spacing:0; }
    h1 { margin:0; color:var(--blue); font-size:2.2rem; line-height:1.2; }
    .intro { margin:10px 0 0; color:var(--muted); }
    .summary { display:flex; flex-wrap:wrap; gap:8px; margin-top:16px; }
    .summary span { padding:4px 9px; border:1px solid #b7d6ee; border-radius:999px; background:#fff; color:#355b78; font-size:.86rem; font-weight:700; }
    .directory-layout { display:grid; grid-template-columns:290px minmax(0,1fr); gap:28px; margin-top:26px; align-items:start; }
    .company-panel { position:sticky; top:16px; min-width:0; padding-right:20px; border-right:2px dashed var(--line); }
    .company-panel label { display:block; margin-bottom:8px; color:var(--blue-deep); font-size:.86rem; font-weight:800; }
    .filter { width:100%; padding:10px 12px; border:1px solid #a8cee9; border-radius:6px; background:#fff; color:var(--ink); font:inherit; }
    .company-list { display:grid; gap:3px; max-height:calc(100vh - 190px); margin-top:12px; padding-right:6px; overflow:auto; }
    .company-link { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:10px; min-height:40px; padding:7px 9px; border-left:3px solid transparent; color:var(--ink); font-size:.88rem; font-weight:750; text-decoration:none; }
    .company-link span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .company-link strong { display:grid; place-items:center; min-width:24px; height:24px; padding:0 6px; border-radius:999px; background:var(--blue-pale); color:var(--blue-deep); font-size:.75rem; }
    .company-link:hover,.company-link:focus-visible { background:#f1f8fd; }
    .company-link.is-active { border-left-color:var(--blue); background:#eaf6ff; color:var(--blue-deep); }
    .company-results { min-width:0; }
    .company-section { scroll-margin-top:18px; }
    .company-heading { display:flex; align-items:end; justify-content:space-between; gap:20px; padding:2px 0 14px; border-bottom:2px dashed var(--line); }
    .company-heading p { margin:0 0 3px; color:var(--muted); font-size:.76rem; font-weight:800; text-transform:uppercase; }
    .company-heading h2 { margin:0; color:var(--blue-deep); font-size:1.45rem; }
    .company-heading > span { color:var(--muted); font-size:.86rem; font-weight:750; white-space:nowrap; }
    .news-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px 20px; padding:18px 2px; border-bottom:1px dashed #b2d0e6; }
    .news-meta { display:flex; flex-wrap:wrap; gap:8px; color:var(--muted); font-size:.82rem; }
    .news-meta span { padding:1px 7px; border-radius:999px; background:var(--blue-pale); }
    .news-row h3 { grid-column:1; margin:0; font-size:1rem; line-height:1.5; }
    .report-link { grid-column:2; grid-row:1 / span 2; align-self:center; padding:6px 9px; border:1px solid #a8cee9; border-radius:6px; background:#fff; font-size:.84rem; font-weight:800; text-decoration:none; white-space:nowrap; }
    .report-link:hover,.report-link:focus-visible { background:var(--blue-pale); }
    .empty { display:none; margin:18px 0; color:var(--muted); }
    footer { margin-top:30px; color:var(--muted); font-size:.86rem; }
    [hidden] { display:none !important; }
    @media (max-width:760px) { .page{width:min(100% - 20px,1120px);padding-top:14px}.site-nav{align-items:flex-start}.site-nav .brand{max-width:130px}.nav-links{gap:10px}.masthead{padding:20px}h1{font-size:1.75rem}.directory-layout{grid-template-columns:1fr;gap:22px}.company-panel{position:static;padding:0 0 18px;border-right:0;border-bottom:2px dashed var(--line)}.company-list{grid-template-columns:repeat(2,minmax(0,1fr));max-height:240px;padding-right:4px}.company-heading{align-items:flex-start}.news-row{grid-template-columns:1fr}.report-link{grid-column:1;grid-row:auto;justify-self:start} }
  </style>
</head>
<body>
  <main class="page">
    <nav class="site-nav" aria-label="报告导航">
      <a class="brand" href="./">Lithium Industry Briefing</a>
      <div class="nav-links">
        <a href="./">最新报告</a>
        <a href="archive.html">历史报告</a>
        <a class="current" aria-current="page" href="subjects.html">企业动态</a>
      </div>
    </nav>
    <header class="masthead">
      <p class="kicker">Company Index</p>
      <h1>企业动态</h1>
      <p class="intro">按公司或机构集中查看历次报告中的相关新闻。</p>
      <div class="summary"><span>${subjects.length} 家公司与机构</span><span>${totalReferences} 条新闻关联</span></div>
    </header>
    <div class="directory-layout">
      <aside class="company-panel" aria-label="公司目录">
        <label for="company-filter">查找公司或机构</label>
        <input class="filter" id="company-filter" type="search" placeholder="输入名称" autocomplete="off">
        <nav class="company-list" aria-label="公司列表">
          ${buttons}
        </nav>
        <p class="empty" id="empty-state">没有匹配的公司或机构。</p>
      </aside>
      <div class="company-results" aria-live="polite">
${sections}
      </div>
    </div>
    <footer>随每期报告自动更新。</footer>
  </main>
  <script>
    const input = document.querySelector('#company-filter');
    const links = [...document.querySelectorAll('.company-link')];
    const sections = [...document.querySelectorAll('.company-section')];
    const empty = document.querySelector('#empty-state');
    const activate = (id, shouldScroll = false) => {
      const target = sections.find((section) => section.id === id) || sections[0];
      if (!target) return;
      for (const section of sections) section.hidden = section !== target;
      for (const link of links) {
        const active = link.hash === '#' + target.id;
        link.classList.toggle('is-active', active);
        if (active) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      }
      history.replaceState(null, '', '#' + target.id);
      if (shouldScroll && window.matchMedia('(max-width: 760px)').matches) target.scrollIntoView({ behavior: 'smooth' });
    };
    for (const link of links) link.addEventListener('click', (event) => {
      event.preventDefault();
      activate(link.hash.slice(1), true);
    });
    input.addEventListener('input', () => {
      const query = input.value.trim().toLowerCase();
      let visible = 0;
      let onlyMatch;
      for (const link of links) {
        const match = !query || link.dataset.companyName.includes(query);
        link.hidden = !match;
        if (match) {
          visible += 1;
          onlyMatch = link;
        }
      }
      empty.style.display = visible ? 'none' : 'block';
      if (visible === 1) activate(onlyMatch.hash.slice(1));
    });
    activate(location.hash.slice(1));
  </script>
</body>
</html>
`;
}

export async function buildSubjectIndex() {
  const reportsFile = JSON.parse(await readFile(path.join(ROOT, "reports.json"), "utf8"));
  reportsFile.reports = reportsFile.reports.map((report) => ({
    ...report,
    title: report.title === "锂电产业链新闻日报" ? "锂电产业链新闻简报" : report.title,
  }));
  const grouped = new Map();

  for (const report of reportsFile.reports) {
    const reportPath = path.join(ROOT, report.file);
    const html = ensureNewsAnchors(ensureSubjectNavigation(await readFile(reportPath, "utf8")));
    await writeFile(reportPath, html);
    for (const item of parseReport(html, report)) {
      const group = grouped.get(item.subject) || [];
      group.push(item);
      grouped.set(item.subject, group);
    }
  }

  const subjects = [...grouped.entries()].map(([name, items]) => ({
    id: subjectId(name),
    name,
    count: items.length,
    items: items.sort((left, right) => right.date.localeCompare(left.date) || right.report_date.localeCompare(left.report_date)),
  })).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, "zh-CN"));

  const siteFiles = (await readdir(ROOT)).filter((file) =>
    file === "index.html" || file === "archive.html" || /^daily-\d{4}-\d{2}-\d{2}\.html$/.test(file),
  );
  await Promise.all(siteFiles.map(async (file) => {
    const filePath = path.join(ROOT, file);
    const html = await readFile(filePath, "utf8");
    await writeFile(filePath, ensureNewsAnchors(ensureSubjectNavigation(html)));
  }));

  await Promise.all([
    writeFile(path.join(ROOT, "subjects.html"), renderSubjects(subjects)),
    writeFile(path.join(ROOT, "subjects.json"), `${JSON.stringify({ updated_at: new Date().toISOString(), subjects }, null, 2)}\n`),
    writeFile(path.join(ROOT, "reports.json"), `${JSON.stringify(reportsFile, null, 2)}\n`),
  ]);
  console.log(`Built subject index: ${subjects.length} subjects, ${subjects.reduce((sum, subject) => sum + subject.count, 0)} references.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildSubjectIndex();
}

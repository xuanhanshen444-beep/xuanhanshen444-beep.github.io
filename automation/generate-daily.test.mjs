import assert from "node:assert/strict";
import test from "node:test";
import { extractPublicationCutoff, renderCard } from "./generate-daily.mjs";

const event = {
  segment: "终端电车",
  content_type: "事实动态",
  headline: "某车企发布新车型",
  info_date: "2026-07-14",
  event_details: "某车企于7月14日发布新车型。",
  background: "",
  cathode_impact: "",
  country_region: "中国",
  companies: ["某车企"],
  themes: ["新车型"],
  main_source_label: "电动车公社微信公众号原文",
  main_url: "https://mp.weixin.qq.com/s/example",
  official_source_status: "公司官网未检索到原文",
  background_sources: [],
};

test("labels a WeChat original when no company-site source was found", () => {
  const html = renderCard(event, 1);
  assert.match(html, /官网核验：<\/strong>公司官网未检索到原文/);
  assert.ok(html.indexOf("官网核验") < html.indexOf("新闻链接"));
  assert.match(html, /https:\/\/mp\.weixin\.qq\.com\/s\/example/);
});

test("does not add the missing-source label when an official source was found", () => {
  const html = renderCard({
    ...event,
    official_source_status: "已找到公司官网或官方公告原文",
  }, 1);
  assert.doesNotMatch(html, /官网核验/);
});

test("renders industry viewpoints as attributed analysis instead of fact news", () => {
  const html = renderCard({
    ...event,
    content_type: "行业观点",
    headline: "芝能汽车：价格战正在转向配置与权益竞争",
    event_details: "芝能汽车结合近期车型配置与渠道反馈提出判断。",
    main_source_label: "芝能汽车微信公众号原文",
    official_source_status: "不适用（观点内容）",
  }, 1);
  assert.match(html, /内容类型 · 行业观点/);
  assert.match(html, /观点摘要/);
  assert.match(html, /不等同于已发生事实/);
  assert.match(html, /观点原文/);
  assert.doesNotMatch(html, /本次事件/);
});

test("does not duplicate the viewpoint disclaimer from model output", () => {
  const html = renderCard({
    ...event,
    content_type: "行业观点",
    event_details: "作者基于渠道反馈提出判断。阅读提示：以上为作者观点，不等同于已发生事实。",
    official_source_status: "不适用（观点内容）",
  }, 1);
  assert.equal((html.match(/不等同于已发生事实/g) || []).length, 1);
});

test("uses the prior report's actual source cutoff across a schedule change", () => {
  const html = '<span>资料截止 2026-07-13 19:24 (Asia/Shanghai)</span>';
  assert.equal(
    extractPublicationCutoff(html, "2026-07-13"),
    "2026-07-13 19:24 (Asia/Shanghai)",
  );
});

test("falls back to the new 16:30 publication time when cutoff metadata is absent", () => {
  assert.equal(
    extractPublicationCutoff("<html></html>", "2026-07-18"),
    "2026-07-18 16:30 (Asia/Shanghai)",
  );
});

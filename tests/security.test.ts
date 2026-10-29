import assert from "node:assert/strict";
import test from "node:test";
import { renderInlineSafe } from "../src/lib/safe-markdown";
import { evaluateReportQuality } from "../src/lib/quality";
import {
  exceedsContentLength,
  normalizePublicHttpUrls,
  readFormDataWithLimit,
  validateFiles,
  MAX_FILE_BYTES,
} from "../src/lib/request-validation";

test("report inline rendering escapes HTML and rejects active URL schemes", () => {
  const rendered = renderInlineSafe('<img src=x onerror=alert(1)> [click](javascript:alert(1))');
  assert.match(rendered, /&lt;img/);
  assert.doesNotMatch(rendered, /<img|<script/i);
  assert.doesNotMatch(rendered, /href="javascript:/i);
  assert.match(rendered, /click/);
});

test("safe report links retain only HTTP(S) and escaped attributes", () => {
  const rendered = renderInlineSafe('[source](https://example.com/report?a=1&b=2)');
  assert.match(rendered, /href="https:\/\/example\.com\/report\?a=1&amp;b=2"/);
  assert.match(rendered, /rel="noopener noreferrer"/);
});

test("source URL validation blocks local and private network targets", () => {
  for (const url of ["http://localhost/admin", "http://127.0.0.1/", "http://10.0.0.1/", "http://[::1]/", "file:///etc/passwd"]) {
    assert.ok(normalizePublicHttpUrls([url]).error, `${url} should be rejected`);
  }
  assert.deepEqual(normalizePublicHttpUrls(["https://example.com/a"]).urls, ["https://example.com/a"]);
});

test("request and upload limits reject malformed and oversized input", () => {
  assert.equal(exceedsContentLength("512", 1024), false);
  assert.equal(exceedsContentLength("not-a-number", 1024), true);
  assert.equal(exceedsContentLength("2048", 1024), true);
  assert.match(validateFiles([{ name: "large.pdf", size: MAX_FILE_BYTES + 1 }]) || "", /不能超过/);
});

test("multipart parsing enforces a streaming byte limit even without Content-Length", async () => {
  const oversizedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(100)));
      controller.close();
    },
  });
  const request = new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=limited-test" },
    body: oversizedBody,
    duplex: "half",
  } as RequestInit);
  const oversized = await readFormDataWithLimit(request, 8);
  assert.deepEqual(oversized, { ok: false, reason: "too_large" });

  const validForm = new FormData();
  validForm.set("source_urls", "[]");
  const validRequest = new Request("http://localhost/api", { method: "POST", body: validForm });
  const valid = await readFormDataWithLimit(validRequest, 1024);
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.value.get("source_urls"), "[]");
});

test("report inline rendering formats bold text and safe table-of-contents links", () => {
  const rendered = renderInlineSafe("**加粗** [执行摘要](#sec_exec_summary) &nbsp;");
  assert.match(rendered, /<strong[^>]*>加粗<\/strong>/);
  assert.match(rendered, /href="#sec_exec_summary"/);
  assert.doesNotMatch(rendered, /&amp;nbsp;/);
});

test("report fragment links reject attribute injection", () => {
  const rendered = renderInlineSafe('[x](#ok" onclick="alert(1))');
  assert.doesNotMatch(rendered, /onclick=/i);
});


test("strict report quality blocks missing provenance, weak citations, and placeholders", () => {
  const report = [
    "## 执行摘要",
    "这段结论没有引用。",
    "## 核心指标概览",
    "## 详细分析",
    "## 冲突与差异分析",
    "## 风险提示",
    "## 结论与建议",
    "结论字段为 undefined。",
  ].join("\n\n");
  const result = evaluateReportQuality({
    report,
    evidence: [{
      evidence_id: "E000001",
      source_id: "S001",
      subject: "比亚迪",
      predicate: "销量",
      object: "披露",
      value: 100,
      unit: "辆",
      period: "2026-08",
      scope: "月度",
      evidence_type: "number",
      locator: { page: 1 },
      quote: "2026年8月销量100辆。",
      confidence: 0.9,
      source_authority: 5,
    }],
    conflicts: [],
    sources: [],
    strictMode: true,
    decisionQuestion: "分析销量变化",
  });

  assert.equal(result.quality_status, "blocked");
  assert.ok(result.blocking_reasons?.some((reason) => reason.includes("来源清单缺失")));
  assert.ok(result.blocking_reasons?.some((reason) => reason.includes("引用覆盖率不足")));
  assert.ok(result.blocking_reasons?.some((reason) => reason.includes("占位字段")));
});

test("strict report quality blocks a missing decision question", () => {
  const report = [
    "## 执行摘要",
    "事实 [E000001]",
    "## 核心指标概览",
    "## 详细分析",
    "## 冲突与差异分析",
    "## 风险提示",
    "## 结论与建议",
  ].join("\n\n");
  const result = evaluateReportQuality({
    report,
    evidence: [{
      evidence_id: "E000001",
      source_id: "S001",
      subject: "比亚迪",
      predicate: "销量",
      object: "披露",
      value: 100,
      unit: "辆",
      period: "2026-08",
      scope: "月度",
      evidence_type: "number",
      locator: { page: 1 },
      quote: "2026年8月销量100辆。",
      confidence: 0.9,
      source_authority: 5,
    }],
    conflicts: [],
    sources: [{
      source_id: "S001",
      file_name: "公告.pdf",
      file_type: "application/pdf",
      source_title: "公告",
      authority_level: 5,
      parse_method: "manual",
      parse_status: "ready",
      char_count: 100,
      chunk_count: 1,
    }],
    strictMode: true,
  });

  assert.equal(result.quality_status, "blocked");
  assert.ok(result.blocking_reasons?.some((reason) => reason.includes("核心分析问题")));
});

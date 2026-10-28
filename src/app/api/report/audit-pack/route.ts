import { NextRequest } from "next/server";
import { exceedsContentLength, isRecord, MAX_JSON_REQUEST_BYTES, readJsonWithLimit } from "@/lib/request-validation";

export const runtime = "nodejs";

const MAX_REPORT_LENGTH = 1_000_000;
const MAX_ITEMS = 10_000;

/** Build a downloadable JSON audit artifact from the completed client-side job. */
export async function POST(request: NextRequest) {
  try {
    if (exceedsContentLength(request.headers.get("content-length"), MAX_JSON_REQUEST_BYTES)) {
      return Response.json({ error: "审计包超过 8 MB 限制" }, { status: 413 });
    }

    const json = await readJsonWithLimit(request, MAX_JSON_REQUEST_BYTES);
    if (!json.ok) {
      return Response.json({ error: json.reason === "too_large" ? "审计包超过 8 MB 限制" : "请求内容格式无效" }, { status: json.reason === "too_large" ? 413 : 400 });
    }
    if (!isRecord(json.value)) {
      return Response.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
    }
    const body = json.value;

    const report = typeof body.report === "string" ? body.report : "";
    const evidence = Array.isArray(body.evidence_ledger) ? body.evidence_ledger : [];
    const conflicts = Array.isArray(body.conflict_register) ? body.conflict_register : [];
    const sources = Array.isArray(body.source_registry) ? body.source_registry : [];

    if (report.length > MAX_REPORT_LENGTH || evidence.length > MAX_ITEMS || conflicts.length > MAX_ITEMS || sources.length > MAX_ITEMS) {
      return Response.json({ error: "审计包字段超过允许大小" }, { status: 413 });
    }
    if (!report && evidence.length === 0 && conflicts.length === 0 && sources.length === 0) {
      return Response.json({ error: "没有可导出的报告或审计数据" }, { status: 400 });
    }

    const rawJobId = typeof body.job_id === "string" ? body.job_id : "report";
    const jobId = rawJobId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "report";
    const pack = {
      schema_version: "1.0.0",
      job_id: jobId,
      generated_at: new Date().toISOString(),
      report_markdown: report,
      evidence_ledger: evidence,
      conflict_register: conflicts,
      source_registry: sources,
      quality_metrics: body.quality_metrics ?? null,
    };

    return new Response(JSON.stringify(pack, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="audit_pack_${jobId}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "无效的请求体";
    return Response.json({ error: `审计包生成失败：${message}` }, { status: 400 });
  }
}

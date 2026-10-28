import { NextRequest } from "next/server";
import { isCozeConfigured } from "@/lib/coze-client";

export const runtime = "edge";

/**
 * GET /api/report/audit-pack?job_id=xxx
 *
 * 下载审计包（ZIP 或 JSON 合集）
 * 包含：报告正文、证据台账、冲突清单、解析清单、质量报告
 *
 * 当 Coze 未配置时，从前端传来的数据中直接组装本地演示版
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("job_id");

  if (!isCozeConfigured()) {
    // 演示模式：返回一个示例审计包 JSON
    const demoPack = {
      job_id: jobId || "demo_job",
      generated_at: new Date().toISOString(),
      version: "1.0.0",
      files: {
        "report.md": {
          content_type: "text/markdown",
          description: "专业报告正文",
        },
        "evidence_ledger.json": {
          content_type: "application/json",
          description: "证据台账",
        },
        "conflict_register.json": {
          content_type: "application/json",
          description: "冲突清单",
        },
        "parse_manifest.md": {
          content_type: "text/markdown",
          description: "解析清单",
        },
        "quality_report.json": {
          content_type: "application/json",
          description: "质量报告",
        },
      },
      note: "此为本地演示版本。配置 Coze 工作流后，将返回真实审计包数据。",
    };

    return new Response(JSON.stringify(demoPack, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="audit_pack_${jobId || "demo"}.json"`,
      },
    });
  }

  // 真实模式：TODO 调用工作流结果接口获取完整审计包
  return new Response(
    JSON.stringify({
      error: "完整审计包导出需在工作流 WF60 中实现",
    }),
    { status: 501 },
  );
}

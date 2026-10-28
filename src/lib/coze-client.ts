/**
 * Coze 工作流 API 客户端
 *
 * 通过 HTTP OpenAPI 调用扣子平台上已发布的工作流
 * 参考：https://docs.coze.cn/developer_guides_workflow_run
 */

const COZE_API_BASE =
  process.env.COZE_API_BASE_URL || "https://api.coze.cn";
const COZE_TOKEN = process.env.COZE_WORKLOAD_API_TOKEN || "";

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${COZE_TOKEN}`,
    "Content-Type": "application/json",
  };
  // 支持自定义额外请求头（调试用）
  const extra = process.env.COZE_EXTRA_HEADERS || "";
  if (extra) {
    for (const pair of extra.split(";")) {
      const idx = pair.indexOf("=");
      if (idx > 0) {
        headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      }
    }
  }
  return headers;
}

/** 是否配置了可用的 Coze 凭证 */
export function isCozeConfigured(): boolean {
  return !!COZE_TOKEN && !!process.env.COZE_WORKFLOW_ID;
}

/**
 * 流式执行工作流
 * 返回 ReadableStream，前端通过 SSE 消费进度事件
 */
export async function streamWorkflow(
  parameters: Record<string, unknown>,
): Promise<Response> {
  const workflowId = process.env.COZE_WORKFLOW_ID;
  if (!workflowId) {
    throw new Error("COZE_WORKFLOW_ID 未配置");
  }
  if (!COZE_TOKEN) {
    throw new Error("COZE_WORKLOAD_API_TOKEN 未配置");
  }

  const response = await fetch(`${COZE_API_BASE}/v1/workflow/stream_run`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({
      workflow_id: workflowId,
      parameters,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Coze 工作流调用失败 (${response.status}): ${text.slice(0, 500)}`,
    );
  }

  return response;
}

/**
 * 同步执行工作流（短任务用，长任务建议用流式）
 */
export async function runWorkflow(
  parameters: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const workflowId = process.env.COZE_WORKFLOW_ID;
  if (!workflowId) {
    throw new Error("COZE_WORKFLOW_ID 未配置");
  }
  if (!COZE_TOKEN) {
    throw new Error("COZE_WORKLOAD_API_TOKEN 未配置");
  }

  const response = await fetch(`${COZE_API_BASE}/v1/workflow/run`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({
      workflow_id: workflowId,
      parameters,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Coze 工作流调用失败 (${response.status}): ${text.slice(0, 500)}`,
    );
  }

  const data = await response.json();
  return data as Record<string, unknown>;
}

/**
 * 解析 SSE 事件流中的单行事件
 * 返回 { event, data } 或 null（空行/注释等）
 */
export function parseSseLine(line: string): {
  event: string;
  data: string;
} | null {
  if (!line || line.startsWith(":")) return null;
  if (line.startsWith("event:")) {
    return { event: line.slice(6).trim(), data: "" };
  }
  if (line.startsWith("data:")) {
    return { event: "", data: line.slice(5).trim() };
  }
  return null;
}

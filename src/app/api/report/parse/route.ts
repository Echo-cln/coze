import { NextRequest } from "next/server";
import { uploadAndGetSignedUrl, isStorageAvailable } from "@/lib/storage";
import type { SourceRegistry, ParsedChunk } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * WF10 工作流基础地址
 *
 * 优先从环境变量 WF10_BASE_URL 读取；
 * 若未配置且 WF00 主工作流也未配置，则走 Mock 模式。
 */
function getWf10BaseUrl(): string | null {
  return process.env.WF10_BASE_URL || null;
}

function getWf10Token(): string | null {
  return process.env.WF10_API_TOKEN || null;
}

function isWf10Available(): boolean {
  return !!getWf10BaseUrl();
}

/**
 * POST /api/report/parse
 *
 * 阶段一：材料解析（对应 WF10_Ingest_Parse）
 *
 * 请求体 (multipart/form-data)：
 *   - files:            上传的文件数组
 *   - source_urls:      URL 列表（JSON 字符串数组）
 *   - auto_collect:     "true" | "false"
 *   - allowed_domains:  域名白名单（逗号分隔字符串）
 *   - cutoff_date:      YYYY-MM-DD
 *   - job_id:           任务 ID（可选，不传则自动生成）
 *
 * 响应（SSE 事件流）：
 *   event: source — 每个来源解析完成时推送（SourceRegistry 结构）
 *   event: done   — 全部完成 { total, success, failed, pending }
 *   event: error  — 错误 { message }
 */
export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") || "";
  let fileEntries: File[] = [];
  let sourceUrls: string[] = [];
  let autoCollect = false;
  let allowedDomains: string[] = [];
  let cutoffDate: string | null = null;
  let jobIdFromReq: string | null = null;

  if (contentType.includes("multipart/form-data")) {
    const formData = await req.formData();
    fileEntries = formData.getAll("files") as File[];
    const sourceUrlsRaw = formData.get("source_urls") as string | null;
    const autoCollectRaw = formData.get("auto_collect") as string | null;
    const allowedDomainsRaw = formData.get("allowed_domains") as string | null;
    cutoffDate = formData.get("cutoff_date") as string | null;
    jobIdFromReq = formData.get("job_id") as string | null;

    sourceUrls = sourceUrlsRaw ? JSON.parse(sourceUrlsRaw) : [];
    autoCollect = autoCollectRaw === "true";
    allowedDomains = allowedDomainsRaw
      ? allowedDomainsRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  } else {
    const body = await req.json();
    sourceUrls = body.source_urls || [];
    autoCollect = body.auto_collect || false;
    allowedDomains = body.allowed_domains || [];
    cutoffDate = body.cutoff_date || null;
    jobIdFromReq = body.job_id || null;
  }

  const jobId = jobIdFromReq || `JOB${Date.now()}`;

  // 如果 WF10 未配置，走 Mock 模式
  if (!isWf10Available()) {
    return mockParseStream(fileEntries, sourceUrls);
  }

  // 文件上传到对象存储，获得签名 URL
  const storageReady = isStorageAvailable();
  const wf10Files: Array<{ url: string; file_type: string }> = [];

  if (fileEntries.length > 0 && !storageReady) {
    return sseError("已配置 WF10，但没有配置对象存储；无法将上传文件安全地传给解析工作流。请配置 COZE_BUCKET_ENDPOINT_URL 和 COZE_BUCKET_NAME，或改用在线来源 URL。");
  }

  for (const file of fileEntries) {
    if (storageReady) {
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const signedUrl = await uploadAndGetSignedUrl(buffer, file.name, file.type);
      if (signedUrl) {
        wf10Files.push({ url: signedUrl, file_type: "document" });
        continue;
      }
      return sseError(`文件 ${file.name} 上传对象存储失败，已停止解析，避免静默跳过该材料。`);
    }
  }

  const wf10Base = getWf10BaseUrl()!;
  const wf10Url = `${wf10Base.replace(/\/$/, "")}/stream_run`;

  const wf10Body = {
    job_id: jobId,
    files: wf10Files,
    source_urls: sourceUrls,
    auto_collect: autoCollect,
    allowed_domains: allowedDomains,
    cutoff_date: cutoffDate || new Date().toISOString().split("T")[0],
    user_id: "workbench_user_01",
  };

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    const token = getWf10Token();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const wf10Res = await fetch(wf10Url, {
      method: "POST",
      headers,
      body: JSON.stringify(wf10Body),
    });

    if (!wf10Res.ok || !wf10Res.body) {
      const errText = await wf10Res.text().catch(() => "");
      return sseError(`WF10 调用失败 (${wf10Res.status}): ${errText || "未知错误"}`);
    }

    // 将 WF10 的 SSE 流翻译成前端协议事件
    return translateWf10Stream(wf10Res.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return sseError(`调用 WF10 异常: ${message}`);
  }
}

// ===================== WF10 SSE 翻译层 =====================

/**
 * 将 WF10 /stream_run 的 SSE 输出翻译为前端约定事件。
 *
 * WF10 输出格式（Coze 标准 SSE）：
 *   event: message
 *   data: { type: "workflow_start", ... }
 *   data: { type: "workflow_end", output: { source_manifest, parsed_chunks, pending_sources, failed_sources } }
 *
 * 前端约定事件：
 *   event: source — 每个来源解析完成时推送
 *   event: done   — 全部完成 { total, success, pending, failed, sources, parsed_chunks }
 *   event: error  — 错误
 */
function translateWf10Stream(wf10Body: ReadableStream<Uint8Array>): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      const reader = wf10Body.getReader();
      let totalSources = 0;
      let successCount = 0;
      let pendingCount = 0;
      let failedCount = 0;
      const allSources: SourceRegistry[] = [];
      let allChunks: ParsedChunk[] = [];

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // 按 SSE 事件边界切分
          const eventBlocks = buffer.split(/\r?\n\r?\n/);
          buffer = eventBlocks.pop() || "";

          for (const block of eventBlocks) {
            const lines = block.split(/\r?\n/).filter((l) => l.length > 0);
            let eventName = "message";
            let dataStr = "";

            for (const line of lines) {
              if (line.startsWith("event:")) {
                eventName = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                dataStr += line.slice(5).trim();
              }
            }

            if (!dataStr) continue;

            // Coze 标准格式：所有事件都是 message，data 中有 type 字段区分
            if (eventName === "message") {
              try {
                const payload = JSON.parse(dataStr);
                const msgType = payload.type || payload.event || "";

                if (msgType === "workflow_end" && payload.output) {
                  const output = payload.output as Record<string, unknown>;

                  // 1. 处理 source_manifest（成功解析的来源）
                  if (Array.isArray(output.source_manifest)) {
                    for (const item of output.source_manifest) {
                      if (item && typeof item === "object" && "source_id" in item) {
                        const src = wf10SourceToUi(item as Record<string, unknown>);
                        totalSources++;
                        allSources.push(src as SourceRegistry);
                        if (src.parse_status === "ready") successCount++;
                        else if (src.parse_status === "ocr_pending") pendingCount++;
                        else if (src.parse_status === "failed") failedCount++;
                        send("source", src);
                      }
                    }
                  }

                  // 2. 处理 pending_sources（待 OCR 的）
                  if (Array.isArray(output.pending_sources)) {
                    for (const item of output.pending_sources) {
                      if (item && typeof item === "object") {
                        const src = wf10SourceToUi(item as Record<string, unknown>);
                        // 仅当 source_manifest 中没有相同 source_id 时才添加
                        const exists = allSources.some(
                          (s) => s.source_id === src.source_id,
                        );
                        if (!exists) {
                          totalSources++;
                          pendingCount++;
                          allSources.push(src as SourceRegistry);
                          send("source", src);
                        }
                      }
                    }
                  }

                  // 3. 处理 failed_sources（解析失败的）
                  if (Array.isArray(output.failed_sources)) {
                    for (const item of output.failed_sources) {
                      if (item && typeof item === "object") {
                        const src = wf10SourceToUi(item as Record<string, unknown>);
                        const exists = allSources.some(
                          (s) => s.source_id === src.source_id,
                        );
                        if (!exists) {
                          totalSources++;
                          failedCount++;
                          allSources.push(src as SourceRegistry);
                          send("source", src);
                        }
                      }
                    }
                  }

                  // 4. 累积 parsed_chunks
                  if (Array.isArray(output.parsed_chunks)) {
                    allChunks = output.parsed_chunks as ParsedChunk[];
                  }

                  // 5. 发送 done 事件
                  send("done", {
                    total: totalSources,
                    success: successCount,
                    pending: pendingCount,
                    failed: failedCount,
                    sources: allSources,
                    parsed_chunks: allChunks,
                  });
                }
                // workflow_start 事件忽略即可
              } catch {
                // 解析失败，忽略
              }
            }
          }
        }

        // 流结束但未收到任何来源（异常情况），补一个 done
        if (allSources.length === 0) {
          send("done", {
            total: 0,
            success: 0,
            pending: 0,
            failed: 0,
            sources: [],
            parsed_chunks: [],
          });
        }

        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send("error", { message: `SSE 流处理异常: ${message}` });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * 将 WF10 的 source 结构转换为前端 SourceRegistry 结构
 */
function wf10SourceToUi(wf10Src: Record<string, unknown>) {
  const parseStatus = wf10Src.parse_status as string;
  let uiStatus = "ready";
  if (parseStatus === "failed") uiStatus = "failed";
  else if (parseStatus === "pending_ocr" || parseStatus === "pending" || parseStatus === "need_ocr")
    uiStatus = "ocr_pending";
  else if (parseStatus === "parsing" || parseStatus === "processing") uiStatus = "parsing";

  const rawMethod = (wf10Src.parse_method as string) || "link_reader";
  let uiMethod = "link_reader";
  if (rawMethod.includes("ocr") || rawMethod.includes("precise")) uiMethod = "precise_ocr";
  else if (rawMethod.includes("manual")) uiMethod = "manual";

  return {
    source_id: wf10Src.source_id as string,
    source_type: (wf10Src.source_type as string) || "file",
    file_name:
      (wf10Src.file_name as string) ||
      (wf10Src.source_title as string) ||
      (wf10Src.url as string) ||
      "未命名",
    file_type: (wf10Src.file_type as string) || "unknown",
    source_title:
      (wf10Src.source_title as string) ||
      (wf10Src.file_name as string) ||
      "",
    authority_level: (wf10Src.authority_level as number) ?? 3,
    parse_method: uiMethod,
    parse_status: uiStatus,
    char_count: (wf10Src.char_count as number) || 0,
    chunk_count: (wf10Src.chunk_count as number) || 0,
    source_fingerprint:
      (wf10Src.source_fingerprint as string | null | undefined) ?? undefined,
    error_message:
      (wf10Src.error_message as string | null | undefined) ??
      (wf10Src.error as string | null | undefined) ??
      undefined,
    url: (wf10Src.url as string | null | undefined) ?? undefined,
  };
}

// ===================== Mock 模式 =====================

function mockParseStream(
  fileEntries: File[],
  sourceUrls: string[],
): Response {
  const encoder = new TextEncoder();
  const total = fileEntries.length + sourceUrls.length;

  const sources: Array<Record<string, unknown>> = [
    ...fileEntries.map((f, i) => ({
      source_id: `S${String(i + 1).padStart(3, "0")}`,
      source_type: "file",
      file_name: f.name,
      file_type: f.type || "unknown",
      source_title: f.name.replace(/\.[^.]+$/, ""),
      authority_level: 4,
      parse_method: f.size > 500 * 1024 ? "precise_ocr" : "link_reader",
      parse_status: "ready",
      char_count: Math.floor(2000 + Math.random() * 15000),
      chunk_count: Math.floor(3 + Math.random() * 20),
      url: null,
    })),
    ...sourceUrls.map((url, i) => {
      const idx = fileEntries.length + i + 1;
      let hostname = url;
      try {
        hostname = new URL(url).hostname;
      } catch {
        // ignore
      }
      return {
        source_id: `S${String(idx).padStart(3, "0")}`,
        source_type: "url",
        file_name: url,
        file_type: "url",
        source_title: hostname,
        authority_level: 3,
        parse_method: "link_reader",
        parse_status: "ready",
        char_count: Math.floor(1000 + Math.random() * 8000),
        chunk_count: Math.floor(2 + Math.random() * 10),
        url,
      };
    }),
  ];

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, d: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(d)}\n\n`),
        );
      };

      for (const src of sources) {
        await new Promise((r) => setTimeout(r, 300 + Math.random() * 400));
        send("source", src);
      }

      // 模拟一个失败案例（如果来源数 ≥ 3）
      if (sources.length >= 3) {
        const last = sources[sources.length - 1];
        await new Promise((r) => setTimeout(r, 300));
        send("source", {
          ...last,
          parse_status: "failed",
          error_message: "文件格式不支持或已损坏",
        });
      }

      // 模拟一个待 OCR 案例
      if (sources.length >= 2) {
        const mid = sources[Math.floor(sources.length / 2)];
        await new Promise((r) => setTimeout(r, 200));
        send("source", {
          ...mid,
          parse_status: "pending_ocr",
          error_message: "疑似扫描件，需 OCR 精准解析",
        });
      }

      // 生成模拟 parsed_chunks（给后续 C 模块/WF40 直通使用）
      const mockChunks = sources.slice(0, 3).flatMap((s) => [
        {
          source_id: s.source_id,
          chunk_id: `${s.source_id}-C0001`,
          text: "【示例切片1】公司2025年度营业收入达到100亿元，同比增长15%。",
          parse_mode: "native",
          locator: { page: 1, section: "第一章 业务概览", paragraph_index: 1, quote_hash: "mockhash001" },
          chunk_type: "text",
          parse_confidence: 0.95,
        },
        {
          source_id: s.source_id,
          chunk_id: `${s.source_id}-C0002`,
          text: "【示例切片2】归属于母公司股东的净利润为25亿元，同比增长8.3%。",
          parse_mode: "native",
          locator: { page: 5, section: "第二章 财务摘要", paragraph_index: 3, quote_hash: "mockhash002" },
          chunk_type: "text",
          parse_confidence: 0.92,
        },
      ]);

      send("done", {
        total,
        success: sources.length - (sources.length >= 3 ? 1 : 0) - (sources.length >= 2 ? 1 : 0),
        pending: sources.length >= 2 ? 1 : 0,
        failed: sources.length >= 3 ? 1 : 0,
        source_manifest: sources,
        parsed_chunks: mockChunks,
      });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function sseError(message: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(`event: error\ndata: ${JSON.stringify({ message })}\n\n`),
      );
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

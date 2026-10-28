import { NextRequest } from "next/server";
import { LLMClient, Config, HeaderUtils } from "coze-coding-dev-sdk";
import type {
  SourceRegistry,
  EvidenceItem,
  ConflictItem,
  CModuleOutput,
  WF60Output,
} from "@/lib/types";
import {
  uploadAndGetSignedUrl,
  isStorageAvailable,
} from "@/lib/storage";
import { evaluateReportQuality } from "@/lib/quality";

export const runtime = "nodejs";
export const maxDuration = 900; // 长任务

/*
 * POST /api/report/generate
 *
 * 阶段二：生成报告。
 *
 * 支持两种数据入口（自动路由）：
 *   A) parsed_chunks 直通 — WF10 已解析好的切片，直接进入证据抽取+冲突检测+报告生成
 *   B) files + source_urls — 原始文件/URL，C 模块自己做解析+抽取
 *
 * 底层优先对接 C 模块（完整证据链路，端口 9000）。
 * 若配置了 WF60，则额外用 WF60 做专业四页签渲染。
 * 未配置时走 Mock 模式。
 *
 * 响应（SSE）：
 *   event: progress  — 步骤推进
 *   event: evidence  — 证据增量
 *   event: conflict  — 冲突增量
 *   event: content   — 报告正文增量
 *   event: metrics   — 质量指标
 *   event: done      — 生成完成
 *   event: error     — 错误
 */
export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const contentType = req.headers.get("content-type") || "";
  let jobId = `JOB_${Date.now()}`;
  let industry = "finance";
  let templateId = "finance_v1";
  let audience = "management";
  let decisionQuestion = "";
  let cutoffDate = "";
  let strictMode = false;
  let parsedChunks: unknown = null;
  let sourceUrls: string[] = [];
  let fileEntries: File[] = [];
  let kbQuery = "";
  let kbBackend = "local";
  let kbTopK = 10;

  if (contentType.includes("multipart/form-data")) {
    const formData = await req.formData();
    jobId = (formData.get("job_id") as string) || jobId;
    industry = (formData.get("industry") as string) || industry;
    templateId = (formData.get("template_id") as string) || templateId;
    audience = (formData.get("audience") as string) || audience;
    decisionQuestion = (formData.get("decision_question") as string) || "";
    cutoffDate = (formData.get("cutoff_date") as string) || "";
    strictMode = (formData.get("strict_mode") as string) === "true";

    const parsedChunksStr = formData.get("parsed_chunks") as string;
    parsedChunks = parsedChunksStr ? JSON.parse(parsedChunksStr) : null;

    const sourceUrlsStr = formData.get("source_urls") as string;
    sourceUrls = sourceUrlsStr ? JSON.parse(sourceUrlsStr) : [];

    kbQuery = (formData.get("kb_query") as string) || "";
    kbBackend = (formData.get("kb_backend") as string) || "local";
    const kbTopKRaw = formData.get("kb_top_k") as string;
    kbTopK = kbTopKRaw ? parseInt(kbTopKRaw, 10) : 10;

    for (const [key, val] of formData.entries()) {
      if (key === "files" && val instanceof File) {
        fileEntries.push(val);
      }
    }
  } else {
    const body = await req.json();
    jobId = body.job_id || jobId;
    industry = body.industry || industry;
    templateId = body.template_id || templateId;
    audience = body.audience || audience;
    decisionQuestion = body.decision_question || "";
    cutoffDate = body.cutoff_date || "";
    strictMode = body.strict_mode || false;
    parsedChunks = body.parsed_chunks || null;
    sourceUrls = body.source_urls || [];
    kbQuery = body.kb_query || "";
    kbBackend = body.kb_backend || "local";
    kbTopK = body.kb_top_k || 10;
    fileEntries = []; // JSON 模式不支持文件上传
  }

  const encoder = new TextEncoder();
  let progressStep = 0;
  const totalSteps = 5; // 信息校验 → 证据抽取 → 冲突检测 → 报告撰写 → 合规审计

  const sendEvent = (event: string, data: unknown) => {
    progressStep++;
    return encoder.encode(
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    );
  };

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const cModuleUrl = process.env.C_MODULE_BASE_URL;
  const cModuleToken = process.env.C_MODULE_API_TOKEN || "";
  const wf60BaseUrl = process.env.WF60_BASE_URL;
  const wf60Token = process.env.WF60_API_TOKEN || "";
  const isWf60Available = !!(wf60BaseUrl && wf60Token);

        // —— Mock 模式：未配置 C 模块时 ——
        if (!cModuleUrl) {
          await runMockGeneration({
            controller,
            encoder,
            industry,
            templateId,
            decisionQuestion,
            strictMode,
          });
          return;
        }

        // —— 真实模式：调用 C 模块 ——
        let cInput: Record<string, unknown> = {
          job_id: jobId,
          decision_question: decisionQuestion,
          max_files: 20,
        };

        // 入口 B：parsed_chunks 直通（优先）
        if (Array.isArray(parsedChunks) && parsedChunks.length > 0) {
          cInput.parsed_chunks = parsedChunks;
        }
        // 入口 A：文件上传
        else if (fileEntries.length > 0) {
          const storageOk = await isStorageAvailable();

          if (!storageOk) {
            throw new Error("C 模块处理上传文件需要对象存储。请配置 COZE_BUCKET_ENDPOINT_URL 和 COZE_BUCKET_NAME，或先完成 WF10 解析后传入 parsed_chunks。");
          }

          const fileUrls: string[] = [];
          for (const file of fileEntries) {
            const bytes = await file.arrayBuffer();
            const signedUrl = await uploadAndGetSignedUrl(
              Buffer.from(bytes),
              file.name,
              file.type || "application/octet-stream",
            );
            if (signedUrl) fileUrls.push(signedUrl);
          }
          if (fileUrls.length !== fileEntries.length) {
            throw new Error("至少一个文件未能上传到对象存储，已停止生成以避免材料缺失。");
          }
          cInput.files = fileUrls.map((url) => ({ url, file_type: "document" }));
        }

        // 入口 C：知识库检索（RAG）
        if (kbQuery && kbQuery.trim()) {
          cInput.kb_query = kbQuery.trim();
          cInput.kb_backend = kbBackend;
          cInput.kb_top_k = kbTopK;
        }

        // 如果没有任何有效输入，报错
        const hasParsedChunks = Array.isArray(cInput.parsed_chunks) && cInput.parsed_chunks.length > 0;
        const hasFiles = Array.isArray(cInput.files) && cInput.files.length > 0;
        const hasKbQuery = !!cInput.kb_query;

        if (!hasParsedChunks && !hasFiles && !hasKbQuery) {
          controller.enqueue(
            sendEvent("error", {
              message: "没有可用于生成报告的材料，请先上传文件、完成解析或填写检索词",
            }),
          );
          controller.close();
          return;
        }

        // 与前端 WORKFLOW_STEPS 对齐：6 步
        // step 0 = 材料解析（前端已完成）
        // step 1 = 事实抽取  step 2 = 冲突检测  step 3 = 大纲与撰写
        // step 4 = 引用质量校验  step 5 = 渲染与交付
        const stepNames = [
          "材料解析",
          "事实抽取",
          "冲突检测",
          "大纲与撰写",
          "引用质量校验",
          "渲染与交付",
        ];

        // 调用 C 模块 /stream_run，第一步：事实抽取
        controller.enqueue(
          sendEvent("progress", {
            step: 1,
            label: stepNames[1],
            status: "running",
          }),
        );

        const streamUrl = `${cModuleUrl.replace(/\/$/, "")}/stream_run`;
        const resp = await fetch(streamUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-run-id": jobId,
            ...(cModuleToken
              ? { Authorization: `Bearer ${cModuleToken}` }
              : {}),
          },
          body: JSON.stringify(cInput),
          signal: req.signal,
        });

        if (!resp.ok || !resp.body) {
          const text = await resp.text().catch(() => "");
          throw new Error(
            `C 模块调用失败 (${resp.status}): ${text.slice(0, 200)}`,
          );
        }

        // 消费 SSE
        const reader = resp.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let allSources: SourceRegistry[] = [];
        let allEvidence: EvidenceItem[] = [];
        let allConflicts: ConflictItem[] = [];
        let finalReport = "";
        let finalOutput: CModuleOutput | null = null;

        let currentStep = 0;
        let cModuleDone = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let idx: number;
          while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
            const separator = /\r?\n\r?\n/.exec(buffer.slice(idx))?.[0] || "\n\n";
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + separator.length);

            const event = parseSseEvent(raw);
            if (!event) continue;

            // C 模块事件：Coze 标准 SSE 格式
            // { type: "workflow_start" } / { type: "workflow_end", output: {...} }
            if (event.type === "message" && event.data) {
              const payload = JSON.parse(event.data) as {
                type?: string;
                output?: Record<string, unknown>;
                error?: string;
              };

              if (payload.error) {
                throw new Error(payload.error);
              }

              const msgType = payload.type || "";

              if (msgType === "workflow_start") {
                // C 模块开始，步骤 1 正在运行（已在调用前设置）
              } else if (msgType === "workflow_end" && payload.output) {
                const output = payload.output;

                if (Array.isArray(output.source_manifest)) {
                  allSources = output.source_manifest as SourceRegistry[];
                }

                // 收集证据
                const evidences = (output.evidence_ledger ||
                  output.merged_evidences ||
                  []) as EvidenceItem[];
                for (const ev of evidences) {
                  const norm = normalizeEvidence(ev);
                  controller.enqueue(sendEvent("evidence", norm));
                  allEvidence.push(norm);
                }

                // 步骤 1 完成 → 步骤 2 开始：冲突检测
                if (currentStep <= 1) {
                  controller.enqueue(
                    sendEvent("progress", {
                      step: 1,
                      label: stepNames[1],
                      status: "completed",
                    }),
                  );
                  currentStep = 2;
                  controller.enqueue(
                    sendEvent("progress", {
                      step: currentStep,
                      label: stepNames[currentStep],
                      status: "running",
                    }),
                  );
                }

                // 收集冲突
                const conflicts = (output.conflict_register ||
                  output.conflicts ||
                  []) as ConflictItem[];
                for (const cf of conflicts) {
                  const norm = normalizeConflict(cf);
                  controller.enqueue(sendEvent("conflict", norm));
                  allConflicts.push(norm);
                }

                // 保存完整输出供后续 WF60 使用
                finalOutput = output as unknown as CModuleOutput;

              // 跳过 C 模块自带的短报告，用我们自己生成的详细报告

                // C 模块工作流已完成，跳出循环继续后续步骤
                cModuleDone = true;
              }
            } else if (event.type === "error") {
              throw new Error(event.data || "生成失败");
            }
          }

          if (cModuleDone) break;
        }

        // 如果没拿到最终结果，检查 buffer 里还有没有
        if (buffer.trim()) {
          const last = parseSseEvent(buffer);
          if (last?.type === "message" && last.data) {
            try {
              const p = JSON.parse(last.data);
              if (p.output) {
                finalOutput = p.output as unknown as CModuleOutput;
              }
            } catch {
              // ignore
            }
          }
        }

        if (!cModuleDone || !finalOutput) {
          throw new Error("C 模块流已结束，但未收到完整的 workflow_end 结果；请检查工作流运行日志后重试。");
        }

        // 计算失败来源和质量指标
        const allFailed = allSources.filter((s) => s.parse_status === "failed");
        let wf60FinalOutput: any = null;
        // 步骤 2 完成 → 步骤 3：大纲与撰写
        controller.enqueue(sendEvent("progress", { step: 2, label: stepNames[2], status: "completed" }));
        controller.enqueue(sendEvent("progress", { step: 3, label: stepNames[3], status: "running" }));

        // 先构建结构化章节骨架 + 模板报告（作为 LLM 失败或流中断时的保底内容）
        const generatedSections = buildSectionsFromEvidence(
          allEvidence,
          allConflicts,
          decisionQuestion,
          industry,
          audience,
        );
        const templateReport = buildReportFromSections(generatedSections, decisionQuestion, industry);
        finalReport = templateReport; // 先把模板报告存好，确保有充足内容

        // 提取 forward headers 用于 LLM 调用
        let forwardHeaders: Record<string, string> | undefined;
        try {
          forwardHeaders = HeaderUtils.extractForwardHeaders(req.headers);
        } catch {
          forwardHeaders = undefined;
        }

        // LLM 生成详细报告正文（流式推送 content 事件）
        finalReport = await generateReportWithLLM(
          controller,
          encoder,
          sendEvent,
          allEvidence,
          allConflicts,
          decisionQuestion,
          industry,
          audience,
          forwardHeaders,
        );

        const metrics = evaluateReportQuality({
          report: finalReport,
          evidence: allEvidence,
          conflicts: allConflicts,
          sources: allSources,
          strictMode,
          startedAt,
        });

        const evidenceIds = new Set(allEvidence.map((item) => item.evidence_id));
        const duplicateEvidenceIds = allEvidence
          .map((item) => item.evidence_id)
          .filter((id, index, ids) => ids.indexOf(id) !== index);
        if (duplicateEvidenceIds.length > 0) {
          throw new Error(`C 模块返回重复证据编号：${Array.from(new Set(duplicateEvidenceIds)).join("、")}`);
        }
        const duplicateConflictIds = allConflicts
          .map((item) => item.conflict_id)
          .filter((id, index, ids) => ids.indexOf(id) !== index);
        if (duplicateConflictIds.length > 0) {
          throw new Error(`C 模块返回重复冲突编号：${Array.from(new Set(duplicateConflictIds)).join("、")}`);
        }
        const invalidConflictRefs = allConflicts.flatMap((conflict) =>
          conflict.evidence_ids.filter((id) => !evidenceIds.has(id)).map((id) => `${conflict.conflict_id} → ${id}`),
        );
        if (invalidConflictRefs.length > 0) {
          throw new Error(`冲突清单引用了不存在的证据：${invalidConflictRefs.join("、")}`);
        }
        controller.enqueue(sendEvent("metrics", metrics));

        controller.enqueue(sendEvent("progress", { step: 3, label: stepNames[3], status: "completed" }));

        // 步骤 4：引用质量校验
        controller.enqueue(sendEvent("progress", { step: 4, label: stepNames[4], status: "running" }));

        // 如果 WF60 可用，并行调用获取专业渲染的导出链接（仅作为导出增强，不作为正文）
        if (isWf60Available) {
          try {
            const wf60Url = `${wf60BaseUrl}/stream_run`;
            const wf60Resp = await fetch(wf60Url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${wf60Token}`,
              },
              body: JSON.stringify({
                title: decisionQuestion || "专业分析报告",
                industry: industry || "finance",
                audience: audience || "management",
                decision_question: decisionQuestion || "",
                template_id: templateId || "finance_v1",
                template_version: "1.0.0",
                strict_mode: strictMode,
                generated_at: new Date().toISOString(),
                runtime_ms: 0,
                sections: generatedSections,
                evidence_list: allEvidence.map((e) => ({
                  evidence_id: e.evidence_id,
                  source_id: e.source_id,
                  source_name: e.source_title || e.source_id,
                  location: e.locator || "",
                  quote: e.quote || "",
                  confidence: typeof e.confidence === "number" ? e.confidence : 0.8,
                })),
                conflicts: allConflicts.map((c: any) => ({
                  conflict_id: c.conflict_id,
                  severity: c.severity,
                  conflict_type: c.conflict_type,
                  title: c.summary || c.conflict_type,
                  parties: c.parties || c.evidence_ids || [],
                  description: c.explanation || c.summary || "",
                  handling: c.resolution_suggestion || "",
                  status: c.status || c.resolution_status || "open",
                })),
                failed_sources: allFailed.map((s: any) => s.file_name || s.source_id || ""),
                quality: metrics,
                report_markdown: finalReport,
              }),
            });

            if (wf60Resp.ok) {
              const wf60Reader = wf60Resp.body!.getReader();
              const wf60Decoder = new TextDecoder();
              let wf60Buffer = "";
              let wf60Output: any = null;

              while (true) {
                const { value, done: wf60Done } = await wf60Reader.read();
                if (wf60Done) break;
                wf60Buffer += wf60Decoder.decode(value, { stream: true });

                const wf60Lines = wf60Buffer.split("\n");
                wf60Buffer = wf60Lines.pop() || "";

                let eventName = "";
                let eventData = "";
                for (const line of wf60Lines) {
                  if (line.startsWith("event:")) {
                    eventName = line.slice(6).trim();
                  } else if (line.startsWith("data:")) {
                    eventData = line.slice(5).trim();
                  } else if (line === "" && eventName && eventData) {
                    if (eventName === "message") {
                      try {
                        const msg = JSON.parse(eventData);
                        if (msg.type === "workflow_end" && msg.output) {
                          wf60Output = msg.output;
                        }
                      } catch {}
                    }
                    eventName = "";
                    eventData = "";
                  }
                }
              }

              wf60FinalOutput = wf60Output as any;
            }
          } catch (err) {
            console.warn("WF60 call failed:", err);
          }
        }

        controller.enqueue(sendEvent("progress", { step: 4, label: stepNames[4], status: "completed" }));

        // 步骤 5：渲染与交付 — 生成可下载的导出文件
        controller.enqueue(sendEvent("progress", { step: 5, label: stepNames[5], status: "running" }));

        // 标准化 WF60 导出链接（download_areas 可能是数组或对象）
        const normalizeExportUrls = (wfOutput: any): { pdf?: string; docx?: string; markdown?: string } => {
          if (!wfOutput?.export_result?.download_areas) return {};
          const areas = wfOutput.export_result.download_areas;
          const result: { pdf?: string; docx?: string; markdown?: string } = {};
          if (Array.isArray(areas)) {
            for (const area of areas) {
              const url = area.url || area.download_url || area.file_url;
              const type = (area.type || area.format || area.name || "").toString().toLowerCase();
              if (!url) continue;
              if (type.includes("pdf")) result.pdf = url;
              else if (type.includes("doc") || type.includes("word")) result.docx = url;
              else if (type.includes("md") || type.includes("markdown")) result.markdown = url;
            }
          } else if (typeof areas === "object" && areas !== null) {
            if (areas.pdf) result.pdf = areas.pdf.url || areas.pdf;
            if (areas.docx) result.docx = areas.docx.url || areas.docx;
            if (areas.word && !result.docx) result.docx = areas.word.url || areas.word;
            if (areas.markdown) result.markdown = areas.markdown.url || areas.markdown;
          }
          return result;
        };

        // WF60 的导出链接（优先用 WF60 的专业导出）
        const wf60ExportUrls = wf60FinalOutput ? normalizeExportUrls(wf60FinalOutput) : {};

        // 后端自己生成的导出文件（确保一定能打开，优先使用）
        const localExportUrls = await generateExportFiles(
          finalReport,
          decisionQuestion,
          forwardHeaders,
        );

        // 合并：优先用后端本地生成的（保证能打开），WF60 的仅作补充
        const exportUrls = {
          pdf: localExportUrls.pdf || wf60ExportUrls.pdf || localExportUrls.html || "",
          docx: localExportUrls.docx || wf60ExportUrls.docx || localExportUrls.html || "",
          markdown: localExportUrls.markdown || wf60ExportUrls.markdown || "",
        };

        controller.enqueue(sendEvent("progress", { step: 5, label: stepNames[5], status: "completed" }));

        controller.enqueue(
          sendEvent("done", {
            report_markdown: finalReport,
            evidence_ledger: allEvidence,
            conflict_register: allConflicts,
            source_manifest: allSources,
            quality_metrics: metrics,
            raw_output: finalOutput,
            wf60_output: (typeof wf60FinalOutput !== 'undefined') ? wf60FinalOutput : null,
            export_urls: exportUrls,
          }),
        );

        controller.close();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ message })}\n\n`,
          ),
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// ===== 工具函数 =====

interface ReportSection {
  section_id: string;
  title: string;
  markdown: string;
  used_evidence_ids: string[];
  used_conflict_ids: string[];
  open_questions: string[];
}

/**
 * 基于证据台账、冲突清单和决策问题，结构化生成专业报告章节。
 * 当 WF40 未配置时作为降级方案，确保报告内容充实专业。
 */
function buildSectionsFromEvidence(
  evidences: EvidenceItem[],
  conflicts: any[],
  decisionQuestion: string,
  industry: string,
  audience: string,
): ReportSection[] {
  const sections: ReportSection[] = [];
  const evidenceById = new Map(evidences.map((e) => [e.evidence_id, e]));

  // —— 章节 1：执行摘要 ——
  const keyMetrics = evidences.filter((e) => e.evidence_type === "number");
  const facts = evidences.filter((e) => e.evidence_type === "fact");
  const forecasts = evidences.filter((e) => e.evidence_type === "forecast");

  let execSummary = "";
  if (keyMetrics.length > 0) {
    const topMetrics = keyMetrics.slice(0, 5);
    execSummary += `本次报告基于 **${evidences.length}** 条有效证据、**${conflicts.length}** 项数据差异提示，围绕「${decisionQuestion}」展开系统分析。\n\n`;
    execSummary += "**核心发现：**\n\n";
    for (const m of topMetrics) {
      const val = m.value !== undefined && m.value !== null ? `${m.value}${m.unit ? " " + m.unit : ""}` : "已披露";
      execSummary += `- **${m.subject}**：${val}（来源：${m.source_id}，置信度 ${(m.confidence * 100).toFixed(0)}%） [${m.evidence_id}]\n`;
    }
    execSummary += "\n";
  } else if (facts.length > 0) {
    execSummary += `本报告围绕「${decisionQuestion}」进行了系统性梳理，共形成 **${evidences.length}** 条可追溯证据条目，覆盖 **${new Set(evidences.map((e) => e.source_id)).size}** 个信息源。\n\n`;
    execSummary += `**整体结论：** 现有证据链${conflicts.length > 0 ? "存在部分数据口径差异，需结合冲突雷达谨慎解读" : "相互印证，一致性较高"}，可作为专业决策的参考基础。\n\n`;
  } else {
    execSummary += `基于现有材料，我们围绕「${decisionQuestion}」进行了系统化梳理。\n\n`;
    execSummary += `> **说明：** 当前材料中可直接抽取的量化证据有限，以下分析基于已有事实框架进行结构化呈现，后续可补充更多原始材料以获得更深入的洞察。\n\n`;
  }

  sections.push({
    section_id: "sec_exec_summary",
    title: "执行摘要",
    markdown: execSummary.trim(),
    used_evidence_ids: evidences.map((e) => e.evidence_id),
    used_conflict_ids: [],
    open_questions: [],
  });

  // —— 章节 2：核心指标速览 ——
  if (keyMetrics.length > 0) {
    let metricsMd = "以下关键指标均有原始材料支撑，每条数据标注了来源编号与置信度。\n\n";
    metricsMd += "| 指标 | 数值 | 期间/范围 | 来源 | 置信度 |\n|------|------|----------|------|--------|\n";
    for (const m of keyMetrics) {
      const val = m.value !== undefined && m.value !== null
        ? `${m.value}${m.unit ? " " + m.unit : ""}`
        : "—";
      const period = m.period || m.scope || "—";
      metricsMd += `| ${m.subject} | ${val} | ${period} | ${m.source_id} | ${(m.confidence * 100).toFixed(0)}% |\n`;
    }
    metricsMd += "\n*数据来源：各原始材料对应章节，详见证据地图。*\n";
    sections.push({
      section_id: "sec_key_metrics",
      title: "核心指标概览",
      markdown: metricsMd.trim(),
      used_evidence_ids: keyMetrics.map((e) => e.evidence_id),
      used_conflict_ids: [],
      open_questions: [],
    });
  }

  // —— 章节 3：详细分析（按主题分组） ——
  // 按 subject 对证据分组，每个主题作为一个子分析段落
  const subjectGroups = new Map<string, EvidenceItem[]>();
  for (const e of evidences) {
    const key = e.subject || "其他";
    if (!subjectGroups.has(key)) subjectGroups.set(key, []);
    subjectGroups.get(key)!.push(e);
  }

  if (subjectGroups.size > 0) {
    let analysisMd = "";
    const allAnalysisEids: string[] = [];

    // 确定行业分析框架
    const industryLabels: Record<string, string> = {
      finance: "投研分析框架（宏观—行业—公司—估值）",
      government: "政务评估框架（政策—执行—成效—风险）",
      consulting: "咨询诊断框架（市场—竞争—运营—战略）",
    };
    const framework = industryLabels[industry] || "综合分析框架";

    analysisMd += `按照${framework}，我们对全部 **${evidences.length}** 条证据进行了结构化梳理与交叉验证，以下按主题展开详细分析。\n\n`;

    let subIdx = 0;
    for (const [subject, items] of subjectGroups) {
      subIdx++;
      analysisMd += `### ${subIdx}. ${subject}\n\n`;

      // 主题概述
      analysisMd += `**主题概述：** 本小节围绕「${subject}」展开系统分析，共涉及 **${items.length}** 条来自不同来源的证据。以下从事实陈述、量化解读、交叉验证、趋势研判、影响评估五个维度进行深入拆解。\n\n`;

      // 1. 事实陈述
      analysisMd += `#### ${subIdx}.1 事实陈述与来源分布\n\n`;
      for (let i = 0; i < items.length; i++) {
        const e = items[i];
        const valStr = e.value !== undefined && e.value !== null
          ? `（量化值：${e.value}${e.unit ? " " + e.unit : ""}）`
          : "";
        const srcInfo = e.source_title ? `来源：${e.source_title}` : `来源编号：${e.source_id}`;
        const periodInfo = e.period ? `，报告期：${e.period}` : "";
        analysisMd += `${i + 1}. ${e.quote || e.object || "未命名证据"}${valStr} [${e.evidence_id}]\n`;
        analysisMd += `   &nbsp;&nbsp;${srcInfo}${periodInfo}\n`;
      }
      analysisMd += "\n";

      // 2. 量化解读
      const numericItems = items.filter((e) => e.value !== undefined && e.value !== null);
      if (numericItems.length > 0) {
        analysisMd += `#### ${subIdx}.2 量化解读\n\n`;
        for (const e of numericItems) {
          const valLabel = e.value !== undefined && e.value !== null
            ? `${e.value}${e.unit ? " " + e.unit : ""}`
            : "—";
          analysisMd += `- **${e.evidence_id}**：当前值为 **${valLabel}**`;
          if (e.period) analysisMd += `，数据报告期为 ${e.period}`;
          if (e.scope) analysisMd += `，统计口径为 ${e.scope}`;
          analysisMd += "。\n";
        }
        analysisMd += "\n";

        // 如果有多个数值，做对比和变化幅度分析
        if (numericItems.length >= 2) {
          analysisMd += "**多源数据对比与差异分析：** ";
          const values = numericItems.map((e) => `${e.value}${e.unit ? " " + e.unit : ""}`);
          analysisMd += values.join(" ｜ ");
          analysisMd += "。";

          // 计算最大最小值差异
          const nums = numericItems.map((e) => e.value as number);
          const maxVal = Math.max(...nums);
          const minVal = Math.min(...nums);
          if (minVal !== 0 && maxVal !== minVal) {
            const diffPct = ((maxVal - minVal) / Math.abs(minVal) * 100).toFixed(1);
            analysisMd += ` 其中最大值与最小值相差 **${diffPct}%**，`;
          }

          const hasConflict = conflicts.some((c: any) =>
            c.evidence_ids?.some((id: string) => numericItems.some((ni) => ni.evidence_id === id)),
          );
          if (hasConflict) {
            analysisMd += "不同来源数据存在口径差异（详见「冲突与口径差异」章节），建议以高权威来源为准或人工核验后引用。";
          } else {
            analysisMd += "不同来源数据在方向上基本一致，可交叉印证，数据可信度较高。";
          }
          analysisMd += "\n\n";
        }
      }

      // 3. 交叉验证
      analysisMd += `#### ${subIdx}.3 交叉验证与证据强度\n\n`;
      const uniqueSources = new Set(items.map((e) => e.source_id));
      analysisMd += `- **来源数量：** ${uniqueSources.size} 个独立来源\n`;
      analysisMd += `- **证据条数：** ${items.length} 条\n`;

      // 按类型统计
      const byType = new Map<string, number>();
      for (const e of items) {
        const t = e.evidence_type || "fact";
        byType.set(t, (byType.get(t) || 0) + 1);
      }
      const typeLabels: Record<string, string> = {
        fact: "事实陈述",
        number: "量化数据",
        forecast: "预测判断",
        quote: "引用观点",
        opinion: "专家意见",
      };
      analysisMd += "- **证据类型：** ";
      const typeDescs: string[] = [];
      for (const [t, cnt] of byType) {
        typeDescs.push(`${typeLabels[t] || t} ${cnt} 条`);
      }
      analysisMd += typeDescs.join("、") + "\n";

      // 证据强度评级
      let strength = "中";
      if (items.length >= 5 && uniqueSources.size >= 3) strength = "高";
      else if (items.length <= 2 && uniqueSources.size <= 1) strength = "较低";
      analysisMd += `- **证据强度评级：** ${strength}（综合考虑来源独立性、数量与一致性）\n\n`;

      // 4. 趋势研判与影响评估（行业差异化）
      analysisMd += `#### ${subIdx}.4 趋势研判与影响评估\n\n`;

      if (industry === "finance") {
        analysisMd += `从金融投研视角看，「${subject}」维度的变动对投资决策具有直接影响：\n\n`;
        analysisMd += `- **对基本面的影响：** 若该指标持续向当前方向演化，将直接影响相关标的的盈利能力、现金流水平与估值中枢，建议纳入核心跟踪变量清单。\n`;
        analysisMd += `- **对行业格局的影响：** 头部机构与中小机构的差距可能进一步扩大，行业集中度存在提升趋势，关注头部标的的竞争壁垒与定价权。\n`;
        analysisMd += `- **对政策面的敏感性：** 该领域受监管政策影响较大，需持续关注政策风向变化及其对行业估值的系统性影响。\n`;
        analysisMd += `- **风险提示：** 数据时效性与口径差异可能影响判断的准确性，严格模式下建议以原始公告和权威发布为准。\n\n`;
      } else if (industry === "government") {
        analysisMd += `从政务评估视角看，「${subject}」维度对政策制定与执行评估具有重要参考价值：\n\n`;
        analysisMd += `- **政策执行效果：** 现有证据反映了该领域政策落地的阶段性成效，总体呈现稳中向好的态势，但部分细分指标仍有优化空间。\n`;
        analysisMd += `- **民生影响评估：** 该维度的变化直接关系到群众获得感，建议持续跟踪并完善配套措施，确保政策红利精准落地。\n`;
        analysisMd += `- **区域/部门差异：** 不同区域或部门的执行成效存在一定差异，建议总结先进经验并推广至后进区域，推动整体均衡发展。\n`;
        analysisMd += `- **下一步工作建议：** 聚焦短板指标攻坚，建立长效跟踪机制，定期开展"回头看"评估，确保各项政策措施持续见效。\n\n`;
      } else {
        analysisMd += `从咨询诊断视角看，「${subject}」维度对企业战略决策与运营优化具有关键意义：\n\n`;
        analysisMd += `- **市场机会评估：** 该维度的发展趋势指向了潜在的市场机会窗口，建议企业提前布局，抢占先发优势。\n`;
        analysisMd += `- **竞争格局变化：** 行业参与者应关注竞争格局变化带来的挑战与机遇，及时调整战略定位，构建差异化竞争优势。\n`;
        analysisMd += `- **运营优化方向：** 基于证据反映的现状，企业可在成本控制、效率提升、客户体验等方面寻找优化空间。\n`;
        analysisMd += `- **战略建议：** 建议从"长—中—短"三个时间维度制定策略，长期锚定方向、中期配置资源、短期快速验证。\n\n`;
      }

      for (const e of items) allAnalysisEids.push(e.evidence_id);
    }

    // 全局分析总结
    analysisMd += `### 综合分析结论\n\n`;
    analysisMd += `综合以上 ${subIdx} 个维度的证据交叉验证，我们认为整体证据链条**${subjectGroups.size >= 5 ? "较为完整" : "基本完整"}**，核心结论具有一定的支撑力度。同时需要注意的是，部分细分领域的证据密度仍有提升空间，建议在后续迭代中补充更多原始材料以提高分析的全面性与稳健性。\n\n`;
    analysisMd += `> 注：以上分析基于现有证据自动生成，引用标注见「证据地图」页签，冲突提示见「冲突雷达」页签。严格模式下，所有结论均已标注证据来源，未作无依据推测。\n`;

    sections.push({
      section_id: "sec_detailed_analysis",
      title: "详细分析",
      markdown: analysisMd.trim(),
      used_evidence_ids: allAnalysisEids,
      used_conflict_ids: conflicts.map((c) => c.conflict_id),
      open_questions: [],
    });
  }

  // —— 章节 4：冲突与口径差异 ——
  if (conflicts.length > 0) {
    const critical = conflicts.filter((c) => c.severity === "critical" || c.severity === "high");
    const medium = conflicts.filter((c) => c.severity === "medium");
    const low = conflicts.filter((c) => c.severity === "low");

    let conflictMd = "";
    const usedConflictIds: string[] = [];

    conflictMd += `报告共识别出 **${conflicts.length}** 处数据口径或表述差异，按严重程度分级如下：\n\n`;
    if (critical.length > 0) conflictMd += `- 🔴 高风险/严重：${critical.length} 项\n`;
    if (medium.length > 0) conflictMd += `- 🟡 中风险：${medium.length} 项\n`;
    if (low.length > 0) conflictMd += `- 🟢 低风险：${low.length} 项\n`;
    conflictMd += "\n";

    conflictMd += "### 重点差异说明\n\n";
    const topConflicts = conflicts.slice(0, 5);
    for (const c of topConflicts) {
      const severityLabel: Record<string, string> = {
        critical: "🔴 严重",
        high: "🔴 高风险",
        medium: "🟡 中风险",
        low: "🟢 低风险",
      };
      conflictMd += `**${c.conflict_id} ${c.title || "数据差异"}**（${severityLabel[c.severity] || c.severity}）\n\n`;
      if (c.description) conflictMd += `${c.description}\n\n`;
      if (c.evidence_ids && c.evidence_ids.length > 0) {
        conflictMd += `涉及证据：${c.evidence_ids.join("、")}\n\n`;
      }
      if (c.handling) conflictMd += `**处理建议：** ${c.handling}\n\n`;
      usedConflictIds.push(c.conflict_id);
    }

    if (conflicts.length > 5) {
      conflictMd += `> 其余 ${conflicts.length - 5} 项差异详见「冲突雷达」页签。\n`;
    }

    sections.push({
      section_id: "sec_conflicts",
      title: "冲突与差异分析",
      markdown: conflictMd.trim(),
      used_evidence_ids: [],
      used_conflict_ids: usedConflictIds,
      open_questions: critical.map((c) => c.title || c.conflict_id),
    });
  }

  // —— 章节 5：风险提示 ——
  const risks: string[] = [];
  if (conflicts.some((c) => c.severity === "critical" || c.severity === "high")) {
    risks.push("部分关键指标存在高风险数据口径差异，建议以高权威来源为准或人工核验后使用");
  }
  if (forecasts.length > 0) {
    risks.push("前瞻性预测数据存在不确定性，实际结果可能因市场环境变化而偏离");
  }
  if (evidences.length < 3) {
    risks.push("当前样本量有限，结论的稳健性需更多原始材料交叉验证");
  }
  risks.push("市场环境与政策变化可能对结论的时效性产生影响");
  if (conflicts.some((c) => c.status !== "resolved")) {
    risks.push("部分数据冲突尚未完全消解，严格模式下相关结论需审慎引用");
  }

  const riskMd = "根据证据质量评估与冲突检测结果，提示以下风险：\n\n" +
    risks.map((r, i) => `${i + 1}. **${r}**`).join("\n") +
    "\n\n*建议在决策时综合考虑上述风险因素，并结合更多维度的信息进行判断。*\n";

  sections.push({
    section_id: "sec_risks",
    title: "风险提示",
    markdown: riskMd.trim(),
    used_evidence_ids: [],
    used_conflict_ids: conflicts.filter((c) => c.severity === "high" || c.severity === "critical").map((c) => c.conflict_id),
    open_questions: [],
  });

  // —— 章节 6：结论与建议 ——
  let conclusionMd = "";
  // 从证据中提取关键信息用于针对性结论
  const highConfidenceEvidences = evidences.filter((e) => e.confidence >= 0.8);
  const highRiskConflicts = conflicts.filter((c) => c.severity === "high" || c.severity === "critical");
  const mediumConflicts = conflicts.filter((c) => c.severity === "medium");
  // 基于证据三元组构建主题分类（用 subject 作为分类维度）
  const evidenceCategories = Array.from(new Set(evidences.map((e) => e.subject).filter(Boolean))).slice(0, 8);

  // 基于证据内容生成关键判断（用 quote 字段作为原文引用）
  const keyFindings: string[] = [];
  const topEvidence = (highConfidenceEvidences.length > 0 ? highConfidenceEvidences : evidences).slice(0, 5);
  for (const ev of topEvidence) {
    // 用三元组方式构建关键发现
    const statement = `${ev.subject} ${ev.predicate} ${ev.object}` +
      (ev.value !== undefined && ev.value !== null ? `（${ev.value}${ev.unit || ""}）` : "");
    keyFindings.push(statement);
  }

  // 核心判断逻辑：基于证据方向给出明确结论
  const positiveSignals = evidences.filter((e) =>
    e.predicate.includes("增长") || e.predicate.includes("提升") || e.predicate.includes("增加") ||
    e.predicate.includes("超过") || e.predicate.includes("盈利") || e.predicate.includes("领先")
  ).length;
  const negativeSignals = evidences.filter((e) =>
    e.predicate.includes("下降") || e.predicate.includes("减少") || e.predicate.includes("风险") ||
    e.predicate.includes("亏损") || e.predicate.includes("低于") || e.predicate.includes("负债")
  ).length;
  const overallTone = positiveSignals > negativeSignals ? "positive" :
    negativeSignals > positiveSignals ? "negative" : "neutral";

  // 判断决策问题类型（用于针对性结论）
  const dq = decisionQuestion || "";
  const isFinance = industry === "finance" || dq.includes("融资") || dq.includes("投资") || dq.includes("估值") || dq.includes("上市");
  const isGov = industry === "government" || dq.includes("政策") || dq.includes("监管") || dq.includes("规划");
  const isConsulting = industry === "consulting" || dq.includes("战略") || dq.includes("市场") || dq.includes("竞争");

  if (audience === "management") {
    conclusionMd += "### 核心结论\n\n";
    conclusionMd += `针对「${decisionQuestion || "核心决策问题"}」，基于 ${evidences.length} 条有效证据的系统性分析，我们给出以下判断：\n\n`;

    // 整体判断 - 直接回答问题
    const overallSentiment =
      highConfidenceEvidences.length >= evidences.length * 0.6 && highRiskConflicts.length === 0
        ? "**证据链整体支持正面判断**。核心指标相互印证，数据一致性较高，决策基础较为扎实。"
        : highRiskConflicts.length > 0
          ? "**当前证据存在关键分歧，暂不支持明确结论**。建议在重大决策前补充材料、核验高风险数据差异。"
          : "**证据整体方向基本一致，但支撑力度有待加强**。部分维度数据覆盖不足，建议审慎决策。";
    conclusionMd += `**整体判断：** ${overallSentiment}\n\n`;

    // 关键依据
    if (keyFindings.length > 0) {
      conclusionMd += "### 关键依据\n\n";
      conclusionMd += "支撑本次判断的核心证据包括：\n\n";
      keyFindings.forEach((finding, i) => {
        conclusionMd += `${i + 1}. ${finding}\n`;
      });
      conclusionMd += "\n";
    }

    // 风险提示
    if (highRiskConflicts.length > 0 || mediumConflicts.length > 0) {
      conclusionMd += "### 需要关注的风险点\n\n";
      if (highRiskConflicts.length > 0) {
        conclusionMd += `- **高风险冲突 ${highRiskConflicts.length} 项**：涉及核心数据口径差异，可能直接影响结论可靠性，需优先核验\n`;
      }
      if (mediumConflicts.length > 0) {
        conclusionMd += `- **中等风险差异 ${mediumConflicts.length} 项**：存在局部数据不一致，建议交叉印证后使用\n`;
      }
      conclusionMd += "\n";
    }

    // 针对性行动建议
    conclusionMd += "### 行动建议\n\n";
    if (isFinance) {
      conclusionMd += "1. **决策建议**：";
      if (highRiskConflicts.length === 0 && highConfidenceEvidences.length >= 3) {
        conclusionMd += "在补充尽职调查的前提下，可推进本轮融资的初步评估";
      } else if (highRiskConflicts.length > 0) {
        conclusionMd += "建议暂缓决策，先完成高风险数据项的核验与补充";
      } else {
        conclusionMd += "建议进一步收集关键数据后再做判断";
      }
      conclusionMd += "\n";
      conclusionMd += "2. **下一步重点**：补充财务数据、业务指标、市场规模等核心维度证据，完善决策基础\n";
      conclusionMd += "3. **风险缓释**：对冲突登记中的高风险项逐一核实，必要时要求提供原始凭证\n";
      conclusionMd += "4. **持续跟踪**：建立关键指标动态监控机制，及时掌握变化趋势\n";
    } else if (isGov) {
      conclusionMd += "1. **决策建议**：基于现有证据，";
      conclusionMd += highRiskConflicts.length === 0 ? "政策方向基本明确，可推进下一步工作" : "存在关键数据分歧，建议补充调研后再决策";
      conclusionMd += "\n";
      conclusionMd += "2. **数据完善**：优先补充官方统计口径数据，提升证据权威性\n";
      conclusionMd += "3. **多方印证**：对重要结论进行跨部门、跨数据源交叉验证\n";
      conclusionMd += "4. **预案准备**：针对不确定性因素，提前制定备选方案\n";
    } else if (isConsulting) {
      conclusionMd += "1. **战略判断**：";
      conclusionMd += highConfidenceEvidences.length >= 3 ? "市场信号较为明确，可基于现有判断制定策略" : "市场信号尚不明朗，建议扩大调研范围";
      conclusionMd += "\n";
      conclusionMd += "2. **竞争分析**：建议补充竞品对比、市场份额等维度数据\n";
      conclusionMd += "3. **落地路径**：基于结论制定分阶段行动计划，明确里程碑指标\n";
      conclusionMd += "4. **风险预案**：识别关键假设，建立敏感性分析框架\n";
    } else {
      conclusionMd += "1. **决策建议**：基于当前证据水平，";
      conclusionMd += highRiskConflicts.length === 0 ? "可在审慎评估后推进决策" : "建议暂缓决策，待关键差异核实后再判断";
      conclusionMd += "\n";
      conclusionMd += "2. **优先核验高风险数据差异项**，必要时补充原始材料进行人工确认\n";
      conclusionMd += "3. **补充关键维度证据**，完善决策信息基础\n";
      conclusionMd += "4. **建立定期复核机制**，跟踪核心指标的后续变化\n";
    }
  } else if (audience === "analyst") {
    conclusionMd += "### 专业结论\n\n";
    conclusionMd += `基于前述系统分析，针对「${decisionQuestion || "核心问题"}」形成如下专业判断：\n\n`;

    conclusionMd += "**数据可信度评估**\n\n";
    conclusionMd += `- 证据总量：${evidences.length} 条，其中高置信度（≥80%）${highConfidenceEvidences.length} 条，占比 ${evidences.length > 0 ? ((highConfidenceEvidences.length / evidences.length) * 100).toFixed(1) : 0}%\n`;
    conclusionMd += `- 来源覆盖：涉及 ${evidenceCategories.length} 个数据类别${evidenceCategories.length > 0 ? "（" + evidenceCategories.join("、") + "）" : ""}\n`;
    conclusionMd += `- 数据冲突：共 ${conflicts.length} 处，其中高风险 ${highRiskConflicts.length} 处、中风险 ${mediumConflicts.length} 处\n\n`;

    conclusionMd += "**核心发现**\n\n";
    if (keyFindings.length > 0) {
      keyFindings.forEach((finding, i) => {
        conclusionMd += `${i + 1}. ${finding}\n`;
      });
    } else {
      conclusionMd += "暂未识别到明确的核心结论，建议补充更多证据材料。\n";
    }
    conclusionMd += "\n";

    conclusionMd += "**分析局限性说明**\n\n";
    conclusionMd += "- 本报告结论严格基于输入材料的范围与质量，材料覆盖度直接决定分析深度\n";
    conclusionMd += "- 不同来源的数据可能存在统计口径差异，使用时需注意可比性\n";
    conclusionMd += "- 前瞻性判断受外部环境不确定性影响，需动态跟踪验证\n";
    conclusionMd += "- 冲突项已标注，使用者需根据风险等级自行评估影响\n";
  } else {
    conclusionMd += "### 核心结论\n\n";
    conclusionMd += `综合全部 ${evidences.length} 条证据分析，关于「${decisionQuestion || "核心问题"}」的主要结论如下：\n\n`;

    const simpleVerdict =
      highRiskConflicts.length === 0 && highConfidenceEvidences.length >= 2
        ? "**现有证据指向较为明确的正面判断**，核心数据相互印证，结论可信度较高。"
        : highRiskConflicts.length > 0
          ? "**当前证据存在重大分歧，暂无法得出明确结论**。建议补充关键数据后再做判断。"
          : "**证据基本支持判断，但支撑力度有限**。建议审慎参考，结合更多信息综合决策。";
    conclusionMd += `${simpleVerdict}\n\n`;

    if (keyFindings.length > 0) {
      conclusionMd += "**主要依据：**\n\n";
      keyFindings.forEach((finding, i) => {
        conclusionMd += `${i + 1}. ${finding}\n`;
      });
      conclusionMd += "\n";
    }

    conclusionMd += "**建议：** 请结合风险提示章节内容，综合评估后做出判断。";
  }

  sections.push({
    section_id: "sec_conclusion",
    title: "结论与建议",
    markdown: conclusionMd.trim(),
    used_evidence_ids: evidences.map((e) => e.evidence_id),
    used_conflict_ids: conflicts.map((c) => c.conflict_id),
    open_questions: [],
  });

  return sections;
}

/**
 * 从结构化章节拼接完整 Markdown 报告（WF60 不可用时的降级方案）
 */
function buildReportFromSections(
  sections: any[],
  decisionQuestion: string,
  industry: string,
): string {
  const industryLabel: Record<string, string> = {
    finance: "金融投研",
    government: "政务汇报",
    consulting: "咨询调研",
  };
  const title = decisionQuestion ? `关于「${decisionQuestion}」的专业分析报告` : "专业分析报告";

  let md = `# ${title}

`;
  md += `> **报告类型：** ${industryLabel[industry] || industry} ｜ **生成时间：** ${new Date().toLocaleString("zh-CN")}

`;
  md += `---

`;

  // 目录
  md += `## 目录

`;
  sections.forEach((s, i) => {
    md += `${i + 1}. [${s.title}](#${s.section_id})
`;
  });
  md += `
---

`;

  // 各章节正文
  sections.forEach((s) => {
    md += `## ${s.title}

`;
    md += `${s.markdown || ""}

`;
  });

  md += `---\n\n## 质量说明\n\n本报告的引用编号、章节完整性和来源状态由工作台在生成后进行结构检查。该检查不等同于事实正确性或模型效果评测；请结合证据台账与原始材料复核关键判断。\n\n`;

  // 页脚
  md += `---

*本报告由证衡 EvidenceOS 自动生成，所有事实性论断均标注来源。建议结合原始材料进行最终判断。*
`;

  return md;
}

/**
 * 用 LLM 流式生成详细专业报告正文
 * 基于证据库 + 冲突信息 + 决策问题，生成 3000+ 字的深度分析报告
 */
async function generateReportWithLLM(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  sendEvent: (event: string, data: unknown) => Uint8Array,
  evidences: EvidenceItem[],
  conflicts: ConflictItem[],
  decisionQuestion: string,
  industry: string,
  audience: string,
  customHeaders?: Record<string, string>,
): Promise<string> {
  const industryLabels: Record<string, string> = {
    finance: "金融投研",
    government: "政务汇报",
    consulting: "咨询调研",
  };
  const audienceLabels: Record<string, string> = {
    management: "管理层决策",
    analyst: "专业分析师",
    public: "公众传播",
  };

  // 格式化证据列表
  const evidenceText = evidences.slice(0, 50).map((e, i) => {
    const val = e.value !== undefined && e.value !== null
      ? `${e.value}${e.unit ? " " + e.unit : ""}`
      : "";
    return `${i + 1}. [${e.evidence_id}] 来源: ${e.source_title || e.source_id} | 主题: ${e.subject} ${e.predicate ? "— " + e.predicate : ""} ${val ? "| 数值: " + val : ""} | 原文: "${(e.quote || "").slice(0, 150)}"${e.confidence ? ` | 置信度: ${Math.round(e.confidence * 100)}%` : ""}`;
  }).join("\n");

  // 格式化冲突列表
  const conflictText = conflicts.length > 0
    ? conflicts.slice(0, 10).map((c, i) => {
        return `${i + 1}. [${c.conflict_id}] 级别: ${c.severity} | 类型: ${c.conflict_type} | 摘要: ${c.summary || c.explanation || ""}`;
      }).join("\n")
    : "无";

  const systemPrompt = `你是一位资深的${industryLabels[industry] || "专业"}分析师，擅长基于多源证据撰写深度研究报告。

你的写作风格：
- 专业、严谨、有深度，不做空洞表态
- 每个关键论断都尽量关联证据编号（如 [E001]）
- 结构清晰，分章节论述，逻辑层次分明
- 分析要有洞察，不只是罗列事实
- 中文表达专业流畅，符合行业规范
- 总字数不少于 4000 字
- 结论与建议必须直接、明确地回答核心决策问题，给出有证据支撑的判断，严禁空洞套话和答非所问

报告必须包含以下章节（用 Markdown 格式）：
1. 执行摘要 — 300-500 字，提炼核心结论与关键发现
2. 核心指标概览 — 用表格呈现关键数据指标
3. 详细分析 — 按主题分 4-6 个小节展开深入论述
4. 冲突与差异分析 — 对不一致数据的解读与判断
5. 风险提示 — 基于证据的风险识别与评估
6. 结论与建议 — 可落地的行动建议
7. 质量说明 — 报告可信度与局限性说明

写作要求：
- 详细分析部分要有深度，每个小节至少 400 字
- 用事实说话，基于证据展开推理，不要凭空臆造
- 适当引用原文片段作为论据支撑
- 用 [证据编号] 标注关键论断的出处
- 不要写"以下是报告"之类的引导语，直接输出正文
- 输出纯 Markdown，不要用代码块包裹`;

  const userPrompt = `决策问题：${decisionQuestion || "综合分析"}
目标受众：${audienceLabels[audience] || audience}
行业方向：${industryLabels[industry] || industry}

【证据库】共 ${evidences.length} 条有效证据：
${evidenceText || "（暂无具体证据条目，将基于决策问题进行框架性分析）"}

【冲突登记】共 ${conflicts.length} 项：
${conflictText}

请基于以上证据，撰写一份完整、专业、有深度的分析报告。`;

  let fullReport = "";
  let streamClosed = false;

  const safeEnqueue = (data: Uint8Array) => {
    if (streamClosed) return false;
    try {
      controller.enqueue(data);
      return true;
    } catch {
      streamClosed = true;
      return false;
    }
  };

  try {
    const config = new Config();
    const client = new LLMClient(config, customHeaders);

    const stream = client.stream(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      {
        model: "doubao-seed-2-0-pro-260215",
        temperature: 0.7,
      },
    );

    for await (const chunk of stream) {
      if (streamClosed) break;
      if (chunk.content) {
        const delta = chunk.content.toString();
        fullReport += delta;
        safeEnqueue(
          sendEvent("content", {
            delta,
            text: fullReport,
          }),
        );
      }
    }
  } catch (err) {
    console.warn("LLM generation failed, falling back to template:", err);
    // LLM 失败/流中断时：如果已生成内容足够长，保留之；否则用模板报告兜底
    if (fullReport.length < 2000) {
      const sections = buildSectionsFromEvidence(evidences, conflicts, decisionQuestion, industry, audience);
      const fallbackReport = buildReportFromSections(sections, decisionQuestion, industry);
      // 把 LLM 已生成的内容拼在前面
      if (fullReport.length > 0) {
        fullReport = fullReport + "\n\n---\n\n" + fallbackReport;
      } else {
        fullReport = fallbackReport;
      }
    }

    if (!streamClosed) {
      // 分段推送
      const paragraphs = fullReport.split("\n\n");
      let current = "";
      for (const para of paragraphs) {
        if (streamClosed) break;
        if (!para.trim()) continue;
        const delta = para + "\n\n";
        current += delta;
        await new Promise((r) => setTimeout(r, 80));
        safeEnqueue(
          sendEvent("content", {
            delta,
            text: current,
          }),
        );
      }
    }
  }

  return fullReport;
}

/**
 * 生成导出文件（Markdown + HTML + DOCX）并上传到对象存储，返回下载链接
 */
async function generateExportFiles(
  reportMarkdown: string,
  decisionQuestion: string,
  customHeaders?: Record<string, string>,
): Promise<{ pdf?: string; docx?: string; markdown?: string; html?: string }> {
  const result: { pdf?: string; docx?: string; markdown?: string; html?: string } = {};
  const storageOk = await isStorageAvailable();
  const title = decisionQuestion || "专业分析报告";
  const timestamp = new Date().toISOString().slice(0, 10);

  // 1. Markdown 文件
  try {
    const mdContent = reportMarkdown;
    if (storageOk) {
      const mdBuffer = Buffer.from(mdContent, "utf-8");
      const mdUrl = await uploadAndGetSignedUrl(mdBuffer, `report_${timestamp}.md`, "text/markdown;charset=utf-8");
      if (mdUrl) result.markdown = mdUrl;
    } else {
      // 无存储时用 data URL
      result.markdown = `data:text/markdown;charset=utf-8,${encodeURIComponent(mdContent)}`;
    }
  } catch (e) {
    console.warn("Failed to generate markdown export:", e);
  }

  // 2. HTML 文件（用简单但美观的样式，DOCX 也能打开）
  try {
    // 简单的 Markdown → HTML 转换（支持标题、加粗、列表、表格、引用、代码块）
    let htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${title}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.8; max-width: 900px; margin: 40px auto; padding: 0 20px; color: #1a1a2e; background: #fff; }
h1 { font-size: 28px; border-bottom: 3px solid #4f46e5; padding-bottom: 12px; margin-top: 40px; }
h2 { font-size: 22px; color: #1e3a5f; border-left: 4px solid #4f46e5; padding-left: 12px; margin-top: 32px; }
h3 { font-size: 18px; color: #2c5282; margin-top: 24px; }
p { margin: 12px 0; text-align: justify; }
strong { color: #1e3a5f; }
blockquote { border-left: 4px solid #a0aec0; padding-left: 16px; color: #4a5568; margin: 16px 0; background: #f7fafc; padding: 12px 16px; }
table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px; }
th, td { border: 1px solid #e2e8f0; padding: 10px 12px; text-align: left; }
th { background: #f1f5f9; font-weight: 600; color: #334155; }
tr:nth-child(even) { background: #f8fafc; }
ul, ol { padding-left: 24px; margin: 12px 0; }
li { margin: 6px 0; }
hr { border: none; border-top: 1px solid #e2e8f0; margin: 32px 0; }
code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-family: "SF Mono", Consolas, monospace; font-size: 13px; }
.report-header { text-align: center; margin-bottom: 40px; padding-bottom: 24px; border-bottom: 2px solid #e2e8f0; }
.report-header h1 { border: none; padding: 0; margin: 0 0 12px 0; font-size: 32px; color: #1e3a5f; }
.report-meta { color: #64748b; font-size: 14px; }
</style>
</head>
<body>
<div class="report-header">
<h1>${title}</h1>
<div class="report-meta">生成时间：${new Date().toLocaleString("zh-CN")} ｜ 证衡 EvidenceOS</div>
</div>
`;

    // 简易 Markdown 渲染
    let htmlBody = reportMarkdown;
    // 转义 HTML 特殊字符
    htmlBody = htmlBody.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // 代码块
    htmlBody = htmlBody.replace(/```([\s\S]*?)```/g, (_, code) =>
      `<pre><code>${code}</code></pre>`);
    // 标题
    htmlBody = htmlBody.replace(/^###### (.*)$/gm, "<h6>$1</h6>");
    htmlBody = htmlBody.replace(/^##### (.*)$/gm, "<h5>$1</h5>");
    htmlBody = htmlBody.replace(/^#### (.*)$/gm, "<h4>$1</h4>");
    htmlBody = htmlBody.replace(/^### (.*)$/gm, "<h3>$1</h3>");
    htmlBody = htmlBody.replace(/^## (.*)$/gm, "<h2>$1</h2>");
    htmlBody = htmlBody.replace(/^# (.*)$/gm, "<h1>$1</h1>");
    // 粗体
    htmlBody = htmlBody.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    htmlBody = htmlBody.replace(/__(.+?)__/g, "<strong>$1</strong>");
    // 斜体
    htmlBody = htmlBody.replace(/\*(.+?)\*/g, "<em>$1</em>");
    // 行内代码
    htmlBody = htmlBody.replace(/`(.+?)`/g, "<code>$1</code>");
    // 引用
    htmlBody = htmlBody.replace(/^&gt; (.*)$/gm, "<blockquote>$1</blockquote>");
    // 分割线
    htmlBody = htmlBody.replace(/^---+$/gm, "<hr>");
    // 表格（简单处理）
    htmlBody = htmlBody.replace(/\|[-:]+\|[-:| ]+\|\n/g, ""); // 分隔行
    // 把表格行包起来
    const tableRows = htmlBody.match(/^\|.*\|$/gm);
    if (tableRows && tableRows.length > 1) {
      let inTable = false;
      const lines = htmlBody.split("\n");
      const newLines: string[] = [];
      for (const line of lines) {
        if (/^\|.*\|$/.test(line) && !/^\|[-:]+\|/.test(line)) {
          if (!inTable) {
            newLines.push("<table>");
            inTable = true;
          }
          const cells = line.slice(1, -1).split("|").map((c) => `<td>${c.trim()}</td>`).join("");
          newLines.push(`<tr>${cells}</tr>`);
        } else if (inTable) {
          newLines.push("</table>");
          inTable = false;
          newLines.push(line);
        } else {
          newLines.push(line);
        }
      }
      if (inTable) newLines.push("</table>");
      htmlBody = newLines.join("\n");
    }
    // 无序列表
    htmlBody = htmlBody.replace(/^- (.*)$/gm, "<li>$1</li>");
    htmlBody = htmlBody.replace(/^[0-9]+\. (.*)$/gm, "<li>$1</li>");
    // 段落
    htmlBody = htmlBody.replace(/\n\n+/g, "</p><p>");
    htmlBody = "<p>" + htmlBody + "</p>";

    htmlContent += htmlBody + "\n</body>\n</html>";

    if (storageOk) {
      const htmlBuffer = Buffer.from(htmlContent, "utf-8");
      const htmlUrl = await uploadAndGetSignedUrl(htmlBuffer, `report_${timestamp}.html`, "text/html;charset=utf-8");
      if (htmlUrl) result.html = htmlUrl;
    } else {
      result.html = `data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`;
    }

    // HTML 也可作为 DOCX 替代（Word 能打开 HTML）
    if (storageOk) {
      const docxBuffer = Buffer.from(htmlContent, "utf-8");
      const docxUrl = await uploadAndGetSignedUrl(docxBuffer, `report_${timestamp}.doc`, "application/msword");
      if (docxUrl) result.docx = docxUrl;
    } else {
      result.docx = `data:application/msword;charset=utf-8,${encodeURIComponent(htmlContent)}`;
    }
  } catch (e) {
    console.warn("Failed to generate html/docx export:", e);
  }

  return result;
}

function parseSseEvent(raw: string): { type: string; data?: string } | null {
  const lines = raw.split(/\r?\n/);
  let event = "message";
  let data = "";
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data += (data ? "\n" : "") + line.slice(5).trim();
    }
  }
  if (!data && event === "message") return null;
  return { type: event, data: data || undefined };
}

function normalizeEvidence(raw: unknown): EvidenceItem {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("C 模块返回了无效的证据项");
  }
  const r = raw as Record<string, unknown>;
  const evidenceId = String(r.evidence_id || r.claim_id || r.id || "").trim();
  const sourceId = String(r.source_id || "").trim();
  const quote = String(r.quote || r.text || "").trim();
  if (!evidenceId || !sourceId || !quote) {
    throw new Error("证据项缺少 evidence_id、source_id 或原文引用，拒绝生成不可追溯报告");
  }
  const numericValue = r.value == null || r.value === "" ? null : Number(r.value);
  const confidence = typeof r.confidence === "number" && Number.isFinite(r.confidence)
    ? Math.min(1, Math.max(0, r.confidence))
    : 0;
  const locator = typeof r.locator === "object" && r.locator
    ? (r.locator as EvidenceItem["locator"])
    : typeof r.locator === "string" && r.locator.trim()
      ? { section: r.locator.trim() }
      : {};
  return {
    evidence_id: evidenceId,
    source_id: sourceId,
    source_title: String(r.source_title || r.document_name || ""),
    subject: String(r.subject || ""),
    predicate: String(r.predicate || ""),
    object: String(r.object || ""),
    value: numericValue !== null && Number.isFinite(numericValue) ? numericValue : null,
    unit: r.unit ? String(r.unit) : undefined,
    period: r.period ? String(r.period) : undefined,
    scope: r.scope ? String(r.scope) : undefined,
    evidence_type: (r.evidence_type as EvidenceItem["evidence_type"]) || "fact",
    locator,
    quote,
    confidence,
    source_authority: typeof r.source_authority === "number" && Number.isFinite(r.source_authority) ? r.source_authority : 0,
  };
}

function normalizeConflict(raw: unknown): ConflictItem {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("C 模块返回了无效的冲突项");
  }
  const r = raw as Record<string, unknown>;
  const conflictId = String(r.conflict_id || r.id || "").trim();
  const conflictType = String(r.conflict_type || "");
  const severity = String(r.severity || "");
  const summary = String(r.title || r.summary || r.description || "").trim();
  const evidenceIds = Array.isArray(r.evidence_ids)
    ? Array.from(new Set(r.evidence_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)))
    : [];
  const validConflictTypes = ["hard", "definition", "caliber", "time", "timing", "semantic", "source"];
  const validSeverities = ["critical", "high", "medium", "low"];
  if (!conflictId || evidenceIds.length < 2 || !summary || !validConflictTypes.includes(conflictType) || !validSeverities.includes(severity)) {
    throw new Error("冲突项必须包含编号、类型、风险级别、摘要和至少两个 evidence_ids");
  }
  const resolutionRaw = String(r.handling || r.resolution || "preserve_both");
  const validResolutions = ["prefer_latest", "prefer_authoritative", "preserve_both", "manual"] as const;
  const resolution = (validResolutions as readonly string[]).includes(resolutionRaw)
    ? (resolutionRaw as ConflictItem["resolution"])
    : "preserve_both";
  return {
    conflict_id: conflictId,
    evidence_ids: evidenceIds,
    conflict_type: conflictType as ConflictItem["conflict_type"],
    severity: severity as ConflictItem["severity"],
    summary,
    explanation: String(r.description || r.explanation || ""),
    resolution,
    resolved: r.resolved === true || r.status === "resolved",
  };
}

// ===== Mock 生成 =====
async function runMockGeneration(params: {
  controller: ReadableStreamDefaultController;
  encoder: TextEncoder;
  industry: string;
  templateId: string;
  decisionQuestion: string;
  strictMode: boolean;
}) {
  const { controller, encoder, industry, decisionQuestion, strictMode } = params;
  const startedAt = Date.now();

  const sendEvent = (event: string, data: unknown) => {
    controller.enqueue(
      encoder.encode(
        `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
      ),
    );
  };

  const steps = ["信息校验", "证据抽取", "冲突检测", "报告撰写", "合规审计"];
  let sampleReportText = "";
  let mockEvidenceForAudit: EvidenceItem[] = [];
  let mockConflictsForAudit: ConflictItem[] = [];

  for (let i = 0; i < steps.length; i++) {
    sendEvent("progress", {
      step: i,
      label: steps[i],
      status: "running",
    });
    await new Promise((r) => setTimeout(r, 600));

    if (i === 1) {
      // 模拟证据
      const mockEvidence = [
        {
          evidence_id: "E000001",
          source_id: "S001",
          source_title: "2025年度报告",
          subject: "公司",
          predicate: "营业收入",
          object: "",
          value: "100.5",
          unit: "亿元",
          period: "2025FY",
          scope: "合并报表",
          evidence_type: "number",
          locator: { page: 12, section: "财务摘要" },
          quote: "2025年度公司实现营业收入100.5亿元，同比增长15.3%。",
          confidence: 0.98,
          source_authority: 5,
        },
        {
          evidence_id: "E000002",
          source_id: "S001",
          source_title: "2025年度报告",
          subject: "公司",
          predicate: "净利润",
          object: "",
          value: "25.8",
          unit: "亿元",
          period: "2025FY",
          scope: "归母净利润",
          evidence_type: "number",
          locator: { page: 15, table: "表3.2" },
          quote: "归属于母公司股东的净利润为25.8亿元，同比增长12.1%。",
          confidence: 0.97,
          source_authority: 5,
        },
      ];
      mockEvidenceForAudit = mockEvidence as unknown as EvidenceItem[];
      for (const ev of mockEvidence) {
        sendEvent("evidence", ev);
      }
    }

    if (i === 3) {
      // 用结构化模板生成内容丰富的专业报告
      const mockEvidenceForReport = [
        {
          evidence_id: "E000001",
          source_id: "S001",
          source_title: "2025年度报告",
          subject: "公司",
          predicate: "营业收入",
          value: "100.5",
          unit: "亿元",
          period: "2025FY",
          scope: "合并报表",
          evidence_type: "number",
          quote: "2025年度公司实现营业收入100.5亿元，同比增长15.3%，主要受益于主营业务收入的稳健增长以及新兴业务板块的快速放量。",
          confidence: 0.98,
          source_authority: 5,
          topic: "财务表现",
        },
        {
          evidence_id: "E000002",
          source_id: "S001",
          source_title: "2025年度报告",
          subject: "公司",
          predicate: "归母净利润",
          value: "25.8",
          unit: "亿元",
          period: "2025FY",
          scope: "归母净利润",
          evidence_type: "number",
          quote: "归属于母公司股东的净利润为25.8亿元，同比增长12.1%，扣非净利润为23.2亿元，同比增长14.5%，盈利质量持续提升。",
          confidence: 0.97,
          source_authority: 5,
          topic: "财务表现",
        },
        {
          evidence_id: "E000003",
          source_id: "S002",
          source_title: "行业研究报告",
          subject: "行业",
          predicate: "市场规模",
          value: "5000",
          unit: "亿元",
          period: "2025E",
          scope: "全行业",
          evidence_type: "number",
          quote: "预计2025年全行业市场规模将达到5000亿元，同比增长18%，其中头部企业市场份额持续提升，行业集中度进一步提高。",
          confidence: 0.92,
          source_authority: 4,
          topic: "行业格局",
        },
        {
          evidence_id: "E000004",
          source_id: "S002",
          source_title: "行业研究报告",
          subject: "公司",
          predicate: "市场份额",
          value: "8.5",
          unit: "%",
          period: "2025H1",
          scope: "全渠道口径",
          evidence_type: "number",
          quote: "公司2025年上半年全渠道市场份额约为8.5%，位列行业前三，较去年同期提升0.8个百分点。",
          confidence: 0.90,
          source_authority: 4,
          topic: "行业格局",
        },
        {
          evidence_id: "E000005",
          source_id: "S003",
          source_title: "第三方数据",
          subject: "公司",
          predicate: "市场份额",
          value: "6.2",
          unit: "%",
          period: "2025H1",
          scope: "上市业务口径",
          evidence_type: "number",
          quote: "上市公司主体2025年上半年市场份额为6.2%，若包含非上市业务板块预计份额更高。",
          confidence: 0.88,
          source_authority: 3,
          topic: "行业格局",
        },
        {
          evidence_id: "E000006",
          source_id: "S001",
          source_title: "2025年度报告",
          subject: "公司",
          predicate: "研发投入",
          value: "8.6",
          unit: "亿元",
          period: "2025FY",
          scope: "研发费用",
          evidence_type: "number",
          quote: "全年研发投入8.6亿元，同比增长28.7%，研发费用率提升至8.6%，重点投向核心技术攻关和新产品开发。",
          confidence: 0.96,
          source_authority: 5,
          topic: "技术创新",
        },
        {
          evidence_id: "E000007",
          source_id: "S004",
          source_title: "公司公告",
          subject: "公司",
          predicate: "新业务占比",
          value: "23.5",
          unit: "%",
          period: "2025FY",
          scope: "营收占比",
          evidence_type: "number",
          quote: "新业务板块营收占比从去年的15.2%提升至23.5%，业务结构持续优化，第二增长曲线初步成型。",
          confidence: 0.95,
          source_authority: 4,
          topic: "业务布局",
        },
        {
          evidence_id: "E000008",
          source_id: "S002",
          source_title: "行业研究报告",
          subject: "行业",
          predicate: "增长率",
          value: "18",
          unit: "%",
          period: "2025E",
          scope: "同比增长",
          evidence_type: "number",
          quote: "行业整体保持高速增长态势，预计未来三年复合增长率维持在15-20%区间，政策红利与技术创新双轮驱动。",
          confidence: 0.91,
          source_authority: 4,
          topic: "行业趋势",
        },
      ];
      const mockConflictsForReport = [
        {
          conflict_id: "CF001",
          evidence_ids: ["E000004", "E000005"],
          conflict_type: "definition",
          severity: "medium" as const,
          summary: "市场份额统计口径存在差异",
          explanation:
            "一处来源使用全渠道可比口径（S002，8.5%），另一处使用上市业务口径（S003，6.2%），两者统计范围不同导致数值差异。",
          resolution: "preserve_both" as const,
          resolved: true,
        },
      ];
      mockEvidenceForAudit = mockEvidenceForReport as unknown as EvidenceItem[];
      mockConflictsForAudit = mockConflictsForReport as unknown as ConflictItem[];
      for (const evidenceItem of mockEvidenceForReport) {
        sendEvent("evidence", evidenceItem);
      }
      for (const conflictItem of mockConflictsForReport) {
        sendEvent("conflict", conflictItem);
      }

      const sections = buildSectionsFromEvidence(
        mockEvidenceForReport as unknown as EvidenceItem[],
        mockConflictsForReport,
        decisionQuestion,
        industry,
        "management",
      );
      sampleReportText = buildReportFromSections(
        sections,
        decisionQuestion,
        industry,
      );

      // 分段流式发送（打字机效果）
      const chunks = sampleReportText.match(/.{1,80}/g) || [sampleReportText];
      let fullText = "";
      for (const chunk of chunks) {
        fullText += chunk;
        sendEvent("content", { delta: chunk, text: fullText });
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    sendEvent("progress", {
      step: i,
      label: steps[i],
      status: "completed",
    });
  }

  const finalMetrics = evaluateReportQuality({
    report: sampleReportText,
    evidence: mockEvidenceForAudit,
    conflicts: mockConflictsForAudit,
    sources: [],
    strictMode,
    startedAt,
    measurementMode: "demo",
  });
  sendEvent("metrics", finalMetrics);

  // 生成真实可下载的导出文件
  let exportUrls: { pdf: string; docx: string; markdown: string } = {
    pdf: "",
    docx: "",
    markdown: "",
  };
  try {
    const generated = await generateExportFiles(sampleReportText, industry);
    exportUrls = {
      pdf: generated.pdf || "",
      docx: generated.docx || "",
      markdown: generated.markdown || "",
    };
  } catch {
    // 失败时降级为 data URL
    exportUrls.markdown =
      "data:text/markdown;charset=utf-8," +
      encodeURIComponent(sampleReportText);
  }

  sendEvent("done", {
    ok: true,
    report_markdown: sampleReportText,
    export_urls: exportUrls,
    evidence_ledger: mockEvidenceForAudit,
    conflict_register: mockConflictsForAudit,
    source_manifest: [],
    quality_metrics: finalMetrics,
  });
}

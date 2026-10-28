"use client";

import { useState, useCallback, useRef } from "react";
import type {
  UploadedFile,
  SourceUrl,
  Industry,
  Audience,
  WorkflowStep,
  EvidenceItem,
  ConflictItem,
  QualityMetrics,
  JobStatus,
  ParseStatus,
  SourceRegistry,
  ParsedChunk,
} from "@/lib/types";
import { WORKFLOW_STEPS } from "@/lib/types";
import { evaluateReportQuality } from "@/lib/quality";

const genId = (): string =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const pad = (n: number, len = 3): string => String(n).padStart(len, "0");

// ========= SSE 解析工具 =========

interface SseEvent {
  event: string;
  data: string;
}

/**
 * 解析 SSE 响应流，逐条调用 onEvent 回调
 * 兼容标准 SSE 格式：event: xxx / data: xxx
 */
async function consumeSseStream(
  response: Response,
  onEvent: (evt: SseEvent) => void,
): Promise<void> {
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(message || `请求失败（HTTP ${response.status}）`);
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // 按双换行分割事件
    const blocks = buffer.split(/\r?\n\r?\n+/);
    // 最后一块可能不完整，留到下次
    buffer = blocks.pop() || "";

    for (const block of blocks) {
      const lines = block.split(/\r?\n/).filter((l) => l.trim());
      let eventName = "";
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }

      if (eventName || dataLines.length > 0) {
        onEvent({
          event: eventName || "message",
          data: dataLines.join("\n"),
        });
      }
    }
  }

  // 处理最后剩余
  if (buffer.trim()) {
    const lines = buffer.split(/\r?\n/).filter((l) => l.trim());
    let eventName = "";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (eventName || dataLines.length > 0) {
      onEvent({
        event: eventName || "message",
        data: dataLines.join("\n"),
      });
    }
  }
}

// ========= Hook =========

export function useReportForm() {
  // ==== 材料区 ====
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [sourceUrls, setSourceUrls] = useState<SourceUrl[]>([]);
  const [autoCollect, setAutoCollect] = useState(false);
  const [allowedDomains, setAllowedDomains] = useState("");

  // ==== 参数区 ====
  const [industry, setIndustry] = useState<Industry>("finance");
  const [templateId, setTemplateId] = useState("finance_v1");
  const [decisionQuestion, setDecisionQuestion] = useState("");
  const [cutoffDate, setCutoffDate] = useState(() => {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  });
  const [audience, setAudience] = useState<Audience>("management");
  const [strictMode, setStrictMode] = useState(true);

  // ==== 工作流状态 ====
  const [jobId, setJobId] = useState<string>("");
  const [jobStatus, setJobStatus] = useState<JobStatus>("idle");
  const [steps, setSteps] = useState<WorkflowStep[]>(WORKFLOW_STEPS);
  const [isParsing, setIsParsing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileMapRef = useRef<Map<string, File>>(new Map());

  // ==== 产出物 ====
  const [reportContent, setReportContent] = useState<string>("");
  const [evidenceLedger, setEvidenceLedger] = useState<EvidenceItem[]>([]);
  const [conflictRegister, setConflictRegister] = useState<ConflictItem[]>([]);
  const [qualityMetrics, setQualityMetrics] = useState<QualityMetrics | null>(
    null,
  );
  const [sourceRegistry, setSourceRegistry] = useState<SourceRegistry[]>([]);
  const [parsedChunks, setParsedChunks] = useState<ParsedChunk[]>([]);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [exportUrls, setExportUrls] = useState<{ pdf?: string; docx?: string; markdown?: string }>({});

  // ==== source_id 计数器（仅用于上传时分配临时编号） ====
  const sourceCounterRef = useRef(1);

  const nextSourceId = useCallback((): string => {
    const id = `S${pad(sourceCounterRef.current)}`;
    sourceCounterRef.current += 1;
    return id;
  }, []);

  // ============ 文件操作 ============
  const addFiles = useCallback((newFiles: FileList | File[]) => {
    const fileArr = Array.from(newFiles);
    const uploaded: UploadedFile[] = fileArr.map((f) => {
      const sourceId = nextSourceId();
      // 把原始 File 对象存到 ref，供后端调用时读取
      fileMapRef.current.set(sourceId, f);
      return {
        id: genId(),
        source_id: sourceId,
        name: f.name,
        size: f.size,
        type: f.type || "",
        parse_status: "pending",
        authority_level: 3,
        upload_progress: 0,
      };
    });
    setFiles((prev) => [...prev, ...uploaded]);

    // 模拟上传进度（前端本地效果，真实上传由后端处理）
    uploaded.forEach((uf, idx) => {
      let progress = 0;
      const timer = setInterval(() => {
        progress += Math.random() * 30 + 15;
        if (progress >= 100) {
          clearInterval(timer);
          setFiles((prev) =>
            prev.map((f) =>
              f.id === uf.id
                ? { ...f, upload_progress: 100, parse_status: "pending" }
                : f,
            ),
          );
        } else {
          setFiles((prev) =>
            prev.map((f) =>
              f.id === uf.id
                ? { ...f, upload_progress: Math.round(progress) }
                : f,
            ),
          );
        }
      }, 180 + idx * 60);
    });
  }, [nextSourceId]);

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => {
      const target = prev.find((f) => f.id === id);
      if (target) fileMapRef.current.delete(target.source_id);
      return prev.filter((f) => f.id !== id);
    });
  }, []);

  // ============ URL 操作 ============
  const addSourceUrl = useCallback((url: string) => {
    if (!url.trim()) return;
    const sourceId = nextSourceId();
    const newUrl: SourceUrl = {
      id: genId(),
      source_id: sourceId,
      url: url.trim(),
      parse_status: "pending",
      authority_level: 2,
    };
    setSourceUrls((prev) => [...prev, newUrl]);
  }, [nextSourceId]);

  const removeSourceUrl = useCallback((id: string) => {
    setSourceUrls((prev) => prev.filter((u) => u.id !== id));
  }, []);

  // ============ 行业切换 ============
  const changeIndustry = useCallback((ind: Industry) => {
    setIndustry(ind);
    const templatesByIndustry: Record<Industry, string> = {
      finance: "finance_v1",
      government: "gov_policy",
      consulting: "consult_strategy",
    };
    setTemplateId(templatesByIndustry[ind]);
  }, []);

  // ============ 更新步骤状态 ============
  const setStepStatus = useCallback(
    (stepId: string, status: WorkflowStep["status"]) => {
      setSteps((prev) =>
        prev.map((s) => (s.id === stepId ? { ...s, status } : s)),
      );
    },
    [],
  );

  // ============ 开始解析（阶段一） ============
  const startParse = useCallback(async () => {
    if (isParsing || isGenerating) return;
    if (files.length === 0 && sourceUrls.length === 0) return;

    setIsParsing(true);
    setJobStatus("parsing");
    setErrorMessage("");
    setSteps(WORKFLOW_STEPS.map((s) => ({ ...s, status: "pending" })));
    setStepStatus("parse", "running");
    setSourceRegistry([]);
    setEvidenceLedger([]);
    setConflictRegister([]);
    setReportContent("");
    setQualityMetrics(null);

    const newJobId = `job_${Date.now()}`;
    setJobId(newJobId);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const formData = new FormData();
      files.forEach((f) => {
        const fileObj = fileMapRef.current.get(f.source_id);
        if (fileObj) {
          formData.append("files", fileObj, f.name);
        }
      });
      formData.append("source_urls", JSON.stringify(sourceUrls.map((u) => u.url)));
      formData.append("auto_collect", String(autoCollect));
      formData.append("allowed_domains", allowedDomains);
      formData.append("cutoff_date", cutoffDate);
      formData.append("job_id", newJobId);

      const response = await fetch("/api/report/parse", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      await consumeSseStream(response, (evt) => {
        try {
          switch (evt.event) {
            case "source": {
            const src = JSON.parse(evt.data) as SourceRegistry;
            setSourceRegistry((prev) => {
              const exists = prev.find((s) => s.source_id === src.source_id);
              if (exists) {
                return prev.map((s) =>
                  s.source_id === src.source_id ? { ...s, ...src } : s,
                );
              }
              return [...prev, src];
            });
            // 同步更新 files / sourceUrls 的解析状态
            setFiles((prev) =>
              prev.map((f) =>
                f.source_id === src.source_id
                  ? { ...f, parse_status: src.parse_status as ParseStatus }
                  : f,
              ),
            );
            setSourceUrls((prev) =>
              prev.map((u) =>
                u.source_id === src.source_id
                  ? { ...u, parse_status: src.parse_status as ParseStatus }
                  : u,
              ),
            );
            break;
          }
          case "done": {
            const data = JSON.parse(evt.data);
            setStepStatus("parse", "completed");
            setJobStatus("parsed");
            if (data.parsed_chunks && data.parsed_chunks.length > 0) {
              setParsedChunks(data.parsed_chunks);
            }
            setIsParsing(false);
            break;
          }
          case "error": {
            const data = JSON.parse(evt.data);
            setErrorMessage(data.message || "解析失败");
            setStepStatus("parse", "failed");
            setJobStatus("failed");
            break;
          }
          }
        } catch (e) {
          console.warn("[SSE] 解析事件失败:", evt.event, e);
        }
      });
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setErrorMessage((err as Error).message || "解析请求失败");
        setStepStatus("parse", "failed");
        setJobStatus("failed");
      }
    } finally {
      setIsParsing(false);
      abortRef.current = null;
    }
  }, [
    isParsing,
    isGenerating,
    files,
    sourceUrls,
    autoCollect,
    allowedDomains,
    cutoffDate,
    setStepStatus,
  ]);

  // ============ 生成报告（阶段二） ============
  const generateReport = useCallback(async () => {
    if (isParsing || isGenerating) return;
    if (sourceRegistry.length === 0 && files.length === 0) return;

    setIsGenerating(true);
    setJobStatus("writing");
    setErrorMessage("");
    setReportContent("");

    // 标记后续 5 个步骤为待执行（extract → conflict → outline → citation_qa → render）
    const stepIds = ["extract", "conflict", "outline", "citation_qa", "render"];
    stepIds.forEach((id, idx) => {
      setStepStatus(id, idx === 0 ? "running" : "pending");
    });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const formData = new FormData();
      formData.append("job_id", jobId);
      formData.append("industry", industry);
      formData.append("template_id", templateId);
      formData.append("audience", audience);
      formData.append("decision_question", decisionQuestion);
      formData.append("cutoff_date", cutoffDate);
      formData.append("strict_mode", String(strictMode));

      // 优先传 parsed_chunks（WF10 已解析的结果），走入口B直通
      if (parsedChunks.length > 0) {
        formData.append("parsed_chunks", JSON.stringify(parsedChunks));
      } else {
        // 否则传文件，走入口A文件直传
        const fileArr = Array.from(fileMapRef.current.values());
        fileArr.forEach((file) => {
          formData.append("files", file);
        });
        sourceUrls.forEach((s) => {
          formData.append("source_urls", s.url);
        });
      }

      const response = await fetch("/api/report/generate", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      let currentStep = -1;
      const stepMap: Record<string, string> = {
        "1": "extract",
        "2": "conflict",
        "3": "outline",
        "4": "citation_qa",
        "5": "render",
      };

      await consumeSseStream(response, (evt) => {
        try {
          switch (evt.event) {
            case "progress": {
              const data = JSON.parse(evt.data);
              const stepNum = String(data.step);
              const stepId = stepMap[stepNum];
              if (stepId && data.status === "running") {
                // 完成上一步
                if (currentStep >= 0) {
                  const prevStepId = stepMap[String(currentStep)];
                  if (prevStepId) setStepStatus(prevStepId, "completed");
                }
                setStepStatus(stepId, "running");
                currentStep = data.step;
              } else if (stepId && data.status === "completed") {
                setStepStatus(stepId, "completed");
              }
              break;
            }
            case "source": {
            const src = JSON.parse(evt.data) as SourceRegistry;
            setSourceRegistry((prev) => {
              const exists = prev.find((s) => s.source_id === src.source_id);
              if (exists) {
                return prev.map((s) =>
                  s.source_id === src.source_id ? { ...s, ...src } : s,
                );
              }
              return [...prev, src];
            });
            break;
          }
          case "evidence": {
            const ev = JSON.parse(evt.data) as EvidenceItem;
            setEvidenceLedger((prev) => {
              if (prev.find((e) => e.evidence_id === ev.evidence_id))
                return prev;
              return [...prev, ev];
            });
            break;
          }
          case "conflict": {
            const c = JSON.parse(evt.data) as ConflictItem;
            setConflictRegister((prev) => {
              if (prev.find((x) => x.conflict_id === c.conflict_id))
                return prev;
              return [...prev, c];
            });
            break;
          }
          case "content": {
            const data = JSON.parse(evt.data);
            // 支持增量追加（delta）或全量替换（text）
            if (data.delta) {
              setReportContent((prev) => prev + data.delta);
            } else if (data.text) {
              setReportContent(data.text);
            }
            break;
          }
          case "metrics": {
            const m = JSON.parse(evt.data) as QualityMetrics;
            setQualityMetrics(m);
            break;
          }
          case "done": {
            const data = JSON.parse(evt.data);
            // 兼容两种字段命名：旧格式与 C 模块/WF60 格式
            const reportMd = data.report ?? data.report_markdown ?? "";
            const evidenceList = data.evidence ?? data.evidence_ledger ?? data.merged_evidences ?? [];
            const conflictList = data.conflicts ?? data.conflict_register ?? [];
            const qualityMetrics = data.metrics ?? data.quality_metrics ?? data.audit_summary ?? {};
            const sources = data.sources ?? data.source_manifest ?? null;
            if (reportMd) setReportContent(reportMd);
            if (sources) setSourceRegistry(sources);
            if (evidenceList.length > 0) setEvidenceLedger(evidenceList);
            if (conflictList.length > 0) setConflictRegister(conflictList);
            if (Object.keys(qualityMetrics).length > 0) setQualityMetrics(qualityMetrics);

            // 导出链接（WF60 输出的 PDF/DOCX/Markdown 下载地址）
            // 优先使用后端已标准化的 export_urls，否则从 wf60_output 解析
            if (data.export_urls && (data.export_urls.pdf || data.export_urls.docx || data.export_urls.markdown)) {
              setExportUrls({
                pdf: data.export_urls.pdf,
                docx: data.export_urls.docx,
                markdown: data.export_urls.markdown,
              });
            } else {
              const wf60 = data.wf60_output || data.wf60Output || null;
              if (wf60?.export_result?.download_areas) {
                const areas = wf60.export_result.download_areas;
                const urls: { pdf?: string; docx?: string; markdown?: string } = {};
                if (Array.isArray(areas)) {
                  for (const area of areas) {
                    const url = area.url || area.download_url || area.file_url;
                    const type = (area.type || area.format || area.name || "").toString().toLowerCase();
                    if (!url) continue;
                    if (type.includes("pdf")) urls.pdf = url;
                    else if (type.includes("doc") || type.includes("word")) urls.docx = url;
                    else if (type.includes("md") || type.includes("markdown")) urls.markdown = url;
                  }
                } else if (typeof areas === "object" && areas !== null) {
                  urls.pdf = areas.pdf?.url || areas.pdf;
                  urls.docx = areas.docx?.url || areas.docx || areas.word?.url || areas.word;
                  urls.markdown = areas.markdown?.url || areas.markdown;
                }
                if (urls.pdf || urls.docx || urls.markdown) {
                  setExportUrls(urls);
                }
              }
            }

            // 标记全部步骤为 done
            Object.values(stepMap).forEach((sid) => setStepStatus(sid, "completed"));
            setJobStatus(qualityMetrics.quality_status === "blocked" ? "blocked" : "done");
            setIsGenerating(false);
            break;
          }
          case "error": {
            const data = JSON.parse(evt.data);
            setErrorMessage(data.message || "生成失败");
            setJobStatus("failed");
            setIsGenerating(false);
            break;
          }
          }
        } catch (e) {
          // 单个事件解析失败不中断整个流
          console.warn("[SSE] 事件解析失败:", evt.event, e);
        }
      });
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setErrorMessage((err as Error).message || "生成请求失败");
        setJobStatus("failed");
      }
    } finally {
      setIsGenerating(false);
      abortRef.current = null;
    }
  }, [
    isParsing,
    isGenerating,
    sourceRegistry.length,
    files,
    jobId,
    sourceUrls,
    autoCollect,
    allowedDomains,
    industry,
    templateId,
    decisionQuestion,
    cutoffDate,
    audience,
    strictMode,
    setStepStatus,
  ]);

  // ============ 重新校验 ============
  const revalidate = useCallback(() => {
    if (jobStatus === "idle" || isParsing || isGenerating) return;

    setStepStatus("citation_qa", "running");
    const metrics = evaluateReportQuality({
      report: reportContent,
      evidence: evidenceLedger,
      conflicts: conflictRegister,
      sources: sourceRegistry,
      strictMode,
    });
    setQualityMetrics(metrics);
    setStepStatus("citation_qa", "completed");
    setJobStatus(metrics.quality_status === "blocked" ? "blocked" : "done");
  }, [jobStatus, isParsing, isGenerating, reportContent, evidenceLedger, conflictRegister, sourceRegistry, strictMode, setStepStatus]);

  // ============ 导出审计包 ============
  const exportAudit = useCallback(async () => {
    try {
      const pack = {
      job_id: jobId,
      report: reportContent,
      evidence_ledger: evidenceLedger,
      conflict_register: conflictRegister,
      source_registry: sourceRegistry,
      quality_metrics: qualityMetrics,
      };

      const response = await fetch("/api/report/audit-pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pack),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setErrorMessage(payload?.error || "审计包导出失败");
        return;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit_pack_${jobId || "report"}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "审计包导出失败");
    }
  }, [jobId, reportContent, evidenceLedger, conflictRegister, sourceRegistry, qualityMetrics]);

  // ============ 可解析性判断 ============
  const canParse =
    (files.length > 0 || sourceUrls.length > 0) && !isParsing && !isGenerating;

  const canGenerate =
    sourceRegistry.some((s) => s.parse_status === "ready") &&
    !isGenerating &&
    !isParsing;

  // ============ 计算属性 ============
  const hasAnyMaterial = files.length > 0 || sourceUrls.length > 0;
  const hasReadyMaterial = sourceRegistry.some((s) => s.parse_status === "ready");

  // 解析进度百分比（基于来源台账中已完成的数量）
  const totalSources = files.length + sourceUrls.length;
  const parsedSources = sourceRegistry.filter(
    (s) => s.parse_status === "ready" || s.parse_status === "failed",
  ).length;
  const parseProgress =
    totalSources > 0 ? Math.round((parsedSources / totalSources) * 100) : 0;

  return {
    // 材料
    files,
    sourceUrls,
    autoCollect,
    allowedDomains,
    addFiles,
    removeFile,
    addSourceUrl,
    removeSourceUrl,
    setAutoCollect,
    setAllowedDomains,
    parseProgress,
    hasAnyMaterial,
    hasReadyMaterial,
    // 参数
    industry,
    templateId,
    decisionQuestion,
    cutoffDate,
    audience,
    strictMode,
    setIndustry: changeIndustry,
    setTemplateId,
    setDecisionQuestion,
    setCutoffDate,
    setAudience,
    setStrictMode,
    // 工作流
    jobId,
    jobStatus,
    steps,
    isParsing,
    isGenerating,
    errorMessage,
    canParse,
    canGenerate,
    startParse,
    generateReport,
    revalidate,
    exportAudit,
    // 产出物
    reportContent,
    evidenceLedger,
    conflictRegister,
    qualityMetrics,
    sourceRegistry,
    exportUrls,
  };
}

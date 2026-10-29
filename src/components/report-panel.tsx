"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Play,
  CheckCircle2,
  Circle,
  Loader2,
  AlertTriangle,
  XCircle,
  FileText,
  RefreshCw,
  Download,
  AlertCircle,
  ShieldCheck,
  Clock,
  Map as MapIcon,
  Radar,
  Gauge,
  FileCheck,
  FileWarning,
  FileX,
  ChevronDown,
  ChevronRight,
  Zap,
} from "lucide-react";
import type {
  WorkflowStep,
  EvidenceItem,
  ConflictItem,
  QualityMetrics,
  JobStatus,
} from "@/lib/types";
import {
  CONFLICT_TYPE_LABELS,
  SEVERITY_LABELS,
  EVIDENCE_TYPE_LABELS,
} from "@/lib/types";
import { renderInlineSafe as renderInline } from "@/lib/safe-markdown";

interface ReportPanelProps {
  steps: WorkflowStep[];
  jobStatus: JobStatus;
  isParsing: boolean;
  isGenerating: boolean;
  hasAnyMaterial: boolean;
  hasReadyMaterial: boolean;
  reportContent: string;
  evidenceLedger: EvidenceItem[];
  conflictRegister: ConflictItem[];
  qualityMetrics: QualityMetrics | null;
  strictMode: boolean;

  onStartParse: () => void;
  onGenerate: () => void;
  onRevalidate: () => void;
  onExport: () => void;
}

function getStepIcon(status: WorkflowStep["status"]) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />;
    case "running":
      return <Loader2 className="h-4 w-4 text-indigo-500 animate-spin flex-shrink-0" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-rose-500 flex-shrink-0" />;
    case "skipped":
      return <Circle className="h-4 w-4 text-slate-300 flex-shrink-0" />;
    default:
      return <Circle className="h-4 w-4 text-slate-300 flex-shrink-0" />;
  }
}

function getSeverityColor(sev: ConflictItem["severity"]) {
  const map = {
    critical: "text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900",
    high: "text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/40 border-orange-200 dark:border-orange-900",
    medium: "text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900",
    low: "text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-900/50 border-slate-200 dark:border-slate-800",
  };
  return map[sev];
}

function getSeverityBadgeVariant(sev: ConflictItem["severity"]) {
  const map = {
    critical: "destructive" as const,
    high: "destructive" as const,
    medium: "default" as const,
    low: "secondary" as const,
  };
  return map[sev];
}

// ===== 渲染简易 Markdown =====
function renderMarkdown(text: string) {
  const normalizedText = text.replace(/\r\n?/g, "\n");
  const lines = normalizedText.split("\n");
  const tocTargets = new globalThis.Map<string, string>();
  for (const match of normalizedText.matchAll(/^\s*\d+\.\s+\[([^\]]+)\]\(#([^)]+)\)\s*$/gm)) {
    const target = match[2].replace(/[^\p{L}\p{N}_-]/gu, "-");
    if (target) tocTargets.set(match[1].trim(), target);
  }
  const headingId = (title: string) => {
    const plain = title.replace(/[*_~]/g, "").trim();
    return tocTargets.get(plain) || plain.toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, "-") || "report-section";
  };
  const elements: React.ReactNode[] = [];
  let inList = false;
  let listType: "ul" | "ol" = "ul";
  let listItems: React.ReactNode[] = [];
  let listKeyCounter = 0;
  let inTable = false;
  let tableRows: string[][] = [];

  const flushList = (idx: number) => {
    if (inList && listItems.length > 0) {
      const ListTag = listType;
      elements.push(
        <ListTag
          key={`list-${idx}-${listKeyCounter++}`}
          className={`${listType === "ul" ? "list-disc" : "list-decimal"} pl-5 mb-4 text-sm space-y-1.5 text-slate-700 dark:text-slate-300`}
        >
          {listItems}
        </ListTag>
      );
      listItems = [];
      inList = false;
    }
  };

  const flushTable = (idx: number) => {
    if (inTable && tableRows.length >= 2) {
      const [header, ...rows] = tableRows;
      elements.push(
        <div key={`table-${idx}`} className="my-3 overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-slate-100 dark:bg-slate-800">
                {header.map((h, hi) => (
                  <th
                    key={hi}
                    className="px-2 py-1.5 text-left font-medium text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700"
                  >
                    <span dangerouslySetInnerHTML={{ __html: renderInline(h.trim()) }} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className="border-b border-slate-100 dark:border-slate-800">
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className="px-2 py-1.5 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700"
                    >
                      <span dangerouslySetInnerHTML={{ __html: renderInline(cell.trim()) }} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    inTable = false;
    tableRows = [];
  };

  lines.forEach((line, idx) => {
    const trimmed = line.trim();

    // 表格行
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      if (!inTable) {
        flushList(idx);
        inTable = true;
        tableRows = [];
      }
      const cells = trimmed.slice(1, -1).split("|");
      // 跳过分隔行
      if (!cells.every((c) => c.trim().match(/^[-:]+$/))) {
        tableRows.push(cells);
      }
      return;
    } else if (inTable) {
      flushTable(idx);
    }

    if (/^######\s/.test(trimmed)) {
      flushList(idx);
      const title = trimmed.replace(/^######\s+/, "").replace(/\s+#+$/, "");
      elements.push(<h6 key={idx} id={headingId(title)} className="text-xs font-semibold text-slate-700 dark:text-slate-300 mt-3 mb-1"><span dangerouslySetInnerHTML={{ __html: renderInline(title) }} /></h6>);
    } else if (/^#####\s/.test(trimmed)) {
      flushList(idx);
      const title = trimmed.replace(/^#####\s+/, "").replace(/\s+#+$/, "");
      elements.push(<h5 key={idx} id={headingId(title)} className="text-sm font-medium text-slate-800 dark:text-slate-200 mt-3 mb-1"><span dangerouslySetInnerHTML={{ __html: renderInline(title) }} /></h5>);
    } else if (/^####\s/.test(trimmed)) {
      flushList(idx);
      const title = trimmed.replace(/^####\s+/, "").replace(/\s+#+$/, "");
      elements.push(<h4 key={idx} id={headingId(title)} className="text-sm font-semibold text-slate-800 dark:text-slate-200 mt-4 mb-1.5"><span dangerouslySetInnerHTML={{ __html: renderInline(title) }} /></h4>);
    } else if (trimmed.startsWith("### ")) {
      flushList(idx);
      elements.push(
        <h3
          key={idx}
          id={headingId(trimmed.slice(4))}
          className="text-sm font-semibold text-slate-800 dark:text-slate-200 mt-4 mb-2"
        >
          <span dangerouslySetInnerHTML={{ __html: renderInline(trimmed.slice(4)) }} />
        </h3>
      );
    } else if (trimmed.startsWith("## ")) {
      flushList(idx);
      elements.push(
        <h2
          key={idx}
          id={headingId(trimmed.slice(3))}
          className="text-base font-semibold text-slate-900 dark:text-slate-100 mt-5 mb-2.5 pb-1 border-b border-slate-200 dark:border-slate-800"
        >
          <span dangerouslySetInnerHTML={{ __html: renderInline(trimmed.slice(3)) }} />
        </h2>
      );
    } else if (trimmed.startsWith("# ")) {
      flushList(idx);
      elements.push(
        <h1
          key={idx}
          id={headingId(trimmed.slice(2))}
          className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-3"
        >
          <span dangerouslySetInnerHTML={{ __html: renderInline(trimmed.slice(2)) }} />
        </h1>
      );
    } else if (trimmed.startsWith("- ") || trimmed.match(/^\d+\.\s/)) {
      const isOrdered = /^\d+\.\s/.test(trimmed);
      if (!inList) {
        inList = true;
        listType = isOrdered ? "ol" : "ul";
      }
      const content = isOrdered
        ? trimmed.replace(/^\d+\.\s/, "")
        : trimmed.slice(2);
      listItems.push(
        <li
          key={idx}
          className="leading-relaxed"
        >
          <span dangerouslySetInnerHTML={{ __html: renderInline(content) }} />
        </li>
      );
    } else if (trimmed.startsWith("---")) {
      flushList(idx);
      elements.push(<Separator key={idx} className="my-3" />);
    } else if (trimmed === "") {
      flushList(idx);
    } else if (trimmed.startsWith("> ")) {
      flushList(idx);
      elements.push(
        <blockquote
          key={idx}
          className="text-xs text-slate-500 dark:text-slate-400 border-l-2 border-amber-400 pl-3 py-1 my-2 bg-amber-50/50 dark:bg-amber-950/20"
        >
          <span dangerouslySetInnerHTML={{ __html: renderInline(trimmed.slice(2)) }} />
        </blockquote>
      );
    } else {
      flushList(idx);
      elements.push(
        <p
          key={idx}
          className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed mb-2"
        >
          <span dangerouslySetInnerHTML={{ __html: renderInline(trimmed) }} />
        </p>
      );
    }
  });

  flushList(lines.length);
  flushTable(lines.length);

  return elements;
}

// ===== 质量仪表盘组件 =====
function QualityGauge({
  label,
  value,
  target,
  unit = "%",
  invert = false,
}: {
  label: string;
  value: number | null;
  target: number;
  unit?: string;
  invert?: boolean;
}) {
  const pct = value === null ? 0 : Math.min(100, Math.max(0, value * 100));
  const targetPct = target * 100;
  const isGood = value !== null && (invert ? value <= target : value >= target);
  const barColor = isGood
    ? "bg-emerald-500"
    : value !== null && value >= target * 0.9
    ? "bg-amber-500"
    : "bg-rose-500";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-600 dark:text-slate-400">{label}</span>
        <span
          className={`text-xs font-mono font-semibold tabular-nums ${value === null ? "text-slate-400" : isGood ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
        >
          {value === null ? "未计算" : unit === "%" ? pct.toFixed(1) + "%" : value + unit}
        </span>
      </div>
      <div className="h-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full relative overflow-hidden">
        <div
          className={`h-full ${barColor} rounded-full transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
        {unit === "%" && value !== null && (
          <div
            className="absolute top-0 bottom-0 w-px bg-slate-400 dark:bg-slate-500"
            style={{ left: `${targetPct}%` }}
          />
        )}
      </div>
      <div className="text-[10px] text-slate-400 text-right">
        目标: {unit === "%" ? targetPct + "%" : target + unit}
      </div>
    </div>
  );
}

// ===== 证据项可折叠卡片 =====
function EvidenceCard({ item }: { item: EvidenceItem }) {
  const [expanded, setExpanded] = useState(false);
  const locator = item.locator ?? {};
  const confidence = Number.isFinite(item.confidence) ? Math.min(1, Math.max(0, item.confidence)) : null;
  const authority = Number.isFinite(item.source_authority) ? Math.max(0, Math.min(5, Math.floor(item.source_authority))) : 0;

  const typeColor: Record<string, string> = {
    fact: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    number: "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400",
    opinion: "bg-purple-50 text-purple-700 dark:bg-purple-950/40 dark:text-purple-400",
    forecast: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
    policy: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400",
  };

  return (
    <div
      className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden"
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-start gap-2 p-2.5 hover:bg-slate-50 dark:hover:bg-slate-900/50 transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-slate-400 flex-shrink-0 mt-0.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-slate-400 flex-shrink-0 mt-0.5" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-mono text-[11px] text-indigo-600 dark:text-indigo-400 font-semibold">
              {item.evidence_id}
            </span>
            <Badge
              variant="outline"
              className="font-mono text-[10px] h-4 px-1 border-0 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
            >
              {item.source_id}
            </Badge>
            <Badge
              variant="outline"
              className={`text-[10px] h-4 px-1.5 border-0 ${typeColor[item.evidence_type]}`}
            >
              {EVIDENCE_TYPE_LABELS[item.evidence_type]}
            </Badge>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 line-clamp-1">
            {item.subject} {item.predicate} {item.object}
          </p>
        </div>
        <div className="text-right flex-shrink-0">
          <span className="text-[10px] text-slate-400 font-mono">
            置信度 {confidence === null ? "—" : (confidence * 100).toFixed(0) + "%"}
          </span>
        </div>
      </button>
      {expanded && (
        <div className="px-2.5 pb-2.5 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/30 pt-2">
          <div className="grid grid-cols-2 gap-2 text-[11px] mb-2">
            <div>
              <span className="text-slate-400">定位：</span>
              <span className="text-slate-600 dark:text-slate-400 font-mono">
                {locator.section || locator.table || "未提供定位"}
                {typeof locator.page === "number" && locator.page > 0 ? ` · p.${locator.page}` : ""}
                {locator.table && locator.table !== locator.section ? ` · ${locator.table}` : ""}
              </span>
            </div>
            <div>
              <span className="text-slate-400">期间：</span>
              <span className="text-slate-600 dark:text-slate-400 font-mono">
                {item.period || "-"}
              </span>
            </div>
            {item.value !== null && item.value !== undefined && (
              <div>
                <span className="text-slate-400">数值：</span>
                <span className="text-slate-600 dark:text-slate-400 font-mono font-semibold">
                  {item.value} {item.unit || ""}
                </span>
              </div>
            )}
            <div>
              <span className="text-slate-400">来源等级：</span>
              <span className="text-slate-600 dark:text-slate-400 font-mono">
                {"★".repeat(authority)}
              </span>
            </div>
          </div>
          <div>
            <div className="text-[11px] text-slate-400 mb-1">原文摘录：</div>
            <blockquote className="text-[11px] text-slate-600 dark:text-slate-400 bg-white dark:bg-slate-950/60 border-l-2 border-indigo-300 dark:border-indigo-700 pl-2.5 py-1.5 rounded-r font-serif italic">
              “{item.quote}”
            </blockquote>
          </div>
        </div>
      )}
    </div>
  );
}

// ===== 冲突卡片 =====
function ConflictCard({ item }: { item: ConflictItem }) {
  const [expanded, setExpanded] = useState(false);
  const colorClass = getSeverityColor(item.severity);

  return (
    <div className={`border rounded-lg overflow-hidden ${colorClass.split(" ")[2]} ${colorClass.split(" ")[3]}`}>
      <button
        onClick={() => setExpanded((v) => !v)}
        className={`w-full flex items-start gap-2 p-2.5 hover:bg-white/50 dark:hover:bg-slate-900/30 transition-colors text-left`}
      >
        <AlertTriangle
          className={`h-4 w-4 flex-shrink-0 mt-0.5 ${colorClass.split(" ")[0]}`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-mono text-[11px] font-semibold">
              {item.conflict_id}
            </span>
            <Badge
              variant={getSeverityBadgeVariant(item.severity)}
              className="text-[10px] h-4 px-1.5"
            >
              {SEVERITY_LABELS[item.severity]}
            </Badge>
            <Badge
              variant="outline"
              className="text-[10px] h-4 px-1.5 border-current/30"
            >
              {CONFLICT_TYPE_LABELS[item.conflict_type]}
            </Badge>
            {item.resolved && (
              <Badge
                variant="outline"
                className="text-[10px] h-4 px-1.5 border-emerald-500/50 text-emerald-600 dark:text-emerald-400"
              >
                已处理
              </Badge>
            )}
          </div>
          <p className="text-xs mt-1 line-clamp-1">{item.summary}</p>
        </div>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 opacity-60" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 opacity-60" />
        )}
      </button>
      {expanded && (
        <div className="px-2.5 pb-2.5 border-t border-current/10 pt-2">
          <p className="text-xs text-slate-600 dark:text-slate-400 mb-2">
            {item.explanation}
          </p>
          <div className="flex items-center gap-3 text-[11px]">
            <div>
              <span className="text-slate-400">涉及证据：</span>
              <span className="font-mono">
                {item.evidence_ids.join(", ")}
              </span>
            </div>
            {item.resolution && (
              <div>
                <span className="text-slate-400">处理建议：</span>
                <span className="font-medium">
                  {
                    {
                      prefer_latest: "采信最新",
                      prefer_authoritative: "采信权威",
                      preserve_both: "保留双方",
                      manual: "需人工裁决",
                    }[item.resolution]
                  }
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ReportPanel({
  steps,
  jobStatus,
  isParsing,
  isGenerating,
  hasAnyMaterial,
  hasReadyMaterial,
  reportContent,
  evidenceLedger,
  conflictRegister,
  qualityMetrics,
  strictMode,
  onStartParse,
  onGenerate,
  onRevalidate,
  onExport,
}: ReportPanelProps) {
  const [activeTab, setActiveTab] = useState("report");
  const hasReport = reportContent.length > 0;
  const hasEvidence = evidenceLedger.length > 0;
  const hasConflicts = conflictRegister.length > 0;
  const hasQuality = qualityMetrics !== null;

  const completedSteps = steps.filter((s) => s.status === "completed").length;
  const totalSteps = steps.length;

  const hasBlockingIssue =
    strictMode && conflictRegister.some((c) => ["critical", "high"].includes(c.severity) && !c.resolved);

  const criticalCount = conflictRegister.filter((c) => c.severity === "critical").length;
  const highCount = conflictRegister.filter((c) => c.severity === "high").length;
  const mediumCount = conflictRegister.filter((c) => c.severity === "medium").length;
  const lowCount = conflictRegister.filter((c) => c.severity === "low").length;

  // 按来源分组证据
  const evidenceBySource: Record<string, EvidenceItem[]> = {};
  evidenceLedger.forEach((e) => {
    if (!evidenceBySource[e.source_id]) {
      evidenceBySource[e.source_id] = [];
    }
    evidenceBySource[e.source_id].push(e);
  });

  return (
    <div className="space-y-4 h-full flex flex-col min-h-0">
      {/* 操作按钮组 + 进度 */}
      <Card className="flex-shrink-0">
        <CardContent className="p-4 space-y-3">
          {/* 主操作按钮 */}
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={onStartParse}
              disabled={isParsing || !hasAnyMaterial}
              className="flex-1 min-w-[100px]"
              variant={isGenerating ? "secondary" : "default"}
            >
              {isParsing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  解析中...
                </>
              ) : hasReadyMaterial && !isParsing ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  重新解析
                </>
              ) : (
                <>
                  <Zap className="h-4 w-4 mr-2" />
                  开始解析
                </>
              )}
            </Button>
            <Button
              onClick={onGenerate}
              disabled={isGenerating || isParsing || !hasReadyMaterial}
              className="flex-1 min-w-[100px]"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  生成中...
                </>
              ) : hasReport ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  重新生成
                </>
              ) : (
                <>
                  <Play className="h-4 w-4 mr-2" />
                  生成报告
                </>
              )}
            </Button>
            <Button
              variant="secondary"
              onClick={onRevalidate}
          disabled={!hasReport || isGenerating}
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              重新校验
            </Button>
            <Button
              variant="secondary"
              onClick={onExport}
              disabled={!hasReport || isGenerating}
            >
              <Download className="h-4 w-4 mr-2" />
              导出审计包
            </Button>

          </div>

          {/* 状态提示 */}
          {!hasAnyMaterial && (
            <p className="text-xs text-slate-500 flex items-center gap-1">
              <AlertCircle className="h-3.5 w-3.5" />
              请至少上传一个文件或添加一个在线来源
            </p>
          )}
          {hasAnyMaterial && !hasReadyMaterial && !isParsing && (
            <p className="text-xs text-amber-600 dark:text-amber-500 flex items-center gap-1">
              <AlertCircle className="h-3.5 w-3.5" />
              点击“开始解析”处理材料后再生成报告
            </p>
          )}
          {isParsing && (
            <p className="text-xs text-indigo-600 dark:text-indigo-400 flex items-center gap-1">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在解析材料，解析完成后可生成报告
            </p>
          )}
          {hasBlockingIssue && (
            <p className="text-xs text-rose-600 dark:text-rose-500 flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" />
              严格模式下存在未解决高风险冲突，报告处于阻断状态
            </p>
          )}

          {/* 工作流步骤指示 */}
          {(isParsing || isGenerating || hasReport || hasEvidence) && (
            <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-indigo-500" />
                  处理进度
                </span>
                <span className="text-xs text-slate-500 font-mono tabular-nums">
                  {completedSteps} / {totalSteps}
                </span>
              </div>
              <div className="flex items-center gap-1 overflow-x-auto pb-1">
                {steps.map((step, idx) => (
                  <div key={step.id} className="flex items-center flex-shrink-0">
                    <div className="flex items-center gap-1.5">
                      {getStepIcon(step.status)}
                      <span
                        className={`text-[11px] whitespace-nowrap ${
                          step.status === "completed"
                            ? "text-slate-600 dark:text-slate-400"
                            : step.status === "running"
                            ? "text-indigo-600 dark:text-indigo-400 font-medium"
                            : "text-slate-400 dark:text-slate-500"
                        }`}
                      >
                        {step.name}
                      </span>
                    </div>
                    {idx < steps.length - 1 && (
                      <div
                        className={`w-4 h-px mx-1 ${
                          steps[idx].status === "completed" && steps[idx + 1].status !== "pending"
                            ? "bg-emerald-300 dark:bg-emerald-700"
                            : "bg-slate-200 dark:bg-slate-800"
                        }`}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 四页签内容区 */}
      <Card className="flex-1 min-h-0 flex flex-col">
        <CardHeader className="pb-0 pt-3 px-4 flex-shrink-0">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid grid-cols-4 w-full h-8">
              <TabsTrigger value="report" className="text-xs gap-1.5 h-7">
                <FileText className="h-3.5 w-3.5" />
                报告
              </TabsTrigger>
              <TabsTrigger value="evidence" className="text-xs gap-1.5 h-7">
                <MapIcon className="h-3.5 w-3.5" />
                证据地图
                {hasEvidence && (
                  <Badge variant="secondary" className="ml-0.5 h-4 px-1 text-[9px] font-mono">
                    {evidenceLedger.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="conflict" className="text-xs gap-1.5 h-7">
                <Radar className="h-3.5 w-3.5" />
                冲突雷达
                {hasConflicts && (
                  <Badge
                    variant="destructive"
                    className="ml-0.5 h-4 px-1 text-[9px] font-mono"
                  >
                    {conflictRegister.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="quality" className="text-xs gap-1.5 h-7">
                <Gauge className="h-3.5 w-3.5" />
                质量
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 p-0">
          <ScrollArea className="h-full">
            <div className="p-4 pt-3">
              {/* 报告正文页签 */}
              {activeTab === "report" && (
                <>
                  {hasReport ? (
                    <div className="prose prose-sm dark:prose-invert max-w-none">
                      {renderMarkdown(reportContent)}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                      <FileText className="h-12 w-12 mb-3 opacity-30" />
                      <p className="text-sm">报告尚未生成</p>
                      <p className="text-xs mt-1 text-slate-500">
                        上传材料、解析后点击“生成报告”
                      </p>
                    </div>
                  )}
                </>
              )}

              {/* 证据地图页签 */}
              {activeTab === "evidence" && (
                <>
                  {hasEvidence ? (
                    <div className="space-y-4">
                      {/* 统计概览 */}
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div className="p-2.5 bg-indigo-50 dark:bg-indigo-950/30 rounded-lg">
                          <div className="text-xl font-semibold text-indigo-600 dark:text-indigo-400 font-mono">
                            {evidenceLedger.length}
                          </div>
                          <div className="text-[11px] text-slate-500">证据总数</div>
                        </div>
                        <div className="p-2.5 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg">
                          <div className="text-xl font-semibold text-emerald-600 dark:text-emerald-400 font-mono">
                            {Object.keys(evidenceBySource).length}
                          </div>
                          <div className="text-[11px] text-slate-500">来源数</div>
                        </div>
                        <div className="p-2.5 bg-amber-50 dark:bg-amber-950/30 rounded-lg">
                          <div className="text-xl font-semibold text-amber-600 dark:text-amber-400 font-mono">
                            {evidenceLedger.filter((e) => e.evidence_type === "number").length}
                          </div>
                          <div className="text-[11px] text-slate-500">数值证据</div>
                        </div>
                      </div>

                      {/* 按来源分组 */}
                      {Object.entries(evidenceBySource).map(([sourceId, items]) => (
                        <div key={sourceId}>
                          <div className="flex items-center gap-2 mb-2">
                            <Badge
                              variant="outline"
                              className="font-mono text-[11px] bg-slate-100 dark:bg-slate-800 border-0"
                            >
                              {sourceId}
                            </Badge>
                            <span className="text-xs text-slate-500">
                              {items.length} 条证据
                            </span>
                            <Separator className="flex-1" />
                          </div>
                          <div className="space-y-1.5">
                            {items.map((ev) => (
                              <EvidenceCard key={ev.evidence_id} item={ev} />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                      <MapIcon className="h-12 w-12 mb-3 opacity-30" />
                      <p className="text-sm">证据台账为空</p>
                      <p className="text-xs mt-1 text-slate-500">
                        解析完成后将自动抽取结构化证据
                      </p>
                    </div>
                  )}
                </>
              )}

              {/* 冲突雷达页签 */}
              {activeTab === "conflict" && (
                <>
                  {hasConflicts ? (
                    <div className="space-y-4">
                      {/* 冲突统计 */}
                      <div className="grid grid-cols-4 gap-2 text-center">
                        <div className="p-2 bg-rose-50 dark:bg-rose-950/30 rounded-lg">
                          <div className="text-lg font-semibold text-rose-600 dark:text-rose-400 font-mono">
                            {criticalCount}
                          </div>
                          <div className="text-[10px] text-slate-500">严重</div>
                        </div>
                        <div className="p-2 bg-orange-50 dark:bg-orange-950/30 rounded-lg">
                          <div className="text-lg font-semibold text-orange-600 dark:text-orange-400 font-mono">
                            {highCount}
                          </div>
                          <div className="text-[10px] text-slate-500">高</div>
                        </div>
                        <div className="p-2 bg-amber-50 dark:bg-amber-950/30 rounded-lg">
                          <div className="text-lg font-semibold text-amber-600 dark:text-amber-400 font-mono">
                            {mediumCount}
                          </div>
                          <div className="text-[10px] text-slate-500">中</div>
                        </div>
                        <div className="p-2 bg-slate-100 dark:bg-slate-800/50 rounded-lg">
                          <div className="text-lg font-semibold text-slate-600 dark:text-slate-400 font-mono">
                            {lowCount}
                          </div>
                          <div className="text-[10px] text-slate-500">低</div>
                        </div>
                      </div>

                      {/* 冲突列表 */}
                      <div className="space-y-2">
                        {conflictRegister.map((c) => (
                          <ConflictCard key={c.conflict_id} item={c} />
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                      <ShieldCheck className="h-12 w-12 mb-3 opacity-30 text-emerald-500" />
                      <p className="text-sm">未发现冲突</p>
                      <p className="text-xs mt-1 text-slate-500">
                        系统已完成冲突检测，现有材料无明显冲突
                      </p>
                    </div>
                  )}
                </>
              )}

              {/* 质量面板页签 */}
              {activeTab === "quality" && (
                <>
                  {hasQuality ? (
                    <div className="space-y-5">
                      {/* 总体状态 */}
                      <div className={`p-4 rounded-lg border ${qualityMetrics.quality_status === "blocked" ? "bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900" : qualityMetrics.quality_status === "review_required" ? "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900" : "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900"}`}>
                        <div className="flex items-center gap-3">
                          {qualityMetrics.quality_status === "blocked" ? (
                            <FileX className="h-8 w-8 text-rose-500" />
                          ) : qualityMetrics.quality_status === "review_required" ? (
                            <AlertTriangle className="h-8 w-8 text-amber-500" />
                          ) : (
                            <FileCheck className="h-8 w-8 text-emerald-500" />
                          )}
                          <div>
                            <p className="text-base font-semibold text-slate-900 dark:text-slate-100">
                              {qualityMetrics.quality_status === "blocked" ? "质量闸门未通过" : qualityMetrics.quality_status === "review_required" ? "需要人工复核" : "完整性检查通过"}
                            </p>
                            <p className="text-xs text-slate-500">
                              {qualityMetrics.blocking_reasons?.length ? qualityMetrics.blocking_reasons.join("；") : qualityMetrics.measurement_mode === "demo" ? "演示数据：指标仅反映本地规则检查，不代表模型准确率" : "展示的是引用、章节与来源完整性检查，不代表模型效果基准"}
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* 核心指标 */}
                      <div className="space-y-4">
                        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                          <Gauge className="h-4 w-4 text-indigo-500" />
                          核心质量指标
                        </h3>
                        <QualityGauge
                          label="引用编号有效率"
                          value={qualityMetrics.citation_validity}
                          target={1.0}
                        />
                        <QualityGauge
                          label="正文段落引用率"
                          value={qualityMetrics.citation_coverage}
                          target={0.98}
                        />
                        <QualityGauge
                          label="来源解析成功率"
                          value={qualityMetrics.source_parse_coverage}
                          target={0.95}
                        />
                        <QualityGauge
                          label="必备章节覆盖率"
                          value={qualityMetrics.required_section_coverage}
                          target={1.0}
                        />
                      </div>

                      {/* 产出统计 */}
                      <div className="space-y-3">
                        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                          <FileText className="h-4 w-4 text-indigo-500" />
                          产出统计
                        </h3>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="p-3 bg-slate-50 dark:bg-slate-900/50 rounded-lg">
                            <div className="text-xl font-semibold text-slate-800 dark:text-slate-200 font-mono tabular-nums">
                              {qualityMetrics.total_evidence}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              证据条目
                            </div>
                          </div>
                          <div className="p-3 bg-slate-50 dark:bg-slate-900/50 rounded-lg">
                            <div className="text-xl font-semibold text-slate-800 dark:text-slate-200 font-mono tabular-nums">
                              {qualityMetrics.total_sources}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              来源总数
                            </div>
                          </div>
                          <div className="p-3 bg-rose-50 dark:bg-rose-950/30 rounded-lg">
                            <div className="text-xl font-semibold text-rose-600 dark:text-rose-400 font-mono tabular-nums">
                              {qualityMetrics.failed_sources}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              失败来源
                            </div>
                          </div>
                          <div className="p-3 bg-indigo-50 dark:bg-indigo-950/30 rounded-lg">
                            <div className="text-xl font-semibold text-indigo-600 dark:text-indigo-400 font-mono tabular-nums">
                              {qualityMetrics.critical_conflicts_open}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              未解决严重冲突
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* 元数据 */}
                      <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-slate-500">模板版本</span>
                          <span className="font-mono text-slate-700 dark:text-slate-300">
                            {qualityMetrics.template_version}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-slate-500">运行时长</span>
                          <span className="font-mono text-slate-700 dark:text-slate-300">
                            {qualityMetrics.run_time_seconds === null ? "未记录" : `${qualityMetrics.run_time_seconds.toFixed(1)} 秒`}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-slate-500">严格模式</span>
                          <span className="font-mono text-slate-700 dark:text-slate-300">
                            {strictMode ? "已开启" : "已关闭"}
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                      <Gauge className="h-12 w-12 mb-3 opacity-30" />
                      <p className="text-sm">质量指标尚未生成</p>
                      <p className="text-xs mt-1 text-slate-500">
                        报告生成后将展示完整质量评估
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

import type {
  ConflictItem,
  EvidenceItem,
  QualityMetrics,
  SourceRegistry,
} from "@/lib/types";

const REQUIRED_SECTIONS = [
  "执行摘要",
  "核心指标概览",
  "详细分析",
  "冲突与差异分析",
  "风险提示",
  "结论与建议",
];

/** Deterministic integrity checks. These are not model-quality benchmarks. */
export function evaluateReportQuality(input: {
  report: string;
  evidence: EvidenceItem[];
  conflicts: ConflictItem[];
  sources: SourceRegistry[];
  strictMode: boolean;
  startedAt?: number;
  measurementMode?: "observed" | "demo";
}): QualityMetrics {
  const { report, evidence, conflicts, sources, strictMode } = input;
  const citations = Array.from(report.matchAll(/\[(E\d+)\]/g), (match) => match[1]);
  const evidenceIds = new Set(evidence.map((item) => item.evidence_id));
  const invalidCitationReferences = citations.filter((id) => !evidenceIds.has(id));
  const invalidCitationIds = Array.from(new Set(invalidCitationReferences));

  const proseParagraphs = report
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) =>
      paragraph.length > 0 &&
      !/^#{1,6}\s/.test(paragraph) &&
      !/^\|/.test(paragraph) &&
      !/^---+$/.test(paragraph) &&
      !/\]\(#/.test(paragraph),
    );
  const citedParagraphs = proseParagraphs.filter((paragraph) => /\[E\d+\]/.test(paragraph)).length;

  const headingNames = new Set(
    report
      .split("\n")
      .map((line) => line.match(/^#{1,3}\s+(.+?)\s*#*$/)?.[1]?.trim())
      .filter((heading): heading is string => Boolean(heading)),
  );
  const presentSections = REQUIRED_SECTIONS.filter((section) => headingNames.has(section));
  const missingRequiredSections = REQUIRED_SECTIONS.filter((section) => !presentSections.includes(section));
  const parsedSources = sources.filter((source) => source.parse_status === "ready").length;
  const unresolvedHighRisk = conflicts.filter(
    (conflict) => !conflict.resolved && ["critical", "high"].includes(conflict.severity),
  ).length;

  const blockingReasons: string[] = [];
  if (evidence.length === 0) blockingReasons.push("没有可追溯的证据条目");
  if (invalidCitationIds.length > 0) blockingReasons.push(`报告引用了不存在的证据编号：${invalidCitationIds.join("、")}`);
  if (strictMode && unresolvedHighRisk > 0) blockingReasons.push(`存在 ${unresolvedHighRisk} 项未解决高风险冲突`);
  if (strictMode && missingRequiredSections.length > 0) {
    blockingReasons.push(`缺少必备章节：${missingRequiredSections.join("、")}`);
  }

  const needsReview = blockingReasons.length > 0 || missingRequiredSections.length > 0 || citations.length === 0;
  const qualityStatus = blockingReasons.length > 0
    ? "blocked"
    : needsReview
      ? "review_required"
      : "passed";

  return {
    citation_validity: citations.length > 0 ? (citations.length - invalidCitationReferences.length) / citations.length : null,
    citation_coverage: proseParagraphs.length > 0 ? citedParagraphs / proseParagraphs.length : null,
    source_parse_coverage: sources.length > 0 ? parsedSources / sources.length : null,
    required_section_coverage: REQUIRED_SECTIONS.length > 0 ? presentSections.length / REQUIRED_SECTIONS.length : null,
    critical_conflicts_open: unresolvedHighRisk,
    total_evidence: evidence.length,
    total_sources: sources.length || new Set(evidence.map((item) => item.source_id)).size,
    total_conflicts: conflicts.length,
    failed_sources: sources.filter((source) => source.parse_status === "failed").length,
    template_version: "1.0.0",
    run_time_seconds: typeof input.startedAt === "number" ? Math.max(0, (Date.now() - input.startedAt) / 1000) : null,
    quality_status: qualityStatus,
    blocking_reasons: blockingReasons,
    invalid_citation_ids: invalidCitationIds,
    missing_required_sections: missingRequiredSections,
    measurement_mode: input.measurementMode || "observed",
  };
}

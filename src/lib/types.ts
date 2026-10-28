export type Industry = "finance" | "government" | "consulting";

export type Audience = "management" | "analyst" | "public";

export type ParseStatus =
  | "pending"
  | "parsing"
  | "ready"
  | "need_ocr"
  | "ocr_pending"
  | "failed";

export type ConflictType = "hard" | "definition" | "caliber" | "time" | "timing" | "semantic" | "source";

export type ConflictSeverity = "critical" | "high" | "medium" | "low";

export type EvidenceType = "fact" | "number" | "opinion" | "forecast" | "policy";

export type Resolution =
  | "prefer_latest"
  | "prefer_authoritative"
  | "preserve_both"
  | "manual";

export type JobStatus =
  | "idle"
  | "parsing"
  | "parsed"
  | "parse_blocked"
  | "extract"
  | "conflict"
  | "writing"
  | "review"
  | "done"
  | "blocked"
  | "failed";

export interface TemplateOption {
  id: string;
  name: string;
  description: string;
}

export interface UploadedFile {
  id: string;
  source_id: string; // S001, S002...
  name: string;
  size: number;
  type: string;
  parse_status: ParseStatus;
  parse_method?: "link_reader" | "precise_ocr" | "manual";
  char_count?: number;
  chunk_count?: number;
  authority_level?: number; // 1-5
  error_reason?: string;
  upload_progress?: number;
}

export interface SourceUrl {
  id: string;
  source_id: string;
  url: string;
  title?: string;
  publisher?: string;
  publish_date?: string;
  parse_status: ParseStatus;
  parse_method?: "link_reader" | "precise_ocr";
  char_count?: number;
  authority_level?: number;
  error_reason?: string;
}

export interface ParsedChunk {
  source_id: string;
  chunk_id: string;
  file_name?: string;
  text: string;
  char_count?: number;
  parse_mode?: "native" | "ocr" | "kb";
  source_title?: string;
  source_authority?: number;
  locator?: {
    page?: number;
    section?: string;
    table?: string;
    paragraph_index?: number;
    quote_hash?: string;
  };
  chunk_type?: "text" | "table" | "qa";
  parse_confidence?: number;
  document_hash?: string;
}

export interface EvidenceItem {
  evidence_id: string; // E000123
  source_id: string;
  source_title?: string; // 来源文档标题
  chunk_id?: string;
  subject: string;
  predicate: string;
  object: string;
  value?: number | null;
  unit?: string;
  currency?: string;
  period?: string;
  scope?: string;
  evidence_type: EvidenceType;
  locator: {
    page?: number;
    section?: string;
    paragraph_index?: number;
    table?: string;
    quote_hash?: string;
  };
  quote: string;
  confidence: number; // 0-1
  source_authority: number;
  section_refs?: string[]; // 在哪些章节被引用
}

export interface ConflictItem {
  conflict_id: string; // C001
  evidence_ids: string[];
  conflict_type: ConflictType;
  severity: ConflictSeverity;
  explanation: string;
  resolution?: Resolution;
  resolved: boolean;
  summary: string; // 一句话描述
  // Optional aliases accepted from the external workflow adapter.
  title?: string;
  description?: string;
  handling?: string;
  status?: string;
}

export interface WorkflowStep {
  id: string;
  name: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped" | "error";
  detail?: string;
}

export interface QualityMetrics {
  citation_validity: number | null; // mechanically checked cited IDs / cited IDs
  citation_coverage: number | null; // report paragraphs containing at least one evidence citation
  source_parse_coverage: number | null;
  required_section_coverage: number | null;
  critical_conflicts_open: number;
  total_evidence: number;
  total_sources: number;
  total_conflicts: number;
  failed_sources: number;
  template_version: string;
  run_time_seconds: number | null;
  quality_status?: "passed" | "blocked" | "review_required";
  blocking_reasons?: string[];
  invalid_citation_ids?: string[];
  missing_required_sections?: string[];
  measurement_mode?: "observed" | "demo";
}

// ===== 工作流输出类型 =====

/** Adapter accepts the known C Module field aliases; the external workflow is versioned separately. */
export interface CModuleOutput {
  evidence_ledger?: EvidenceItem[];
  merged_evidences?: EvidenceItem[];
  conflict_register?: ConflictItem[];
  conflicts?: ConflictItem[];
  source_manifest?: SourceRegistry[];
  stats?: Record<string, number>;
  report_markdown?: string;
  [key: string]: unknown;
}

/**
 * WF60 渲染输出（四页签视图结构）
 */
export interface WF60Output {
  run_id?: string;
  report_markdown: string;
  report_html: string;
  toc: string;
  report_body_view: {
    title: string;
    toc_html: string;
    body_html: string;
    footnotes: Array<{
      evidence_id: string;
      source_name: string;
      location: string;
      quote: string;
    }>;
    risk_warnings: string[];
    chapter_count: number;
    chapter_titles: string[];
    evidence_count: number;
  };
  evidence_map_view: {
    title: string;
    total_evidence: number;
    chapter_count: number;
    sections: Array<{
      section_id: string;
      title: string;
      evidence: Array<{
        evidence_id: string;
        source_id: string;
        source_name: string;
        location: string;
        quote: string;
        confidence: number;
      }>;
    }>;
  };
  conflict_radar_view: {
    title: string;
    total_conflicts: number;
    open_high_risk_count: number;
    conflicts: Array<{
      conflict_id: string;
      severity: string;
      severity_label: string;
      severity_rank: number;
      conflict_type: string;
      title: string;
      parties: string[];
      description: string;
      handling: string;
      status: string;
    }>;
  };
  quality_panel_view: {
    title: string;
    metrics: Array<{
      key: string;
      name: string;
      value: number;
      value_display: string;
      target: string;
      passed: boolean;
    }>;
    failed_sources: string[];
    failed_source_count: number;
    failed_sources_passed: boolean;
    template: { id: string; version: string };
    runtime_ms: number;
    runtime_display: string;
    generated_at: string;
    strict_mode: boolean;
    verdict: "passed" | "blocked" | string;
    verdict_cn: string;
  };
  export_result?: {
    title: string;
    docs: {
      pdf?: string;
      docx?: string;
    };
    feishu_url?: string;
    feishu_status?: string;
    download_areas?: {
      markdown: string;
      evidence: string;
      conflicts: string;
    };
    export_status: "ok" | "partial" | "degraded";
    export_errors: string[];
  };
}

// 来源登记台账（对应 source_registry 表）
export interface SourceRegistry {
  source_id: string; // S001
  source_type?: string; // 来源类型：file / url
  job_id?: string;
  file_name: string;
  file_type: string;
  file_size?: number;
  source_title: string;
  publisher?: string;
  publish_date?: string;
  authority_level: number; // 1-5
  parse_method: "link_reader" | "precise_ocr" | "manual";
  parse_status: ParseStatus;
  char_count: number;
  chunk_count: number;
  document_id?: string;
  error_message?: string;
  source_fingerprint?: string;
}

export interface ReportFormData {
  files: UploadedFile[];
  source_urls: SourceUrl[];
  auto_collect: boolean;
  allowed_domains: string;
  industry: Industry;
  template_id: string;
  decision_question: string;
  cutoff_date: string;
  audience: Audience;
  strict_mode: boolean;
}

export const INDUSTRY_LABELS: Record<Industry, string> = {
  finance: "金融投研",
  government: "政务汇报",
  consulting: "咨询调研",
};

export const AUDIENCE_LABELS: Record<Audience, string> = {
  management: "管理层",
  analyst: "专业分析师",
  public: "公众",
};

export const CONFLICT_TYPE_LABELS: Record<ConflictType, string> = {
  hard: "硬冲突",
  definition: "口径差异",
  caliber: "统计口径差异",
  time: "时效冲突",
  timing: "时效冲突",
  semantic: "语义冲突",
  source: "来源差异",
};

export const SEVERITY_LABELS: Record<ConflictSeverity, string> = {
  critical: "严重",
  high: "高",
  medium: "中",
  low: "低",
};

export const EVIDENCE_TYPE_LABELS: Record<EvidenceType, string> = {
  fact: "事实",
  number: "数值",
  opinion: "观点",
  forecast: "预测",
  policy: "政策",
};

export const PARSE_STATUS_LABELS: Record<ParseStatus, string> = {
  pending: "待解析",
  parsing: "解析中",
  ready: "已就绪",
  need_ocr: "需 OCR",
  ocr_pending: "OCR 中",
  failed: "解析失败",
};

export const TEMPLATES_BY_INDUSTRY: Record<Industry, TemplateOption[]> = {
  finance: [
    { id: "finance_v1", name: "金融投研决策简报", description: "适合行业分析与投资决策" },
    { id: "finance_earnings", name: "公司业绩点评", description: "财报季快速解读与评级" },
    { id: "finance_macro", name: "宏观经济周报", description: "政策与经济数据跟踪" },
    { id: "finance_ipo", name: "IPO 定价分析", description: "新股估值与申购建议" },
  ],
  government: [
    { id: "gov_policy", name: "政策解读汇报", description: "政策原文梳理与影响评估" },
    { id: "gov_yearly", name: "年度工作总结", description: "成果汇总与来年规划" },
    { id: "gov_research", name: "专题调研报告", description: "问题导向的深度调研" },
    { id: "gov_brief", name: "领导参阅简报", description: "精炼版信息摘要" },
  ],
  consulting: [
    { id: "consult_strategy", name: "战略咨询报告", description: "市场进入与增长策略" },
    { id: "consult_due", name: "尽职调查报告", description: "并购与投资标的分析" },
    { id: "consult_op", name: "运营优化方案", description: "流程与效率提升建议" },
    { id: "consult_digital", name: "数字化转型规划", description: "技术与组织变革路径" },
  ],
};

export const ALLOWED_FILE_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/markdown",
];

export const ACCEPT_ATTR =
  ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/markdown";

export const WORKFLOW_STEPS: WorkflowStep[] = [
  { id: "parse", name: "材料解析", status: "pending" },
  { id: "extract", name: "事实抽取", status: "pending" },
  { id: "conflict", name: "冲突检测", status: "pending" },
  { id: "outline", name: "大纲与撰写", status: "pending" },
  { id: "citation_qa", name: "引用质量校验", status: "pending" },
  { id: "render", name: "渲染与交付", status: "pending" },
];

"use client";

import { useRef, useState, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Upload,
  FileText,
  X,
  Link2,
  Plus,
  Globe,
  AlertCircle,
  FileCheck,
  FileWarning,
  FileX,
  Clock,
  Eye,
} from "lucide-react";
import { ACCEPT_ATTR, PARSE_STATUS_LABELS } from "@/lib/types";
import type { UploadedFile, SourceUrl, ParseStatus } from "@/lib/types";

interface MaterialPanelProps {
  files: UploadedFile[];
  sourceUrls: SourceUrl[];
  autoCollect: boolean;
  allowedDomains: string;
  parseProgress: number;
  isParsing: boolean;
  onAddFiles: (files: FileList | File[]) => void;
  onRemoveFile: (id: string) => void;
  onAddSourceUrl: (url: string) => void;
  onRemoveSourceUrl: (id: string) => void;
  onAutoCollectChange: (v: boolean) => void;
  onAllowedDomainsChange: (v: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatChars(n?: number): string {
  if (n === undefined) return "-";
  if (n < 1000) return `${n}`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 10000).toFixed(1)}万`;
}

function getFileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  const colorMap: Record<string, string> = {
    pdf: "text-rose-500",
    doc: "text-blue-500",
    docx: "text-blue-500",
    xls: "text-emerald-500",
    xlsx: "text-emerald-500",
    ppt: "text-amber-500",
    pptx: "text-amber-500",
    txt: "text-slate-500",
    md: "text-slate-600",
  };
  return colorMap[ext || ""] || "text-slate-500";
}

function getStatusIcon(status: ParseStatus) {
  switch (status) {
    case "ready":
      return <FileCheck className="h-3.5 w-3.5 text-emerald-500" />;
    case "failed":
      return <FileX className="h-3.5 w-3.5 text-rose-500" />;
    case "need_ocr":
    case "ocr_pending":
      return <FileWarning className="h-3.5 w-3.5 text-amber-500" />;
    case "parsing":
      return <Clock className="h-3.5 w-3.5 text-indigo-500 animate-pulse" />;
    default:
      return <Clock className="h-3.5 w-3.5 text-slate-400" />;
  }
}

function getStatusBadge(status: ParseStatus) {
  const map: Record<ParseStatus, { variant: "default" | "secondary" | "destructive" | "outline"; label: string }> = {
    pending: { variant: "secondary", label: "待解析" },
    parsing: { variant: "default", label: "解析中" },
    ready: { variant: "default", label: "已就绪" },
    need_ocr: { variant: "outline", label: "需 OCR" },
    ocr_pending: { variant: "default", label: "OCR 中" },
    failed: { variant: "destructive", label: "失败" },
  };
  return map[status];
}

export function MaterialPanel({
  files,
  sourceUrls,
  autoCollect,
  allowedDomains,
  parseProgress,
  isParsing,
  onAddFiles,
  onRemoveFile,
  onAddSourceUrl,
  onRemoveSourceUrl,
  onAutoCollectChange,
  onAllowedDomainsChange,
}: MaterialPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [urlInput, setUrlInput] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  const totalSources = files.length + sourceUrls.length;
  const readyCount =
    files.filter((f) => f.parse_status === "ready").length +
    sourceUrls.filter((u) => u.parse_status === "ready").length;
  const failedCount =
    files.filter((f) => f.parse_status === "failed").length +
    sourceUrls.filter((u) => u.parse_status === "failed").length;

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) {
        onAddFiles(e.dataTransfer.files);
      }
    },
    [onAddFiles]
  );

  const handleAddUrl = useCallback(() => {
    if (urlInput.trim()) {
      onAddSourceUrl(urlInput);
      setUrlInput("");
    }
  }, [urlInput, onAddSourceUrl]);

  const handleUrlKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAddUrl();
      }
    },
    [handleAddUrl]
  );

  return (
    <div className="space-y-4">
      {/* 文件上传 */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <FileText className="h-4 w-4 text-indigo-500" />
                资料文件
              </CardTitle>
              <CardDescription className="text-xs mt-1">
                支持 PDF / Word / Excel / PPT / TXT / MD
              </CardDescription>
            </div>
            <Badge variant="secondary" className="font-mono text-xs">
              {files.length} 个
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* 拖拽上传区 */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`relative border-2 border-dashed rounded-lg p-5 text-center cursor-pointer transition-colors ${
              isDragging
                ? "border-indigo-400 bg-indigo-50/50 dark:bg-indigo-950/30"
                : "border-slate-200 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-700"
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPT_ATTR}
              className="hidden"
              onChange={(e) => {
                if (e.target.files) {
                  onAddFiles(e.target.files);
                  e.target.value = "";
                }
              }}
            />
            <Upload className="h-7 w-7 mx-auto text-slate-400 mb-1.5" />
            <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
              点击或拖拽文件到此处上传
            </p>
            <p className="text-xs text-slate-500 mt-1">
              多文件批量上传 · 单文件最大 50MB
            </p>
          </div>

          {/* 解析进度条（有文件且在解析时显示） */}
          {(isParsing || (files.length > 0 && readyCount > 0)) && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-500">解析进度</span>
                <span className="text-slate-500 font-mono tabular-nums">
                  {readyCount + failedCount} / {files.length + sourceUrls.length}
                  {failedCount > 0 && (
                    <span className="text-rose-500 ml-2">· {failedCount} 失败</span>
                  )}
                </span>
              </div>
              <Progress value={parseProgress} className="h-1" />
            </div>
          )}

          {/* 文件台账列表 */}
          {files.length > 0 && (
            <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
              {files.map((file) => {
                const badge = getStatusBadge(file.parse_status);
                const isUploading = file.upload_progress !== undefined && file.upload_progress < 100;
                return (
                  <div
                    key={file.id}
                    className="flex items-start gap-2.5 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50"
                  >
                    <div className="flex-shrink-0 mt-0.5">
                      <FileText
                        className={`h-4 w-4 ${getFileIcon(file.name)}`}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className="font-mono text-[10px] h-4 px-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-0"
                        >
                          {file.source_id}
                        </Badge>
                        <p className="text-xs font-medium truncate text-slate-700 dark:text-slate-300">
                          {file.name}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span className="text-[11px] text-slate-500 font-mono">
                          {formatSize(file.size)}
                        </span>
                        {file.char_count !== undefined && (
                          <span className="text-[11px] text-slate-500 font-mono">
                            {formatChars(file.char_count)} 字
                          </span>
                        )}
                        {file.chunk_count !== undefined && (
                          <span className="text-[11px] text-slate-500 font-mono">
                            {file.chunk_count} 切片
                          </span>
                        )}
                        {file.parse_method && (
                          <span className="text-[11px] text-slate-500">
                            {file.parse_method === "link_reader" ? "链接读取" : "精准OCR"}
                          </span>
                        )}
                        <Badge
                          variant={badge.variant}
                          className="text-[10px] h-4 px-1.5 font-mono"
                        >
                          {badge.label}
                        </Badge>
                      </div>
                      {isUploading && (
                        <div className="mt-1.5">
                          <Progress value={file.upload_progress} className="h-0.5" />
                        </div>
                      )}
                      {file.error_reason && (
                        <p className="text-[11px] text-rose-500 mt-1">
                          {file.error_reason}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 flex-shrink-0 text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                      onClick={() => onRemoveFile(file.id)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 来源 URL */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Link2 className="h-4 w-4 text-indigo-500" />
                在线来源
              </CardTitle>
              <CardDescription className="text-xs mt-1">
                添加公开网页或在线文档链接
              </CardDescription>
            </div>
            <Badge variant="secondary" className="font-mono text-xs">
              {sourceUrls.length} 条
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={handleUrlKeyDown}
              placeholder="https://example.com/report.pdf"
              className="text-sm h-9"
            />
            <Button onClick={handleAddUrl} size="icon" variant="secondary" className="h-9 w-9">
              <Plus className="h-4 w-4" />
            </Button>
          </div>

          {sourceUrls.length > 0 && (
            <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
              {sourceUrls.map((item) => {
                const badge = getStatusBadge(item.parse_status);
                return (
                  <div
                    key={item.id}
                    className="flex items-start gap-2 p-2 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50"
                  >
                    <Badge
                      variant="outline"
                      className="font-mono text-[10px] h-4 px-1 flex-shrink-0 mt-0.5 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-0"
                    >
                      {item.source_id}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Globe className="h-3 w-3 text-slate-400 flex-shrink-0" />
                        <span className="text-xs truncate text-slate-700 dark:text-slate-300">
                          {item.url}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Badge
                          variant={badge.variant}
                          className="text-[10px] h-3.5 px-1 font-mono"
                        >
                          {badge.label}
                        </Badge>
                        {item.char_count !== undefined && (
                          <span className="text-[10px] text-slate-500 font-mono">
                            {formatChars(item.char_count)} 字
                          </span>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 flex-shrink-0"
                      onClick={() => onRemoveSourceUrl(item.id)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 自动采集 */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Globe className="h-4 w-4 text-indigo-500" />
                自动网页采集
              </CardTitle>
              <CardDescription className="text-xs mt-1 flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                默认关闭，避免无边界搜索影响专业结论
              </CardDescription>
            </div>
            <Switch
              checked={autoCollect}
              onCheckedChange={onAutoCollectChange}
            />
          </div>
        </CardHeader>
        {autoCollect && (
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="allowed-domains" className="text-xs">
                允许采集的域名（逗号分隔，留空表示不限）
              </Label>
              <Input
                id="allowed-domains"
                value={allowedDomains}
                onChange={(e) => onAllowedDomainsChange(e.target.value)}
                placeholder="例如：gov.cn, sec.gov"
                className="text-sm font-mono h-9"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                系统将先返回候选来源清单，确认后再入库，避免污染证据链
              </p>
            </div>
          </CardContent>
        )}
      </Card>

      {/* 来源统计 */}
      {totalSources > 0 && (
        <Card className="bg-indigo-50/30 dark:bg-indigo-950/20 border-indigo-100 dark:border-indigo-900/50">
          <CardContent className="p-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-lg font-semibold text-slate-900 dark:text-slate-100 font-mono tabular-nums">
                  {totalSources}
                </div>
                <div className="text-[11px] text-slate-500">总来源</div>
              </div>
              <div>
                <div className="text-lg font-semibold text-emerald-600 dark:text-emerald-400 font-mono tabular-nums">
                  {readyCount}
                </div>
                <div className="text-[11px] text-slate-500">已就绪</div>
              </div>
              <div>
                <div className="text-lg font-semibold text-rose-500 font-mono tabular-nums">
                  {failedCount}
                </div>
                <div className="text-[11px] text-slate-500">失败</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

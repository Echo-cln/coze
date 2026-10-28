"use client";

import { TopNav } from "@/components/top-nav";
import { MaterialPanel } from "@/components/material-panel";
import { ParamsPanel } from "@/components/params-panel";
import { ReportPanel } from "@/components/report-panel";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useReportForm } from "@/hooks/use-report-form";
import { FileText, Settings2 } from "lucide-react";
import { useMediaQuery } from "@/hooks/use-media-query";

export default function Home() {
  const form = useReportForm();
  const isDesktop = useMediaQuery("(min-width: 1024px)");

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <TopNav />

      <main className="p-4 lg:p-6">
        {/* 桌面端：左右分栏，左栏材料+参数 tabs，右栏进度+报告 */}
        {isDesktop ? (
          <div className="flex gap-6 h-[calc(100vh-7rem)]">
            {/* 左侧：材料 + 参数 （Tabs 切换）*/}
            <div className="w-[420px] flex-shrink-0">
              <Tabs defaultValue="material" className="h-full flex flex-col">
                <TabsList className="grid w-full grid-cols-2 mb-4">
                  <TabsTrigger value="material" className="gap-2">
                    <FileText className="h-3.5 w-3.5" />
                    材料
                  </TabsTrigger>
                  <TabsTrigger value="params" className="gap-2">
                    <Settings2 className="h-3.5 w-3.5" />
                    参数
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="material" className="flex-1 overflow-y-auto pr-1 -mr-1 mt-0">
                  <MaterialPanel
                    files={form.files}
                    sourceUrls={form.sourceUrls}
                    autoCollect={form.autoCollect}
                    allowedDomains={form.allowedDomains}
                    parseProgress={form.parseProgress}
                    isParsing={form.isParsing}
                    onAddFiles={form.addFiles}
                    onRemoveFile={form.removeFile}
                    onAddSourceUrl={form.addSourceUrl}
                    onRemoveSourceUrl={form.removeSourceUrl}
                    onAutoCollectChange={form.setAutoCollect}
                    onAllowedDomainsChange={form.setAllowedDomains}
                  />
                </TabsContent>
                <TabsContent value="params" className="flex-1 overflow-y-auto pr-1 -mr-1 mt-0">
                  <ParamsPanel
                    industry={form.industry}
                    templateId={form.templateId}
                    decisionQuestion={form.decisionQuestion}
                    cutoffDate={form.cutoffDate}
                    audience={form.audience}
                    strictMode={form.strictMode}
                    onIndustryChange={form.setIndustry}
                    onTemplateChange={form.setTemplateId}
                    onDecisionQuestionChange={form.setDecisionQuestion}
                    onCutoffDateChange={form.setCutoffDate}
                    onAudienceChange={form.setAudience}
                    onStrictModeChange={form.setStrictMode}
                  />
                </TabsContent>
              </Tabs>
            </div>

            {/* 右侧：进度 + 报告（四页签） */}
            <div className="flex-1 min-w-0">
              <ReportPanel
                steps={form.steps}
                jobStatus={form.jobStatus}
                isParsing={form.isParsing}
                isGenerating={form.isGenerating}
                hasAnyMaterial={form.hasAnyMaterial}
                hasReadyMaterial={form.hasReadyMaterial}
                reportContent={form.reportContent}
                evidenceLedger={form.evidenceLedger}
                conflictRegister={form.conflictRegister}
                qualityMetrics={form.qualityMetrics}
                strictMode={form.strictMode}
                onStartParse={form.startParse}
                onGenerate={form.generateReport}
                onRevalidate={form.revalidate}
                onExport={form.exportAudit}
              />
            </div>
          </div>
        ) : (
          // 移动端：三 tab
          <Tabs defaultValue="material">
            <TabsList className="grid w-full grid-cols-3 mb-4">
              <TabsTrigger value="material" className="gap-1">
                <FileText className="h-3.5 w-3.5" />
                材料
              </TabsTrigger>
              <TabsTrigger value="params" className="gap-1">
                <Settings2 className="h-3.5 w-3.5" />
                参数
              </TabsTrigger>
              <TabsTrigger value="report" className="gap-1">
                报告
              </TabsTrigger>
            </TabsList>
            <TabsContent value="material">
              <MaterialPanel
                files={form.files}
                sourceUrls={form.sourceUrls}
                autoCollect={form.autoCollect}
                allowedDomains={form.allowedDomains}
                parseProgress={form.parseProgress}
                isParsing={form.isParsing}
                onAddFiles={form.addFiles}
                onRemoveFile={form.removeFile}
                onAddSourceUrl={form.addSourceUrl}
                onRemoveSourceUrl={form.removeSourceUrl}
                onAutoCollectChange={form.setAutoCollect}
                onAllowedDomainsChange={form.setAllowedDomains}
              />
            </TabsContent>
            <TabsContent value="params">
              <ParamsPanel
                industry={form.industry}
                templateId={form.templateId}
                decisionQuestion={form.decisionQuestion}
                cutoffDate={form.cutoffDate}
                audience={form.audience}
                strictMode={form.strictMode}
                onIndustryChange={form.setIndustry}
                onTemplateChange={form.setTemplateId}
                onDecisionQuestionChange={form.setDecisionQuestion}
                onCutoffDateChange={form.setCutoffDate}
                onAudienceChange={form.setAudience}
                onStrictModeChange={form.setStrictMode}
              />
            </TabsContent>
            <TabsContent value="report" className="min-h-[60vh]">
              <ReportPanel
                steps={form.steps}
                jobStatus={form.jobStatus}
                isParsing={form.isParsing}
                isGenerating={form.isGenerating}
                hasAnyMaterial={form.hasAnyMaterial}
                hasReadyMaterial={form.hasReadyMaterial}
                reportContent={form.reportContent}
                evidenceLedger={form.evidenceLedger}
                conflictRegister={form.conflictRegister}
                qualityMetrics={form.qualityMetrics}
                strictMode={form.strictMode}
                onStartParse={form.startParse}
                onGenerate={form.generateReport}
                onRevalidate={form.revalidate}
                onExport={form.exportAudit}
              />
            </TabsContent>
          </Tabs>
        )}
      </main>
    </div>
  );
}

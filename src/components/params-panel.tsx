"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Briefcase,
  FileSpreadsheet,
  HelpCircle,
  Calendar,
  Users,
  Shield,
  Building2,
  Landmark,
  Search,
} from "lucide-react";
import {
  INDUSTRY_LABELS,
  AUDIENCE_LABELS,
  TEMPLATES_BY_INDUSTRY,
} from "@/lib/types";
import type { Industry, Audience } from "@/lib/types";

interface ParamsPanelProps {
  industry: Industry;
  templateId: string;
  decisionQuestion: string;
  cutoffDate: string;
  audience: Audience;
  strictMode: boolean;
  onIndustryChange: (v: Industry) => void;
  onTemplateChange: (v: string) => void;
  onDecisionQuestionChange: (v: string) => void;
  onCutoffDateChange: (v: string) => void;
  onAudienceChange: (v: Audience) => void;
  onStrictModeChange: (v: boolean) => void;
}

const INDUSTRY_ICONS: Record<Industry, typeof Briefcase> = {
  finance: Briefcase,
  government: Landmark,
  consulting: Search,
};

const AUDIENCE_DESC: Record<Audience, string> = {
  management: "高层视角，结论优先，控制篇幅",
  analyst: "数据详尽，论证完整，引用充分",
  public: "通俗易懂，少术语，重结论",
};

export function ParamsPanel({
  industry,
  templateId,
  decisionQuestion,
  cutoffDate,
  audience,
  strictMode,
  onIndustryChange,
  onTemplateChange,
  onDecisionQuestionChange,
  onCutoffDateChange,
  onAudienceChange,
  onStrictModeChange,
}: ParamsPanelProps) {
  const templates = TEMPLATES_BY_INDUSTRY[industry];

  return (
    <div className="space-y-4">
      {/* 行业选择 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Building2 className="h-4 w-4 text-indigo-500" />
            报告行业
          </CardTitle>
          <CardDescription className="text-xs">
            选择行业将决定可用模板与分析框架
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RadioGroup
            value={industry}
            onValueChange={(v) => onIndustryChange(v as Industry)}
            className="grid grid-cols-3 gap-2"
          >
            {(Object.keys(INDUSTRY_LABELS) as Industry[]).map((ind) => {
              const Icon = INDUSTRY_ICONS[ind];
              const isActive = industry === ind;
              return (
                <Label
                  key={ind}
                  htmlFor={`industry-${ind}`}
                  className={`flex flex-col items-center justify-center gap-1.5 p-3 rounded-lg border cursor-pointer transition-all ${
                    isActive
                      ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40 ring-1 ring-indigo-500"
                      : "border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-900/50"
                  }`}
                >
                  <RadioGroupItem value={ind} id={`industry-${ind}`} className="sr-only" />
                  <Icon
                    className={`h-5 w-5 ${isActive ? "text-indigo-500" : "text-slate-400"}`}
                  />
                  <span
                    className={`text-xs font-medium ${
                      isActive ? "text-indigo-600 dark:text-indigo-400" : "text-slate-600 dark:text-slate-400"
                    }`}
                  >
                    {INDUSTRY_LABELS[ind]}
                  </span>
                </Label>
              );
            })}
          </RadioGroup>
        </CardContent>
      </Card>

      {/* 模板选择 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-indigo-500" />
            报告模板
          </CardTitle>
          <CardDescription className="text-xs">
            模板列表随行业联动切换
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RadioGroup
            value={templateId}
            onValueChange={onTemplateChange}
            className="space-y-2"
          >
            {templates.map((tpl) => {
              const isActive = templateId === tpl.id;
              return (
                <Label
                  key={tpl.id}
                  htmlFor={`tpl-${tpl.id}`}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                    isActive
                      ? "border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/30 ring-1 ring-indigo-500"
                      : "border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-900/50"
                  }`}
                >
                  <RadioGroupItem
                    value={tpl.id}
                    id={`tpl-${tpl.id}`}
                    className="mt-0.5 sr-only"
                  />
                  <div
                    className={`mt-0.5 h-4 w-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                      isActive
                        ? "border-indigo-500"
                        : "border-slate-300 dark:border-slate-600"
                    }`}
                  >
                    {isActive && (
                      <div className="h-2 w-2 rounded-full bg-indigo-500" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p
                      className={`text-sm font-medium ${
                        isActive
                          ? "text-indigo-600 dark:text-indigo-400"
                          : "text-slate-800 dark:text-slate-200"
                      }`}
                    >
                      {tpl.name}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {tpl.description}
                    </p>
                  </div>
                </Label>
              );
            })}
          </RadioGroup>
        </CardContent>
      </Card>

      {/* 核心问题 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <HelpCircle className="h-4 w-4 text-indigo-500" />
            核心问题
          </CardTitle>
          <CardDescription className="text-xs">
            本次报告需要回答的核心决策问题
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            value={decisionQuestion}
            onChange={(e) => onDecisionQuestionChange(e.target.value)}
            placeholder="例如：当前行业格局下，头部公司未来三年的增长驱动力是什么？"
            className="min-h-[80px] resize-none text-sm"
          />
        </CardContent>
      </Card>

      {/* 截止日期 & 受众 */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Calendar className="h-4 w-4 text-indigo-500" />
              资料截止日
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Input
              type="date"
              value={cutoffDate}
              onChange={(e) => onCutoffDateChange(e.target.value)}
              className="text-sm"
            />
            <p className="text-xs text-slate-500 mt-2">
              仅使用该日期前发布的资料
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Users className="h-4 w-4 text-indigo-500" />
              目标受众
            </CardTitle>
          </CardHeader>
          <CardContent>
            <RadioGroup
              value={audience}
              onValueChange={(v) => onAudienceChange(v as Audience)}
              className="space-y-1.5"
            >
              {(Object.keys(AUDIENCE_LABELS) as Audience[]).map((a) => (
                <div key={a} className="flex items-center space-x-2">
                  <RadioGroupItem value={a} id={`aud-${a}`} />
                  <Label htmlFor={`aud-${a}`} className="text-xs font-normal cursor-pointer">
                    {AUDIENCE_LABELS[a]}
                  </Label>
                </div>
              ))}
            </RadioGroup>
            <p className="text-xs text-slate-500 mt-2 border-t border-slate-100 dark:border-slate-800 pt-2">
              {AUDIENCE_DESC[audience]}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* 严格模式 */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Shield className="h-4 w-4 text-indigo-500" />
                严格模式
              </CardTitle>
              <CardDescription className="text-xs mt-1">
                存在高风险冲突或无效引用时阻止发布
              </CardDescription>
            </div>
            <Switch checked={strictMode} onCheckedChange={onStrictModeChange} />
          </div>
        </CardHeader>
      </Card>
    </div>
  );
}

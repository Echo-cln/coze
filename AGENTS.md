# 智能报告工作台 AGENTS.md

## 项目概览

专业级智能报告生成工作台，面向金融投研、政务汇报、咨询调研三大场景。用户通过"材料—参数—进度—报告"四象限工作台完成从资料上传到报告产出的全流程。

## 版本技术栈

- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5
- **UI 组件**: shadcn/ui (基于 Radix UI)
- **Styling**: Tailwind CSS 4

## 目录结构

```
├── public/                    # 静态资源
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   └── report/
│   │   │       ├── parse/route.ts      # 阶段一：材料解析 API（SSE）
│   │   │       ├── generate/route.ts   # 阶段二：生成报告 API（SSE）
│   │   │       └── audit-pack/route.ts # 审计包导出 API
│   │   ├── layout.tsx                  # 根布局
│   │   ├── page.tsx                    # 工作台首页（主入口）
│   │   └── robots.ts
│   ├── components/
│   │   ├── ui/                # shadcn/ui 组件库
│   │   ├── top-nav.tsx        # 顶部导航栏
│   │   ├── material-panel.tsx # 材料上传区组件
│   │   ├── params-panel.tsx   # 参数配置区组件
│   │   └── report-panel.tsx   # 进度与报告区（四页签）
│   ├── hooks/
│   │   ├── use-report-form.ts # 表单与工作流状态管理
│   │   └── use-media-query.ts # 响应式媒体查询
│   └── lib/
│       ├── types.ts           # 类型定义与常量
│       ├── coze-client.ts     # Coze 平台工作流 API 客户端（备用）
│       ├── storage.ts         # S3 对象存储工具（文件上传 + 签名URL）
│       └── utils.ts           # 通用工具函数
├── .env.example               # 环境变量示例（含 Coze/WF10/存储配置）
├── DESIGN.md                  # 设计规范
├── AGENTS.md                  # 本文档
├── next.config.ts
├── package.json
└── tsconfig.json
```

## 工作流对接架构

### 支持三种接入方式

1. **独立部署的 WF10 + C 模块 + WF60**（当前主链路，推荐）
   - WF10（材料解析）：`WF10_BASE_URL` + `WF10_API_TOKEN`
   - C 模块（证据抽取 + 冲突检测）：`C_MODULE_BASE_URL` + `C_MODULE_API_TOKEN`
   - WF60（专业渲染四页签）：`WF60_BASE_URL` + `WF60_API_TOKEN`
   - 支持 parsed_chunks 直通（WF10 → C 模块 → WF60），避免重复解析
   - 三个数据入口：files / parsed_chunks / kb_query

2. **细粒度子工作流串联**（WF40 + WF50 + WF60）
   - WF40（大纲写作）：`WF40_BASE_URL`
   - WF50（引用 QA 闸门）：`WF50_BASE_URL`
   - WF60（专业渲染四页签）：`WF60_BASE_URL`

3. **Coze 平台工作流**（备用，WF00 主编排）
   - 通过 `COZE_WORKLOAD_API_TOKEN` + `COZE_WORKFLOW_ID` 配置
   - 使用 `src/lib/coze-client.ts` 封装 OpenAPI 调用

### 对接架构图

```
用户操作
  ↓
useReportForm Hook（前端状态管理 + SSE 消费）
  ↓
/api/report/parse       → WF10（阶段一：材料解析，SSE 流式）
/api/report/generate    → C 模块（阶段二：证据抽取 + 冲突检测）
                         → WF60（阶段三：专业四页签渲染）
/api/report/audit-pack  → 导出审计包
  ↓
文件先上传到 S3 对象存储（src/lib/storage.ts）获得签名 URL
  ↓
工作流 /stream_run（SSE 流式）→ SSE 翻译层 → 前端事件协议
```

### Coze 标准 SSE 格式

所有独立部署工作流（WF10/C模块/WF60）均使用 Coze 标准 SSE 格式：
- 事件名统一为 `message`
- data 中通过 `type` 字段区分：`workflow_start` / `workflow_end`
- `workflow_end` 事件中包含完整 `output` 对象

后端 API 负责将其翻译为前端约定的事件协议（progress / source / evidence / conflict / content / metrics / done / error）。

### WF10 对接细节

- **请求格式**：同时支持 `multipart/form-data`（含文件）和 `application/json`（纯 URL）
- **文件处理**：前端上传文件 → 后端转存 S3 → 生成签名 URL → 放入 `files[].url`
- **鉴权**：Bearer Token（`WF10_API_TOKEN`）
- **流式事件翻译**：WF10 的 Coze 标准 SSE 被翻译为前端约定的 `source / done / error` 事件

### C 模块 + WF60 对接细节

- **C 模块**：证据抽取 + 冲突检测，输出 `evidence_ledger` / `conflict_register` / `stats`
  - 支持三种数据入口：`files`（原始文件）/ `parsed_chunks`（WF10 直通切片）/ `kb_query`（知识库 RAG 检索）
  - RAG 参数：`kb_backend`（local/coze_openapi/auto）、`kb_top_k`、`kb_dataset_ids` 等
- **WF60**：专业四页签渲染，输入证据+冲突+质量指标，输出 `report_markdown` + 四页签视图 + PDF/DOCX 导出
- **鉴权**：各自独立 Bearer Token
- **降级策略**：WF60 不可用时降级为仅展示 C 模块结果

### 环境变量配置

1. 复制 `.env.example` 为 `.env.local`
2. 材料解析：`WF10_BASE_URL` + `WF10_API_TOKEN`
3. 证据与冲突：`C_MODULE_BASE_URL` + `C_MODULE_API_TOKEN`
4. 专业渲染：`WF60_BASE_URL` + `WF60_API_TOKEN`
5. 对象存储（文件上传）：`COZE_BUCKET_*` 系列变量
6. Coze 平台工作流（备用）：`COZE_WORKLOAD_API_TOKEN` + `COZE_WORKFLOW_ID`

### 降级模式

当未配置对应工作流地址时，API 自动返回模拟 SSE 事件流，用于本地开发和界面演示。
文件上传功能在无对象存储时会跳过（仅 URL 来源可用），不影响前端交互演示。

### SSE 事件协议

| 事件名 | 说明 | 数据 |
|--------|------|------|
| `progress` | 步骤推进 | `{ step, label, status }` |
| `source` | 来源解析完成 | `SourceRegistry` |
| `evidence` | 证据抽取 | `EvidenceItem` |
| `conflict` | 冲突检测结果 | `ConflictItem` |
| `content` | 报告正文增量 | `{ text, delta }` |
| `metrics` | 质量指标 | `QualityMetrics` |
| `done` | 生成完成 | 完整输出对象 |
| `error` | 错误 | `{ message }` |

真实工作流（WF00）的输出事件应遵循上述协议，前端即可直接消费。

## 功能模块

### 材料区 (MaterialPanel)
- **多文件上传**：支持拖拽/点击上传，PDF/Word/Excel/PPT/TXT/MD
- **上传进度**：实时进度条 + 状态徽章
- **在线来源 URL**：可重复添加/删除网页链接
- **自动网页采集**：开关控制 + 域名白名单（默认关闭）

### 参数区 (ParamsPanel)
- **行业选择**：金融投研 / 政务汇报 / 咨询调研（三列单选卡片）
- **报告模板**：随行业联动切换，4个模板/行业
- **核心问题**：多行文本域输入
- **资料截止日**：日期选择器
- **目标受众**：管理层 / 专业分析师 / 公众（附文案说明）
- **严格模式**：开关，默认开启

### 进度与报告区 (ReportPanel)
- **操作按钮组**：开始解析 / 重新校验 / 导出审计包
- **步骤进度条**：5步工作流（解析→校验→大纲→撰写→审计）
- **审计发现**：风险分级展示（高/中/低）
- **报告预览**：Markdown 渲染，可滚动查看

### 状态管理 (useReportForm)
集中管理所有表单状态、工作流进度、模拟业务逻辑（上传进度动画、报告生成流程）。

## 数据契约（与 Coze 工作流对应）

### 阶段一：材料解析（/api/report/parse）

| 字段 | 类型 | 说明 |
|------|------|------|
| `files` | `Array<File>` | 上传的文件列表（multipart 模式） |
| `source_urls` | `string[]` | 在线来源 URL 列表 |
| `auto_collect` | `boolean` | 是否开启自动网页采集 |
| `allowed_domains` | `string` | 允许采集的域名（逗号分隔） |
| `cutoff_date` | `string` | 资料截止日期（YYYY-MM-DD） |
| `job_id` | `string` | 任务 ID（可选） |

### 阶段二：报告生成（/api/report/generate）

| 字段 | 类型 | 说明 |
|------|------|------|
| `parsed_chunks` | `Array<ParsedChunk>` | WF10 解析好的切片（入口 A：直通） |
| `files` | `Array<File>` | 原始文件（入口 B：现场切片） |
| `kb_query` | `string` | 知识库检索词（入口 C：RAG） |
| `kb_backend` | `string` | RAG 后端：local / coze_openapi / auto |
| `kb_top_k` | `number` | 知识库检索返回条数上限 |
| `industry` | `string` | 行业类型：finance / government / consulting |
| `template_id` | `string` | 报告模板 ID |
| `decision_question` | `string` | 核心决策问题 |
| `cutoff_date` | `string` | 资料截止日期（YYYY-MM-DD） |
| `audience` | `string` | 目标受众：management / analyst / public |
| `strict_mode` | `boolean` | 是否开启严格模式 |
| `job_id` | `string` | 任务 ID（可选） |

## 设计规范

详见 `DESIGN.md`。核心原则：专业、严谨、高信息密度，深色调工作台风格。

## 开发命令

- 安装依赖：`pnpm install`
- 开发模式：`pnpm dev`（端口 5000）
- 类型检查：`pnpm ts-check`
- 代码检查：`pnpm lint`
- 生产构建：`pnpm build`

## 编码规范

- TypeScript strict 模式
- 优先使用 shadcn/ui 组件
- 客户端组件标注 `"use client"`
- 动态数据使用 useEffect + useState，避免 hydration 问题

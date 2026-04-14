# Super Agent Release Notes

**版本：v1.2.0**
**发布日期：2026-04-12**
**开发周期：2026-01-08 ~ 2026-04-12**

---

Super Agent 是一个企业级多智能体平台，帮助企业将业务知识沉淀为标准化 SOP，再从 SOP 中孵化出能自主执行任务的虚拟员工（AI Agent）。本次发布为项目首个完整版本，涵盖从平台初始化到 AgentCore 云端部署的全部核心能力。

---

## 🏗️ 平台基础架构

- 基于 React 19 + Vite + TypeScript + Tailwind CSS 初始化前端工程 `2026-01-08`
- 集成 Supabase 后端，支持多租户架构 `2026-01-11`
- 完整架构文档 `2026-01-12`
- 统一 ECS 后端规范文档 `2026-01-12`
- 基于 Fastify + Prisma ORM + PostgreSQL + Redis (BullMQ) 初始化完整后端 `2026-01-19`
- 从 Supabase 迁移至自建 REST API 后端架构 `2026-01-19`
- Markdown 渲染集成 react-markdown + remark-gfm `2026-02-08`
- Dashboard 视图整合，新增工作区文件写入 `2026-02-12`
- 文件上传、Skills 面板与工作区增强 `2026-02-12`
- 代码文件查看器支持语法高亮 `2026-02-13`
- Light / Dark / System 三种主题模式 `2026-02-19`
- 工作区二进制文件写入支持 `2026-04-07`
- 前端 Flex 容器溢出修复 `2026-04-08`
- 无限分页支持（limit=0） `2026-04-08`

---

## 🔐 认证体系

- 从 JWT 迁移至 AWS Cognito 托管认证 `2026-02-13`
- 本地 JWT 认证，支持邮件邀请和密码管理 `2026-03-05`
- 本地 JWT Token 与 Cognito 双模式并行支持 `2026-03-05`

---

## ☁️ 基础设施 (Infra)

- SuperAgentV2Stack CDK 基础设施，EC2 安全加固部署 `2026-02-24`
- CDK 构建产物 gitignore 更新 `2026-02-28`
- 迁移至独立 SuperAgentV2 部署，完整资源自动化供给 `2026-02-28`
- CDK context 与部署配置更新（新 AWS 账户） `2026-02-28`
- EC2 实例规格优化与数据库配置调优 `2026-02-28`
- CloudFront CDN 分发集成、工作区同步分析与 SOP 文件管理 `2026-03-27`
- 部署脚本优化：本地 tsc 编译（避免 EC2 OOM）、S3 + CloudFront 前端部署参数、Seed 幂等性保护 `2026-04-08`
- .env 合并逻辑重构与数据库 URL 解析修复 `2026-04-08`
- Avatar 服务懒加载初始化，修复 ESM 模块加载顺序导致的 S3 配置丢失 `2026-04-08`
- AgentCore deploy-full.sh 和 README 补全 `WORKSPACE_S3_REGION` 环境变量，修复 update-agent-runtime 时环境变量被清空的问题 `2026-04-12`
- AgentCore 执行角色补全 Browser Tool 和 Code Interpreter IAM 权限 `2026-04-12`

---

## 🧠 Business Scope（业务域）

- AI 驱动的 Business Scope 创建与 Agent 自动生成 `2026-01-12`
- 工作流 Schema 增强与业务域集成 `2026-01-25`
- 业务域 UX 重设计文档 `2026-02-09`
- AI Scope 生成器与 Skill Workshop 功能 `2026-02-10`
- AI 驱动的自然语言业务域生成 `2026-02-11`
- 技能创建集成至 Scope 生成器（Chat UI） `2026-02-12`
- Scope 插件系统与 Agent 事件追踪 `2026-02-13`
- Scope 插件系统与技能元数据支持 `2026-02-13`
- Scope 插件冲突解决与 Agent 技能选择优化 `2026-02-13`
- Scope 级访问控制与成员管理 `2026-02-19`
- Business Scope 软删除支持 `2026-03-04`
- Scope 级 MCP 服务器配置与目录面板 `2026-03-27`
- Scope 模型统一化 `2026-04-01`
- Scope 过滤的 Skills API `2026-04-01`

---

## 🤖 Agent 管理

- Avatar 生成服务与 AWS 集成 `2026-01-19`
- Avatar 批量生成与检索优化 `2026-01-19`
- Agent Schema 增强与 AI 工具生成 `2026-01-19`
- Agent 状态实时轮询追踪 `2026-02-11`
- Agent 分页加载 `2026-02-11`
- Poker Table 游戏化 Agent 可视化面板 `2026-02-11`
- Virtual Office 与 Command Center 组件 `2026-02-11`
- Agent 活动指标追踪与 MCP 服务器 Scoping `2026-02-13`
- 陈旧 Agent 自动恢复机制（移除 idle 状态） `2026-02-13`
- Sub-Agent 发言者身份追踪与头像解析 `2026-02-18`
- 灵活的 Agent 创建流程，支持多 Scope 关联 `2026-03-18`
- Chat Room、Digital Twin 向导与项目管理基础 `2026-03-19`
- Digital Twin Scope 渲染与筛选 `2026-03-22`
- Digital Twin 向导集中化 Token 管理 `2026-03-22`
- 可插拔 Agent 运行时抽象，支持多后端切换 `2026-03-16`

---

## 🧬 Agent 自主进化

- 蒸馏（Distillation）、排练（Rehearsal）与记忆驱动提案 `2026-04-01`
- 提案审批工作流与记忆自动蒸馏 `2026-04-08`
- Scope Memory 文件系统化：记忆从 CLAUDE.md 内联改为 `memories/` 目录按需加载，避免上下文膨胀 `2026-04-12`
- Pinned 记忆内联到 CLAUDE.md，agent 无需读文件即可获取关键身份信息和用户偏好 `2026-04-12`
- Distillation 服务重构：从 fire-and-forget 升级为 BullMQ 可靠队列，去除 5 分钟冷却期 `2026-04-12`
- Redis 游标追踪防止重复蒸馏，jobId 去重防止同分钟内重复入队 `2026-04-12`
- 蒸馏模型从 Nova Lite 切换至 Claude Haiku，显著提升中文对话记忆提取质量 `2026-04-12`
- 蒸馏 System Prompt 优化：明确用户偏好（身份、饮食、习惯）为高价值提取目标 `2026-04-12`

---

## 💬 Chat 对话系统

- Claude Agent SDK 集成 Skills、Webhooks 和定时调度 `2026-02-08`
- 会话管理设计文档 `2026-02-08`
- 会话管理与工作区资源管理器 `2026-02-08`
- Claude Agent SDK 执行与 Skill 支持 `2026-02-10`
- 会话历史面板与空闲超时 `2026-02-11`
- 快速问题生成（LLM 上下文） `2026-02-11`
- Nova 2 Lite 集成与错误处理 `2026-02-11`
- 会话状态追踪与流管理 `2026-02-12`
- 会话流持久化 `2026-02-12`
- Chat Room 统一架构设计文档 `2026-03-18`
- Starred Sessions（收藏会话） `2026-04-01`
- SSE 流式 Chat 响应与消息持久化 `2026-04-03`
- Group Chat 成员角色简化与 Claude 运行时集成 `2026-04-03`
- AI 消息持久化失败的错误日志改进 `2026-04-08`

---

## 🔗 Workflow 工作流引擎

### 可视化编辑器
- 拖拽式 DAG 画布编辑器（节点式 UI） `2026-01-25`
- 画布同步与节点自动保存 `2026-01-25`
- 工作流删除确认弹窗 `2026-01-29`
- Handle 映射支持 `2026-03-05`
- Handle 感知的边创建与连接验证增强 `2026-03-05`
- 工作流列表折叠 `2026-03-05`

### AI Copilot
- AI 驱动的工作流生成与修补 `2026-01-29`
- SSE 流式传输 AI 工作流生成与修补 `2026-02-10`
- 业务域上下文集成至工作流生成 `2026-02-11`

### 执行引擎
- 基于 BullMQ 的真实工作流执行引擎 `2026-01-29`
- API Spec 解析与统一工作流执行 v2 `2026-02-11`
- 节点级逐步执行编排器 `2026-02-13`
- 异步检查点设计与工作区持久化 `2026-03-04`
- 执行检查点与 Business Scope 软删除 `2026-03-04`
- 执行详情弹窗与节点级状态追踪 `2026-03-04`
- 运行工作流弹窗与执行规划优化 `2026-03-05`
- 标准化节点执行状态值 `2026-03-05`
- Claude Agent 执行提示词优化与重执行处理 `2026-03-05`
- Mission Brief 生成优化（提示词清晰度与安全性） `2026-03-05`
- Claude Agent 直接 Mission Brief 消息执行 `2026-03-06`
- Skill Gap 检测与执行安全防护 `2026-03-06`

---

## 🧩 Skills 技能系统

- 技能市场浏览器，支持归档 `2026-02-09`
- 技能整合与工作区配置更新 `2026-02-10`
- 市场安装技能的本地路径支持 `2026-02-10`
- 技能内容编辑与持久化存储 `2026-02-10`
- 技能市场集成与会话流持久化 `2026-02-12`
- 企业技能市场与收藏功能 `2026-02-12`
- 企业技能与已发布应用市场 `2026-02-12`
- 技能描述处理优化与插件清理 `2026-02-13`
- 从多来源改进技能提取 `2026-02-13`
- 内存缓存与请求去重优化 `2026-02-13`
- 技能删除功能 `2026-02-13`
- Workshop 技能整合与 MCP 工作流进度追踪 `2026-02-18`
- 技能整合重构，持久化工作区技能 `2026-02-18`
- 两步发布确认与企业技能目录 `2026-03-23`
- AgentCore 技能文件同步至市场安装 `2026-04-02`

---

## 🔌 MCP 集成

- MCP 服务器配置支持（Schema 更新） `2026-02-13`
- Scope 级 MCP 服务器管理与测试改进 `2026-02-13`
- Session 级 MCP 服务器管理端点 `2026-02-13`
- MCP 市场 URL 指向具体服务器文档 `2026-02-13`
- 可搜索的 MCP 服务器目录与筛选 `2026-02-13`
- 多租户隔离与用户友好安装设计文档 `2026-02-13`
- Scope 级 MCP 服务器配置与目录面板 `2026-03-27`

---

## 📚 Knowledge 知识库 (RAG)

- 文档组管理，支持 Multipart 上传 `2026-03-04`
- 工作区同步分析与 SOP 文件管理 `2026-03-27`
- RAG Pipeline 集成 `2026-04-01`
- 文档组同步与 RAG Skill 自动生成 `2026-04-08`

---

## 📱 应用市场

- 已发布应用市场与开发服务器管理 `2026-02-12`
- Sub-path 部署支持与 API 驱动的应用发布 `2026-02-12`
- 应用预览功能与工作区集成 `2026-02-12`
- 截图预览选项文档 `2026-02-12`
- 应用数据管理、定时执行日志与可发布服务策略 `2026-02-18`

---

## 💼 项目管理

- Chat Room、Digital Twin 向导与项目管理基础框架 `2026-03-19`
- 看板（Kanban）面板与 Digital Twin 集成 `2026-03-22`

---

## 📡 IM 渠道接入

- Slack 适配器与 AWS CDK 基础设施 `2026-02-14`
- Scope Memory 系统与多渠道 IM 适配器 `2026-02-14`
- 多平台 IM 适配器重构：Discord Gateway WebSocket、钉钉 Stream 模式、飞书 WSClient 长连接 `2026-04-08`
- BullMQ 异步消息队列，解耦 Webhook/Gateway 消息接收与 Agent 处理 `2026-04-08`
- WhatsApp Cloud API 适配器（Meta Graph API），支持 HMAC-SHA256 签名验证 `2026-04-08`
- Slack 适配器增强：thread_ts 线程回复、subtype 过滤 `2026-04-08`
- Telegram 适配器优化：移除不安全的 parse_mode，改进消息分割 `2026-04-08`
- 飞书适配器修复：token 缓存 bug、业务错误码检查、Lark 国际版域名支持 `2026-04-08`
- 前端 IM Channels 管理面板更新：WhatsApp 配置表单、钉钉 Stream 模式字段、Gateway 模式说明 `2026-04-08`
- 飞书端到端集成测试通过（WSClient → BullMQ → Agent → REST API 回复） `2026-04-08`

---

## 📊 Scope Briefing 智能简报

- AI 驱动的业务域简报生成系统 `2026-02-18`

---

## 🏢 组织管理

- 组织设置与成员管理 `2026-02-18`
- 登出功能与 UI 优化 `2026-03-09`
- 用户组 RBAC 权限控制（Skills 与 MCP 服务器） `2026-04-08`

---

## ☁️ AgentCore 云端运行时

- AgentCore Runtime 迁移技术规范文档 `2026-02-28`
- AgentCore 运行时容器，集成 Claude Agent SDK `2026-03-03`
- AWS Bedrock AgentCore 集成与 S3 工作区同步 `2026-03-18`
- 实时文件监听器与防抖 S3 同步 `2026-03-18`
- 简化工作区同步为单一 S3 目录模型 `2026-03-18`
- AgentCore 直接调用研究与运行时命令指南 `2026-04-02`
- 文件监听器替换为 SDK Hooks 方案 `2026-04-02`
- Agent Network UI 与 S3 Region 配置更新 `2026-04-02`

---

## 🔧 Webhook 与调度

- Claude Agent SDK 集成 Skills、Webhooks 和定时调度 `2026-02-08`
- 公开状态查询端点与 Webhook 服务改进 `2026-03-18`
- Webhook 执行日志与调用历史 UI `2026-04-08`
- 触发类型追踪与 Schema 漂移修复 `2026-04-08`
- Avatar Presigned URL 端点与定时执行处理改进 `2026-04-08`

---

## Tech Stack

| 层级 | 技术栈 |
| --- | --- |
| Backend | Fastify, TypeScript, Prisma ORM, PostgreSQL, Redis (BullMQ) |
| Frontend | React 19, Vite, TypeScript, Tailwind CSS, React Router, XY Flow |
| AI | Amazon Bedrock (Claude), Claude Agent SDK, Langfuse |
| Storage | AWS S3 |
| Auth | AWS Cognito |
| Infra | AWS CDK (EC2, Aurora Serverless v2, S3, Cognito, CloudFront, CloudWatch) |
| Runtime | AWS Bedrock AgentCore |

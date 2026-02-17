# Super Agent

**让企业的每一个业务流程都拥有自己的 AI 员工。**

Super Agent 是一个企业级多智能体平台，帮助企业将业务知识沉淀为标准化 SOP，再从 SOP 中孵化出能自主执行任务的虚拟员工（AI Agent）。通过可视化工作流将多个智能体串联协作，企业可以像搭积木一样构建自动化业务流程——无需写代码，无需改造现有系统。

---

## 产品定位

传统的 RPA 和自动化工具只能处理结构化、规则明确的任务。Super Agent 不同——它让 AI 理解你的业务语境，在模糊指令下也能做出合理判断，真正像一个"懂业务的员工"一样工作。

Super Agent 的核心理念：

> **定义业务 → 创造智能体 → 固化工作流 → 持续进化**

企业通过 Business Scope 划分业务领域（销售、HR、IT 运维等），在每个领域内定义专属的知识库、SOP 和工具集，然后创建具备这些能力的 AI Agent。多个 Agent 通过 Workflow 协同工作，形成可复用、可监控、可迭代的智能业务流水线。

---

## 核心价值

### 🧠 从经验到资产：业务知识不再流失
企业最宝贵的资产是沉淀在老员工脑中的业务经验。Super Agent 通过 Business Scope + Knowledge 体系，将散落的经验文档、SOP、最佳实践转化为 AI 可理解的结构化知识，让每一个新创建的智能体都站在"老员工"的肩膀上。

### 🤖 从 SOP 到虚拟员工：一键孵化 AI 团队
定义好业务范围和标准流程后，Super Agent 可以快速生成具备专业能力的 AI Agent。每个 Agent 拥有独立的角色定义、技能包和工具权限，就像招聘了一个已经培训好的专业员工。

### 🔗 从单兵到协作：工作流串联多智能体
单个 Agent 能力有限，但通过可视化 Workflow Editor，你可以将多个 Agent 编排成完整的业务流程。支持定时触发、Webhook 触发、条件分支，让复杂的跨部门协作自动运转。

### 🧩 从封闭到开放：Skills + MCP 无限扩展
通过 Skills 市场和 MCP（Model Context Protocol）集成，Agent 的能力边界不断扩大。连接 Salesforce、Jira、Slack、企业微信等 40+ 外部系统，让智能体真正融入企业现有工具链。

### 💬 从工具到产品：Chat 即 Mini-SaaS
每个 Agent 都可以通过 Chat 界面直接对话交互，更进一步，你可以将 Agent 能力封装为内部应用，发布到企业应用市场，让非技术人员也能一键使用 AI 能力——Chat 本身就是一个 Mini-SaaS 构建器。

---

## 功能概览

### 核心功能

| 功能 | 说明 |
| --- | --- |
| **Business Scope** | 按业务领域划分独立的智能体运行环境，隔离知识、技能、工具和权限 |
| **Agent 管理** | 创建和配置 AI 智能体，定义角色、系统提示词、模型参数和技能组合 |
| **Chat 对话** | 实时对话界面，支持流式输出、会话恢复、工作区自动配置 |
| **Workflow 编辑器** | 可视化 DAG 工作流构建，支持定时/Webhook 触发、执行历史追溯 |

### 能力扩展

| 功能 | 说明 |
| --- | --- |
| **Skills 市场** | 可复用的技能包，支持版本管理、去重、发布和跨组织共享 |
| **MCP 集成** | 40+ 外部工具连接器，通过 Model Context Protocol 标准化接入 |
| **Knowledge 知识库** | 基于 RAG 的文档管理，为每个 Scope 提供专属知识检索能力 |
| **IM 渠道接入** | Slack、Discord、Telegram、钉钉、飞书等多渠道消息集成 |

### 企业级特性

| 功能 | 说明 |
| --- | --- |
| **应用市场** | 将 Agent 能力封装为内部应用，发布、评分、一键运行 |
| **多租户** | 组织级隔离，角色权限管理，按计划分级 |
| **开发者工具** | API Key、Webhook、OpenAPI 导入、任务审计日志 |
| **Briefing 智能简报** | 定时生成业务范围简报，自动汇总关键信息 |

---

## Tech Stack

| Layer          | Technology                                                        |
| -------------- | ----------------------------------------------------------------- |
| Backend        | Fastify, TypeScript, Prisma ORM, PostgreSQL, Redis (BullMQ)      |
| Frontend       | React 19, Vite, TypeScript, Tailwind CSS, React Router, XY Flow  |
| AI             | Amazon Bedrock (Claude), Claude Agent SDK, Langfuse observability |
| Storage        | AWS S3 (documents, avatars, skills)                               |
| Auth           | AWS Cognito                                                       |
| Infrastructure | AWS CDK (EC2, Aurora Serverless v2, S3, Cognito, CloudWatch)      |
| Containerization | Docker, Docker Compose                                          |

## Project Structure

```
├── backend/                 # Fastify API server
│   ├── prisma/              # Database schema & migrations
│   └── src/
│       ├── config/          # App configuration
│       ├── middleware/       # Auth, logging, error handling
│       ├── repositories/    # Data access layer
│       ├── routes/          # API route handlers
│       ├── schemas/         # Zod validation schemas
│       ├── services/        # Business logic
│       ├── setup/           # App bootstrapping (queues, events)
│       ├── types/           # TypeScript type definitions
│       ├── utils/           # Shared utilities
│       └── websocket/       # WebSocket gateway
├── frontend/                # React SPA
│   └── src/
│       ├── components/      # Reusable UI components
│       ├── data/            # Static data & catalogs
│       ├── hooks/           # Custom React hooks
│       ├── i18n/            # Internationalization
│       ├── lib/             # Library wrappers
│       ├── pages/           # Route-level page components
│       ├── services/        # API clients & auth context
│       ├── types/           # TypeScript type definitions
│       └── utils/           # Shared utilities
├── infra/                   # AWS CDK infrastructure
│   ├── bin/                 # CDK app entry point
│   ├── lib/                 # Stack definitions
│   └── scripts/             # Deployment scripts
└── docs/                    # Architecture & design documents
```

## Prerequisites

- Node.js >= 18
- Docker & Docker Compose
- AWS account with Bedrock access (Claude models)
- PostgreSQL 15+ (or use Docker Compose)
- Redis 7+ (or use Docker Compose)

## Getting Started

### 1. Clone the repository

```bash
git clone <repository-url>
cd super-agent-platform
```

### 2. Backend Setup

```bash
cd backend
cp .env.example .env
# Edit .env with your configuration (see Environment Variables below)
npm install
npx prisma generate
npx prisma migrate dev
npm run dev
```

The backend runs on `http://localhost:3000` by default.

### 3. Frontend Setup

```bash
cd frontend
cp .env.example .env
# Edit .env with your configuration
npm install
npm run dev
```

The frontend runs on `http://localhost:5173` by default.

### 4. Using Docker Compose (recommended for local dev)

This spins up PostgreSQL, Redis, LocalStack (S3 mock), runs migrations, and starts the backend:

```bash
cd backend
docker compose up -d
```

Then start the frontend separately:

```bash
cd frontend
npm install
npm run dev
```

## License

AGPL-3

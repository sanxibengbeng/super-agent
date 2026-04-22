# Super Agent 功能优化路线图

本文档记录待优化的功能点和技术改进思路。

---

## 调度系统优化 ✅ 已完成

### 实现方案

定时任务已迁移到 BullMQ Repeatable Jobs：

```
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│  Backend 1       │      │  Backend 2       │      │  Backend N       │
│  (Worker)        │      │  (Worker)        │      │  (Worker)        │
└────────┬─────────┘      └────────┬─────────┘      └────────┬─────────┘
         │                         │                         │
         └─────────────────────────┼─────────────────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │           Redis              │
                    │  ┌────────────────────────┐  │
                    │  │ ZSET: delayed jobs     │  │  ← BullMQ 原子调度
                    │  │ LIST: active jobs      │  │  ← 带锁执行
                    │  │ Repeatable job config  │  │  ← cron 配置
                    │  └────────────────────────┘  │
                    └──────────────────────────────┘
```

**文件位置：**
- `backend/src/services/schedule-queue.service.ts` — BullMQ 队列服务
- `backend/src/services/schedule.service.ts` — 调度业务逻辑
- `backend/src/setup/schedule-processor.ts` — 启动入口

**特性：**
| 特性 | 说明 |
|------|------|
| 多实例安全 | Redis Lua 脚本原子取任务 |
| 故障恢复 | Stalled job 检测 + 自动重试 |
| 精确调度 | 毫秒级精度，支持时区 |
| 持久化 | Redis 持久化 + 启动时从 DB 同步 |

**配置：**
```typescript
{
  lockDuration: 60000,      // 60 秒锁
  stalledInterval: 30000,   // 30 秒检查 stalled
  maxStalledCount: 2,       // 最多重试 2 次
  attempts: 3,              // 总共尝试 3 次
}
```

---

## Workflow 执行复用 Chat Session（进行中）

### 问题

1. 定时任务执行不创建 `workflow_executions` 记录 → UI 看不到执行历史 ✅ 已修复
2. 定时任务不传递 workflow 变量默认值 → agent 拿不到 `@{var:xxx}` ✅ 已修复
3. Workflow 执行不创建 `chat_session` → 无法与执行结果继续对话

### 改造方案

核心思路：让 workflow executor 创建真实 `chat_session`，复用 agentcore session 路由和消息持久化。

```
Schedule/Manual Trigger
        │
        ▼
workflow-executor-v2.executeSegment()
        │
        ├── 1. 创建 chat_session (source='workflow')
        ├── 2. 传 sessionId 给 agentcore runConversation
        ├── 3. 捕获 agentcore session_id → 存入 claude_session_id
        ├── 4. assistant 输出写入 chat_messages
        └── 5. 存 chat_session_id 到 workflow_executions
                │
                ▼
        用户点击"继续对话" → 打开对应 chat_session → 自动恢复上下文
```

### 数据模型变更

- `workflow_executions` 新增 `chat_session_id` 列（nullable UUID, FK → chat_sessions）
- `chat_sessions` 新增 `source` 字段区分来源：`'user'`（默认）/ `'workflow'`

### UI 展示策略

- Chat 列表过滤掉 `source='workflow'` 的 session，避免与用户对话混淆
- Workflow Execution History 展示 `chat_session_id`，提供"继续对话"按钮
- 点击后跳转 `/chat?session={chat_session_id}`，自动加载历史消息

### 修改文件

| 文件 | 变更 |
|------|------|
| `prisma/schema.prisma` | `workflow_executions` 加 `chat_session_id`；`chat_sessions` 加 `source` |
| `services/workflow-executor-v2.ts` | `executeSegment()` 创建 chat session，传 sessionId，持久化消息 |
| `services/schedule.service.ts` | 传 `workflowId` 到 executor ✅；存 `chat_session_id` 到 record |
| `routes/workflows.routes.ts` | execution 详情返回 `chatSessionId` |
| 前端 execution history | 加"继续对话"入口 |

### 已完成修复

- `schedule.service.ts`：传 `workflowId` + `triggerType: 'scheduled'` 给 executor
- `schedule.service.ts`：`buildV2Plan` 从 trigger 节点提取变量默认值
- `workflow-executor-v2.ts`：`createExecutionRecord` 支持 `triggerType` 参数
- `checkpoint.routes.ts`：`safeStringify` 防御循环引用
- `agent-runtime-agentcore.ts`：过滤 `type:'sdk'` 的 in-process MCP server

---

## AgentCore ~/.claude 目录同步 ✅ 已完成

### 问题

AgentCore 容器内 Claude Code 的 HOME 级 `~/.claude/` 目录（session resume 数据、projects 状态）未同步到 S3。当 microVM 回收后，session resume 失败，需要靠 history injection 回退，丢失原生上下文。

### 改造方案

在 S3 workspace prefix 下新增 `__claude_home__/` 子前缀，专门存放容器 `~/.claude/` 目录内容。

```
s3://{bucket}/{org}/{scope}/{session}/
├── CLAUDE.md                           ← workspace 文件
├── .claude/settings.json               ← 项目级配置
├── .claude/skills/...
├── __claude_home__/                    ← 新增：HOME 级 Claude Code 状态
│   ├── projects/...                    ← session resume 数据
│   └── ...
└── __diff__.json
```

### 数据流

```
容器启动 (index.ts)
    ├── restoreWorkspaceFromS3()     ← S3 → /workspace/
    ├── restoreClaudeHomeFromS3()    ← S3 __claude_home__/ → ~/.claude/  [新增]
    └── createGitBaseline()

Agent 执行完毕 (Stop hook)
    ├── extractAndUploadDiff()
    ├── syncWorkspaceToS3()          ← /workspace/ → S3
    └── syncClaudeHomeToS3()         ← ~/.claude/ → S3 __claude_home__/  [新增]

Backend 同步回本地 (syncBackFromS3)
    └── 跳过 __claude_home__/ 前缀    ← 容器内部状态，不下载到本地  [新增]
```

### 修改文件

| 文件 | 变更 |
|------|------|
| `agentcore/src/workspace-sync.ts` | 新增 `restoreClaudeHomeFromS3()` 和 `syncClaudeHomeToS3()` |
| `agentcore/src/agent-runner.ts` | Stop hook 新增 `syncClaudeHomeToS3()` 调用 |
| `agentcore/src/index.ts` | 启动时新增 `restoreClaudeHomeFromS3()` 调用 |
| `backend/src/services/agent-runtime-agentcore.ts` | `syncBackFromS3` 跳过 `__claude_home__/` 前缀 |
| `backend/tests/unit/agentcore-s3-sync.test.ts` | 新增同步过滤逻辑测试 |

---

## 其他待优化项

（待补充）

---

*最后更新：2026-04-22*

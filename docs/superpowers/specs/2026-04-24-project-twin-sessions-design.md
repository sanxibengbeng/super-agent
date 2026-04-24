# Project Twin Sessions Design

## Overview

为 Project Board 增加 Twin Session 能力：项目成员可以自选有权限的 agent，开启私有聊天 session 来讨论和推进项目/issue。Twin 通过内置 project tools 读取项目状态、建议操作（需确认）、生成摘要回流到项目 workspace。

## 核心设计决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 数据模型 | 新建关联表，不改 chat_sessions | 对底座零侵入 |
| Twin 来源 | 成员自选有权限的 agent | 灵活，不绑定预设角色 |
| 信息回流 | 半自动（suggest_action 需确认） | 不越权 |
| 知识沉淀 | 摘要文件写入项目 workspace context/ | 用户主动触发，不用额外表 |
| 上下文获取 | CLAUDE.md 精简 + tools 按需拉取 | 避免 CLAUDE.md 膨胀 |
| Project tools | 内置 tools 注入 | 比 MCP server 简单，调已有 service |
| Session 粒度 | Per-issue + Per-project 都支持 | 从 issue 详情或项目级别都能开 |
| UI 布局 | 可拆卸面板（侧边栏 ↔ 独立页面） | 快速讨论 vs 深度对话 |
| 可见性 | 默认私密，可切换公开 | 所有活跃 session 在卡片上显示状态，点击后做权限判断 |
| Action 持久化 | 写入 twin workspace actions/ 目录 + index.json | 可追溯、可重开聊天继续 |

## 数据模型

### 新增表：project_twin_sessions

```sql
CREATE TABLE project_twin_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id    UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  issue_id      UUID REFERENCES project_issues(id) ON DELETE SET NULL,
  created_by    UUID NOT NULL REFERENCES profiles(id),
  agent_id      UUID NOT NULL REFERENCES agents(id),
  visibility    VARCHAR(10) NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_twin_sessions_project_user ON project_twin_sessions(project_id, created_by);
CREATE INDEX idx_twin_sessions_project_issue ON project_twin_sessions(project_id, issue_id);
CREATE INDEX idx_twin_sessions_project_visibility ON project_twin_sessions(project_id, visibility);
```

### 不改动的表

- `chat_sessions` — 零改动
- `chat_messages` — 零改动
- `projects` — 零改动
- `project_issues` — 零改动

## Twin Session Workspace 结构

```
/tmp/workspaces/{twin_session_id}/
├── CLAUDE.md                          # 精简身份 + 焦点
├── .claude/settings.json              # MCP + permissions
├── actions/                           # 操作记录（持久化）
│   ├── index.json                     # 索引
│   ├── 001-suggest-create-issue.json
│   └── 002-suggest-update-issue.json
└── notes/                             # 讨论中产生的笔记、草稿
```

### CLAUDE.md 内容（精简，不膨胀）

```markdown
# Twin Session

## 项目
- 名称: {project.name}
- 仓库: {project.repo_url}
- 你的角色: 协助 {user_name} 以 {agent_role} 视角推进项目

## 当前焦点
Issue #{issue.number}: {issue.title}（仅 issue 级 session）

## 能力
你可以通过工具查询项目状态、读取历史讨论摘要、建议操作。
在回答问题前，主动用工具获取最新信息。
```

### actions/index.json 结构

```json
[
  {
    "id": "001",
    "type": "suggest_action",
    "action_type": "create_issue",
    "status": "confirmed",
    "reason": "需求拆分为3个子任务",
    "created_at": "2026-04-24T10:30:00Z",
    "resolved_at": "2026-04-24T10:31:00Z",
    "file": "001-suggest-create-issue.json"
  }
]
```

### 单条 action 文件结构

```json
{
  "id": "001",
  "type": "suggest_action",
  "action_type": "create_issue",
  "payload": { "title": "...", "description": "...", "priority": "medium", "status": "todo" },
  "reason": "需求拆分为3个子任务",
  "status": "confirmed",
  "created_at": "2026-04-24T10:30:00Z",
  "resolved_at": "2026-04-24T10:31:00Z",
  "resolved_by": "user_id",
  "result": { "issue_number": 8 }
}
```

## Twin Session 与主项目 Context 的连接

Twin session 不直接共享主项目 workspace。通过内置 tools 做桥接：读是即时的（调 API 拿最新数据），写是显式的（摘要回流、建议操作）。

## Project Tools 定义

### 只读 Tools

**`get_board_status`** — 无参数
- 返回所有 issue 列表：`[{ number, title, status, priority, assignee, effort }]`
- 调用 `projectService.listIssues(projectId)`

**`get_issue_detail`** — `{ issue_number: number }`
- 返回 issue 完整信息：描述、验收标准、评论、子任务、关联 issue
- 调用 `projectService.getIssue(projectId, issueId)`

**`read_project_context`** — 无参数
- 返回主项目 workspace `context/` 目录下的文件列表（文件名 + 创建时间 + 首行摘要）

**`read_context_file`** — `{ filename: string }`
- 返回某份摘要文件的完整内容

### 写入 Tools

**`suggest_action`** — `{ action_type, payload, reason }`
- `action_type`: `create_issue` | `update_issue` | `add_comment` | `change_status`
- 不直接执行，写入 workspace `actions/` 目录
- SSE 推送确认卡片给前端
- 用户确认后执行操作、更新 action 文件

**`summarize_to_project`** — `{ title: string, content: string }`
- 生成文件名：`{date}-{user}-{title_slug}.md`
- 写入主项目 workspace 的 `context/` 目录

### suggest_action 确认流程

```
Agent 调用 suggest_action
  ├── 写 action 文件到 workspace actions/
  ├── 更新 index.json
  ├── SSE 推送 suggestion 事件给前端
  ▼
前端渲染确认卡片（操作预览 + 原因）
  ├── 用户确认 → API 执行操作 → 更新 action 文件（status, result）
  └── 用户拒绝 → 更新 action 文件（status: rejected）

重开聊天时
  ├── Agent 读 CLAUDE.md 知道身份和焦点
  ├── Agent 用 tool 读 actions/index.json
  ├── 看到 pending → 继续推进
  └── 看到历史 confirmed/rejected → 知道推进脉络
```

## 后端 API

### 新增路由：`/api/projects/:id/twin-sessions`

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/` | 创建 twin session（选 agent，可选绑定 issue） |
| `GET` | `/` | 列出 twin sessions（过滤：我的 / 公开的 / 按 issue） |
| `GET` | `/:twinSessionId` | 获取详情（含 chat_session 信息） |
| `PATCH` | `/:twinSessionId/visibility` | 切换 private/public |
| `DELETE` | `/:twinSessionId` | 关闭并删除 |

### 创建流程

```
POST /api/projects/:id/twin-sessions { agent_id, issue_id?, visibility? }
  1. 校验权限（用户是项目成员 + 有 agent 访问权）
  2. 创建 chat_session（room_mode: 'single', agent_id, scope_id）
  3. 准备 workspace
     ├── 生成精简 CLAUDE.md
     └── 注册 project tools 到 agent tool definitions
  4. 创建 project_twin_sessions 记录
  5. 返回 { twinSession, chatSessionId }
```

### suggest_action 确认 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/:twinSessionId/actions/:actionId/confirm` | 确认执行建议操作 |
| `POST` | `/:twinSessionId/actions/:actionId/reject` | 拒绝建议操作 |

## 前端 UI

### 入口

1. **项目级入口** — Board 顶部工具栏"Twin Sessions"按钮 → 列出我的 sessions + 公开 sessions，可新建
2. **Issue 级入口** — Issue 详情弹窗"和 Twin 讨论"按钮 → 创建/打开绑定该 issue 的 session

### 创建 Twin Session 弹窗

- 选择 Agent（从有权限的 agent 列表）
- 绑定 Issue（可选，默认项目级）
- 可见性（私密 / 公开）

### 侧边栏模式（默认）

Board 右侧弹出聊天面板：
- 顶部显示绑定的 issue 和 agent 信息
- 中间是对话消息流（复用现有 chat 消息组件）
- suggest_action 渲染为确认卡片（确认 / 拒绝按钮）
- 底部输入框 + 弹出按钮 `⤢`

### 弹出模式

点击 `⤢` 跳转到独立路由 `/projects/:projectId/twin-session/:twinSessionId`：
- 左侧：完整对话区
- 右侧：绑定的 issue 详情、actions 历史、context 文件列表
- 携带完整项目上下文

### Board 上的状态指示

所有活跃 twin session 在 issue 卡片上显示状态：
```
Issue #5: 权限设计
┌────────────────────────┐
│ 🟢 PM·产品助手         │
│ 🟢 Dev·研发助手        │
│ Priority: medium       │
└────────────────────────┘
```

点击状态指示器：
- public session → 打开该 session（只读）
- private session → 提示"该讨论未公开，无法查阅"

### 前端新增组件

| 组件 | 说明 |
|------|------|
| `TwinSessionPanel.tsx` | 侧边栏聊天面板（复用现有 chat 消息组件） |
| `TwinSessionList.tsx` | Session 列表（我的 + 公开的） |
| `CreateTwinSessionModal.tsx` | 创建弹窗（agent 选择 + issue 绑定 + 可见性） |
| `SuggestionCard.tsx` | Action 确认/拒绝卡片 |
| `TwinSessionPage.tsx` | 弹出模式独立页面 |

### 前端修改

| 文件 | 改动 |
|------|------|
| `ProjectBoard.tsx` | 集成侧边栏入口、issue 卡片活跃指示 |
| `App.tsx` routes | 新增 `/projects/:id/twin-session/:twinSessionId` |

## 实现边界

### 改动范围

| 范围 | 内容 |
|------|------|
| **新增** | `project_twin_sessions` Prisma model + migration |
| **新增** | `project-twin-session.service.ts` — CRUD + workspace 准备 |
| **新增** | `project-twin-session.routes.ts` — REST API |
| **新增** | `project-tools.ts` — 6 个内置 tool 的定义和执行逻辑 |
| **修改** | `chat.service.ts` — `prepareScopeSession` 中检测 twin session，注入 project tools |
| **新增** | 5 个前端组件 |
| **修改** | `ProjectBoard.tsx` — 集成侧边栏和状态指示 |
| **修改** | 路由配置 — 新增独立页面路由 |

### 不改动

- 现有 chat streaming / reconnect / workspace 机制
- 现有 project service / governance service
- 现有 ChatRoom / Chat 页面
- chat_sessions / chat_messages 表结构

### 并发安全

- 多人同时操作 board：issue 更新用 `updatedAt` 乐观锁，sort_order reorder 原子操作
- Twin session 之间不共享 workspace，天然隔离
- 摘要写入主 workspace context/：文件名含 user + timestamp，不冲突

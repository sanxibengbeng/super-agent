# Project Copilot — AI-Native Project Interaction

**Date:** 2026-04-25
**Status:** Draft
**Scope:** Frontend restructure of ProjectBoard into Chat-first experience

---

## Problem

The current ProjectBoard page has fragmented AI interaction points:

| Feature | Current UX | Problem |
|---------|-----------|---------|
| Issue execution | Drag to in_progress → confirm dialog → read-only Agent Console | User cannot intervene during execution |
| AI Triage | Button → wait → read-only slide-over report | One-shot, cannot follow up |
| Twin Sessions | Right sidebar chat panel | Separate from board, unclear entry point |
| Agent Console | Bottom read-only log panel | Cannot interact, polling-based |
| Create Issue | Modal with form fields | Manual, no AI assist |
| Issue Detail | Full slide-over panel | Disconnected from AI context |

These are separate UIs for what should be a unified conversational workflow.

## Solution

Replace the ProjectBoard page with a **Chat-first layout** that reuses the existing Chat page infrastructure (ChatRoom, Workspace Explorer, scope selector, @ mentions). The Kanban board becomes a **progressive-disclosure status overlay** on top of the Chat.

## Layout

```
┌──────────────────────────────────────────────────────────────┐
│ Header: [📋 ProjectName ▾] [Scope] [Group Chat] [Save] [Clear] │
├──────────────────────────────────────────────────────────────┤
│ Board Status Bar: ■3 todo ■2 wip ■1 review ■5 done  ● #1 executing  [▾] │
├─────────────────────────────────────┬────────────────────────┤
│                                     │                        │
│  Chat Area                          │  Workspace Sidebar     │
│  (reuse ChatRoom component)         │  (reuse WorkspaceExplorer) │
│                                     │  - File browser        │
│  · AI / user messages               │  - File preview        │
│  · Tool use blocks                  │  - MCP tools           │
│  · Suggestion cards (confirm/reject)│  - Session actions     │
│  · Inline board cards               │                        │
│                                     │                        │
├─────────────────────────────────────┤                        │
│ Input: [📎] [message... @mention] [Send]                    │
└─────────────────────────────────────┴────────────────────────┘
```

The Chat area and Workspace sidebar are the **existing Chat page components**, not new implementations. The only new UI element is the Board Status Bar between the header and the chat.

## Board: Three-Level Progressive Disclosure

### L1 — Status Bar (default, always visible)

A single row showing lane counts as colored badges and active agent indicator:

```
■ 3 todo  ■ 2 wip  ■ 1 review  ■ 5 done   ● Agent executing #1   [▾ expand]
```

- Colored squares match lane colors from existing LANES config
- Agent activity shows a pulsing dot + issue number when workspace session is active
- Active Twin Sessions count badge (e.g., "👥 2 twins active")
- Click [▾] to expand to L2

Height: ~28px. Always visible, does not scroll with chat.

### L2 — Expanded Issue List (toggle)

Clicking the expand button reveals a panel between the status bar and chat:

```
┌─────────────────────────────────────────────────────┐
│  Todo (3)              In Progress (2)              │
│  ┌──────────────────┐  ┌──────────────────┐        │
│  │ #3 Auth module 🟡 │  │ ● #1 Setup DB    │        │
│  │ #4 API tests   🟢 │  │   #5 Cache layer │        │
│  │ #7 Logging     🟢 │  └──────────────────┘        │
│  └──────────────────┘                               │
│  In Review (1)         Done (5)                     │
│  ┌──────────────────┐  ┌──────────────────┐        │
│  │ #2 Config         │  │ 5 completed       │        │
│  └──────────────────┘  └──────────────────┘        │
│                                    [📊 Open Board]  │
└─────────────────────────────────────────────────────┘
```

- Issues shown as compact rows: `#number` + title + priority badge
- Click an issue → sends context to Chat (equivalent of "tell me about #3")
- Issues with active Twin Sessions show a 👥 indicator
- Issues being executed show a pulsing ● indicator
- "Open Board" button at bottom-right → opens L3
- Collapsible: click [▴] to return to L1

Max height: 200px with overflow scroll. Pushes chat content down (does not overlay).

### L3 — Full Kanban Modal

A modal overlay showing the complete Kanban board:

- Reuses the existing board rendering from ProjectBoard (LANES, IssueCard, drag-and-drop)
- Full drag-and-drop between lanes
- Click issue → opens issue detail slide-over (existing component)
- "+ New Issue" button for quick manual creation
- Twin Session indicators on cards
- Close modal → return to Chat with L1 status bar

The modal content is extracted from the current ProjectBoard component. The existing IssueCard, lane rendering, and drag-drop logic are reused as-is.

## Chat Unifies All AI Interactions

Every AI feature that was previously a separate button/panel becomes part of the conversation:

### Issue Creation
- User: "创建一个用户认证的 issue，高优先级"
- AI: generates issue details → returns a **Suggestion Card** with title, description, priority
- User clicks "Apply" → issue created, board status bar updates

### Triage
- User: "triage 一下 backlog"
- AI: calls `get_board_status` tool → analyzes → returns triage report inline
- User can follow up: "为什么 #3 排在 #4 前面？" — this was impossible with the old read-only report

### Issue Execution
- User: "执行 #3" or clicks issue in L2 list
- AI: returns **Suggestion Card** to confirm execution
- User approves → AI sends task to workspace session
- Execution progress appears in the Chat stream as tool-use blocks (create_file, run_command, etc.)
- User can intervene mid-execution: "先别写测试，把主逻辑完成"

### Issue Detail
- User: "看一下 #5 的详情" or clicks issue in L2
- AI: calls `get_issue_detail` tool → returns rich card with description, status, priority, comments, diff stats
- Files from the issue appear in Workspace sidebar

### Agent Console (replaced)
- The Agent Console bottom panel is **removed entirely**
- Its function (showing agent execution messages) is now the Chat stream itself
- Since the workspace session IS the chat session, all agent activity is already chat messages

### Twin Sessions
- User: "让产品经理看看 #3" or clicks "👥 Discuss" on an issue in L2
- Opens CreateTwinSessionModal (existing component)
- Twin Session appears as a separate chat session — user can switch via session list or sidebar
- Twin Sessions are **independent** from the Project Copilot session: different agent, different scope, different chat history
- Purpose: different Digital Twin roles (PM, ops, QA) provide their perspective on project issues

## Component Architecture

### New Components

| Component | Purpose |
|-----------|---------|
| `ProjectCopilot.tsx` | Page component: composes ChatRoom + BoardStatusBar + WorkspaceExplorer |
| `BoardStatusBar.tsx` | Three-level board: status bar (L1), expanded list (L2), open modal trigger (L3) |
| `BoardKanbanModal.tsx` | Modal wrapper around extracted kanban board logic |

### Reused Components (no changes)

| Component | Reused For |
|-----------|-----------|
| `ChatRoom.tsx` | Main chat area with messages, input, streaming |
| `WorkspaceExplorer` | Right sidebar file browser |
| `TwinSessionPanel.tsx` | Twin session chat (opened via modal or session switch) |
| `CreateTwinSessionModal.tsx` | Creating new twin sessions |
| `SuggestionCard.tsx` | Confirm/reject AI-suggested actions |

### Modified Components

| Component | Change |
|-----------|--------|
| `App.tsx` | Route `/projects/:id` points to `ProjectCopilot` instead of `ProjectBoard` |
| `ChatRoom.tsx` | Accept optional `headerSlot` prop for BoardStatusBar insertion between header and messages |

### Preserved (for L3 Modal)

The existing ProjectBoard kanban rendering logic (LANES, IssueCard, drag handlers) is extracted into `BoardKanbanModal.tsx`. The current `ProjectBoard.tsx` file can be refactored: kanban logic extracted, rest deprecated.

## Backend Changes

**None required.** All backend infrastructure is already in place:

| Capability | Already exists |
|-----------|---------------|
| Project workspace session | `project.service.ts` `ensureWorkspaceSession()` with `source: 'project'` |
| Chat streaming | `/api/chat/stream` with SSE |
| Project tools | `project-tools.ts` (get_board_status, suggest_action, etc.) |
| Project tools MCP injection | `project-tools-mcp.ts` |
| Twin Sessions CRUD | `project-twin-session.service.ts` |
| Twin Session chat | Reuses `/api/chat/stream` with twin session's chat_session_id |
| Issue execution | `project.service.ts` `executeIssue()` |
| Triage | `project-governance.service.ts` `generateTriageReport()` |

The only backend consideration: ensure the workspace session has project tools MCP injected when entering the Project Copilot page. This is already handled by `chat.service.ts` which reads the session's `context.project_id` and injects tools accordingly.

## Data Flow

```
User types message in Chat
  → POST /api/chat/stream (session_id = workspace_session_id)
  → chat.service processes with project tools MCP injected
  → Agent calls get_board_status, suggest_action, get_issue_detail, etc.
  → SSE stream returns messages + tool results
  → ChatRoom renders messages, tool blocks, suggestion cards
  → User confirms suggestion card:
    - Project Copilot actions → workspace action confirm API
      POST /api/projects/:id/twin-sessions/:tsId/actions/:actionId/confirm
    - Direct chat commands (e.g., "执行 #3") → agent handles via chat flow
  → Board status bar polls GET /api/projects/:id/issues for lane count updates
```

## Migration

- `/projects/:id` route changes from `ProjectBoard` to `ProjectCopilot`
- Old ProjectBoard's kanban logic extracted into `BoardKanbanModal` for L3
- Agent Console (bottom panel) removed — replaced by Chat stream
- Triage button removed from header — replaced by conversational triage
- Twin Session sidebar removed — Twin Sessions accessed via session switching or modal
- WorkspaceExplorer moves from ProjectBoard sidebar to ChatRoom sidebar (already exists in Chat)

## Out of Scope

- Board drag-and-drop in L2 (only L3 modal supports drag)
- Real-time collaborative editing (multiple users in same project chat)
- Notification system for Twin Session updates
- Mobile-responsive layout

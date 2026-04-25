# Project Copilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ProjectBoard page with a Chat-first Project Copilot that reuses the existing Chat infrastructure (ChatProvider, MessageList, MessageInput, WorkspaceExplorer) and adds a three-level progressive-disclosure Board overlay.

**Architecture:** New `ProjectCopilot.tsx` page wraps `ChatProvider` with the project's workspace session ID, composes existing chat components (MessageList, MessageInput, WorkspaceExplorer), and inserts a new `BoardStatusBar` between the header and chat. The existing kanban logic from `ProjectBoard.tsx` is extracted into `BoardKanbanModal.tsx` for the L3 full-board modal. No backend changes needed.

**Tech Stack:** React 19, TypeScript, Tailwind CSS 4, React Router 7, existing ChatProvider/ChatContext, existing REST services (restProjectService, restTwinSessionService)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `frontend/src/pages/ProjectCopilot.tsx` | Create | Page component: loads project, ensures workspace session, composes ChatProvider + BoardStatusBar + chat components + WorkspaceExplorer |
| `frontend/src/components/BoardStatusBar.tsx` | Create | L1 status bar + L2 expanded issue list (self-contained, polls issues) |
| `frontend/src/components/BoardKanbanModal.tsx` | Create | L3 full kanban modal (extracts existing board/card/drag logic from ProjectBoard) |
| `frontend/src/App.tsx` | Modify (line 40) | Change `/projects/:id` route from `ProjectBoard` to `ProjectCopilot` |
| `frontend/src/i18n/translations.ts` | Modify | Add translation keys for ProjectCopilot header/board |

**Not modified:** ChatProvider, ChatContext, MessageList, MessageInput, WorkspaceExplorer, SuggestionCard, TwinSessionPanel, CreateTwinSessionModal, restProjectService, restTwinSessionService — all reused as-is.

---

### Task 1: BoardStatusBar Component (L1 + L2)

**Files:**
- Create: `frontend/src/components/BoardStatusBar.tsx`

This is the core new UI: a compact status bar (L1) that expands to show an issue list (L2). It is a standalone component that receives issues and twin sessions as props.

- [ ] **Step 1: Create BoardStatusBar with L1 status bar**

```tsx
// frontend/src/components/BoardStatusBar.tsx
import { useState } from 'react'
import { ChevronDown, ChevronUp, LayoutGrid, Bot, Users } from 'lucide-react'
import { useTranslation } from '@/i18n'
import type { ProjectIssue } from '@/services/api/restProjectService'
import type { TwinSessionSummary } from '@/services/api/restTwinSessionService'

const LANE_CONFIG = [
  { id: 'backlog', color: 'bg-gray-500', labelKey: 'project.backlog' },
  { id: 'todo', color: 'bg-blue-500', labelKey: 'project.todo' },
  { id: 'in_progress', color: 'bg-yellow-500', labelKey: 'project.inProgress' },
  { id: 'in_review', color: 'bg-purple-500', labelKey: 'project.inReview' },
  { id: 'done', color: 'bg-green-500', labelKey: 'project.done' },
] as const

const PRIORITY_ICONS: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
}

interface BoardStatusBarProps {
  issues: ProjectIssue[]
  twinSessions: TwinSessionSummary[]
  executingIssueNumber: number | null
  onIssueClick: (issue: ProjectIssue) => void
  onOpenBoard: () => void
  onCreateTwin: (issueId?: string) => void
}

export function BoardStatusBar({
  issues,
  twinSessions,
  executingIssueNumber,
  onIssueClick,
  onOpenBoard,
  onCreateTwin,
}: BoardStatusBarProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  const laneCounts = LANE_CONFIG.map(lane => ({
    ...lane,
    count: issues.filter(i => i.status === lane.id).length,
  }))

  const activeTwinCount = twinSessions.length

  return (
    <div className="border-b border-gray-800 flex-shrink-0">
      {/* L1: Status bar */}
      <div
        className="flex items-center justify-between px-4 py-1.5 cursor-pointer hover:bg-gray-800/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500 font-medium">Board</span>
          <div className="flex items-center gap-2">
            {laneCounts.map(lane => (
              <div key={lane.id} className="flex items-center gap-1">
                <div className={`w-2 h-2 rounded-sm ${lane.color}`} />
                <span className="text-xs text-gray-400">{lane.count}</span>
              </div>
            ))}
          </div>
          {executingIssueNumber && (
            <>
              <div className="w-px h-3 bg-gray-700" />
              <div className="flex items-center gap-1">
                <Bot size={12} className="text-purple-400 animate-pulse" />
                <span className="text-xs text-purple-400">#{executingIssueNumber}</span>
              </div>
            </>
          )}
          {activeTwinCount > 0 && (
            <>
              <div className="w-px h-3 bg-gray-700" />
              <div className="flex items-center gap-1">
                <Users size={12} className="text-cyan-400" />
                <span className="text-xs text-cyan-400">{activeTwinCount}</span>
              </div>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); onOpenBoard() }}
            className="text-xs text-gray-500 hover:text-white px-2 py-0.5 rounded hover:bg-gray-700 transition-colors"
          >
            <LayoutGrid size={14} />
          </button>
          {expanded ? <ChevronUp size={14} className="text-gray-500" /> : <ChevronDown size={14} className="text-gray-500" />}
        </div>
      </div>

      {/* L2: Expanded issue list */}
      {expanded && (
        <div className="px-4 pb-3 max-h-[200px] overflow-y-auto">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {LANE_CONFIG.filter(lane => {
              const laneIssues = issues.filter(i => i.status === lane.id)
              return lane.id !== 'done' ? laneIssues.length > 0 : laneIssues.length > 0
            }).map(lane => {
              const laneIssues = issues.filter(i => i.status === lane.id)
              if (lane.id === 'done' && laneIssues.length > 0) {
                return (
                  <div key={lane.id}>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <div className={`w-2 h-2 rounded-sm ${lane.color}`} />
                      <span className="text-[10px] text-gray-400 font-medium">{t(lane.labelKey)}</span>
                      <span className="text-[10px] text-gray-600">({laneIssues.length})</span>
                    </div>
                    <div className="text-[10px] text-gray-600 px-2 py-1 bg-gray-900/50 rounded">
                      {laneIssues.length} completed
                    </div>
                  </div>
                )
              }
              return (
                <div key={lane.id}>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <div className={`w-2 h-2 rounded-sm ${lane.color}`} />
                    <span className="text-[10px] text-gray-400 font-medium">{t(lane.labelKey)}</span>
                    <span className="text-[10px] text-gray-600">({laneIssues.length})</span>
                  </div>
                  <div className="space-y-1">
                    {laneIssues.map(issue => {
                      const isExecuting = issue.status === 'in_progress' && issue.workspace_session_id
                      const issueTwins = twinSessions.filter(ts => ts.issue?.id === issue.id)
                      return (
                        <div
                          key={issue.id}
                          onClick={() => onIssueClick(issue)}
                          className="flex items-center gap-1.5 px-2 py-1 bg-gray-900/50 rounded cursor-pointer hover:bg-gray-800 transition-colors group"
                        >
                          {isExecuting && <span className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse flex-shrink-0" />}
                          <span className="text-[10px] text-gray-500 flex-shrink-0">#{issue.issue_number}</span>
                          <span className="text-[10px] text-gray-300 truncate flex-1">{issue.title}</span>
                          <span className="text-[10px] flex-shrink-0">{PRIORITY_ICONS[issue.priority] ?? '🟡'}</span>
                          {issueTwins.length > 0 && (
                            <span className="text-[10px] text-cyan-400 flex-shrink-0">👥{issueTwins.length}</span>
                          )}
                          <button
                            onClick={(e) => { e.stopPropagation(); onCreateTwin(issue.id) }}
                            className="text-[10px] text-gray-600 hover:text-purple-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                            title={t('twinSession.discussIssue')}
                          >
                            💬
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="flex justify-end mt-2">
            <button
              onClick={onOpenBoard}
              className="text-[10px] text-gray-500 hover:text-white flex items-center gap-1 px-2 py-0.5 rounded hover:bg-gray-700 transition-colors"
            >
              <LayoutGrid size={10} /> {t('projectCopilot.openBoard')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd /home/ubuntu/super-agent/frontend && npx tsc --noEmit --pretty 2>&1 | grep -i "BoardStatusBar" | head -10`
Expected: No errors referencing BoardStatusBar (file may have unused import warnings until wired up)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/BoardStatusBar.tsx
git commit -m "feat(frontend): add BoardStatusBar component with L1 status bar and L2 issue list"
```

---

### Task 2: BoardKanbanModal Component (L3)

**Files:**
- Create: `frontend/src/components/BoardKanbanModal.tsx`
- Read (reference only): `frontend/src/pages/ProjectBoard.tsx:1609-1700` (IssueCard), `ProjectBoard.tsx:16-36` (LANES, PRIORITY_BADGES, RELATION_TYPE_CONFIG)

This extracts the existing kanban board into a modal. We copy the LANES config, IssueCard, and drag-drop logic from ProjectBoard and wrap them in a modal overlay.

- [ ] **Step 1: Create BoardKanbanModal**

```tsx
// frontend/src/components/BoardKanbanModal.tsx
import { useState } from 'react'
import { X, Plus, GripVertical, Bot, Sparkles, MessageSquare } from 'lucide-react'
import { useTranslation } from '@/i18n'
import type { ProjectIssue, IssueRelation } from '@/services/api/restProjectService'
import type { TwinSessionSummary } from '@/services/api/restTwinSessionService'

const LANES = [
  { id: 'backlog', labelKey: 'project.backlog', color: 'border-gray-600' },
  { id: 'todo', labelKey: 'project.todo', color: 'border-blue-600' },
  { id: 'in_progress', labelKey: 'project.inProgress', color: 'border-yellow-600' },
  { id: 'in_review', labelKey: 'project.inReview', color: 'border-purple-600' },
  { id: 'done', labelKey: 'project.done', color: 'border-green-600' },
]

const PRIORITY_BADGES: Record<string, { label: string; cls: string }> = {
  critical: { label: '🔴', cls: 'text-red-400' },
  high: { label: '🟠', cls: 'text-orange-400' },
  medium: { label: '🟡', cls: 'text-yellow-400' },
  low: { label: '🟢', cls: 'text-green-400' },
}

interface BoardKanbanModalProps {
  issues: ProjectIssue[]
  relations: IssueRelation[]
  twinSessions: TwinSessionSummary[]
  onClose: () => void
  onDrop: (issueId: string, newStatus: string) => void
  onIssueClick: (issue: ProjectIssue) => void
  onCreateIssue: () => void
}

export function BoardKanbanModal({
  issues,
  relations,
  twinSessions,
  onClose,
  onDrop,
  onIssueClick,
  onCreateIssue,
}: BoardKanbanModalProps) {
  const { t } = useTranslation()
  const [dragIssueId, setDragIssueId] = useState<string | null>(null)

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-8" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-[90vw] h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-white">{t('projectCopilot.fullBoard')}</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={onCreateIssue}
              className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg transition-colors"
            >
              <Plus size={14} /> {t('project.newIssue')}
            </button>
            <button onClick={onClose} className="p-1.5 text-gray-500 hover:text-white rounded transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Kanban lanes */}
        <div className="flex-1 flex overflow-x-auto p-4 gap-3">
          {LANES.map(lane => {
            const laneIssues = issues.filter(i => i.status === lane.id).sort((a, b) => a.sort_order - b.sort_order)
            return (
              <div
                key={lane.id}
                className={`flex-1 min-w-[180px] flex flex-col bg-gray-800/50 rounded-xl border-t-2 ${lane.color}`}
                onDragOver={e => e.preventDefault()}
                onDrop={() => {
                  if (dragIssueId) {
                    onDrop(dragIssueId, lane.id)
                    setDragIssueId(null)
                  }
                }}
              >
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-xs font-medium text-gray-300">{t(lane.labelKey)}</span>
                  <span className="text-xs text-gray-500">{laneIssues.length}</span>
                </div>
                <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-2">
                  {laneIssues.map(issue => {
                    const priority = PRIORITY_BADGES[issue.priority]
                    const isWorking = issue.status === 'in_progress' && issue.workspace_session_id
                    const issueRels = relations.filter(r => r.source_issue_id === issue.id || r.target_issue_id === issue.id)
                    const pendingConflicts = issueRels.filter(r => r.relation_type === 'conflicts_with' && r.status === 'pending')
                    const issueTwins = twinSessions.filter(ts => ts.issue?.id === issue.id)

                    return (
                      <div
                        key={issue.id}
                        draggable
                        onDragStart={() => setDragIssueId(issue.id)}
                        onClick={() => onIssueClick(issue)}
                        className={`bg-gray-800 border rounded-lg p-3 cursor-grab active:cursor-grabbing hover:border-gray-600 transition-colors ${
                          pendingConflicts.length > 0 ? 'border-red-500/40' :
                          isWorking ? 'border-yellow-500/50' : 'border-gray-700'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 mb-1">
                              <span className="text-[10px] text-gray-500">#{issue.issue_number}</span>
                              {priority && <span className={`text-xs ${priority.cls}`}>{priority.label}</span>}
                              {isWorking && (
                                <span className="flex items-center gap-0.5 text-[10px] text-yellow-400">
                                  <Bot size={10} className="animate-pulse" />
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-white font-medium leading-snug">{issue.title}</p>
                          </div>
                          <GripVertical size={12} className="text-gray-600 flex-shrink-0 mt-0.5" />
                        </div>
                        <div className="flex items-center justify-between mt-2">
                          <div className="flex items-center gap-1">
                            {issue.labels?.map((label: string, i: number) => (
                              <span key={i} className="px-1.5 py-0.5 bg-gray-700 text-[10px] text-gray-400 rounded">{label}</span>
                            ))}
                          </div>
                          <div className="flex items-center gap-1.5">
                            {pendingConflicts.length > 0 && (
                              <span className="text-[10px] text-red-400">⚠️{pendingConflicts.length}</span>
                            )}
                            {issueTwins.length > 0 && (
                              <span className="text-[10px] text-cyan-400">👥{issueTwins.length}</span>
                            )}
                            {issue._count?.comments ? (
                              <span className="flex items-center gap-0.5 text-[10px] text-gray-500">
                                <MessageSquare size={10} /> {issue._count.comments}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd /home/ubuntu/super-agent/frontend && npx tsc --noEmit --pretty 2>&1 | grep -i "BoardKanban" | head -10`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/BoardKanbanModal.tsx
git commit -m "feat(frontend): add BoardKanbanModal with full kanban view for L3"
```

---

### Task 3: ProjectCopilot Page Component

**Files:**
- Create: `frontend/src/pages/ProjectCopilot.tsx`
- Read (reference only): `frontend/src/pages/Chat.tsx:1607-1998` (ChatInterfaceContent layout pattern), `frontend/src/services/ChatContext.tsx:109-131` (ChatProvider props)

This is the main page. It loads the project, ensures the workspace session exists, then renders ChatProvider (initialized with the workspace session) + BoardStatusBar + the same chat components the Chat page uses.

- [ ] **Step 1: Create ProjectCopilot page**

```tsx
// frontend/src/pages/ProjectCopilot.tsx
import { useState, useEffect, useCallback, useContext, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Loader2, Settings } from 'lucide-react'
import { useTranslation } from '@/i18n'
import { RestProjectService, type Project, type ProjectIssue, type IssueRelation } from '@/services/api/restProjectService'
import { RestTwinSessionService, type TwinSessionSummary } from '@/services/api/restTwinSessionService'
import { ChatProvider, ChatContext } from '@/services/ChatContext'
import { MessageList, WorkspaceExplorer } from '@/components'
import { BoardStatusBar } from '@/components/BoardStatusBar'
import { BoardKanbanModal } from '@/components/BoardKanbanModal'
import { CreateTwinSessionModal } from '@/components/CreateTwinSessionModal'
import type { QuickQuestion } from '@/types'

export function ProjectCopilot() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [project, setProject] = useState<Project | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [workspaceSessionId, setWorkspaceSessionId] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) return
    async function load() {
      try {
        const proj = await RestProjectService.getProject(projectId!)
        setProject(proj)
        let sessionId = proj.workspace_session_id
        if (!sessionId) {
          sessionId = await RestProjectService.ensureWorkspace(projectId!)
        }
        setWorkspaceSessionId(sessionId)
      } catch (err) {
        console.error('Failed to load project:', err)
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [projectId])

  if (isLoading) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="w-8 h-8 text-blue-500 animate-spin" /></div>
  }
  if (!project || !workspaceSessionId) {
    return <div className="flex items-center justify-center h-full text-gray-400">{t('project.notFound')}</div>
  }

  return (
    <ChatProvider
      key={workspaceSessionId}
      initialSessionId={workspaceSessionId}
      initialScopeId={project.business_scope_id ?? undefined}
      initialAgentId={project.agent_id ?? undefined}
    >
      <ProjectCopilotContent
        project={project}
        onProjectUpdated={setProject}
      />
    </ChatProvider>
  )
}

function ProjectCopilotContent({
  project,
  onProjectUpdated,
}: {
  project: Project
  onProjectUpdated: (p: Project) => void
}) {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const {
    messages,
    backendSessionId,
    selectedBusinessScopeId,
    isSending,
    sendMessage,
    stopGeneration,
  } = useContext(ChatContext)

  // Board data
  const [issues, setIssues] = useState<ProjectIssue[]>([])
  const [relations, setRelations] = useState<IssueRelation[]>([])
  const [twinSessions, setTwinSessions] = useState<TwinSessionSummary[]>([])
  const [showKanban, setShowKanban] = useState(false)
  const [showCreateTwin, setShowCreateTwin] = useState(false)
  const [createTwinIssueId, setCreateTwinIssueId] = useState<string | undefined>()

  // Workspace refresh
  const [wsRefreshKey, setWsRefreshKey] = useState(0)
  const [panelWidth, setPanelWidth] = useState(288)
  const prevSending = useRef(isSending)

  useEffect(() => {
    if (prevSending.current && !isSending) {
      setWsRefreshKey(k => k + 1)
      loadBoardData()
    }
    prevSending.current = isSending
  }, [isSending])

  const loadBoardData = useCallback(async () => {
    if (!projectId) return
    try {
      const [issueList, rels, twins] = await Promise.all([
        RestProjectService.listIssues(projectId),
        RestProjectService.getProjectRelations(projectId).catch(() => []),
        RestTwinSessionService.getActiveSessions(projectId).catch(() => []),
      ])
      setIssues(issueList)
      setRelations(rels)
      setTwinSessions(twins)
    } catch { /* silent */ }
  }, [projectId])

  useEffect(() => { loadBoardData() }, [loadBoardData])

  // Poll board data every 10s to pick up agent-driven changes
  useEffect(() => {
    const interval = setInterval(loadBoardData, 10000)
    return () => clearInterval(interval)
  }, [loadBoardData])

  const executingIssue = issues.find(i => i.status === 'in_progress' && i.workspace_session_id)

  const handleIssueClick = (issue: ProjectIssue) => {
    sendMessage(`Tell me about issue #${issue.issue_number}: ${issue.title}`)
  }

  const handleDrop = async (issueId: string, newStatus: string) => {
    if (!projectId) return
    await RestProjectService.changeStatus(projectId, issueId, newStatus)
    loadBoardData()
  }

  const handleSendMessage = useCallback(async (content: string, mentionAgentId?: string) => {
    await sendMessage(content, mentionAgentId)
  }, [sendMessage])

  const handleOpenCreateTwin = (issueId?: string) => {
    setCreateTwinIssueId(issueId)
    setShowCreateTwin(true)
  }

  return (
    <div className="flex h-full">
      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/projects')} className="p-1.5 hover:bg-gray-800 rounded-lg transition-colors">
              <ArrowLeft size={18} className="text-gray-400" />
            </button>
            <div>
              <h1 className="text-sm font-semibold text-white">{project.name}</h1>
              {project.description && <p className="text-xs text-gray-500 truncate max-w-[300px]">{project.description}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate(`/projects`)}
              className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
              title={t('project.settings')}
            >
              <Settings size={18} />
            </button>
          </div>
        </div>

        {/* Board Status Bar */}
        <BoardStatusBar
          issues={issues}
          twinSessions={twinSessions}
          executingIssueNumber={executingIssue?.issue_number ?? null}
          onIssueClick={handleIssueClick}
          onOpenBoard={() => setShowKanban(true)}
          onCreateTwin={handleOpenCreateTwin}
        />

        {/* Chat area */}
        {messages.length === 0 && !isSending ? (
          <ProjectQuickStart onSend={handleSendMessage} issueCount={issues.length} />
        ) : (
          <MessageList messages={messages} isTyping={isSending} />
        )}

        {/* Message input — reuse the same pattern as Chat page */}
        <ProjectMessageInput
          onSend={handleSendMessage}
          onStop={stopGeneration}
          disabled={isSending}
          isSending={isSending}
          sessionId={backendSessionId}
          businessScopeId={selectedBusinessScopeId}
        />
      </div>

      {/* Workspace sidebar */}
      <WorkspaceExplorer
        sessionId={backendSessionId}
        businessScopeId={selectedBusinessScopeId}
        refreshKey={wsRefreshKey}
        width={panelWidth}
        onWidthChange={setPanelWidth}
      />

      {/* L3: Full Kanban Modal */}
      {showKanban && (
        <BoardKanbanModal
          issues={issues}
          relations={relations}
          twinSessions={twinSessions}
          onClose={() => setShowKanban(false)}
          onDrop={handleDrop}
          onIssueClick={(issue) => {
            setShowKanban(false)
            handleIssueClick(issue)
          }}
          onCreateIssue={() => {
            setShowKanban(false)
            sendMessage('Create a new issue for me')
          }}
        />
      )}

      {/* Create Twin Session Modal */}
      {showCreateTwin && (
        <CreateTwinSessionModal
          scopeId={project.business_scope_id ?? null}
          issues={issues}
          preSelectedIssueId={createTwinIssueId}
          onClose={() => setShowCreateTwin(false)}
          onCreate={async (input) => {
            await RestTwinSessionService.create(projectId!, input)
            await loadBoardData()
            setShowCreateTwin(false)
          }}
        />
      )}
    </div>
  )
}

function ProjectQuickStart({ onSend, issueCount }: { onSend: (msg: string) => void; issueCount: number }) {
  const { t } = useTranslation()

  const suggestions = [
    { icon: '📊', label: t('projectCopilot.quickTriage'), message: 'Triage the backlog and suggest execution order' },
    { icon: '➕', label: t('projectCopilot.quickCreate'), message: 'Help me create a new issue' },
    { icon: '📋', label: t('projectCopilot.quickStatus'), message: 'Give me a project status summary' },
    { icon: '🚀', label: t('projectCopilot.quickExecute'), message: 'Pick the highest priority todo and start executing' },
  ]

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8">
      <h2 className="text-lg font-semibold text-white mb-2">{t('projectCopilot.welcome')}</h2>
      <p className="text-sm text-gray-400 mb-6 text-center max-w-md">
        {issueCount > 0
          ? t('projectCopilot.welcomeWithIssues', { count: issueCount })
          : t('projectCopilot.welcomeEmpty')}
      </p>
      <div className="grid grid-cols-2 gap-3 max-w-lg w-full">
        {suggestions.map((s, i) => (
          <button
            key={i}
            onClick={() => onSend(s.message)}
            className="flex items-center gap-3 px-4 py-3 bg-gray-800/50 border border-gray-700 rounded-lg text-left hover:bg-gray-800 hover:border-gray-600 transition-colors"
          >
            <span className="text-lg">{s.icon}</span>
            <span className="text-xs text-gray-300">{s.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function ProjectMessageInput({
  onSend,
  onStop,
  disabled,
  isSending,
  sessionId,
  businessScopeId,
}: {
  onSend: (content: string, mentionAgentId?: string) => Promise<void>
  onStop: () => void
  disabled: boolean
  isSending: boolean
  sessionId: string | null
  businessScopeId: string | null
}) {
  const [input, setInput] = useState('')
  const { t } = useTranslation()

  const handleSubmit = async () => {
    if (!input.trim() || disabled) return
    const msg = input
    setInput('')
    await onSend(msg)
  }

  return (
    <div className="px-4 py-3 border-t border-gray-800">
      <div className="flex items-center gap-2 bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit() } }}
          placeholder={t('projectCopilot.inputPlaceholder')}
          className="flex-1 bg-transparent text-sm text-white placeholder-gray-500 outline-none"
          disabled={disabled}
        />
        {isSending ? (
          <button onClick={onStop} className="px-3 py-1 bg-red-600 hover:bg-red-500 text-white text-xs rounded-md transition-colors">
            {t('chat.stop')}
          </button>
        ) : (
          <button onClick={handleSubmit} disabled={!input.trim()} className="px-3 py-1 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-xs rounded-md transition-colors">
            {t('chat.send')}
          </button>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd /home/ubuntu/super-agent/frontend && npx tsc --noEmit --pretty 2>&1 | grep "ProjectCopilot\|error TS" | head -20`
Expected: No errors related to ProjectCopilot

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/ProjectCopilot.tsx
git commit -m "feat(frontend): add ProjectCopilot page with chat-first project interaction"
```

---

### Task 4: Add Translation Keys

**Files:**
- Modify: `frontend/src/i18n/translations.ts`

Add the new keys used by ProjectCopilot, BoardStatusBar, and BoardKanbanModal.

- [ ] **Step 1: Add translation keys**

Find the `project:` section in the English translations and add after the last `project.*` key:

```typescript
// Add to the en translations object, inside the top level:
'projectCopilot.welcome': 'Project Copilot',
'projectCopilot.welcomeWithIssues': 'You have {{count}} issues. Ask me anything about the project.',
'projectCopilot.welcomeEmpty': 'No issues yet. I can help you create and plan tasks.',
'projectCopilot.inputPlaceholder': 'Ask about the project, create issues, run triage...',
'projectCopilot.openBoard': 'Open Board',
'projectCopilot.fullBoard': 'Project Board',
'projectCopilot.quickTriage': 'Triage backlog',
'projectCopilot.quickCreate': 'Create issue',
'projectCopilot.quickStatus': 'Project status',
'projectCopilot.quickExecute': 'Execute next task',
```

And the Chinese equivalents in the zh section:

```typescript
'projectCopilot.welcome': '项目助手',
'projectCopilot.welcomeWithIssues': '当前有 {{count}} 个任务。你可以问我任何关于项目的问题。',
'projectCopilot.welcomeEmpty': '还没有任务。我可以帮你创建和规划。',
'projectCopilot.inputPlaceholder': '问我项目相关的问题、创建任务、分析优先级...',
'projectCopilot.openBoard': '打开看板',
'projectCopilot.fullBoard': '项目看板',
'projectCopilot.quickTriage': '分析 Backlog',
'projectCopilot.quickCreate': '创建任务',
'projectCopilot.quickStatus': '项目状态',
'projectCopilot.quickExecute': '执行下一个任务',
```

- [ ] **Step 2: Verify no syntax errors in translations**

Run: `cd /home/ubuntu/super-agent/frontend && npx tsc --noEmit --pretty 2>&1 | grep "translations" | head -5`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/i18n/translations.ts
git commit -m "feat(i18n): add ProjectCopilot translation keys (en + zh)"
```

---

### Task 5: Wire Route and Verify

**Files:**
- Modify: `frontend/src/App.tsx` (line 14, line 40)

Change the `/projects/:id` route to use `ProjectCopilot` instead of `ProjectBoard`.

- [ ] **Step 1: Update imports in App.tsx**

Add the import for ProjectCopilot after the existing ProjectBoard import (line 14):

```typescript
import { ProjectCopilot } from '@/pages/ProjectCopilot'
```

- [ ] **Step 2: Change the route**

Change line 40 from:

```typescript
<Route path="/projects/:id" element={<ProjectBoard />} />
```

to:

```typescript
<Route path="/projects/:id" element={<ProjectCopilot />} />
```

Keep the `ProjectBoard` import — it's still used by `BoardKanbanModal` references and the old route may need to be preserved temporarily.

- [ ] **Step 3: Run full type check**

Run: `cd /home/ubuntu/super-agent/frontend && npx tsc --noEmit --pretty 2>&1 | tail -5`
Expected: No new errors introduced

- [ ] **Step 4: Start dev server and test in browser**

Run: The dev server should already be running via Docker Compose at http://localhost:8080

Manual test:
1. Navigate to http://localhost:8080/projects — select a project
2. Verify the new ProjectCopilot layout loads (header + board status bar + chat area + workspace sidebar)
3. Click the board status bar expand toggle — verify L2 issue list appears
4. Click the board icon or "Open Board" — verify L3 kanban modal opens
5. Type a message in the chat input — verify it sends via the workspace session
6. Verify the workspace sidebar shows files from the project workspace

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(frontend): route /projects/:id to ProjectCopilot chat-first view"
```

---

### Task 6: Polish and Edge Cases

**Files:**
- Modify: `frontend/src/pages/ProjectCopilot.tsx`
- Modify: `frontend/src/components/BoardStatusBar.tsx`

Handle edge cases discovered during testing.

- [ ] **Step 1: Handle project with no business_scope_id**

In `ProjectCopilot.tsx`, if the project has no `business_scope_id`, show a prompt to configure one in settings before the chat can work. Add after the `if (!project || !workspaceSessionId)` check:

```tsx
if (!project.business_scope_id) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4">
      <p className="text-sm text-gray-400">{t('project.noScopeConfigured')}</p>
      <button
        onClick={() => navigate('/projects')}
        className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg"
      >
        {t('project.goToSettings')}
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Handle empty issues state in BoardStatusBar**

When there are no issues, L1 should show "No issues" instead of all-zero counts. In `BoardStatusBar.tsx`, add above the lane counts rendering:

```tsx
{issues.length === 0 ? (
  <span className="text-xs text-gray-600">{t('projectCopilot.noIssues')}</span>
) : (
  <div className="flex items-center gap-2">
    {laneCounts.map(lane => (
      // ... existing lane count badges
    ))}
  </div>
)}
```

Add translation keys:
- en: `'projectCopilot.noIssues': 'No issues yet'`
- zh: `'projectCopilot.noIssues': '暂无任务'`

- [ ] **Step 3: Test the edge cases**

Manual test:
1. Open a project with no issues — verify "No issues yet" shown in L1, quick start shows in chat
2. Open a project with no business scope — verify the "configure scope" prompt appears
3. Verify the chat works end-to-end: type "create a new issue called Test" → AI responds

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/ProjectCopilot.tsx frontend/src/components/BoardStatusBar.tsx frontend/src/i18n/translations.ts
git commit -m "fix(frontend): handle edge cases in ProjectCopilot (no scope, no issues)"
```

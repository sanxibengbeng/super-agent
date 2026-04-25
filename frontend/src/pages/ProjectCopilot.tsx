// frontend/src/pages/ProjectCopilot.tsx
import { useState, useEffect, useCallback, useContext } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Loader2, Settings, MessageSquare, File as FileIcon, Users, X } from 'lucide-react'
import { useTranslation } from '@/i18n'
import { RestProjectService, type Project, type ProjectIssue, type IssueRelation } from '@/services/api/restProjectService'
import { RestTwinSessionService, type TwinSessionSummary } from '@/services/api/restTwinSessionService'
import { ChatProvider, ChatContext } from '@/services/ChatContext'
import { MessageList, WorkspaceExplorer } from '@/components'
import { BoardStatusBar } from '@/components/BoardStatusBar'
import { BoardKanbanModal } from '@/components/BoardKanbanModal'
import { CreateTwinSessionModal } from '@/components/CreateTwinSessionModal'
import { TwinSessionsDrawer } from '@/components/TwinSessionsDrawer'
import { TwinSessionPanel } from '@/components/TwinSessionPanel'
import { FileViewerTab, isPreviewableFile, type FileTab } from '@/pages/Chat'

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

  // File and twin session tabs
  const [fileTabs, setFileTabs] = useState<FileTab[]>([])
  const [activeTab, setActiveTab] = useState<string>('chat')
  const [showTwinDrawer, setShowTwinDrawer] = useState(false)

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

  // Initial load and polling for agent-driven changes
  useEffect(() => {
    if (!projectId) return

    let cancelled = false

    async function fetchData() {
      try {
        const [issueList, rels, twins] = await Promise.all([
          RestProjectService.listIssues(projectId!),
          RestProjectService.getProjectRelations(projectId!).catch(() => []),
          RestTwinSessionService.getActiveSessions(projectId!).catch(() => []),
        ])
        if (!cancelled) {
          setIssues(issueList)
          setRelations(rels)
          setTwinSessions(twins)
        }
      } catch { /* silent */ }
    }

    fetchData()
    const interval = setInterval(fetchData, 10000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [projectId])

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
    // After agent finishes responding, refresh workspace and board data
    setWsRefreshKey(k => k + 1)
    void loadBoardData()
  }, [sendMessage, loadBoardData])

  const handleOpenCreateTwin = (issueId?: string) => {
    setCreateTwinIssueId(issueId)
    setShowCreateTwin(true)
  }

  const handleFileOpen = useCallback((path: string, name: string) => {
    const preview = isPreviewableFile(name)
    const tabId = preview ? `preview:${path}` : path
    if (fileTabs.some(tab => tab.id === tabId)) {
      setActiveTab(tabId)
      return
    }
    setFileTabs(prev => [...prev, { id: tabId, name, path, kind: preview ? 'preview' : 'file' }])
    setActiveTab(tabId)
  }, [fileTabs])

  const handleCloseTab = useCallback((tabId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setFileTabs(prev => prev.filter(tab => tab.id !== tabId))
    if (activeTab === tabId) setActiveTab('chat')
  }, [activeTab])

  const handleTwinSessionClick = useCallback((session: TwinSessionSummary) => {
    const tabId = `twin:${session.id}`
    const label = session.agent.display_name ?? session.agent.name
    const name = session.issue ? `${label} #${session.issue.issue_number}` : label
    if (fileTabs.some(tab => tab.id === tabId)) {
      setActiveTab(tabId)
    } else {
      setFileTabs(prev => [...prev, { id: tabId, name, path: session.id, kind: 'file' }])
      setActiveTab(tabId)
    }
    setShowTwinDrawer(false)
  }, [fileTabs])

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
          onTwinBadgeClick={() => setShowTwinDrawer(prev => !prev)}
        />

        {/* Twin Sessions Drawer */}
        {showTwinDrawer && (
          <TwinSessionsDrawer
            projectId={projectId!}
            twinSessions={twinSessions}
            onClose={() => setShowTwinDrawer(false)}
            onSessionClick={handleTwinSessionClick}
            onCreateNew={() => { setShowTwinDrawer(false); handleOpenCreateTwin() }}
          />
        )}

        {/* Tab bar — only when file tabs are open */}
        {fileTabs.length > 0 && (
          <div className="flex items-center border-b border-gray-800 bg-gray-900/50 overflow-x-auto">
            <button
              onClick={() => setActiveTab('chat')}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm border-r border-gray-800 flex-shrink-0 transition-colors ${
                activeTab === 'chat'
                  ? 'bg-gray-800 text-white border-b-2 border-b-blue-500'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
              }`}
            >
              <MessageSquare className="w-3.5 h-3.5" />
              Chat
            </button>
            {fileTabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm border-r border-gray-800 flex-shrink-0 transition-colors group ${
                  activeTab === tab.id
                    ? 'bg-gray-800 text-white border-b-2 border-b-blue-500'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                }`}
              >
                {tab.id.startsWith('twin:') ? <Users className="w-3.5 h-3.5 text-cyan-400" /> : <FileIcon className="w-3.5 h-3.5 text-blue-400" />}
                <span className="max-w-[120px] truncate">{tab.name}</span>
                <span
                  role="button"
                  onClick={(e) => handleCloseTab(tab.id, e)}
                  className="ml-1 rounded hover:bg-gray-600 p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="w-3 h-3" />
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Tab content */}
        {activeTab === 'chat' ? (
          <>
            {/* Chat area */}
            {messages.length === 0 && !isSending ? (
              <ProjectQuickStart onSend={handleSendMessage} issueCount={issues.length} />
            ) : (
              <MessageList messages={messages} isTyping={isSending} />
            )}

            {/* Message input */}
            <ProjectMessageInput
              onSend={handleSendMessage}
              onStop={stopGeneration}
              disabled={isSending}
              isSending={isSending}
            />
          </>
        ) : (
          (() => {
            const tab = fileTabs.find(t => t.id === activeTab)
            if (!tab) return null
            if (tab.id.startsWith('twin:')) {
              return (
                <TwinSessionPanel
                  projectId={projectId!}
                  twinSessionId={tab.path}
                  onClose={() => handleCloseTab(tab.id, { stopPropagation: () => {} } as React.MouseEvent)}
                />
              )
            }
            return backendSessionId ? <FileViewerTab path={tab.path} sessionId={backendSessionId} /> : null
          })()
        )}
      </div>

      {/* Workspace sidebar */}
      <WorkspaceExplorer
        sessionId={backendSessionId}
        businessScopeId={selectedBusinessScopeId}
        refreshKey={wsRefreshKey}
        onFileOpen={handleFileOpen}
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
    { icon: '\u{1F4CA}', label: t('projectCopilot.quickTriage'), message: 'Triage the backlog and suggest execution order' },
    { icon: '\u{2795}', label: t('projectCopilot.quickCreate'), message: 'Help me create a new issue' },
    { icon: '\u{1F4CB}', label: t('projectCopilot.quickStatus'), message: 'Give me a project status summary' },
    { icon: '\u{1F680}', label: t('projectCopilot.quickExecute'), message: 'Pick the highest priority todo and start executing' },
  ]

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8">
      <h2 className="text-lg font-semibold text-white mb-2">{t('projectCopilot.welcome')}</h2>
      <p className="text-sm text-gray-400 mb-6 text-center max-w-md">
        {issueCount > 0
          ? t('projectCopilot.welcomeWithIssues')
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
}: {
  onSend: (content: string, mentionAgentId?: string) => Promise<void>
  onStop: () => void
  disabled: boolean
  isSending: boolean
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
            {t('chat.stopGeneration')}
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

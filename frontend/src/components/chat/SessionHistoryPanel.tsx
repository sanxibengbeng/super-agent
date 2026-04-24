import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Plus, MessageSquare, Trash2, PanelLeftClose, PanelLeftOpen, Clock, Loader2, Star, Pencil, Users, Search, X, Workflow } from 'lucide-react'
import { RestChatService } from '@/services/api/restChatService'
import { restClient } from '@/services/api/restClient'
import { sessionStreamManager } from '@/services/SessionStreamManager'
import { useTranslation } from '@/i18n'
import { PublishToShowcaseModal } from './PublishToShowcaseModal'

interface SessionItem {
  id: string
  title: string | null
  status: string
  is_starred: boolean
  room_mode: string
  source: string
  agent_id: string | null
  created_at: string
  updated_at: string
}

interface SessionHistoryPanelProps {
  businessScopeId: string | null
  activeSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onNewSession: () => void
  refreshKey?: number
}

type CategoryKey = 'starred' | 'groupChat' | 'workflow' | 'singleChat'

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function getTimeGroup(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 7) return 'thisWeek'
  if (diffDays < 30) return 'thisMonth'
  return 'older'
}

const TIME_GROUP_ORDER = ['today', 'yesterday', 'thisWeek', 'thisMonth', 'older'] as const

function categorizeSession(session: SessionItem): CategoryKey {
  if (session.is_starred) return 'starred'
  if (session.room_mode === 'group') return 'groupChat'
  if (session.source === 'workflow') return 'workflow'
  return 'singleChat'
}

const CATEGORY_ORDER: CategoryKey[] = ['starred', 'groupChat', 'workflow', 'singleChat']

interface CategoryConfig {
  labelKey: string
  icon: typeof Star
  iconClass: string
}

const CATEGORY_CONFIG: Record<CategoryKey, CategoryConfig> = {
  starred: { labelKey: 'sessionPanel.starred', icon: Star, iconClass: 'text-yellow-400' },
  groupChat: { labelKey: 'sessionPanel.groupChats', icon: Users, iconClass: 'text-purple-400' },
  workflow: { labelKey: 'sessionPanel.workflows', icon: Workflow, iconClass: 'text-green-400' },
  singleChat: { labelKey: 'sessionPanel.chats', icon: MessageSquare, iconClass: 'text-blue-400' },
}

export function SessionHistoryPanel({
  businessScopeId,
  activeSessionId,
  onSelectSession,
  onNewSession,
  refreshKey = 0,
}: SessionHistoryPanelProps) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(false)
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [collapsedCategories, setCollapsedCategories] = useState<Set<CategoryKey>>(new Set())
  const hasAutoSelected = useRef(false)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const loadSessions = useCallback(async (silent = false) => {
    if (!businessScopeId) {
      setSessions([])
      return
    }
    if (!silent) setLoading(true)
    try {
      const result = await RestChatService.getSessions(businessScopeId)
      const sorted = result
        .map(s => ({
          id: s.id,
          title: s.title ?? null,
          status: s.status ?? 'idle',
          is_starred: !!(s as any).is_starred,
          room_mode: (s as any).room_mode ?? 'single',
          source: (s as any).source ?? 'user',
          agent_id: (s as any).agent_id ?? null,
          created_at: s.created_at,
          updated_at: s.updated_at,
        }))
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      setSessions(sorted)

      if (!activeSessionId && !hasAutoSelected.current) {
        hasAutoSelected.current = true
        const generating = sorted.find(s => s.status === 'generating')
        if (generating) {
          onSelectSession(generating.id)
        }
      }
    } catch (err) {
      console.error('Failed to load sessions:', err)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [businessScopeId, activeSessionId, onSelectSession])

  useEffect(() => { void loadSessions() }, [loadSessions, refreshKey])

  // Auto-refresh when any session is generating (e.g. workflow in progress)
  const hasGenerating = sessions.some(s => s.status === 'generating')
  useEffect(() => {
    if (!hasGenerating) return
    const id = setInterval(() => { void loadSessions(true) }, 5000)
    return () => clearInterval(id)
  }, [hasGenerating, loadSessions])

  const handleDelete = useCallback(async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await RestChatService.clearHistory(sessionId)
      setSessions(prev => prev.filter(s => s.id !== sessionId))
      if (activeSessionId === sessionId) onNewSession()
    } catch (err) {
      console.error('Failed to delete session:', err)
    }
  }, [activeSessionId, onNewSession])

  const handleToggleStar = useCallback(async (sessionId: string, isStarred: boolean, e: React.MouseEvent) => {
    e.stopPropagation()
    if (isStarred) {
      try {
        await restClient.put(`/api/chat/sessions/${sessionId}/unstar`, {})
        setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, is_starred: false } : s))
      } catch (err) {
        console.error('Failed to unstar:', err)
      }
    } else {
      const session = sessions.find(s => s.id === sessionId)
      setPublishTarget({ id: sessionId, title: session?.title || null })
    }
  }, [sessions])

  const [publishTarget, setPublishTarget] = useState<{ id: string; title: string | null } | null>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)

  const handleStartRename = useCallback((sessionId: string, currentTitle: string | null, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingId(sessionId)
    setEditTitle(currentTitle || '')
    setTimeout(() => editInputRef.current?.focus(), 0)
  }, [])

  const handleSaveRename = useCallback(async () => {
    if (!editingId) return
    const trimmed = editTitle.trim()
    if (trimmed) {
      try {
        await restClient.put(`/api/chat/sessions/${editingId}`, { title: trimmed })
        setSessions(prev => prev.map(s => s.id === editingId ? { ...s, title: trimmed } : s))
      } catch (err) {
        console.error('Failed to rename session:', err)
      }
    }
    setEditingId(null)
  }, [editingId, editTitle])

  const handleCancelRename = useCallback(() => {
    setEditingId(null)
  }, [])

  const toggleCategory = useCallback((cat: CategoryKey) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }, [])

  const filteredSessions = useMemo(() => {
    if (!search.trim()) return sessions
    const q = search.toLowerCase()
    return sessions.filter(s =>
      (s.title || '').toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q)
    )
  }, [sessions, search])

  const groupedByCategory = useMemo(() => {
    const groups: Record<CategoryKey, Record<string, SessionItem[]>> = {
      starred: {},
      groupChat: {},
      workflow: {},
      singleChat: {},
    }

    for (const session of filteredSessions) {
      const cat = categorizeSession(session)
      const timeGroup = getTimeGroup(session.updated_at)
      if (!groups[cat][timeGroup]) groups[cat][timeGroup] = []
      groups[cat][timeGroup].push(session)
    }

    return groups
  }, [filteredSessions])

  const totalCount = filteredSessions.length

  const renderSessionItem = (session: SessionItem) => (
    <div
      key={session.id}
      onClick={() => onSelectSession(session.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelectSession(session.id) }}
      className={`w-full text-left px-3 py-2 hover:bg-gray-800/70 transition-colors group cursor-pointer ${
        activeSessionId === session.id ? 'bg-gray-800 border-l-2 border-l-blue-500' : 'border-l-2 border-l-transparent'
      }`}
    >
      <div className="flex items-start gap-2">
        {(sessionStreamManager.isSending(session.id) || session.status === 'generating') ? (
          <Loader2 className="w-3.5 h-3.5 text-blue-400 mt-0.5 flex-shrink-0 animate-spin" />
        ) : session.room_mode === 'group' ? (
          <Users className="w-3.5 h-3.5 text-purple-400 mt-0.5 flex-shrink-0" />
        ) : session.source === 'workflow' ? (
          <Workflow className="w-3.5 h-3.5 text-green-400 mt-0.5 flex-shrink-0" />
        ) : (
          <MessageSquare className="w-3.5 h-3.5 text-gray-500 mt-0.5 flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          {editingId === session.id ? (
            <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
              <input
                ref={editInputRef}
                type="text"
                value={editTitle}
                onChange={e => setEditTitle(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSaveRename()
                  if (e.key === 'Escape') handleCancelRename()
                }}
                onBlur={handleSaveRename}
                className="w-full px-1 py-0.5 bg-gray-900 border border-blue-500 rounded text-xs text-white focus:outline-none"
              />
            </div>
          ) : (
            <div
              className="text-xs text-gray-200 truncate leading-tight"
              onDoubleClick={(e) => handleStartRename(session.id, session.title, e)}
              title={session.title || t('sessionPanel.untitled')}
            >
              {session.title || t('sessionPanel.untitled')}
            </div>
          )}
          <div className="flex items-center gap-1 mt-0.5">
            <Clock className="w-2.5 h-2.5 text-gray-600" />
            <span className="text-[10px] text-gray-500">{formatRelativeTime(session.updated_at)}</span>
          </div>
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {editingId !== session.id && (
            <button
              onClick={(e) => handleStartRename(session.id, session.title, e)}
              className="p-0.5 rounded text-gray-600 hover:text-white opacity-0 group-hover:opacity-100 transition-all"
              title={t('sessionPanel.rename')}
            >
              <Pencil className="w-2.5 h-2.5" />
            </button>
          )}
          <button
            onClick={(e) => handleToggleStar(session.id, session.is_starred, e)}
            className={`p-0.5 rounded transition-all ${
              session.is_starred
                ? 'text-yellow-400 hover:text-yellow-300'
                : 'text-gray-600 hover:text-yellow-400 opacity-0 group-hover:opacity-100'
            }`}
            title={session.is_starred ? t('sessionPanel.unstar') : t('sessionPanel.star')}
          >
            <Star className="w-3 h-3" fill={session.is_starred ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={(e) => handleDelete(session.id, e)}
            className="p-0.5 rounded hover:bg-gray-600 text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
            title={t('sessionPanel.delete')}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  )

  if (collapsed) {
    return (
      <div className="flex flex-col items-center py-3 px-1 border-r border-gray-800 bg-gray-900/50">
        <button
          onClick={() => setCollapsed(false)}
          className="p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
          title={t('sessionPanel.expand')}
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
      </div>
    )
  }

  return (
    <div className="w-64 flex flex-col border-r border-gray-800 bg-gray-900/50 flex-shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-800">
        <span className="text-sm font-medium text-gray-300">{t('sessionPanel.title')}</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={onNewSession}
            className="p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
            title={t('sessionPanel.newChat')}
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            onClick={() => setCollapsed(true)}
            className="p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
            title={t('sessionPanel.collapse')}
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Search */}
      {businessScopeId && sessions.length > 0 && (
        <div className="px-2 py-2 border-b border-gray-800/50">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('sessionPanel.search')}
              className="w-full pl-7 pr-7 py-1.5 bg-gray-800 border border-gray-700 rounded-md text-xs text-white placeholder-gray-500 outline-none focus:border-blue-500 transition-colors"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Session list */}
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent">
        {!businessScopeId ? (
          <div className="px-3 py-8 text-xs text-gray-500 text-center">{t('sessionPanel.selectScope')}</div>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 px-3 py-8">
            <Loader2 className="w-4 h-4 text-gray-500 animate-spin" />
            <span className="text-xs text-gray-500">{t('sessionPanel.loading')}</span>
          </div>
        ) : (
          <>
            {/* New Chat placeholder */}
            {!activeSessionId && (
              <div className="w-full text-left px-3 py-2 bg-gray-800 border-l-2 border-l-blue-500 cursor-default">
                <div className="flex items-start gap-2">
                  <MessageSquare className="w-3.5 h-3.5 text-blue-400 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-white truncate leading-tight">{t('sessionPanel.newChat')}</div>
                    <div className="flex items-center gap-1 mt-0.5">
                      <Clock className="w-2.5 h-2.5 text-gray-600" />
                      <span className="text-[10px] text-gray-500">just now</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {totalCount === 0 && search ? (
              <div className="px-3 py-8 text-xs text-gray-500 text-center">{t('sessionPanel.noSearchResults')}</div>
            ) : totalCount === 0 && activeSessionId ? (
              <div className="px-3 py-8 text-xs text-gray-500 text-center">{t('sessionPanel.noSessions')}</div>
            ) : (
              CATEGORY_ORDER.map(catKey => {
                const timeGroups = groupedByCategory[catKey]
                const catSessions = Object.values(timeGroups).flat()
                if (catSessions.length === 0) return null

                const config = CATEGORY_CONFIG[catKey]
                const Icon = config.icon
                const isCollapsed = collapsedCategories.has(catKey)

                return (
                  <div key={catKey}>
                    {/* Category header */}
                    <button
                      onClick={() => toggleCategory(catKey)}
                      className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-wider font-semibold text-gray-500 hover:text-gray-300 hover:bg-gray-800/30 transition-colors sticky top-0 bg-gray-900/95 backdrop-blur-sm z-10 border-b border-gray-800/30"
                    >
                      <Icon className={`w-3 h-3 ${config.iconClass}`} fill={catKey === 'starred' ? 'currentColor' : 'none'} />
                      <span>{t(config.labelKey)}</span>
                      <span className="ml-auto text-gray-600 font-normal">{catSessions.length}</span>
                      <svg
                        className={`w-3 h-3 text-gray-600 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                        viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>

                    {!isCollapsed && TIME_GROUP_ORDER.map(tg => {
                      const items = timeGroups[tg]
                      if (!items || items.length === 0) return null

                      return (
                        <div key={tg}>
                          <div className="px-3 py-1 text-[10px] text-gray-600 font-medium">
                            {t(`sessionPanel.time.${tg}`)}
                          </div>
                          {items.map(renderSessionItem)}
                        </div>
                      )
                    })}
                  </div>
                )
              })
            )}
          </>
        )}
      </div>

      {/* Footer with session count */}
      {businessScopeId && sessions.length > 0 && (
        <div className="px-3 py-1.5 border-t border-gray-800 text-[10px] text-gray-600 text-center">
          {search ? `${totalCount} / ${sessions.length}` : `${sessions.length}`} {t('sessionPanel.sessions')}
        </div>
      )}

      {/* Publish to Showcase Modal */}
      {publishTarget && (
        <PublishToShowcaseModal
          sessionId={publishTarget.id}
          sessionTitle={publishTarget.title}
          onClose={() => setPublishTarget(null)}
          onPublished={() => {
            setSessions(prev => prev.map(s => s.id === publishTarget.id ? { ...s, is_starred: true } : s))
            setPublishTarget(null)
          }}
          onStarOnly={() => {
            setSessions(prev => prev.map(s => s.id === publishTarget.id ? { ...s, is_starred: true } : s))
            setPublishTarget(null)
          }}
        />
      )}
    </div>
  )
}

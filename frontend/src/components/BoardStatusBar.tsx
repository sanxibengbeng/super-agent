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

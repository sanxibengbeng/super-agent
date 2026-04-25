import { useState } from 'react'
import { X, Plus, GripVertical, Bot, MessageSquare } from 'lucide-react'
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

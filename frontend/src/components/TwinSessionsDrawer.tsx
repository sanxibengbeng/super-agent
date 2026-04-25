import { useState, useEffect } from 'react'
import { Plus, Users, X } from 'lucide-react'
import { useTranslation } from '@/i18n'
import { RestTwinSessionService, type TwinSessionSummary } from '@/services/api/restTwinSessionService'

interface TwinSessionsDrawerProps {
  projectId: string
  twinSessions: TwinSessionSummary[]
  onClose: () => void
  onSessionClick: (session: TwinSessionSummary) => void
  onCreateNew: () => void
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function TwinSessionsDrawer({
  projectId,
  twinSessions,
  onClose,
  onSessionClick,
  onCreateNew,
}: TwinSessionsDrawerProps) {
  const { t } = useTranslation()
  const [allSessions, setAllSessions] = useState<TwinSessionSummary[]>(twinSessions)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    RestTwinSessionService.list(projectId)
      .then(sessions => { if (!cancelled) setAllSessions(sessions) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectId])

  const projectLevel = allSessions.filter(s => !s.issue_id)
  const issueLevel = allSessions.filter(s => s.issue_id)

  return (
    <div className="border-b border-gray-800 bg-gray-900/80 flex-shrink-0">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800/50">
        <div className="flex items-center gap-2">
          <Users size={14} className="text-cyan-400" />
          <span className="text-xs font-medium text-white">{t('twinSession.title')}</span>
          <span className="text-[10px] text-gray-500">({allSessions.length})</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onCreateNew}
            className="flex items-center gap-1 px-2 py-1 text-[10px] bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
          >
            <Plus size={10} /> {t('twinSession.new')}
          </button>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-white rounded transition-colors">
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="max-h-[240px] overflow-y-auto px-3 py-2 space-y-1">
        {loading && allSessions.length === 0 && (
          <div className="text-[10px] text-gray-500 text-center py-4">{t('common.loading')}</div>
        )}

        {allSessions.length === 0 && !loading && (
          <div className="text-center py-4">
            <p className="text-[10px] text-gray-500 mb-2">{t('twinSession.empty')}</p>
            <button
              onClick={onCreateNew}
              className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
            >
              {t('twinSession.createFirst')}
            </button>
          </div>
        )}

        {projectLevel.length > 0 && (
          <div className="mb-2">
            <div className="text-[10px] text-gray-500 font-medium px-1 mb-1">{t('twinSession.projectLevel')}</div>
            {projectLevel.map(session => (
              <SessionRow key={session.id} session={session} onClick={() => onSessionClick(session)} />
            ))}
          </div>
        )}

        {issueLevel.length > 0 && (
          <div>
            {projectLevel.length > 0 && <div className="text-[10px] text-gray-500 font-medium px-1 mb-1">{t('twinSession.issueLevel')}</div>}
            {issueLevel.map(session => (
              <SessionRow key={session.id} session={session} onClick={() => onSessionClick(session)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SessionRow({ session, onClick }: { session: TwinSessionSummary; onClick: () => void }) {
  const isActive = session.session.status === 'active'

  return (
    <div
      onClick={onClick}
      className="flex items-center gap-2.5 px-2 py-1.5 rounded cursor-pointer hover:bg-gray-800 transition-colors group"
    >
      <div className="flex-shrink-0">
        {session.agent.avatar ? (
          <img src={session.agent.avatar} alt="" className="w-6 h-6 rounded-full" />
        ) : (
          <div className="w-6 h-6 rounded-full bg-gray-700 flex items-center justify-center text-[10px] text-gray-400">
            {(session.agent.display_name ?? session.agent.name).charAt(0).toUpperCase()}
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isActive ? 'bg-green-500' : 'bg-gray-600'}`} />
          <span className="text-xs text-white truncate">{session.agent.display_name ?? session.agent.name}</span>
          {session.issue && (
            <span className="text-[10px] text-gray-500 truncate">#{session.issue.issue_number} {session.issue.title}</span>
          )}
        </div>
        <div className="text-[10px] text-gray-600 ml-3">
          {timeAgo(session.created_at)}
        </div>
      </div>
    </div>
  )
}

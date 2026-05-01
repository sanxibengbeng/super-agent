import { useMemo } from 'react'
import { useState } from 'react'
import {
  Briefcase, LayoutGrid, Spade,
  Users, Zap, TrendingUp, Activity,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from '@/i18n'
import { CommandCenter } from '@/components'
import { useAgents } from '@/services/useAgents'
import { useBusinessScopes } from '@/services/useBusinessScopes'
import type { Agent, SystemStats } from '@/types'

type DashboardView = 'classic' | 'casino'

function calculateStats(agents: Agent[]): SystemStats {
  const activeAgents = agents.filter(a => a.status === 'active').length
  const totalTasks = agents.reduce((sum, a) => sum + (a.metrics?.taskCount || 0), 0)
  const avgCompliance = agents.length > 0
    ? Math.round(agents.reduce((sum, a) => sum + (a.metrics?.responseRate || 0), 0) / agents.length)
    : 0
  const activeTasks = agents.filter(a => a.status === 'busy').length * 2 + agents.filter(a => a.status === 'active').length
  return {
    totalActiveAgents: activeAgents,
    tasksAutomated: totalTasks,
    slaCompliance: avgCompliance,
    activeTaskCount: activeTasks,
  }
}

function findScopeForAgent(
  agent: Agent,
  businessScopes: { id: string; name: string }[],
): { id: string; name: string } | null {
  const dept = agent.department
  const byId = businessScopes.find(s => s.id === dept)
  if (byId) return byId
  const legacyNameMap: Record<string, string> = {
    hr: 'HR', it: 'IT', marketing: 'Marketing', sales: 'Sales', support: 'Customer Support',
  }
  const scopeName = legacyNameMap[dept] || dept
  return businessScopes.find(s => s.name.toLowerCase() === scopeName.toLowerCase()) || null
}

function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: typeof Users; label: string; value: string | number; sub?: string; color: string
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex items-start gap-4">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${color}`}>
        <Icon className="w-5 h-5 text-white" />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] text-gray-500 uppercase tracking-wider font-medium">{label}</p>
        <p className="text-2xl font-bold text-white leading-tight mt-0.5">{value}</p>
        {sub && <p className="text-[11px] text-gray-500 mt-0.5">{sub}</p>}
      </div>
    </div>
  )
}

function ScopeSummaryCard({
  name, icon, agentCount, activeCount, busyCount, taskCount, onClick,
}: {
  name: string; icon: string | null; agentCount: number; activeCount: number; busyCount: number; taskCount: number; onClick: () => void
}) {
  const offlineCount = agentCount - activeCount - busyCount

  return (
    <button
      onClick={onClick}
      className="w-full bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-gray-600 transition-all text-left group"
    >
      <div className="flex items-center gap-3 mb-3">
        <div className="w-9 h-9 rounded-lg bg-gray-800 flex items-center justify-center flex-shrink-0">
          {icon ? <span className="text-lg">{icon}</span> : <Briefcase className="w-4 h-4 text-gray-400" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate group-hover:text-blue-400 transition-colors">
            {name}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-gray-500">Agents</span>
          <span className="text-xs font-medium text-gray-300">{agentCount}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-gray-500">Tasks</span>
          <span className="text-xs font-medium text-gray-300">{taskCount}</span>
        </div>
        <div className="col-span-2 flex items-center gap-2 mt-1">
          {activeCount > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-green-400">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />{activeCount}
            </span>
          )}
          {busyCount > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-yellow-400">
              <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />{busyCount}
            </span>
          )}
          {offlineCount > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-gray-500">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-600" />{offlineCount}
            </span>
          )}
          {agentCount === 0 && (
            <span className="text-[10px] text-gray-600">No agents</span>
          )}
        </div>
      </div>
    </button>
  )
}

export function Dashboard() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [view, setView] = useState<DashboardView>('classic')
  const { agents, isLoading: agentsLoading } = useAgents({ pollInterval: 5000 })
  const { businessScopes, isLoading: scopesLoading } = useBusinessScopes()

  const stats = useMemo(() => calculateStats(agents), [agents])

  const agentsByScopeId = useMemo(() => {
    const grouped: Record<string, Agent[]> = {}
    for (const agent of agents) {
      const scope = findScopeForAgent(agent, businessScopes)
      const key = scope?.id || 'unassigned'
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(agent)
    }
    return grouped
  }, [agents, businessScopes])

  const isLoading = agentsLoading || scopesLoading

  if (isLoading) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <div className="text-gray-400">{t('common.loading')}</div>
      </div>
    )
  }

  const busyCount = agents.filter(a => a.status === 'busy').length
  const offlineCount = agents.filter(a => a.status === 'offline').length

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-white">{t('nav.dashboard')}</h1>
        <div className="flex items-center gap-1 bg-gray-800/60 rounded-lg p-1 border border-white/[0.06]">
          <button
            onClick={() => setView('classic')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${view === 'classic' ? 'bg-purple-600 text-white' : 'text-gray-400 hover:text-white'}`}
          >
            <LayoutGrid className="w-3.5 h-3.5" />
            Overview
          </button>
          <button
            onClick={() => setView('casino')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${view === 'casino' ? 'bg-purple-600 text-white' : 'text-gray-400 hover:text-white'}`}
          >
            <Spade className="w-3.5 h-3.5" />
            Casino
          </button>
        </div>
      </div>

      {view === 'casino' ? (
        <CommandCenter
          stats={stats}
          businessScopes={businessScopes}
          agentsByScopeId={agentsByScopeId}
        />
      ) : (
        <div className="space-y-6">
          {/* Stat Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              icon={Users}
              label={t('dashboard.activeAgents') || 'Active Agents'}
              value={stats.totalActiveAgents}
              sub={`${busyCount} busy · ${offlineCount} offline`}
              color="bg-blue-600/80"
            />
            <StatCard
              icon={Zap}
              label={t('dashboard.tasksCompleted') || 'Tasks Completed'}
              value={stats.tasksAutomated.toLocaleString()}
              color="bg-purple-600/80"
            />
            <StatCard
              icon={TrendingUp}
              label={t('dashboard.responseRate') || 'Response Rate'}
              value={`${stats.slaCompliance}%`}
              color="bg-emerald-600/80"
            />
            <StatCard
              icon={Activity}
              label={t('dashboard.activeTasks') || 'Active Tasks'}
              value={stats.activeTaskCount}
              color="bg-amber-600/80"
            />
          </div>

          {/* Scope Summary Grid */}
          <div>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
              {t('dashboard.scopes') || 'Business Scopes'}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {businessScopes.map((scope) => {
                const scopeAgents = agentsByScopeId[scope.id] || []
                const activeCount = scopeAgents.filter(a => a.status === 'active').length
                const scopeBusyCount = scopeAgents.filter(a => a.status === 'busy').length
                const taskCount = scopeAgents.reduce((sum, a) => sum + (a.metrics?.taskCount || 0), 0)

                return (
                  <ScopeSummaryCard
                    key={scope.id}
                    name={scope.name}
                    icon={scope.icon ?? null}
                    agentCount={scopeAgents.length}
                    activeCount={activeCount}
                    busyCount={scopeBusyCount}
                    taskCount={taskCount}
                    onClick={() => navigate(`/agents?scope=${scope.id}`)}
                  />
                )
              })}
            </div>
          </div>

          {/* Unassigned agents hint */}
          {(agentsByScopeId['unassigned']?.length ?? 0) > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Briefcase className="w-4 h-4 text-gray-500" />
                <span className="text-sm text-gray-400">
                  {agentsByScopeId['unassigned'].length} unassigned agent{agentsByScopeId['unassigned'].length > 1 ? 's' : ''}
                </span>
              </div>
              <button
                onClick={() => navigate('/agents')}
                className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                Manage →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

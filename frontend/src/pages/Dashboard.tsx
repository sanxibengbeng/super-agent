import { useMemo, useState } from 'react'
import { Briefcase, LayoutGrid, Spade, Plus } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from '@/i18n'
import { DepartmentSection, CommandCenter } from '@/components'
import { useAgents } from '@/services/useAgents'
import { useBusinessScopes } from '@/services/useBusinessScopes'
import type { Agent, SystemStats } from '@/types'

type DashboardView = 'classic' | 'casino'

// Default icon colors for business scopes that don't have a color set
const DEFAULT_COLORS = [
  'bg-purple-500/20',
  'bg-blue-500/20',
  'bg-pink-500/20',
  'bg-green-500/20',
  'bg-orange-500/20',
  'bg-cyan-500/20',
  'bg-yellow-500/20',
]

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
    activeTaskCount: activeTasks 
  }
}

// Maps legacy department names to business scope names for backward compatibility
function findScopeForAgent(
  agent: Agent, 
  businessScopes: { id: string; name: string }[]
): { id: string; name: string } | null {
  const dept = agent.department
  
  // First try to match by ID (UUID from Supabase)
  const byId = businessScopes.find(s => s.id === dept)
  if (byId) return byId
  
  // Fall back to matching by name (legacy department names)
  const legacyNameMap: Record<string, string> = {
    'hr': 'HR',
    'it': 'IT',
    'marketing': 'Marketing',
    'sales': 'Sales',
    'support': 'Customer Support',
  }
  const scopeName = legacyNameMap[dept] || dept
  return businessScopes.find(s => s.name.toLowerCase() === scopeName.toLowerCase()) || null
}

export function Dashboard() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [view, setView] = useState<DashboardView>('classic')
  const { agents, isLoading: agentsLoading } = useAgents({ pollInterval: 5000 })
  const { businessScopes, isLoading: scopesLoading } = useBusinessScopes()

  const stats = useMemo(() => calculateStats(agents), [agents])
  
  // Group agents by their business scope
  const agentsByScopeId = useMemo(() => {
    const grouped: Record<string, Agent[]> = {}
    
    for (const agent of agents) {
      const scope = findScopeForAgent(agent, businessScopes)
      const key = scope?.id || 'unassigned'
      if (!grouped[key]) {
        grouped[key] = []
      }
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

  return (
    <div className="p-6 space-y-6">
      {/* Header with view toggle and create button */}
      <div className="flex items-center justify-end">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/create-business-scope')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-gradient-to-r from-purple-500 to-blue-600 text-white hover:shadow-lg hover:shadow-purple-500/20 transition-all"
          >
            <Plus className="w-3.5 h-3.5" />
            Create Scope
          </button>
          <div className="flex items-center gap-1 bg-gray-800/60 rounded-lg p-1 border border-white/[0.06]">
            <button
              onClick={() => setView('classic')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${view === 'classic' ? 'bg-purple-600 text-white' : 'text-gray-400 hover:text-white'}`}
              aria-label="Classic dashboard view"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              Classic
            </button>
            <button
              onClick={() => setView('casino')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${view === 'casino' ? 'bg-purple-600 text-white' : 'text-gray-400 hover:text-white'}`}
              aria-label="Casino dashboard view"
            >
              <Spade className="w-3.5 h-3.5" />
              Casino
            </button>
          </div>
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
            {businessScopes.map((scope, index) => {
              const scopeAgents = agentsByScopeId[scope.id] || []
              const bgColor = scope.color 
                ? `bg-[${scope.color}]/20` 
                : DEFAULT_COLORS[index % DEFAULT_COLORS.length]
              
              return (
                <DepartmentSection
                  key={scope.id}
                  name={scope.name}
                  icon={scope.icon ? <span>{scope.icon}</span> : <Briefcase className="w-4 h-4 text-white" />}
                  color={bgColor}
                  agents={scopeAgents}
                />
              )
            })}
            
            {/* Show unassigned agents if any */}
            {agentsByScopeId['unassigned']?.length > 0 && (
              <DepartmentSection
                name={t('dashboard.unassigned') || 'Unassigned'}
                icon={<Briefcase className="w-4 h-4 text-white" />}
                color="bg-gray-500/20"
                agents={agentsByScopeId['unassigned']}
              />
            )}
          </div>
      )}
    </div>
  )
}

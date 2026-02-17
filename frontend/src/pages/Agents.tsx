import { useState, useEffect, useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { Users, Loader2 } from 'lucide-react'
import { useTranslation } from '@/i18n'
import { useAgents } from '@/services'
import { useBusinessScopes } from '@/services/useBusinessScopes'
import { AgentList, AgentProfile, ScopeProfile } from '@/components'
import type { Agent, AgentStatus } from '@/types'

export function Agents() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { agents, isLoading, error, getAgentById, updateAgent, deleteAgent } = useAgents({ pollInterval: 5000 })
  const { businessScopes } = useBusinessScopes()

  // Get agent ID and scope ID from URL params
  const selectedAgentId = useMemo(() => searchParams.get('id'), [searchParams])
  const selectedScopeId = useMemo(() => searchParams.get('scope'), [searchParams])

  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
  const [isLoadingAgent, setIsLoadingAgent] = useState(false)

  // Load selected agent details
  useEffect(() => {
    let isMounted = true
    async function loadAgent() {
      if (!selectedAgentId) { setSelectedAgent(null); return }
      setIsLoadingAgent(true)
      const agent = await getAgentById(selectedAgentId)
      if (isMounted) { setSelectedAgent(agent); setIsLoadingAgent(false) }
    }
    loadAgent()
    return () => { isMounted = false }
  }, [selectedAgentId, getAgentById])

  const handleSelectAgent = (agentId: string) => {
    navigate(`/agents?id=${agentId}`, { replace: true })
  }

  const handleSelectScope = (scopeId: string) => {
    navigate(`/agents?scope=${scopeId}`, { replace: true })
  }

  const handleConfigureAgent = (agentId: string) => {
    navigate(`/agents/config/${agentId}`)
  }

  const handleRemoveAgent = async (agentId: string) => {
    if (window.confirm(t('agents.confirmRemove'))) {
      const success = await deleteAgent(agentId)
      if (success) { setSelectedAgent(null); navigate('/agents', { replace: true }) }
    }
  }

  const handleToggleAgentStatus = async (agentId: string, newStatus: AgentStatus) => {
    const updated = await updateAgent(agentId, { status: newStatus })
    if (updated) setSelectedAgent(updated)
  }

  // Find selected scope
  const selectedScope = selectedScopeId
    ? businessScopes.find(s => s.id === selectedScopeId) ?? null
    : null

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-6">
        <p className="text-red-400 mb-4">{error}</p>
        <button onClick={() => window.location.reload()}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white transition-colors">
          {t('common.retry')}
        </button>
      </div>
    )
  }

  // Determine what to show in the right panel
  const showAgent = selectedAgentId && selectedAgent && !selectedScopeId
  const showScope = selectedScopeId && selectedScope && !selectedAgentId

  return (
    <div className="flex h-full">
      {/* Left Panel - Agent List */}
      <div className="w-72 border-r border-gray-800 bg-gray-900 flex flex-col">
        <div className="p-4 border-b border-gray-800">
          <p className="text-xs text-gray-400 mt-1">
            {agents.length} {t('common.allAgents').toLowerCase()}
          </p>
        </div>
        <div className="flex-1 overflow-hidden">
          <AgentList
            agents={agents}
            selectedAgentId={selectedAgentId}
            selectedScopeId={selectedScopeId}
            onSelectAgent={handleSelectAgent}
            onSelectScope={handleSelectScope}
          />
        </div>
      </div>

      {/* Right Panel */}
      <div className="flex-1 bg-gray-950">
        {isLoadingAgent ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
          </div>
        ) : showAgent ? (
          <AgentProfile
            agent={selectedAgent}
            onConfigure={handleConfigureAgent}
            onRemove={handleRemoveAgent}
            onToggleStatus={handleToggleAgentStatus}
          />
        ) : showScope ? (
          <ScopeProfile scope={selectedScope} agents={agents.filter(a => a.department === selectedScopeId)} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center p-6">
            <div className="w-16 h-16 rounded-full bg-gray-800 flex items-center justify-center mb-4">
              <Users className="w-8 h-8 text-gray-600" />
            </div>
            <h3 className="text-lg font-medium text-gray-400 mb-2">
              {t('agents.profile')}
            </h3>
            <p className="text-sm text-gray-500 max-w-xs">
              {t('agents.selectPrompt')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

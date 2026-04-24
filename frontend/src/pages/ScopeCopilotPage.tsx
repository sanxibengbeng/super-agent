import { useEffect, useState, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Sparkles, Save, Loader2 } from 'lucide-react'
import { ScopeWorkspace } from '@/components/ScopeWorkspace'
import { ScopeCopilot } from '@/components/ScopeCopilot'
import { useScopeDraft } from '@/hooks/useScopeDraft'
import { useToast } from '@/components'
import type { GeneratedScopeConfig } from '@/services/scopeGeneratorService'
import type { AgentDraft, ScopeDraft } from '@/hooks/useScopeDraft'
import { consumeSopFile } from '@/services/sopFileStore'

export interface ServerVersion {
  draft: ScopeDraft
  updatedAt: string
}

export function ScopeCopilotPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { success: showSuccess, error: showError } = useToast()

  const scopeId = searchParams.get('scopeId')
  const initialDescription = searchParams.get('description') || undefined
  const language = (searchParams.get('language') as 'en' | 'cn') || 'en'

  const [sopFile] = useState<File | null>(() => consumeSopFile())
  const [isLoading, setIsLoading] = useState(true)
  const [serverVersion, setServerVersion] = useState<ServerVersion | null>(null)

  const {
    draft, chatHistory, setChatHistory,
    isDirty, isSaving, versions, currentVersion, activeAgents,
    initializeFromApi, applyFullConfig, applyPatches,
    updateScope, updateAgent, addAgent, removeAgent, restoreAgent,
    startOver, createSnapshot, loadVersion, save,
  } = useScopeDraft(scopeId)

  // Redirect if no scopeId
  useEffect(() => {
    if (!scopeId) {
      navigate('/create-business-scope')
    }
  }, [scopeId, navigate])

  const loadServerVersion = useCallback(() => {
    if (!serverVersion) return
    initializeFromApi(serverVersion.draft.scope, serverVersion.draft.agents)
  }, [serverVersion, initializeFromApi])

  // Fetch scope from API on mount
  useEffect(() => {
    if (!scopeId) return

    const fetchScope = async () => {
      try {
        const { getAuthToken } = await import('@/services/api/restClient')
        const token = getAuthToken()
        const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'

        const response = await fetch(`${API_BASE_URL}/api/business-scopes/${scopeId}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })

        if (!response.ok) {
          if (response.status === 404) {
            navigate('/create-business-scope')
            return
          }
          throw new Error(`Failed to fetch scope: ${response.status}`)
        }

        const data = await response.json()
        const scope = data.data ?? data

        const existingAgents: AgentDraft[] = (scope.agents ?? []).map((a: {
          id: string; name: string; display_name?: string; displayName?: string;
          role?: string; system_prompt?: string; systemPrompt?: string;
          skills?: Array<{ name: string; description?: string; body?: string }>
        }) => ({
          id: a.id,
          name: a.name,
          displayName: a.display_name ?? a.displayName ?? a.name,
          role: a.role ?? '',
          systemPrompt: a.system_prompt ?? a.systemPrompt ?? '',
          skills: a.skills ?? [],
          _localId: `api-${a.id}`,
          _deleted: false,
        }))

        const scopeFields = {
          name: scope.name || '',
          description: scope.description || '',
          icon: scope.icon || '📋',
          color: scope.color || '#6366f1',
        }

        const apiDraft: ScopeDraft = { scope: scopeFields, agents: existingAgents }
        const apiUpdatedAt = scope.updated_at ?? scope.updatedAt ?? ''
        setServerVersion({ draft: apiDraft, updatedAt: apiUpdatedAt })

        // Always default to server version
        initializeFromApi(scopeFields, existingAgents)
        const lsDraft = localStorage.getItem(`scopeDraft:${scopeId}`)
        if (!lsDraft) {
          const label = existingAgents.length > 0 ? 'Loaded from database' : 'Empty scope created'
          createSnapshot(label, 'created')
        }
      } catch (err) {
        console.error('Failed to load scope:', err)
        showError('Error', 'Failed to load scope')
      } finally {
        setIsLoading(false)
      }
    }

    void fetchScope()
  }, [scopeId])

  const handleSave = async () => {
    try {
      await save()
      showSuccess('Saved', 'Scope configuration saved successfully')
    } catch (err) {
      showError('Save Failed', err instanceof Error ? err.message : 'Unknown error')
    }
  }

  const currentConfig: GeneratedScopeConfig | null = activeAgents.length > 0
    ? { scope: draft.scope, agents: activeAgents }
    : null

  if (!scopeId) return null

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-purple-400" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 flex-shrink-0">
        <button onClick={() => navigate('/')} className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <Sparkles className="w-4 h-4 text-purple-400" />
        <span className="text-sm font-semibold text-white">Scope Copilot</span>
        {draft.scope.name && (
          <>
            <span className="text-gray-600">—</span>
            <span className="text-sm text-gray-400">{draft.scope.name}</span>
          </>
        )}
        <div className="flex-1" />
        {isDirty && (
          <span className="px-2 py-1 rounded text-[10px] bg-yellow-500/20 text-yellow-400">● Unsaved</span>
        )}
        <button
          onClick={handleSave}
          disabled={!isDirty || isSaving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-gray-800 border border-gray-700 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Save
        </button>
      </div>

      {/* Split pane */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Workspace */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <ScopeWorkspace
            scope={draft.scope}
            agents={draft.agents}
            activeAgents={activeAgents}
            versions={versions}
            currentVersion={currentVersion}
            serverVersion={serverVersion}
            onUpdateScope={updateScope}
            onUpdateAgent={updateAgent}
            onAddAgent={addAgent}
            onRemoveAgent={removeAgent}
            onRestoreAgent={restoreAgent}
            onEditComplete={() => createSnapshot('Manual edit', 'manual-edit')}
            onLoadVersion={loadVersion}
            onLoadServerVersion={loadServerVersion}
            onStartOver={startOver}
          />
        </div>

        {/* Right: Chat */}
        <div className="w-96 border-l border-gray-800 bg-gray-900/95 flex flex-col flex-shrink-0">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-400" />
            <span className="text-sm font-medium text-white">AI Chat</span>
          </div>
          <div className="flex-1 min-h-0">
            <ScopeCopilot
              scopeId={scopeId}
              hasAgents={activeAgents.length > 0}
              currentConfig={currentConfig}
              chatHistory={chatHistory}
              onChatHistoryChange={setChatHistory}
              onApplyFullConfig={applyFullConfig}
              onApplyPatches={applyPatches}
              onCreateSnapshot={createSnapshot}
              initialDescription={initialDescription}
              sopFile={sopFile}
              language={language}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

import { useState, useCallback, useEffect, useRef } from 'react'
import type { GeneratedScope, GeneratedAgent, GeneratedScopeConfig } from '@/services/scopeGeneratorService'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentDraft extends GeneratedAgent {
  id?: string
  _localId: string
  _deleted: boolean
}

export interface ScopeDraft {
  scope: GeneratedScope
  agents: AgentDraft[]
}

export interface ChatMessageDraft {
  id: string
  role: 'user' | 'assistant'
  content: string
  status?: 'streaming' | 'done' | 'error'
  timestamp: number
}

interface StoredDraft {
  draft: ScopeDraft
  chatHistory: ChatMessageDraft[]
  lastModified: number
}

export interface VersionSnapshot {
  version: number
  label: string
  timestamp: number
  source: 'created' | 'ai-generated' | 'ai-modified' | 'manual-edit' | 'saved'
  data: ScopeDraft
}

// ---------------------------------------------------------------------------
// LocalStorage helpers
// ---------------------------------------------------------------------------

const MAX_VERSIONS = 20

function loadDraft(scopeId: string): StoredDraft | null {
  try {
    const raw = localStorage.getItem(`scopeDraft:${scopeId}`)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveDraftToStorage(scopeId: string, stored: StoredDraft): void {
  try {
    localStorage.setItem(`scopeDraft:${scopeId}`, JSON.stringify(stored))
  } catch { /* storage full — silently ignore */ }
}

function loadVersions(scopeId: string): VersionSnapshot[] {
  try {
    const raw = localStorage.getItem(`scopeVersions:${scopeId}`)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveVersionsToStorage(scopeId: string, versions: VersionSnapshot[]): void {
  try {
    localStorage.setItem(`scopeVersions:${scopeId}`, JSON.stringify(versions))
  } catch { /* storage full */ }
}

// ---------------------------------------------------------------------------
// UID helper
// ---------------------------------------------------------------------------

let _counter = 0
function localId(): string {
  return `local-${++_counter}-${Date.now()}`
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const EMPTY_SCOPE: GeneratedScope = { name: '', description: '', icon: '📋', color: '#6366f1' }

export function useScopeDraft(scopeId: string | null) {
  const [draft, setDraft] = useState<ScopeDraft>(() => {
    if (!scopeId) return { scope: EMPTY_SCOPE, agents: [] }
    const stored = loadDraft(scopeId)
    return stored ? stored.draft : { scope: EMPTY_SCOPE, agents: [] }
  })
  const [chatHistory, setChatHistory] = useState<ChatMessageDraft[]>(() => {
    if (!scopeId) return []
    const stored = loadDraft(scopeId)
    return stored ? stored.chatHistory : []
  })
  const [isDirty, setIsDirty] = useState(false)
  const [versions, setVersions] = useState<VersionSnapshot[]>(() => scopeId ? loadVersions(scopeId) : [])
  const [isSaving, setIsSaving] = useState(false)
  const savedDraftRef = useRef<string>(
    scopeId ? (() => { const s = loadDraft(scopeId); return s ? JSON.stringify(s.draft) : '' })() : ''
  )

  // Re-sync if scopeId changes after mount
  useEffect(() => {
    if (!scopeId) return
    const stored = loadDraft(scopeId)
    if (stored) {
      setDraft(stored.draft)
      setChatHistory(stored.chatHistory)
      setIsDirty(false)
      savedDraftRef.current = JSON.stringify(stored.draft)
    }
    setVersions(loadVersions(scopeId))
  }, [scopeId])

  // Persist to LocalStorage on every draft/chat change
  useEffect(() => {
    if (!scopeId) return
    const stored: StoredDraft = { draft, chatHistory, lastModified: Date.now() }
    saveDraftToStorage(scopeId, stored)
  }, [scopeId, draft, chatHistory])

  // -----------------------------------------------------------------------
  // Version management
  // -----------------------------------------------------------------------

  const createSnapshot = useCallback((label: string, source: VersionSnapshot['source']) => {
    if (!scopeId) return
    setVersions(prev => {
      const nextVersion = prev.length > 0 ? prev[prev.length - 1].version + 1 : 0
      const snapshot: VersionSnapshot = {
        version: nextVersion,
        label,
        timestamp: Date.now(),
        source,
        data: JSON.parse(JSON.stringify(draft)),
      }
      const updated = [...prev, snapshot].slice(-MAX_VERSIONS)
      saveVersionsToStorage(scopeId, updated)
      return updated
    })
  }, [scopeId, draft])

  const loadVersion = useCallback((version: number) => {
    const snapshot = versions.find(v => v.version === version)
    if (!snapshot) return
    setDraft(JSON.parse(JSON.stringify(snapshot.data)))
    setIsDirty(true)
  }, [versions])

  // -----------------------------------------------------------------------
  // Draft mutations
  // -----------------------------------------------------------------------

  const initializeFromApi = useCallback((scope: GeneratedScope, agents: AgentDraft[]) => {
    const newDraft = { scope, agents }
    setDraft(newDraft)
    savedDraftRef.current = JSON.stringify(newDraft)
    setIsDirty(false)
  }, [])

  const applyFullConfig = useCallback((config: GeneratedScopeConfig) => {
    const agents: AgentDraft[] = config.agents.map(a => ({
      ...a,
      _localId: localId(),
      _deleted: false,
    }))
    setDraft({ scope: config.scope, agents })
    setIsDirty(true)
  }, [])

  const applyPatches = useCallback((patches: Array<{ op: string; path: string; value?: unknown }>) => {
    setDraft(prev => {
      const next = JSON.parse(JSON.stringify(prev)) as ScopeDraft
      for (const patch of patches) {
        const segments = patch.path.split('/').filter(Boolean)
        let target: unknown = next
        for (let i = 0; i < segments.length - 1; i++) {
          const seg = segments[i]
          const idx = Number(seg)
          target = Number.isNaN(idx)
            ? (target as Record<string, unknown>)[seg]
            : (target as unknown[])[idx]
        }
        const lastSeg = segments[segments.length - 1]
        const lastIdx = Number(lastSeg)

        if (patch.op === 'replace') {
          if (Number.isNaN(lastIdx)) {
            (target as Record<string, unknown>)[lastSeg] = patch.value
          } else {
            (target as unknown[])[lastIdx] = patch.value
          }
        } else if (patch.op === 'add') {
          if (Array.isArray(target)) {
            if (lastSeg === '-') {
              (target as unknown[]).push(patch.value)
            } else {
              (target as unknown[]).splice(lastIdx, 0, patch.value)
            }
          } else {
            (target as Record<string, unknown>)[lastSeg] = patch.value
          }
        } else if (patch.op === 'remove') {
          if (Array.isArray(target)) {
            (target as unknown[]).splice(lastIdx, 1)
          } else {
            delete (target as Record<string, unknown>)[lastSeg]
          }
        }
      }
      return next
    })
    setIsDirty(true)
  }, [])

  const updateScope = useCallback((fields: Partial<GeneratedScope>) => {
    setDraft(prev => ({ ...prev, scope: { ...prev.scope, ...fields } }))
    setIsDirty(true)
  }, [])

  const updateAgent = useCallback((agentLocalId: string, fields: Partial<AgentDraft>) => {
    setDraft(prev => ({
      ...prev,
      agents: prev.agents.map(a => a._localId === agentLocalId ? { ...a, ...fields } : a),
    }))
    setIsDirty(true)
  }, [])

  const addAgent = useCallback(() => {
    const newAgent: AgentDraft = {
      name: `new-agent-${Date.now()}`,
      displayName: 'New Agent',
      role: 'Define this agent\'s role',
      systemPrompt: 'You are a helpful assistant.',
      skills: [],
      _localId: localId(),
      _deleted: false,
    }
    setDraft(prev => ({ ...prev, agents: [...prev.agents, newAgent] }))
    setIsDirty(true)
    return newAgent._localId
  }, [])

  const removeAgent = useCallback((agentLocalId: string) => {
    setDraft(prev => ({
      ...prev,
      agents: prev.agents.map(a => a._localId === agentLocalId ? { ...a, _deleted: true } : a),
    }))
    setIsDirty(true)
  }, [])

  const restoreAgent = useCallback((localId: string) => {
    setDraft(prev => ({
      ...prev,
      agents: prev.agents.map(a => a._localId === localId ? { ...a, _deleted: false } : a),
    }))
    setIsDirty(true)
  }, [])

  const startOver = useCallback(() => {
    createSnapshot('Before reset', 'manual-edit')
    setDraft({ scope: { ...EMPTY_SCOPE, name: draft.scope.name }, agents: [] })
    setChatHistory([])
    setIsDirty(true)
  }, [createSnapshot, draft.scope.name])

  // -----------------------------------------------------------------------
  // Save to backend
  // -----------------------------------------------------------------------

  const save = useCallback(async (): Promise<boolean> => {
    if (!scopeId) return false
    setIsSaving(true)
    try {
      const { getAuthToken } = await import('@/services/api/restClient')
      const token = getAuthToken()
      const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'

      const response = await fetch(`${API_BASE_URL}/api/scope-generator/save`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          scopeId,
          config: {
            scope: draft.scope,
            agents: draft.agents.map(a => ({
              ...(a.id ? { id: a.id } : {}),
              name: a.name,
              displayName: a.displayName,
              role: a.role,
              systemPrompt: a.systemPrompt,
              skills: a.skills,
              _deleted: a._deleted,
            })),
          },
        }),
      })

      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error || `Save failed: ${response.status}`)
      }

      const result = await response.json()

      // Update agent IDs from server response
      const serverAgents = result.data?.agents as Array<{ id: string; name: string }> | undefined
      if (serverAgents) {
        setDraft(prev => {
          const updated = { ...prev, agents: prev.agents.filter(a => !a._deleted).map(a => {
            const match = serverAgents.find(sa => sa.name === a.name)
            return match ? { ...a, id: match.id } : a
          })}
          savedDraftRef.current = JSON.stringify(updated)
          return updated
        })
      }

      setIsDirty(false)
      createSnapshot('Saved', 'saved')
      return true
    } catch (error) {
      console.error('[useScopeDraft] Save failed:', error)
      throw error
    } finally {
      setIsSaving(false)
    }
  }, [scopeId, draft, createSnapshot])

  // -----------------------------------------------------------------------
  // Derived
  // -----------------------------------------------------------------------

  const activeAgents = draft.agents.filter(a => !a._deleted)
  const currentVersion = versions.length > 0 ? versions[versions.length - 1] : null

  return {
    draft,
    chatHistory,
    setChatHistory,
    isDirty,
    isSaving,
    versions,
    currentVersion,
    activeAgents,
    initializeFromApi,
    applyFullConfig,
    applyPatches,
    updateScope,
    updateAgent,
    addAgent,
    removeAgent,
    restoreAgent,
    startOver,
    createSnapshot,
    loadVersion,
    save,
  }
}

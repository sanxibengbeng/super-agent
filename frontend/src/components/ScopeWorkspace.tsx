import { useState } from 'react'
import { Pencil, Plus, Trash2, RefreshCw, ChevronDown, X, Clock } from 'lucide-react'
import type { GeneratedScope } from '@/services/scopeGeneratorService'
import type { AgentDraft, VersionSnapshot } from '@/hooks/useScopeDraft'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScopeWorkspaceProps {
  scope: GeneratedScope
  agents: AgentDraft[]
  activeAgents: AgentDraft[]
  versions: VersionSnapshot[]
  currentVersion: VersionSnapshot | null
  onUpdateScope: (fields: Partial<GeneratedScope>) => void
  onUpdateAgent: (localId: string, fields: Partial<AgentDraft>) => void
  onAddAgent: () => string
  onRemoveAgent: (localId: string) => void
  onRestoreAgent: (localId: string) => void
  onLoadVersion: (version: number) => void
  onStartOver: () => void
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ScopeOverviewCard({
  scope, onUpdate,
}: {
  scope: GeneratedScope
  onUpdate: (fields: Partial<GeneratedScope>) => void
}) {
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <div className="rounded-xl border border-blue-500/40 bg-gray-800/60 p-4 space-y-3">
        <div className="flex justify-between items-center">
          <span className="text-sm font-medium text-gray-300">Edit Scope</span>
          <button onClick={() => setEditing(false)} className="text-xs text-blue-400 hover:text-blue-300">Done</button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-500">Name</label>
            <input value={scope.name} onChange={e => onUpdate({ name: e.target.value })}
              className="w-full mt-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="text-xs text-gray-500">Icon (emoji)</label>
            <input value={scope.icon} onChange={e => onUpdate({ icon: e.target.value })}
              className="w-full mt-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-500">Description</label>
          <textarea value={scope.description} onChange={e => onUpdate({ description: e.target.value })} rows={2}
            className="w-full mt-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none" />
        </div>
        <div>
          <label className="text-xs text-gray-500">Color</label>
          <div className="flex items-center gap-2 mt-1">
            <input type="color" value={scope.color} onChange={e => onUpdate({ color: e.target.value })}
              className="w-8 h-8 rounded cursor-pointer border-0" />
            <span className="text-xs text-gray-400">{scope.color}</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-gray-700 bg-gray-800/60 p-4 flex items-center gap-4 group cursor-pointer hover:border-gray-600 transition-colors"
      onClick={() => setEditing(true)}>
      <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl" style={{ backgroundColor: `${scope.color}20` }}>
        {scope.icon || '📋'}
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="text-base font-semibold text-white">{scope.name || 'Untitled Scope'}</h3>
        {scope.description && <p className="text-sm text-gray-400 mt-0.5 truncate">{scope.description}</p>}
      </div>
      <Pencil className="w-4 h-4 text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity" />
    </div>
  )
}

function AgentGridCard({
  agent, isSelected, onClick,
}: {
  agent: AgentDraft
  isSelected: boolean
  onClick: () => void
}) {
  const skillCount = agent.skills?.length ?? 0
  return (
    <div
      onClick={onClick}
      className={`p-3 rounded-lg cursor-pointer transition-all ${
        agent._deleted
          ? 'bg-gray-800/30 border border-gray-700/50 opacity-50'
          : isSelected
          ? 'bg-gray-800/80 border-2 border-indigo-500'
          : 'bg-gray-800/60 border border-gray-700 hover:border-gray-600'
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white ${
          agent._deleted ? 'bg-gray-700' : 'bg-gradient-to-br from-blue-500 to-purple-600'
        }`}>
          {agent.displayName.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className={`text-sm font-medium truncate ${agent._deleted ? 'text-gray-500 line-through' : 'text-white'}`}>
            {agent.displayName}
          </div>
          <div className="text-xs text-gray-500">{skillCount} skill{skillCount !== 1 ? 's' : ''}</div>
        </div>
      </div>
    </div>
  )
}

function AgentDetailPanel({
  agent, onUpdate, onRemove, onRestore, onClose,
}: {
  agent: AgentDraft
  onUpdate: (fields: Partial<AgentDraft>) => void
  onRemove: () => void
  onRestore: () => void
  onClose: () => void
}) {
  const [editing, setEditing] = useState(false)

  return (
    <div className="rounded-xl border border-indigo-500/30 bg-gray-800/60 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-700 flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-sm font-bold text-white">
          {agent.displayName.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white">{agent.displayName}</div>
          <div className="text-xs text-gray-500 font-mono">{agent.name}</div>
        </div>
        {!agent._deleted && (
          <button onClick={() => setEditing(!editing)} className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors">
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
        <button onClick={agent._deleted ? onRestore : onRemove}
          className={`p-1.5 rounded-lg transition-colors ${agent._deleted ? 'text-green-400 hover:bg-green-500/20' : 'text-red-400 hover:bg-red-500/20'}`}>
          {agent._deleted ? <RefreshCw className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
        </button>
        <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Body */}
      <div className="p-4 space-y-3">
        {editing ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500">Display Name</label>
                <input value={agent.displayName} onChange={e => onUpdate({ displayName: e.target.value })}
                  className="w-full mt-1 px-3 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
              </div>
              <div>
                <label className="text-xs text-gray-500">Role</label>
                <input value={agent.role} onChange={e => onUpdate({ role: e.target.value })}
                  className="w-full mt-1 px-3 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500">System Prompt</label>
              <textarea value={agent.systemPrompt} onChange={e => onUpdate({ systemPrompt: e.target.value })} rows={4}
                className="w-full mt-1 px-3 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none" />
            </div>
            <button onClick={() => setEditing(false)} className="text-xs text-blue-400 hover:text-blue-300">Done editing</button>
          </>
        ) : (
          <>
            <div>
              <div className="text-[10px] uppercase text-gray-500 tracking-wider mb-1">Role</div>
              <div className="text-sm text-gray-300">{agent.role}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-gray-500 tracking-wider mb-1">System Prompt</div>
              <div className="text-xs text-gray-400 bg-gray-900/60 rounded-md p-2 border border-gray-700 max-h-20 overflow-hidden">
                {agent.systemPrompt}
              </div>
            </div>
            {agent.skills && agent.skills.length > 0 && (
              <div>
                <div className="text-[10px] uppercase text-gray-500 tracking-wider mb-2">Skills ({agent.skills.length})</div>
                <div className="space-y-1">
                  {agent.skills.map((skill, i) => (
                    <div key={i} className="flex items-center gap-2 px-2 py-1.5 bg-gray-900/60 border border-gray-700 rounded-md">
                      <span className="text-indigo-400 text-xs">⚡</span>
                      <span className="text-xs text-gray-300 flex-1 font-mono">{skill.name}</span>
                      <span className="text-[10px] text-gray-500 truncate max-w-[40%]">{skill.description}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function VersionBar({
  currentVersion, versions, onLoadVersion, onStartOver,
}: {
  currentVersion: VersionSnapshot | null
  versions: VersionSnapshot[]
  onLoadVersion: (version: number) => void
  onStartOver: () => void
}) {
  const [showHistory, setShowHistory] = useState(false)

  const timeAgo = (ts: number) => {
    const sec = Math.floor((Date.now() - ts) / 1000)
    if (sec < 60) return `${sec}s ago`
    const min = Math.floor(sec / 60)
    if (min < 60) return `${min}min ago`
    const hr = Math.floor(min / 60)
    return `${hr}h ago`
  }

  return (
    <div className="relative">
      {/* Version history panel */}
      {showHistory && (
        <div className="absolute bottom-full left-0 right-0 border-t border-gray-700 bg-gray-900/95 max-h-64 overflow-y-auto rounded-t-lg">
          <div className="p-3 border-b border-gray-700 flex items-center justify-between sticky top-0 bg-gray-900/95 z-10">
            <div className="flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-gray-400" />
              <span className="text-sm font-medium text-white">Version History</span>
              <span className="text-xs text-gray-500">({versions.length})</span>
            </div>
            <button onClick={() => setShowHistory(false)} className="text-gray-400 hover:text-white">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="p-2 space-y-1">
            {[...versions].reverse().map(v => (
              <div key={v.version}
                className={`px-3 py-2 rounded-md cursor-pointer transition-colors ${
                  v.version === currentVersion?.version
                    ? 'bg-indigo-500/15 border border-indigo-500/30'
                    : 'bg-gray-800/50 border border-gray-700 hover:bg-gray-800'
                }`}
                onClick={() => { onLoadVersion(v.version); setShowHistory(false) }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-gray-300">v{v.version}</span>
                    <span className="text-xs text-gray-400">{v.label}</span>
                  </div>
                  {v.version === currentVersion?.version && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300">current</span>
                  )}
                </div>
                <div className="text-[10px] text-gray-500 mt-1">{timeAgo(v.timestamp)} · {v.source}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bar */}
      <div className="px-4 py-3 border-t border-gray-700 flex items-center justify-between bg-gray-900/80">
        <button onClick={() => setShowHistory(!showHistory)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-gray-800 border border-gray-700 hover:border-gray-600 transition-colors">
          <Clock className="w-3.5 h-3.5 text-gray-400" />
          {currentVersion ? (
            <>
              <span className="text-xs font-medium text-gray-300">v{currentVersion.version}</span>
              <span className="text-xs text-gray-500">· {timeAgo(currentVersion.timestamp)}</span>
            </>
          ) : (
            <span className="text-xs text-gray-500">No versions</span>
          )}
          <ChevronDown className={`w-3 h-3 text-gray-500 transition-transform ${showHistory ? 'rotate-180' : ''}`} />
        </button>
        <button onClick={onStartOver} className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors">
          <RefreshCw className="w-3 h-3" />
          Start over
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function ScopeWorkspace({
  scope, agents, activeAgents, versions, currentVersion,
  onUpdateScope, onUpdateAgent, onAddAgent, onRemoveAgent, onRestoreAgent,
  onLoadVersion, onStartOver,
}: ScopeWorkspaceProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedAgent = agents.find(a => a._localId === selectedId) ?? null

  return (
    <div className="flex flex-col h-full">
      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* Scope Overview */}
        <div className="p-4 border-b border-gray-700">
          <ScopeOverviewCard scope={scope} onUpdate={onUpdateScope} />
        </div>

        {/* Agent Grid + Detail */}
        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-400 font-medium">Agents ({activeAgents.length})</span>
            <button onClick={() => { const id = onAddAgent(); setSelectedId(id) }}
              className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
              <Plus className="w-3.5 h-3.5" /> Add
            </button>
          </div>

          {agents.length === 0 ? (
            <div className="text-center py-12 text-gray-500 text-sm">
              No agents yet. Use the chat to generate your scope configuration.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                {agents.map(agent => (
                  <AgentGridCard
                    key={agent._localId}
                    agent={agent}
                    isSelected={selectedId === agent._localId}
                    onClick={() => setSelectedId(selectedId === agent._localId ? null : agent._localId)}
                  />
                ))}
              </div>

              {selectedAgent && (
                <AgentDetailPanel
                  agent={selectedAgent}
                  onUpdate={(fields) => onUpdateAgent(selectedAgent._localId, fields)}
                  onRemove={() => onRemoveAgent(selectedAgent._localId)}
                  onRestore={() => onRestoreAgent(selectedAgent._localId)}
                  onClose={() => setSelectedId(null)}
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* Version Bar (fixed bottom) */}
      <VersionBar
        currentVersion={currentVersion}
        versions={versions}
        onLoadVersion={onLoadVersion}
        onStartOver={onStartOver}
      />
    </div>
  )
}

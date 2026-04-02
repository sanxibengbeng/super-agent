/**
 * RehearsalPanel — Displays rehearsal history and evolution proposals for a scope.
 * Allows admins to trigger rehearsals and review AI-generated improvement proposals.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  FlaskConical, Play, Loader2, CheckCircle2, XCircle, Clock,
  AlertTriangle, ChevronDown, ChevronRight, Lightbulb, Target,
} from 'lucide-react'
import { restClient } from '@/services/api/restClient'

interface RehearsalSession {
  id: string
  rehearsal_type: string
  trigger_memory_ids: string[]
  status: string
  evaluation: {
    score: number
    summary: string
    details: Array<{ memory_id: string; can_handle: boolean; analysis: string }>
  } | null
  created_at: string
  completed_at: string | null
}

interface Proposal {
  id: string
  proposal_type: string
  proposed_changes: Array<{
    target: string
    description: string
    before?: string
    after: string
    rationale: string
  }>
  evaluation_score: number | null
  evaluation_summary: string | null
  status: string
  created_at: string
}

interface RehearsalPanelProps {
  scopeId: string
  scopeName?: string
}

const STATUS_STYLE: Record<string, { icon: typeof Clock; color: string; bg: string }> = {
  pending: { icon: Clock, color: 'text-gray-400', bg: 'bg-gray-500/10' },
  running: { icon: Loader2, color: 'text-blue-400', bg: 'bg-blue-500/10' },
  completed: { icon: CheckCircle2, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  failed: { icon: XCircle, color: 'text-red-400', bg: 'bg-red-500/10' },
}

const PROPOSAL_TYPE_LABEL: Record<string, string> = {
  prompt_tuning: 'Prompt Tuning',
  new_skill: 'New Skill',
  tool_config: 'Tool Config',
  new_agent: 'New Agent',
}

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 7 ? 'text-emerald-400 bg-emerald-500/10'
    : score >= 4 ? 'text-yellow-400 bg-yellow-500/10'
    : 'text-red-400 bg-red-500/10'
  return (
    <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${color}`}>
      {score}/10
    </span>
  )
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export function RehearsalPanel({ scopeId, scopeName }: RehearsalPanelProps) {
  const [rehearsals, setRehearsals] = useState<RehearsalSession[]>([])
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [loading, setLoading] = useState(true)
  const [triggering, setTriggering] = useState(false)
  const [expandedRehearsal, setExpandedRehearsal] = useState<string | null>(null)
  const [expandedProposal, setExpandedProposal] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'rehearsals' | 'proposals'>('rehearsals')

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [rRes, pRes] = await Promise.all([
        restClient.get<{ data: RehearsalSession[] }>(`/api/business-scopes/${scopeId}/rehearsals?limit=20`),
        restClient.get<{ data: Proposal[] }>(`/api/business-scopes/${scopeId}/proposals?limit=20`),
      ])
      setRehearsals(rRes.data || [])
      setProposals(pRes.data || [])
    } catch (err) {
      console.error('Failed to load rehearsal data:', err)
    } finally {
      setLoading(false)
    }
  }, [scopeId])

  useEffect(() => { loadData() }, [loadData])

  const handleTrigger = async () => {
    setTriggering(true)
    try {
      await restClient.post(`/api/business-scopes/${scopeId}/rehearsals`, {})
      await loadData()
    } catch (err) {
      console.error('Failed to trigger rehearsal:', err)
    } finally {
      setTriggering(false)
    }
  }

  const pendingProposals = proposals.filter(p => p.status === 'pending').length

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <FlaskConical className="w-4 h-4 text-purple-400" />
          <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Agent Evolution</h3>
          {pendingProposals > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 font-medium">
              {pendingProposals} pending
            </span>
          )}
        </div>
        <button
          onClick={handleTrigger}
          disabled={triggering}
          className="flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors disabled:opacity-50"
        >
          {triggering ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
          Run Rehearsal
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-3">
        <button
          onClick={() => setActiveTab('rehearsals')}
          className={`px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${
            activeTab === 'rehearsals' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Rehearsals ({rehearsals.length})
        </button>
        <button
          onClick={() => setActiveTab('proposals')}
          className={`px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${
            activeTab === 'proposals' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Proposals ({proposals.length})
        </button>
      </div>

      {loading ? (
        <div className="py-6 text-center text-xs text-gray-500">Loading...</div>
      ) : activeTab === 'rehearsals' ? (
        /* Rehearsal list */
        rehearsals.length === 0 ? (
          <div className="py-6 text-center">
            <FlaskConical className="w-6 h-6 text-gray-700 mx-auto mb-1" />
            <p className="text-xs text-gray-500">No rehearsals yet</p>
            <p className="text-[10px] text-gray-600 mt-0.5">
              Click "Run Rehearsal" to evaluate {scopeName || 'this scope'}'s agents.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {rehearsals.map(r => {
              const style = STATUS_STYLE[r.status] || STATUS_STYLE.pending
              const StatusIcon = style.icon
              const isExpanded = expandedRehearsal === r.id
              return (
                <div key={r.id} className="bg-gray-800/50 border border-gray-700/50 rounded-lg overflow-hidden">
                  <button
                    onClick={() => setExpandedRehearsal(isExpanded ? null : r.id)}
                    className="w-full flex items-center gap-2 p-2.5 text-left hover:bg-gray-800/70 transition-colors"
                  >
                    {isExpanded ? <ChevronDown className="w-3 h-3 text-gray-500" /> : <ChevronRight className="w-3 h-3 text-gray-500" />}
                    <StatusIcon className={`w-3.5 h-3.5 ${style.color} ${r.status === 'running' ? 'animate-spin' : ''}`} />
                    <span className="text-xs text-gray-300 flex-1">
                      {r.rehearsal_type === 'manual' ? 'Manual' : 'Auto'} rehearsal
                    </span>
                    {r.evaluation?.score != null && <ScoreBadge score={r.evaluation.score} />}
                    <span className="text-[10px] text-gray-600">{formatDate(r.created_at)}</span>
                  </button>
                  {isExpanded && r.evaluation && (
                    <div className="px-3 pb-3 border-t border-gray-700/50">
                      <p className="text-xs text-gray-400 mt-2 mb-2">{r.evaluation.summary}</p>
                      {r.evaluation.details.length > 0 && (
                        <div className="space-y-1">
                          {r.evaluation.details.map((d, i) => (
                            <div key={i} className="flex items-start gap-1.5 text-[10px]">
                              {d.can_handle
                                ? <CheckCircle2 className="w-3 h-3 text-emerald-500 mt-0.5 flex-shrink-0" />
                                : <AlertTriangle className="w-3 h-3 text-yellow-500 mt-0.5 flex-shrink-0" />
                              }
                              <span className="text-gray-400">{d.analysis}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      ) : (
        /* Proposals list */
        proposals.length === 0 ? (
          <div className="py-6 text-center">
            <Lightbulb className="w-6 h-6 text-gray-700 mx-auto mb-1" />
            <p className="text-xs text-gray-500">No proposals yet</p>
            <p className="text-[10px] text-gray-600 mt-0.5">
              Proposals are generated after rehearsals find improvement opportunities.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {proposals.map(p => {
              const isExpanded = expandedProposal === p.id
              return (
                <div key={p.id} className="bg-gray-800/50 border border-gray-700/50 rounded-lg overflow-hidden">
                  <button
                    onClick={() => setExpandedProposal(isExpanded ? null : p.id)}
                    className="w-full flex items-center gap-2 p-2.5 text-left hover:bg-gray-800/70 transition-colors"
                  >
                    {isExpanded ? <ChevronDown className="w-3 h-3 text-gray-500" /> : <ChevronRight className="w-3 h-3 text-gray-500" />}
                    <Target className="w-3.5 h-3.5 text-yellow-400" />
                    <span className="text-xs text-gray-300 flex-1">
                      {PROPOSAL_TYPE_LABEL[p.proposal_type] || p.proposal_type}
                    </span>
                    {p.evaluation_score != null && <ScoreBadge score={p.evaluation_score} />}
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
                      p.status === 'pending' ? 'bg-yellow-500/20 text-yellow-400'
                      : p.status === 'approved' ? 'bg-emerald-500/20 text-emerald-400'
                      : 'bg-gray-500/20 text-gray-400'
                    }`}>
                      {p.status}
                    </span>
                    <span className="text-[10px] text-gray-600">{formatDate(p.created_at)}</span>
                  </button>
                  {isExpanded && (
                    <div className="px-3 pb-3 border-t border-gray-700/50">
                      {p.evaluation_summary && (
                        <p className="text-xs text-gray-400 mt-2 mb-2">{p.evaluation_summary}</p>
                      )}
                      <div className="space-y-2 mt-2">
                        {p.proposed_changes.map((change, i) => (
                          <div key={i} className="p-2 bg-gray-900/50 rounded border border-gray-700/30">
                            <div className="flex items-center gap-1.5 mb-1">
                              <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 font-medium">
                                {change.target}
                              </span>
                              <span className="text-[10px] text-gray-300">{change.description}</span>
                            </div>
                            <p className="text-[10px] text-gray-500 mb-1">{change.rationale}</p>
                            {change.after && (
                              <pre className="text-[10px] text-emerald-400/80 bg-emerald-500/5 p-1.5 rounded overflow-x-auto whitespace-pre-wrap">
                                {change.after.slice(0, 500)}
                              </pre>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      )}
    </div>
  )
}

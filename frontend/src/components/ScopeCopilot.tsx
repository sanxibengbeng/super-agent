import { useState, useCallback, useRef, useEffect } from 'react'
import { Send, Loader2, User, Bot } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { parseScopeConfig, type GeneratedScopeConfig } from '@/services/scopeGeneratorService'
import type { ChatMessageDraft } from '@/hooks/useScopeDraft'
import { getAuthToken } from '@/services/api/restClient'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScopeCopilotProps {
  scopeId: string
  hasAgents: boolean
  currentConfig: GeneratedScopeConfig | null
  chatHistory: ChatMessageDraft[]
  onChatHistoryChange: (history: ChatMessageDraft[]) => void
  onApplyFullConfig: (config: GeneratedScopeConfig) => void
  onApplyPatches: (patches: Array<{ op: string; path: string; value?: unknown }>) => void
  onCreateSnapshot: (label: string, source: 'ai-generated' | 'ai-modified') => void
  initialDescription?: string
  sopFile?: File | null
  language?: string
  disabled?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function msgId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ScopeCopilot({
  scopeId,
  hasAgents,
  chatHistory,
  onChatHistoryChange,
  onApplyFullConfig,
  onApplyPatches,
  onCreateSnapshot,
  initialDescription,
  sopFile,
  language,
  disabled,
}: ScopeCopilotProps) {
  const [input, setInput] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const autoTriggered = useRef(false)
  const historyLoaded = useRef(false)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatHistory])

  // Load persistent chat history from backend on first mount
  useEffect(() => {
    if (historyLoaded.current || !scopeId) return
    historyLoaded.current = true

    const load = async () => {
      try {
        const token = getAuthToken()
        const res = await fetch(
          `${API_BASE_URL}/api/scope-generator/copilot/messages?scope_id=${scopeId}`,
          { headers: token ? { Authorization: `Bearer ${token}` } : {} },
        )
        if (!res.ok) return
        const data = await res.json() as { messages: Array<{ id: string; type: string; content: string; created_at: string }> }
        if (!data.messages?.length) return

        let latestConfigJson: string | null = null
        const chatMsgs = data.messages.map(m => {
          if (m.type !== 'ai') {
            return { id: m.id, role: 'user' as const, content: m.content, status: 'done' as const, timestamp: new Date(m.created_at).getTime() }
          }
          // Parse content blocks array
          let displayText = ''
          try {
            const blocks = JSON.parse(m.content) as Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>
            for (const block of blocks) {
              if (block.type === 'text' && block.text) displayText += block.text
              // Extract scope config from Write tool_use block
              if (block.type === 'tool_use' && block.name === 'Write' && block.input) {
                const fp = block.input.file_path as string | undefined
                const ct = block.input.content as string | undefined
                if (fp?.includes('scope-config') && ct) {
                  latestConfigJson = ct
                }
              }
            }
          } catch {
            displayText = m.content
          }
          return { id: m.id, role: 'assistant' as const, content: displayText, status: 'done' as const, timestamp: new Date(m.created_at).getTime() }
        })

        onChatHistoryChange(chatMsgs)

        // Apply the latest scope config found in history to the workspace
        if (latestConfigJson) {
          try {
            const config = parseScopeConfig(latestConfigJson)
            onApplyFullConfig(config)
          } catch { /* config parse failed — skip */ }
        }
      } catch {
        // non-fatal
      }
    }
    void load()
  }, [scopeId])

  // Clean up orphaned streaming messages on mount
  const mountCleanupDone = useRef(false)
  useEffect(() => {
    if (mountCleanupDone.current) return
    mountCleanupDone.current = true
    const hasOrphaned = chatHistory.some(m => m.status === 'streaming')
    if (hasOrphaned) {
      onChatHistoryChange(chatHistory.filter(m => m.status !== 'streaming'))
    }
  }, [])

  // Auto-trigger generation when arriving with initial description and no agents
  useEffect(() => {
    if (!initialDescription || hasAgents || autoTriggered.current) return
    const realMessages = chatHistory.filter(m => m.status !== 'streaming')
    if (realMessages.length > 0) return
    autoTriggered.current = true
    void handleSend(initialDescription)
  }, [initialDescription, hasAgents, chatHistory.length])

  const handleSend = useCallback(async (text?: string) => {
    const message = (text ?? input).trim()
    if (!message || isProcessing) return
    if (!text) setInput('')
    setIsProcessing(true)

    // Upload SOP document to workspace before first message if provided
    if (sopFile && !hasAgents) {
      try {
        const token = getAuthToken()
        const formData = new FormData()
        formData.append('file', sopFile)
        formData.append('scope_id', scopeId)
        await fetch(`${API_BASE_URL}/api/scope-generator/copilot/upload-document`, {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: formData,
        })
      } catch {
        // non-fatal — generation will proceed without the document
      }
    }

    const userMsg: ChatMessageDraft = { id: msgId(), role: 'user', content: message, timestamp: Date.now() }
    const assistantMsg: ChatMessageDraft = { id: msgId(), role: 'assistant', content: '', status: 'streaming', timestamp: Date.now() }
    const newHistory = [...chatHistory, userMsg, assistantMsg]
    onChatHistoryChange(newHistory)

    const assistantId = assistantMsg.id
    let accumulated = ''

    try {
      const token = getAuthToken()
      const response = await fetch(`${API_BASE_URL}/api/scope-generator/copilot/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ scope_id: scopeId, message, language }),
      })

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Request failed' })) as { error?: string }
        throw new Error(err.error ?? `Request failed: ${response.status}`)
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('No response body')

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue
          try {
            const event = JSON.parse(data) as {
              type: string
              content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>
              message?: string
            }
            if (event.type === 'assistant' && Array.isArray(event.content)) {
              for (const block of event.content) {
                if (block.type === 'text' && block.text) {
                  accumulated += block.text
                }
                // Capture tool_use input — agent writes scope-config.json via Write tool
                if (block.type === 'tool_use' && block.input) {
                  const input = block.input as Record<string, unknown>
                  // Write tool: { file_path: '...scope-config.json', content: '...' }
                  if (
                    typeof input.file_path === 'string' &&
                    input.file_path.includes('scope-config') &&
                    typeof input.content === 'string'
                  ) {
                    accumulated = input.content
                  }
                }
              }
              onChatHistoryChange(
                newHistory.map(m => m.id === assistantId ? { ...m, content: accumulated } : m)
              )
            }
          } catch {
            // skip unparseable lines
          }
        }
      }

      // Try to extract scope config from accumulated text
      let applied = false
      try {
        const config = parseScopeConfig(accumulated)
        onApplyFullConfig(config)
        onCreateSnapshot(hasAgents ? 'AI modified' : 'AI generated', hasAgents ? 'ai-modified' : 'ai-generated')
        applied = true
      } catch {
        // No config in response — treat as conversational reply
      }

      onChatHistoryChange(
        newHistory.map(m => m.id === assistantId
          ? { ...m, content: accumulated || (applied ? 'Scope configuration updated.' : ''), status: 'done' }
          : m
        )
      )
    } catch (err) {
      onChatHistoryChange(
        newHistory.map(m => m.id === assistantId
          ? { ...m, content: err instanceof Error ? err.message : 'An error occurred', status: 'error' }
          : m
        )
      )
    } finally {
      setIsProcessing(false)
      inputRef.current?.focus()
    }
  }, [input, isProcessing, scopeId, hasAgents, chatHistory, sopFile, language, onChatHistoryChange, onApplyFullConfig, onApplyPatches, onCreateSnapshot])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void handleSend()
    }
  }, [handleSend])

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-3 pb-2 px-4 pt-4">
        {chatHistory.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 text-sm text-center">
            <Bot className="w-8 h-8 mb-2 text-gray-600" />
            <p>{hasAgents ? 'Ask AI to modify your scope' : 'Describe your business scope'}</p>
            <p className="text-xs mt-1 text-gray-600">e.g. "We're an e-commerce fashion brand..."</p>
          </div>
        )}

        {chatHistory.map((msg) => (
          <div key={msg.id} className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'assistant' && (
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-purple-500/20 flex items-center justify-center mt-0.5">
                <Bot className="w-3.5 h-3.5 text-purple-400" />
              </div>
            )}
            <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
              msg.role === 'user'
                ? 'bg-blue-600/30 text-blue-100'
                : msg.status === 'error'
                ? 'bg-red-500/10 border border-red-500/20 text-red-300'
                : 'bg-gray-800 text-gray-300'
            }`}>
              {msg.status === 'streaming' && !msg.content && (
                <Loader2 className="w-4 h-4 animate-spin text-purple-400" />
              )}
              {msg.content && (
                <div className="prose prose-invert prose-sm max-w-none
                  prose-p:text-inherit prose-p:text-xs prose-p:my-1 prose-p:leading-relaxed
                  prose-li:text-inherit prose-li:text-xs
                  prose-strong:text-gray-200
                  prose-code:text-purple-300 prose-code:bg-gray-900/50 prose-code:px-1 prose-code:rounded prose-code:text-[11px]">
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                  {msg.status === 'streaming' && <Loader2 className="w-3 h-3 animate-spin text-purple-400 mt-1" />}
                </div>
              )}
            </div>
            {msg.role === 'user' && (
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center mt-0.5">
                <User className="w-3.5 h-3.5 text-blue-400" />
              </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-700 p-3">
        <form onSubmit={(e) => { e.preventDefault(); void handleSend() }}>
          <div className="relative">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={hasAgents ? 'Ask AI to modify scope...' : 'Describe your business scope...'}
              disabled={disabled || isProcessing}
              rows={2}
              className="w-full px-3 py-2 pr-12 bg-gray-900 border border-gray-600 rounded-lg resize-none text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <button
              type="submit"
              disabled={disabled || isProcessing || !input.trim()}
              className="absolute right-2 bottom-2 p-1.5 rounded-md transition-colors text-purple-400 hover:bg-purple-500/20 hover:text-purple-300 disabled:text-gray-600 disabled:cursor-not-allowed"
            >
              {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

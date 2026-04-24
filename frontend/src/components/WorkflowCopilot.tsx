import { useState, useCallback, useRef, useEffect, useImperativeHandle, forwardRef } from 'react'
import { Send, Loader2, User, Bot, CheckCircle2, AlertCircle, Wrench, ChevronDown, ChevronRight, Play } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import {
  workflowPlanToCanvasData,
} from '@/lib/workflow-plan'
import type { WorkflowPlan, WorkflowTask, WorkflowVariable } from '@/types/workflow-plan'
import type { CanvasData } from '@/types/canvas'
import { getAuthToken } from '@/services/api/restClient'
import { useTranslation } from '@/i18n'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolUseStep {
  type: 'tool_use'
  name: string
  input: Record<string, unknown>
}

interface ToolResultStep {
  type: 'tool_result'
  content: string | null
  isError: boolean
}

interface ExecutionLogStep {
  type: 'execution_log'
  content: string
}

interface ExecutionNodeStep {
  type: 'execution_node'
  taskId: string
  taskTitle?: string
  status: 'started' | 'completed' | 'failed'
  message?: string
}

type IntermediateStep = ToolUseStep | ToolResultStep | ExecutionLogStep | ExecutionNodeStep

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  status?: 'streaming' | 'done' | 'error'
  steps: IntermediateStep[]
  timestamp: number
}

export interface WorkflowCopilotHandle {
  /** Push an execution event into the chat as a streaming assistant message */
  startExecution: () => string
  pushExecutionEvent: (msgId: string, event: { type: string; taskId?: string; taskTitle?: string; message?: string; content?: unknown }) => void
  finishExecution: (msgId: string, success: boolean, message?: string) => void
}

interface WorkflowCopilotProps {
  workflowId: string | null
  workflowVersion?: string
  canvasData?: CanvasData
  businessScopeId?: string
  onGenerateWorkflow?: (canvasData: CanvasData, title: string, variables?: WorkflowVariable[]) => void
  disabled?: boolean
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

interface SSEChunk {
  type: 'text' | 'tool_use' | 'tool_result' | 'result' | 'error'
  text?: string
  error?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolContent?: string | null
  isError?: boolean
  durationMs?: number
  numTurns?: number
}

async function* streamSSE(
  url: string,
  body: Record<string, unknown>,
): AsyncGenerator<SSEChunk> {
  const token = getAuthToken()
  const response = await fetch(`${API_BASE_URL}${url}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(err.error || `Request failed: ${response.status}`)
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
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') continue

      try {
        const event = JSON.parse(data)
        if (event.type === 'error') {
          yield { type: 'error', error: event.message || 'Generation failed' }
          return
        }
        if (event.type === 'result') {
          yield { type: 'result', durationMs: event.durationMs, numTurns: event.numTurns }
          continue
        }
        if ((event.type === 'assistant') && event.content && Array.isArray(event.content)) {
          for (const block of event.content) {
            if (block.type === 'text' && block.text) {
              yield { type: 'text', text: block.text }
            } else if (block.type === 'tool_use') {
              yield { type: 'tool_use', toolName: block.name, toolInput: block.input }
            } else if (block.type === 'tool_result') {
              yield { type: 'tool_result', toolContent: block.content, isError: block.is_error }
            }
          }
        }
      } catch {
        // skip unparseable lines
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function fixUnescapedControlChars(json: string): string {
  // Walk the string character by character, tracking whether we're inside a JSON string value.
  // Replace raw control characters (U+0000–U+001F) with their escaped forms.
  // All characters in this range are illegal unescaped inside JSON strings.
  const out: string[] = []
  let inString = false
  let escaped = false
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]
    if (escaped) {
      out.push(ch)
      escaped = false
      continue
    }
    if (ch === '\\' && inString) {
      out.push(ch)
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      out.push(ch)
      continue
    }
    if (inString) {
      const code = ch.charCodeAt(0)
      if (code < 0x20) {
        // All control characters U+0000–U+001F must be escaped in JSON strings
        if (ch === '\n') { out.push('\\n'); continue }
        if (ch === '\r') { out.push('\\r'); continue }
        if (ch === '\t') { out.push('\\t'); continue }
        if (ch === '\b') { out.push('\\b'); continue }
        if (ch === '\f') { out.push('\\f'); continue }
        // Other control chars: use \uXXXX escape
        out.push('\\u' + code.toString(16).padStart(4, '0'))
        continue
      }
    }
    out.push(ch)
  }
  return out.join('')
}

function parseWorkflowPlan(text: string): WorkflowPlan {
  let jsonStr = text.trim()
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) jsonStr = fenceMatch[1]!.trim()
  const firstBrace = jsonStr.indexOf('{')
  const lastBrace = jsonStr.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.substring(firstBrace, lastBrace + 1)
  }
  // Fix unescaped control characters inside JSON string values
  jsonStr = fixUnescapedControlChars(jsonStr)
  const parsed = JSON.parse(jsonStr)
  if (!parsed.title || !Array.isArray(parsed.tasks)) {
    throw new Error('Invalid workflow plan: missing title or tasks')
  }
  const validTypes = new Set(['agent', 'action', 'condition', 'document', 'codeArtifact'])
  return {
    title: parsed.title,
    description: parsed.description,
    tasks: (parsed.tasks || []).map((t: Record<string, unknown>) => ({
      id: t.id as string,
      title: t.title as string,
      type: validTypes.has(t.type as string) ? t.type : 'agent',
      prompt: (t.prompt as string) || '',
      dependentTasks: Array.isArray(t.dependentTasks) ? t.dependentTasks : [],
      agentId: t.agentId as string | undefined,
      config: t.config as Record<string, unknown> | undefined,
    })) as WorkflowTask[],
    variables: (parsed.variables || []).map((v: Record<string, unknown>) => ({
      variableId: v.variableId as string,
      variableType: v.variableType === 'resource' ? 'resource' : 'string',
      name: v.name as string,
      description: (v.description as string) || '',
      required: (v.required as boolean) || false,
      value: Array.isArray(v.value) ? v.value : [],
    })),
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ToolStep({ step }: { step: IntermediateStep }) {
  const [expanded, setExpanded] = useState(false)

  if (step.type === 'tool_use') {
    return (
      <div className="text-xs border border-gray-700/50 rounded bg-gray-900/50">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 w-full px-2 py-1.5 text-left hover:bg-gray-800/50 transition-colors"
        >
          {expanded ? <ChevronDown className="w-3 h-3 text-gray-500" /> : <ChevronRight className="w-3 h-3 text-gray-500" />}
          <Wrench className="w-3 h-3 text-yellow-400" />
          <span className="text-yellow-300 font-mono">{step.name}</span>
        </button>
        {expanded && (
          <pre className="px-2 pb-1.5 text-gray-500 font-mono text-[10px] max-h-32 overflow-auto whitespace-pre-wrap">
            {JSON.stringify(step.input, null, 2)}
          </pre>
        )}
      </div>
    )
  }

  if (step.type === 'tool_result') {
    return (
      <div className={`text-xs px-2 py-1 rounded font-mono ${
        step.isError ? 'bg-red-500/10 text-red-400' : 'bg-gray-900/30 text-gray-500'
      }`}>
        {step.content ? (
          <span className="line-clamp-2">{step.content}</span>
        ) : (
          <span className="italic">✓ done</span>
        )}
      </div>
    )
  }

  if (step.type === 'execution_log') {
    const lines = step.content.split('\n')
    const preview = lines.length > 2 ? lines.slice(-2).join('\n') : step.content
    return (
      <div className="text-[10px] font-mono text-gray-500 bg-gray-900/30 rounded">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 w-full px-2 py-1 text-left hover:bg-gray-800/50 transition-colors"
        >
          {expanded ? <ChevronDown className="w-3 h-3 text-gray-600 flex-shrink-0" /> : <ChevronRight className="w-3 h-3 text-gray-600 flex-shrink-0" />}
          <span className="truncate">{preview.split('\n')[0] || 'Log output'}</span>
        </button>
        {expanded && (
          <pre className="whitespace-pre-wrap max-h-48 overflow-y-auto px-2 pb-1">{step.content}</pre>
        )}
      </div>
    )
  }

  if (step.type === 'execution_node') {
    const icon = step.status === 'completed' ? '✅' : step.status === 'failed' ? '❌' : '🔄'
    const color = step.status === 'completed' ? 'text-green-400' : step.status === 'failed' ? 'text-red-400' : 'text-blue-400'
    const bgColor = step.status === 'completed' ? 'bg-green-500/10 border-green-500/20' : step.status === 'failed' ? 'bg-red-500/10 border-red-500/20' : 'bg-blue-500/10 border-blue-500/20'
    const label = step.taskTitle || step.taskId
    return (
      <div className={`text-xs px-2.5 py-1.5 rounded border ${bgColor} ${color} flex items-center gap-2`}>
        <span>{icon}</span>
        <span className="font-medium">{label}</span>
        {step.status === 'started' && <Loader2 className="w-3 h-3 animate-spin ml-auto" />}
        {step.message && <span className="text-gray-500 ml-auto">— {step.message}</span>}
      </div>
    )
  }

  return null
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export const WorkflowCopilot = forwardRef<WorkflowCopilotHandle, WorkflowCopilotProps>(function WorkflowCopilot({
  workflowId,
  workflowVersion,
  canvasData,
  businessScopeId,
  onGenerateWorkflow,
  disabled,
}, ref) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const { t } = useTranslation()
  const loadedWorkflowRef = useRef<string | null>(null)

  const hasNodes = canvasData && canvasData.nodes.length > 0

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Reset state and load history when workflowId changes
  useEffect(() => {
    const key = workflowId ?? null
    if (key === loadedWorkflowRef.current) return

    loadedWorkflowRef.current = key
    setMessages([])
    setInput('')

    if (!workflowId) return
    const version = workflowVersion ?? '1'

    const load = async () => {
      try {
        const token = getAuthToken()
        const res = await fetch(
          `${API_BASE_URL}/api/workflows/copilot/messages?workflow_id=${workflowId}&version=${encodeURIComponent(version)}`,
          { headers: token ? { Authorization: `Bearer ${token}` } : {} },
        )
        if (!res.ok) return
        const data = await res.json() as { messages: Array<{ id: string; type: string; content: string; created_at: string }> }
        if (!data.messages?.length) return
        let latestWorkflowJson: string | null = null
        setMessages(data.messages.map(m => {
          if (m.type === 'user') {
            return { id: m.id, role: 'user' as const, content: m.content, status: 'done' as const, steps: [] as IntermediateStep[], timestamp: new Date(m.created_at).getTime() }
          }
          let displayText = ''
          try {
            const blocks = JSON.parse(m.content) as Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>
            for (const block of blocks) {
              if (block.type === 'text' && block.text) displayText += block.text
              if (block.type === 'tool_use' && block.input) {
                const fp = block.input.file_path as string | undefined
                const ct = block.input.content as string | undefined
                if (fp?.includes('workflow.json') && ct) {
                  latestWorkflowJson = ct
                }
              }
            }
          } catch {
            displayText = m.content
          }
          return { id: m.id, role: 'assistant' as const, content: displayText, status: 'done' as const, steps: [] as IntermediateStep[], timestamp: new Date(m.created_at).getTime() }
        }))
        if (latestWorkflowJson && onGenerateWorkflow) {
          try {
            const plan = parseWorkflowPlan(latestWorkflowJson)
            const canvasData = workflowPlanToCanvasData(plan)
            onGenerateWorkflow(canvasData, plan.title, plan.variables)
          } catch { /* plan parse failed — skip */ }
        }
      } catch {
        // non-fatal
      }
    }
    void load()
  }, [workflowId, workflowVersion])

  const createMessage = useCallback((msg: Omit<ChatMessage, 'id' | 'timestamp' | 'steps'> & { steps?: IntermediateStep[] }) => {
    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const newMsg: ChatMessage = { ...msg, steps: msg.steps || [], id, timestamp: Date.now() }
    setMessages(prev => [...prev, newMsg])
    return id
  }, [])

  const updateMessage = useCallback((id: string, updates: Partial<ChatMessage>) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...updates } : m))
  }, [])

  const appendStep = useCallback((id: string, step: IntermediateStep) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, steps: [...m.steps, step] } : m))
  }, [])

  // Expose execution methods via ref so the Run button can push events
  useImperativeHandle(ref, () => ({
    startExecution() {
      const id = createMessage({
        role: 'system',
        content: '',
        status: 'streaming',
      })
      return id
    },
    pushExecutionEvent(msgId, event) {
      if (event.type === 'log' && event.content) {
        appendStep(msgId, { type: 'execution_log', content: String(event.content) })
      } else if (event.type === 'step_start' && event.taskId) {
        // Only add a new step if this taskId doesn't already have one
        setMessages(prev => prev.map(m => {
          if (m.id !== msgId) return m
          const existing = m.steps.find(s => s.type === 'execution_node' && (s as ExecutionNodeStep).taskId === event.taskId)
          if (existing) {
            // Already have this node — update it back to started (re-execution)
            const steps = m.steps.map(s =>
              s.type === 'execution_node' && (s as ExecutionNodeStep).taskId === event.taskId
                ? { ...s, status: 'started' as const, message: event.message }
                : s
            )
            return { ...m, steps }
          }
          // New node — append
          return { ...m, steps: [...m.steps, { type: 'execution_node' as const, taskId: event.taskId, taskTitle: event.taskTitle, status: 'started' as const, message: event.message }] }
        }))
      } else if (event.type === 'step_complete' && event.taskId) {
        // Update the existing started step to completed instead of adding a new one
        setMessages(prev => prev.map(m => {
          if (m.id !== msgId) return m
          const steps = m.steps.map(s =>
            s.type === 'execution_node' && s.taskId === event.taskId
              ? { ...s, status: 'completed' as const, message: event.message }
              : s
          )
          return { ...m, steps }
        }))
      } else if (event.type === 'step_failed' && event.taskId) {
        setMessages(prev => prev.map(m => {
          if (m.id !== msgId) return m
          const steps = m.steps.map(s =>
            s.type === 'execution_node' && s.taskId === event.taskId
              ? { ...s, status: 'failed' as const, message: event.message }
              : s
          )
          return { ...m, steps }
        }))
      } else if (event.type === 'error') {
        updateMessage(msgId, { content: event.message || t('copilot.executionError'), status: 'error' })
      }
    },
    finishExecution(msgId, success, message) {
      // Build a summary from the steps
      setMessages(prev => {
        const msg = prev.find(m => m.id === msgId)
        if (!msg) return prev
        const nodeSteps = msg.steps.filter(s => s.type === 'execution_node') as ExecutionNodeStep[]
        const completed = nodeSteps.filter(s => s.status === 'completed').length
        const failed = nodeSteps.filter(s => s.status === 'failed').length
        const total = nodeSteps.length
        const summary = message
          || (success
            ? t('copilot.workflowCompleted').replace('{completed}', String(completed)).replace('{total}', String(total)).replace('{failed}', failed > 0 ? `, ${failed} failed` : '')
            : t('copilot.workflowFailed'))
        return prev.map(m => m.id === msgId ? { ...m, content: summary, status: success ? 'done' : 'error' } : m)
      })
    },
  }), [createMessage, updateMessage, appendStep])

  const handleSubmit = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault()
    const text = input.trim()
    if (!text || isProcessing) return

    setInput('')
    setIsProcessing(true)

    createMessage({ role: 'user', content: text })
    const assistantId = createMessage({ role: 'assistant', content: '', status: 'streaming' })

    // Build conversation history from previous messages (exclude system messages and the ones we just created)
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = []
    for (const msg of messages) {
      if (msg.role === 'system') continue
      if (msg.role === 'user' || (msg.role === 'assistant' && msg.status === 'done' && msg.content)) {
        history.push({ role: msg.role, content: msg.content })
      }
    }

    try {
      let accumulatedText = ''
      let workflowJsonContent: string | null = null

      const version = workflowVersion ?? '1'

      for await (const chunk of streamSSE('/api/workflows/copilot/stream', {
        workflow_id: workflowId ?? '',
        version,
        message: text,
        business_scope_id: businessScopeId,
      })) {
        if (chunk.type === 'error') throw new Error(chunk.error)
        if (chunk.type === 'text' && chunk.text) {
          accumulatedText += chunk.text
          updateMessage(assistantId, { content: accumulatedText })
        }
        if (chunk.type === 'tool_use') {
          appendStep(assistantId, { type: 'tool_use', name: chunk.toolName!, input: chunk.toolInput! })
          // Capture Write tool_use for workflow.json
          if (chunk.toolInput) {
            const input = chunk.toolInput as Record<string, unknown>
            if (
              typeof input.file_path === 'string' &&
              input.file_path.includes('workflow.json') &&
              typeof input.content === 'string'
            ) {
              workflowJsonContent = input.content
            }
          }
        }
        if (chunk.type === 'tool_result') {
          appendStep(assistantId, { type: 'tool_result', content: chunk.toolContent ?? null, isError: chunk.isError ?? false })
        }
      }

      // Try to apply the workflow plan from the Write tool_use content
      let applied = false
      if (workflowJsonContent && onGenerateWorkflow) {
        try {
          const plan = parseWorkflowPlan(workflowJsonContent)
          const newCanvasData = workflowPlanToCanvasData(plan)
          onGenerateWorkflow(newCanvasData, plan.title, plan.variables)
          applied = true

          updateMessage(assistantId, {
            content: accumulatedText || `${hasNodes ? 'Updated' : 'Generated'} workflow "${plan.title}" with ${plan.tasks.length} tasks.`,
            status: 'done',
          })
        } catch {
          // workflow.json parse failed — show text as-is
          updateMessage(assistantId, { content: accumulatedText, status: 'done' })
        }
      }

      if (!applied) {
        // No workflow.json written — conversational reply (clarification, etc.)
        // Also try fallback: parse accumulated text as JSON plan directly
        if (onGenerateWorkflow && accumulatedText.trim()) {
          try {
            const plan = parseWorkflowPlan(accumulatedText)
            const newCanvasData = workflowPlanToCanvasData(plan)
            onGenerateWorkflow(newCanvasData, plan.title, plan.variables)
            updateMessage(assistantId, {
              content: `${hasNodes ? 'Updated' : 'Generated'} workflow "${plan.title}" with ${plan.tasks.length} tasks.`,
              status: 'done',
            })
          } catch {
            updateMessage(assistantId, { content: accumulatedText, status: 'done' })
          }
        } else {
          updateMessage(assistantId, { content: accumulatedText, status: 'done' })
        }
      }
    } catch (err) {
      console.error('Copilot error:', err)
      updateMessage(assistantId, {
        content: err instanceof Error ? err.message : t('copilot.error'),
        status: 'error',
      })
    } finally {
      setIsProcessing(false)
      inputRef.current?.focus()
    }
  }, [input, isProcessing, hasNodes, workflowId, workflowVersion, businessScopeId, onGenerateWorkflow, createMessage, updateMessage, appendStep, t])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void handleSubmit()
    }
  }, [handleSubmit])

  const isDisabled = disabled || isProcessing

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-3 pb-2">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 text-sm px-4 text-center">
            <Bot className="w-8 h-8 mb-2 text-gray-600" />
            <p>{hasNodes ? t('copilot.emptyHasNodes') : t('copilot.emptyNoNodes')}</p>
            <p className="text-xs mt-1 text-gray-600">{t('copilot.emptyHint')}</p>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id}>
            <div className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {(msg.role === 'assistant' || msg.role === 'system') && (
                <div className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5 ${
                  msg.role === 'system' ? 'bg-green-500/20' : 'bg-purple-500/20'
                }`}>
                  {msg.role === 'system' ? (
                    <Play className="w-3 h-3 text-green-400" />
                  ) : (
                    <Bot className="w-3.5 h-3.5 text-purple-400" />
                  )}
                </div>
              )}
              <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                msg.role === 'user'
                  ? 'bg-blue-600/30 text-blue-100'
                  : msg.status === 'error'
                  ? 'bg-red-500/10 border border-red-500/20 text-red-300'
                  : msg.status === 'done'
                  ? 'bg-green-500/10 border border-green-500/20 text-green-300'
                  : 'bg-gray-800 text-gray-300'
              }`}>
                {/* Intermediate steps */}
                {(msg.role === 'assistant' || msg.role === 'system') && msg.steps.length > 0 && (
                  <div className="space-y-1 mb-2">
                    {msg.steps.map((step, i) => (
                      <ToolStep key={i} step={step} />
                    ))}
                  </div>
                )}

                {/* Content */}
                {msg.status === 'streaming' && !msg.content && msg.steps.length === 0 && (
                  <Loader2 className="w-4 h-4 animate-spin text-purple-400" />
                )}
                {msg.status === 'streaming' && msg.content && (
                  <div className="prose prose-invert prose-sm max-w-none max-h-64 overflow-y-auto
                    prose-headings:text-gray-200 prose-headings:text-sm prose-headings:font-semibold prose-headings:mt-3 prose-headings:mb-1
                    prose-p:text-gray-300 prose-p:text-xs prose-p:my-1 prose-p:leading-relaxed
                    prose-li:text-gray-300 prose-li:text-xs prose-li:my-0
                    prose-strong:text-gray-200
                    prose-code:text-purple-300 prose-code:bg-gray-900/50 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[11px]
                    prose-pre:bg-gray-900/50 prose-pre:rounded-lg prose-pre:p-2 prose-pre:text-[11px]
                    prose-hr:border-gray-700 prose-hr:my-2">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                    <Loader2 className="w-3 h-3 animate-spin text-purple-400 mt-1" />
                  </div>
                )}
                {msg.status === 'streaming' && !msg.content && msg.steps.length > 0 && (
                  <Loader2 className="w-3 h-3 animate-spin text-purple-400" />
                )}
                {msg.status === 'done' && (
                  <div className="flex items-start gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-green-400 mt-0.5 flex-shrink-0" />
                    <div className="prose prose-invert prose-sm max-w-none
                      prose-headings:text-green-200 prose-headings:text-sm prose-headings:font-semibold prose-headings:mt-3 prose-headings:mb-1
                      prose-p:text-green-300 prose-p:text-xs prose-p:my-1 prose-p:leading-relaxed
                      prose-li:text-green-300 prose-li:text-xs prose-li:my-0
                      prose-strong:text-green-200
                      prose-code:text-green-200 prose-code:bg-gray-900/50 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[11px]
                      prose-pre:bg-gray-900/50 prose-pre:rounded-lg prose-pre:p-2 prose-pre:text-[11px]
                      prose-hr:border-gray-700 prose-hr:my-2">
                      <ReactMarkdown>{msg.content}</ReactMarkdown>
                    </div>
                  </div>
                )}
                {msg.status === 'error' && (
                  <div className="flex items-start gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5 text-red-400 mt-0.5 flex-shrink-0" />
                    <span>{msg.content}</span>
                  </div>
                )}
                {!msg.status && (
                  <div className="prose prose-invert prose-sm max-w-none
                    prose-p:text-gray-300 prose-p:text-xs prose-p:my-1
                    prose-li:text-gray-300 prose-li:text-xs
                    prose-strong:text-gray-200
                    prose-code:text-purple-300 prose-code:bg-gray-900/50 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[11px]">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                )}
              </div>
              {msg.role === 'user' && (
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center mt-0.5">
                  <User className="w-3.5 h-3.5 text-blue-400" />
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-700 pt-3">
        <form onSubmit={handleSubmit}>
          <div className="relative">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('copilot.placeholder')}
              disabled={isDisabled}
              rows={2}
              className={`
                w-full px-3 py-2 pr-12 bg-gray-900 border rounded-lg resize-none
                text-sm text-white placeholder-gray-500
                focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500
                ${isDisabled ? 'opacity-50 cursor-not-allowed border-gray-700' : 'border-gray-600'}
              `}
            />
            <button
              type="submit"
              disabled={isDisabled || !input.trim()}
              className={`
                absolute right-2 bottom-2 p-1.5 rounded-md transition-colors
                ${isDisabled || !input.trim()
                  ? 'text-gray-600 cursor-not-allowed'
                  : 'text-purple-400 hover:bg-purple-500/20 hover:text-purple-300'
                }
              `}
            >
              {isProcessing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </button>
          </div>
          <p className="mt-1.5 text-xs text-gray-600">{t('copilot.enterToSend')}</p>
        </form>
      </div>
    </div>
  )
})

import { useState, useCallback, useRef, useEffect } from 'react'
import { X, Send, Loader2, GripVertical, Trash2 } from 'lucide-react'
import { sessionStreamManager } from '@/services/SessionStreamManager'
import { RestChatService } from '@/services/api/restChatService'
import { MessageList } from './MessageList'
import type { Message } from '@/types'

interface ByTheWayProps {
  businessScopeId: string
  sessionId: string
  agentId?: string
  onClose: () => void
}

function deriveBtwSessionId(sessionId: string): string {
  const first8 = parseInt(sessionId.slice(0, 8), 16)
  const xored = (first8 ^ 0xDEADBEEF) >>> 0
  return xored.toString(16).padStart(8, '0') + sessionId.slice(8)
}

const BTW_MIN_WIDTH = 360
const BTW_MAX_WIDTH = 720
const BTW_DEFAULT_WIDTH = 520

export function ByTheWay({ businessScopeId, sessionId, agentId, onClose }: ByTheWayProps) {
  const [input, setInput] = useState('')
  const btwSessionId = deriveBtwSessionId(sessionId)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [, forceUpdate] = useState(0)
  const [width, setWidth] = useState(BTW_DEFAULT_WIDTH)
  const isResizing = useRef(false)

  useEffect(() => {
    const unsub = sessionStreamManager.subscribe(() => forceUpdate(n => n + 1))
    return unsub
  }, [])

  const skipFetch = useRef(false)

  useEffect(() => {
    if (skipFetch.current) return
    const state = sessionStreamManager.getSession(btwSessionId)
    if (state.messages.length > 0) return
    RestChatService.getSessionHistory(btwSessionId).then(history => {
      if (history.length > 0 && !skipFetch.current) {
        sessionStreamManager.setMessages(btwSessionId, history)
      }
    }).catch(() => {})
  }, [btwSessionId])

  const state = sessionStreamManager.getSession(btwSessionId)
  const messages: Message[] = state.messages
  const isSending = state.isSending

  const handleSend = useCallback(() => {
    const text = input.trim()
    if (!text || isSending) return
    setInput('')
    sessionStreamManager.sendMessage(btwSessionId, text, {
      businessScopeId,
      agentId,
      sopContext: '',
    })
  }, [input, isSending, btwSessionId, businessScopeId, agentId])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const handleClear = useCallback(async () => {
    skipFetch.current = true
    sessionStreamManager.stopStream(btwSessionId)
    sessionStreamManager.setMessages(btwSessionId, [])
    try {
      await RestChatService.clearSessionHistory(btwSessionId)
    } catch {}
  }, [btwSessionId])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    const startX = e.clientX
    const startWidth = width

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizing.current) return
      const delta = startX - moveEvent.clientX
      const newWidth = Math.min(BTW_MAX_WIDTH, Math.max(BTW_MIN_WIDTH, startWidth + delta))
      setWidth(newWidth)
    }

    const handleMouseUp = () => {
      isResizing.current = false
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [width])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div
      className="fixed inset-y-0 right-0 bg-gray-900 border-l border-gray-700 flex flex-col z-50 shadow-2xl"
      style={{ width: `${width}px` }}
    >
      {/* Resize handle */}
      <div
        className="absolute inset-y-0 left-0 w-2 cursor-col-resize flex items-center justify-center hover:bg-blue-500/20 transition-colors group"
        onMouseDown={handleResizeStart}
      >
        <GripVertical className="w-3 h-3 text-gray-600 group-hover:text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-200">By the Way</span>
          <span className="text-[10px] px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded">shared workspace</span>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              onClick={handleClear}
              title="Clear conversation"
              className="p-1 text-gray-400 hover:text-red-400 hover:bg-gray-700 rounded transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <MessageList messages={messages} isTyping={isSending} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-700 p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask something while the main session runs..."
            className="flex-1 resize-none bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 max-h-32"
            rows={1}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isSending}
            className="p-2 rounded-lg bg-blue-600 text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-blue-500 transition-colors"
          >
            {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  )
}

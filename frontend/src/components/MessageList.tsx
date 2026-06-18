import { useRef, useEffect, useMemo, memo } from 'react'
import { User } from 'lucide-react'
import type { Message } from '@/types'
import type { ContentBlock } from '@/services/chatStreamService'
import { ChatMessage } from './chat/ChatMessage'
import { TextContentBlock } from './chat/TextContentBlock'
import { useTranslation } from '@/i18n'

interface MessageListProps {
  messages: Message[]
  isTyping?: boolean
  scrollToTimestamp?: Date
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Attempts to parse AI message content as an array of content blocks.
 * Returns the parsed blocks if valid, or null if it's plain text.
 */
function tryParseContentBlocks(content: string): ContentBlock[] | null {
  if (!content.startsWith('[')) return null
  try {
    const parsed = JSON.parse(content)
    if (!Array.isArray(parsed)) return null
    // Validate that at least the first element looks like a content block
    if (parsed.length > 0 && typeof parsed[0]?.type === 'string') {
      return parsed as ContentBlock[]
    }
    return null
  } catch {
    return null
  }
}

const UserBubble = memo(function UserBubble({ message }: { message: Message }) {
  const isLong =
    message.content.length > 200 ||
    message.content.includes('\n#') ||
    message.content.includes('\n|')
  return (
    <div className="flex gap-3 flex-row-reverse">
      <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 bg-blue-600/15 border border-blue-500/25">
        <User className="w-4 h-4 text-blue-400" />
      </div>
      <div className="flex flex-col max-w-[70%] items-end">
        <div className="px-4 py-2 rounded-2xl bg-blue-600/15 border border-blue-500/20 text-white rounded-br-md">
          {isLong ? (
            <TextContentBlock block={{ type: 'text', text: message.content }} />
          ) : (
            <p className="text-sm whitespace-pre-wrap">{message.content}</p>
          )}
        </div>
        <span className="text-xs text-gray-500 mt-1 px-1">{formatTime(message.timestamp)}</span>
      </div>
    </div>
  )
})

const AIBubble = memo(function AIBubble({
  message,
  isStreaming,
}: {
  message: Message
  isStreaming?: boolean
}) {
  const contentBlocks = useMemo(() => tryParseContentBlocks(message.content), [message.content])

  // While streaming, content starts empty — show typing dots
  if (!message.content) {
    return (
      <div className="flex flex-col items-start">
        <TypingIndicator />
        <span className="text-xs text-gray-500 mt-1 px-1 ml-11">
          {formatTime(message.timestamp)}
        </span>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-start">
      {contentBlocks ? (
        // Rich rendering with content blocks (text, tool_use, tool_result)
        <div className="max-w-[85%]">
          <ChatMessage
            content={contentBlocks}
            isStreaming={isStreaming}
            speakerAgentName={message.speakerAgentName}
            speakerAgentAvatar={message.speakerAgentAvatar}
          />
        </div>
      ) : (
        // Fallback: markdown rendering for plain text messages
        <div className="flex gap-3">
          <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 bg-purple-600">
            <svg
              className="w-4 h-4 text-white"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 8V4H8" />
              <rect width="16" height="12" x="4" y="8" rx="2" />
              <path d="M2 14h2" />
              <path d="M20 14h2" />
              <path d="M15 13v2" />
              <path d="M9 13v2" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <TextContentBlock block={{ type: 'text', text: message.content }} />
          </div>
        </div>
      )}
      <span className="text-xs text-gray-500 mt-1 px-1 ml-11">{formatTime(message.timestamp)}</span>
    </div>
  )
})

function TypingIndicator() {
  return (
    <div className="flex gap-3">
      <div className="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center flex-shrink-0">
        <svg
          className="w-4 h-4 text-white"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 8V4H8" />
          <rect width="16" height="12" x="4" y="8" rx="2" />
          <path d="M2 14h2" />
          <path d="M20 14h2" />
          <path d="M15 13v2" />
          <path d="M9 13v2" />
        </svg>
      </div>
      <div className="bg-gray-800 px-4 py-3 rounded-2xl rounded-bl-md">
        <div className="flex gap-1">
          <span
            className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
            style={{ animationDelay: '0ms' }}
          />
          <span
            className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
            style={{ animationDelay: '150ms' }}
          />
          <span
            className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
            style={{ animationDelay: '300ms' }}
          />
        </div>
      </div>
    </div>
  )
}

export function MessageList({ messages, isTyping = false, scrollToTimestamp }: MessageListProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollTargetRef = useRef<HTMLDivElement>(null)
  const hasScrolledToTarget = useRef(false)
  const { t } = useTranslation()

  useEffect(() => {
    if (scrollToTimestamp && !hasScrolledToTarget.current && messages.length > 0) {
      const targetIdx = messages.findIndex((m) => m.timestamp >= scrollToTimestamp)
      if (targetIdx >= 0) {
        hasScrolledToTarget.current = true
        requestAnimationFrame(() => {
          scrollTargetRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        })
        return
      }
    }
    if (!scrollToTimestamp) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isTyping, scrollToTimestamp])

  if (messages.length === 0 && !isTyping) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        <p>{t('chat.emptyState')}</p>
      </div>
    )
  }

  const targetIdx = scrollToTimestamp
    ? messages.findIndex((m) => m.timestamp >= scrollToTimestamp)
    : -1

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages.map((message, idx) => (
        <div key={message.id} ref={idx === targetIdx ? scrollTargetRef : undefined}>
          {idx === targetIdx && (
            <div className="flex items-center gap-2 py-1 mb-2">
              <div className="flex-1 border-t border-blue-500/30" />
              <span className="text-[10px] text-blue-400 px-2">Execution start</span>
              <div className="flex-1 border-t border-blue-500/30" />
            </div>
          )}
          {message.type === 'user' ? (
            <UserBubble message={message} />
          ) : (
            <AIBubble message={message} isStreaming={isTyping && idx === messages.length - 1} />
          )}
        </div>
      ))}
      {isTyping && !messages.some((m) => m.type === 'ai' && !m.content) && <TypingIndicator />}
      <div ref={messagesEndRef} />
    </div>
  )
}

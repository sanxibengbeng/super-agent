import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Loader2, Maximize2, Eye, EyeOff, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { getValidToken } from '@/services/auth';
import { RestTwinSessionService, type TwinSessionDetail } from '@/services/api/restTwinSessionService';
import { SuggestionCard } from './SuggestionCard';

interface ChatMessage {
  id: string;
  type: 'user' | 'agent' | 'ai' | 'system';
  content: string;
  agent_id: string | null;
  created_at: string;
  metadata?: Record<string, unknown>;
}

interface TwinSessionPanelProps {
  projectId: string;
  twinSessionId: string;
  isFullPage?: boolean;
  onClose?: () => void;
}

export function TwinSessionPanel({ projectId, twinSessionId, isFullPage, onClose }: TwinSessionPanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<TwinSessionDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    async function load() {
      setIsLoading(true);
      try {
        const ts = await RestTwinSessionService.getById(projectId, twinSessionId);
        setDetail(ts);

        const token = await getValidToken();
        const baseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
        const res = await fetch(
          `${baseUrl}/api/chat/history/${ts.session.id}?limit=50`,
          { headers: token ? { Authorization: `Bearer ${token}` } : {} },
        );
        if (res.ok) {
          const data = await res.json();
          setMessages(data.messages ?? data ?? []);
        }
      } catch {
        // handle error
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, [projectId, twinSessionId]);

  useEffect(scrollToBottom, [messages, scrollToBottom]);

  const handleSend = async () => {
    if (!input.trim() || isSending || !detail) return;
    const content = input.trim();
    setInput('');

    const userMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      type: 'user',
      content,
      agent_id: null,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);

    const aiMsgId = `temp-ai-${Date.now()}`;
    const aiMsg: ChatMessage = {
      id: aiMsgId,
      type: 'ai',
      content: '',
      agent_id: detail.agent_id,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, aiMsg]);
    setIsSending(true);

    try {
      const token = await getValidToken();
      const baseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
      const response = await fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          session_id: detail.session.id,
          business_scope_id: detail.session.business_scope_id,
          message: content,
        }),
      });

      if (!response.ok) throw new Error(`Request failed: ${response.status}`);

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'assistant' && Array.isArray(parsed.content)) {
              const textBlocks = parsed.content.filter((b: { type: string }) => b.type === 'text');
              fullText = textBlocks.map((b: { text: string }) => b.text).join('\n');
              setMessages(prev =>
                prev.map(m => (m.id === aiMsgId ? { ...m, content: fullText } : m)),
              );
            }
          } catch { /* skip unparseable SSE events */ }
        }
      }
    } catch (err) {
      setMessages(prev =>
        prev.map(m =>
          m.id === aiMsgId
            ? { ...m, content: err instanceof Error ? err.message : 'Failed to send' }
            : m,
        ),
      );
    } finally {
      setIsSending(false);
    }
  };

  const handleToggleVisibility = async () => {
    if (!detail) return;
    const newVis = detail.visibility === 'private' ? 'public' : 'private';
    await RestTwinSessionService.updateVisibility(projectId, twinSessionId, newVis);
    setDetail({ ...detail, visibility: newVis });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gray-950">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {detail?.agent.avatar ? (
            <img src={detail.agent.avatar} alt="" className="w-6 h-6 rounded-full object-cover" />
          ) : (
            <div className="w-6 h-6 rounded-full bg-purple-600 flex items-center justify-center text-[10px] text-white">
              {(detail?.agent.display_name ?? detail?.agent.name ?? 'T')[0]}
            </div>
          )}
          <div className="min-w-0">
            <p className="text-xs font-medium text-white truncate">
              {detail?.agent.display_name ?? detail?.agent.name}
            </p>
            {detail?.issue && (
              <p className="text-[10px] text-gray-500 truncate">
                #{detail.issue.issue_number} {detail.issue.title}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleToggleVisibility}
            className="p-1 text-gray-500 hover:text-white rounded transition-colors"
            title={detail?.visibility === 'private' ? 'Make public' : 'Make private'}
          >
            {detail?.visibility === 'private' ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          {!isFullPage && (
            <button
              onClick={() => navigate(`/projects/${projectId}/twin-session/${twinSessionId}`)}
              className="p-1 text-gray-500 hover:text-white rounded transition-colors"
              title={t('twinSession.popOut')}
            >
              <Maximize2 size={14} />
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 text-gray-500 hover:text-white rounded transition-colors"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-600 text-xs">
            {t('twinSession.emptyState')}
          </div>
        ) : (
          messages.map((msg) => {
            if (msg.metadata && (msg.metadata as Record<string, unknown>).suggestion_id) {
              return (
                <SuggestionCard
                  key={msg.id}
                  projectId={projectId}
                  twinSessionId={twinSessionId}
                  suggestion={{
                    suggestion_id: (msg.metadata as Record<string, unknown>).suggestion_id as string,
                    preview: (msg.metadata as Record<string, unknown>).preview as {
                      action_type: string;
                      payload: Record<string, unknown>;
                      reason: string;
                    },
                  }}
                />
              );
            }

            return (
              <div
                key={msg.id}
                className={`flex gap-2 ${msg.type === 'user' ? 'flex-row-reverse' : ''}`}
              >
                <div
                  className={`max-w-[80%] px-3 py-2 rounded-xl text-xs ${
                    msg.type === 'user'
                      ? 'bg-blue-600/15 border border-blue-500/20 text-white rounded-br-sm'
                      : 'bg-gray-800 text-gray-100 rounded-bl-sm'
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-800 px-3 py-2 flex-shrink-0">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={t('twinSession.emptyState')}
            className="flex-1 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-white placeholder-gray-600 outline-none focus:border-blue-500"
            disabled={isSending}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isSending}
            className="px-2.5 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg transition-colors"
          >
            {isSending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}

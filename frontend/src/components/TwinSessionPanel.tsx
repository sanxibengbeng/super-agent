import { useState, useEffect, useContext, useCallback } from 'react';
import { Loader2, Maximize2, Eye, EyeOff, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { RestTwinSessionService, type TwinSessionDetail } from '@/services/api/restTwinSessionService';
import { ChatProvider, ChatContext } from '@/services/ChatContext';
import { MessageList } from '@/components';
import { MessageInput } from '@/pages/Chat';

interface TwinSessionPanelProps {
  projectId: string;
  twinSessionId: string;
  isFullPage?: boolean;
  onClose?: () => void;
}

export function TwinSessionPanel({ projectId, twinSessionId, isFullPage, onClose }: TwinSessionPanelProps) {
  const [detail, setDetail] = useState<TwinSessionDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    RestTwinSessionService.getById(projectId, twinSessionId)
      .then(ts => { if (!cancelled) setDetail(ts); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, twinSessionId]);

  if (isLoading || !detail) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
      </div>
    );
  }

  return (
    <ChatProvider
      key={detail.session.id}
      initialSessionId={detail.session.id}
      initialScopeId={detail.session.business_scope_id ?? undefined}
    >
      <TwinSessionContent
        projectId={projectId}
        twinSessionId={twinSessionId}
        detail={detail}
        setDetail={setDetail}
        isFullPage={isFullPage}
        onClose={onClose}
      />
    </ChatProvider>
  );
}

function TwinSessionContent({
  projectId,
  twinSessionId,
  detail,
  setDetail,
  isFullPage,
  onClose,
}: {
  projectId: string;
  twinSessionId: string;
  detail: TwinSessionDetail;
  setDetail: (d: TwinSessionDetail) => void;
  isFullPage?: boolean;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    messages,
    isSending,
    backendSessionId,
    selectedBusinessScopeId,
    sendMessage,
    stopGeneration,
  } = useContext(ChatContext);

  const handleSend = useCallback(async (content: string, mentionAgentId?: string) => {
    await sendMessage(content, mentionAgentId);
  }, [sendMessage]);

  const handleToggleVisibility = async () => {
    const newVis = detail.visibility === 'private' ? 'public' : 'private';
    await RestTwinSessionService.updateVisibility(projectId, twinSessionId, newVis);
    setDetail({ ...detail, visibility: newVis });
  };

  // Stub upload handler — twin panel doesn't support file upload yet
  const noopUpload = useCallback(async (_files: File[]) => {}, []);

  return (
    <div className="flex flex-col h-full bg-gray-950">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {detail.agent.avatar ? (
            <img src={detail.agent.avatar} alt="" className="w-6 h-6 rounded-full object-cover" />
          ) : (
            <div className="w-6 h-6 rounded-full bg-purple-600 flex items-center justify-center text-[10px] text-white">
              {(detail.agent.display_name ?? detail.agent.name ?? 'T')[0]}
            </div>
          )}
          <div className="min-w-0">
            <p className="text-xs font-medium text-white truncate">
              {detail.agent.display_name ?? detail.agent.name}
            </p>
            {detail.issue && (
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
            title={detail.visibility === 'private' ? 'Make public' : 'Make private'}
          >
            {detail.visibility === 'private' ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          {!isFullPage && (
            <button
              onClick={() => {
                const params = new URLSearchParams({ session: detail.session?.id ?? twinSessionId });
                if (detail.session?.business_scope_id) params.set('scope', detail.session.business_scope_id);
                navigate(`/chat?${params.toString()}`);
              }}
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

      {/* Messages — reuse the shared MessageList */}
      {messages.length === 0 && !isSending ? (
        <div className="flex-1 flex items-center justify-center text-gray-600 text-xs">
          {t('twinSession.emptyState')}
        </div>
      ) : (
        <MessageList messages={messages} isTyping={isSending} />
      )}

      {/* Input — reuse the shared MessageInput */}
      <MessageInput
        onSend={handleSend}
        onStop={stopGeneration}
        onUpload={noopUpload}
        sessionId={backendSessionId}
        businessScopeId={selectedBusinessScopeId}
        disabled={isSending}
        isSending={isSending}
      />
    </div>
  );
}

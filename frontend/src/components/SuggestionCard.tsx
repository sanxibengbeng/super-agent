import { useState } from 'react';
import { Check, X, Loader2, AlertCircle } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { RestTwinSessionService } from '@/services/api/restTwinSessionService';

interface SuggestionCardProps {
  projectId: string;
  twinSessionId: string;
  suggestion: {
    suggestion_id: string;
    preview: {
      action_type: string;
      payload: Record<string, unknown>;
      reason: string;
    };
  };
  onResolved?: (actionId: string, status: 'confirmed' | 'rejected') => void;
}

const ACTION_LABELS: Record<string, { en: string; cn: string }> = {
  create_issue: { en: 'Create Issue', cn: '创建 Issue' },
  update_issue: { en: 'Update Issue', cn: '更新 Issue' },
  add_comment: { en: 'Add Comment', cn: '添加评论' },
  change_status: { en: 'Change Status', cn: '变更状态' },
};

export function SuggestionCard({ projectId, twinSessionId, suggestion, onResolved }: SuggestionCardProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<'pending' | 'confirming' | 'rejecting' | 'confirmed' | 'rejected'>('pending');

  const { preview } = suggestion;
  const actionLabel = ACTION_LABELS[preview.action_type]?.en ?? preview.action_type;

  const handleConfirm = async () => {
    setStatus('confirming');
    try {
      await RestTwinSessionService.confirmAction(projectId, twinSessionId, suggestion.suggestion_id);
      setStatus('confirmed');
      onResolved?.(suggestion.suggestion_id, 'confirmed');
    } catch {
      setStatus('pending');
    }
  };

  const handleReject = async () => {
    setStatus('rejecting');
    try {
      await RestTwinSessionService.rejectAction(projectId, twinSessionId, suggestion.suggestion_id);
      setStatus('rejected');
      onResolved?.(suggestion.suggestion_id, 'rejected');
    } catch {
      setStatus('pending');
    }
  };

  const isResolved = status === 'confirmed' || status === 'rejected';

  return (
    <div className={`border rounded-lg p-3 my-2 ${
      status === 'confirmed' ? 'border-green-500/30 bg-green-500/5' :
      status === 'rejected' ? 'border-red-500/30 bg-red-500/5' :
      'border-yellow-500/30 bg-yellow-500/5'
    }`}>
      <div className="flex items-center gap-2 mb-2">
        <AlertCircle size={14} className="text-yellow-400" />
        <span className="text-xs font-medium text-yellow-300">{t('twinSession.suggestion')}: {actionLabel}</span>
        {isResolved && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${
            status === 'confirmed' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
          }`}>
            {status === 'confirmed' ? t('twinSession.suggestion.confirmed') : t('twinSession.suggestion.rejected')}
          </span>
        )}
      </div>

      <p className="text-xs text-gray-300 mb-2">{preview.reason}</p>

      <pre className="text-[10px] text-gray-400 bg-gray-800/50 rounded p-2 mb-2 overflow-x-auto">
        {JSON.stringify(preview.payload, null, 2)}
      </pre>

      {!isResolved && (
        <div className="flex gap-2">
          <button
            onClick={handleConfirm}
            disabled={status !== 'pending'}
            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-green-600/20 hover:bg-green-600/30 text-green-400 border border-green-500/30 rounded transition-colors disabled:opacity-50"
          >
            {status === 'confirming' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {t('twinSession.suggestion.confirm')}
          </button>
          <button
            onClick={handleReject}
            disabled={status !== 'pending'}
            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/30 rounded transition-colors disabled:opacity-50"
          >
            {status === 'rejecting' ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
            {t('twinSession.suggestion.reject')}
          </button>
        </div>
      )}
    </div>
  );
}

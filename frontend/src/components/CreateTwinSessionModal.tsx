import { useState, useEffect } from 'react';
import { X, Loader2 } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { restClient } from '@/services/api/restClient';
import type { ProjectIssue } from '@/services/api/restProjectService';

interface Agent {
  id: string;
  name: string;
  display_name: string | null;
  avatar: string | null;
  role: string | null;
}

interface CreateTwinSessionModalProps {
  scopeId: string | null;
  issues: ProjectIssue[];
  preSelectedIssueId?: string;
  onClose: () => void;
  onCreate: (input: { agent_id: string; issue_id?: string; visibility?: string }) => Promise<void>;
}

export function CreateTwinSessionModal({
  scopeId,
  issues,
  preSelectedIssueId,
  onClose,
  onCreate,
}: CreateTwinSessionModalProps) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [selectedIssueId, setSelectedIssueId] = useState<string>(preSelectedIssueId ?? '');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    async function loadAgents() {
      setIsLoading(true);
      try {
        const res = await restClient.get<{ data: Agent[] }>('/api/agents');
        setAgents(res.data ?? []);
      } catch {
        setAgents([]);
      } finally {
        setIsLoading(false);
      }
    }
    loadAgents();
  }, [scopeId]);

  const handleCreate = async () => {
    if (!selectedAgentId) return;
    setIsCreating(true);
    try {
      await onCreate({
        agent_id: selectedAgentId,
        issue_id: selectedIssueId || undefined,
        visibility,
      });
      onClose();
    } catch {
      // error handled by parent
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-white">{t('twinSession.new')}</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-800 rounded">
            <X size={16} className="text-gray-400" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Agent selector */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">{t('twinSession.selectAgent')}</label>
            {isLoading ? (
              <Loader2 size={16} className="animate-spin text-gray-500" />
            ) : (
              <select
                value={selectedAgentId}
                onChange={(e) => setSelectedAgentId(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white"
              >
                <option value="">--</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.display_name ?? a.name} {a.role ? `(${a.role})` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Issue selector */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">{t('twinSession.bindIssue')}</label>
            <select
              value={selectedIssueId}
              onChange={(e) => setSelectedIssueId(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white"
            >
              <option value="">{t('twinSession.bindIssue.none')}</option>
              {issues.map((issue) => (
                <option key={issue.id} value={issue.id}>
                  #{issue.issue_number} {issue.title}
                </option>
              ))}
            </select>
          </div>

          {/* Visibility */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">{t('twinSession.visibility')}</label>
            <div className="flex gap-3">
              <label className="flex items-center gap-1.5 text-xs text-gray-300">
                <input
                  type="radio"
                  value="private"
                  checked={visibility === 'private'}
                  onChange={() => setVisibility('private')}
                  className="accent-blue-500"
                />
                {t('twinSession.visibility.private')}
              </label>
              <label className="flex items-center gap-1.5 text-xs text-gray-300">
                <input
                  type="radio"
                  value="public"
                  checked={visibility === 'public'}
                  onChange={() => setVisibility('public')}
                  className="accent-blue-500"
                />
                {t('twinSession.visibility.public')}
              </label>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-white transition-colors"
          >
            {t('common.cancel') ?? 'Cancel'}
          </button>
          <button
            onClick={handleCreate}
            disabled={!selectedAgentId || isCreating}
            className="px-4 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg transition-colors"
          >
            {isCreating ? <Loader2 size={14} className="animate-spin" /> : t('twinSession.new')}
          </button>
        </div>
      </div>
    </div>
  );
}

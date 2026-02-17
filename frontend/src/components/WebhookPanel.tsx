/**
 * WebhookPanel - Manage webhooks for a workflow
 */

import { useState, useEffect } from 'react';
import { 
  X, 
  Copy, 
  Check, 
  Plus, 
  Trash2, 
  ToggleLeft, 
  ToggleRight,
  ExternalLink,
  Clock,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { useWebhooks } from '@/services/useWebhooks';
import type { Webhook, WebhookCallRecord } from '@/services/useWebhooks';

interface WebhookPanelProps {
  workflowId: string;
  onClose: () => void;
}

export function WebhookPanel({ workflowId, onClose }: WebhookPanelProps) {
  const {
    webhooks,
    isLoading,
    error,
    loadWebhooks,
    createWebhook,
    updateWebhook,
    deleteWebhook,
    getCallHistory,
    clearError,
  } = useWebhooks();

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState<string | null>(null);
  const [selectedWebhook, setSelectedWebhook] = useState<Webhook | null>(null);
  const [callHistory, setCallHistory] = useState<WebhookCallRecord[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    loadWebhooks(workflowId);
  }, [workflowId, loadWebhooks]);

  const handleCopyUrl = async (webhook: Webhook) => {
    await navigator.clipboard.writeText(webhook.webhookUrl);
    setCopiedId(webhook.webhookId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleCreate = async () => {
    setIsCreating(true);
    const result = await createWebhook(workflowId, {
      name: `Webhook ${webhooks.length + 1}`,
      generateSecret: true,
    });
    setIsCreating(false);
    if (result?.secret) {
      setShowSecret(result.secret);
    }
  };

  const handleToggle = async (webhook: Webhook) => {
    await updateWebhook(webhook.webhookId, { isEnabled: !webhook.isEnabled });
  };

  const handleDelete = async (webhook: Webhook) => {
    if (confirm('Are you sure you want to delete this webhook?')) {
      await deleteWebhook(webhook.webhookId);
      if (selectedWebhook?.webhookId === webhook.webhookId) {
        setSelectedWebhook(null);
        setCallHistory([]);
      }
    }
  };

  const handleViewHistory = async (webhook: Webhook) => {
    setSelectedWebhook(webhook);
    setIsLoadingHistory(true);
    const result = await getCallHistory(webhook.webhookId);
    if (result) {
      setCallHistory(result.records);
    }
    setIsLoadingHistory(false);
  };

  return (
    <div className="w-96 border-l border-gray-800 bg-gray-900/95 flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-gray-800 flex items-center justify-between">
        <h3 className="text-sm font-medium text-white">Webhooks</h3>
        <button onClick={onClose} className="p-1 hover:bg-gray-800 rounded">
          <X className="w-4 h-4 text-gray-400" />
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-4 mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400" />
          <span className="text-sm text-red-400">{error}</span>
          <button onClick={clearError} className="ml-auto text-red-400 hover:text-red-300">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Secret Modal */}
      {showSecret && (
        <div className="mx-4 mt-4 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
          <p className="text-sm text-yellow-400 mb-2 font-medium">
            ⚠️ Save this secret - it won't be shown again!
          </p>
          <code className="block p-2 bg-gray-800 rounded text-xs text-gray-300 break-all">
            {showSecret}
          </code>
          <button
            onClick={() => setShowSecret(null)}
            className="mt-2 text-xs text-yellow-400 hover:text-yellow-300"
          >
            I've saved it
          </button>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
          </div>
        ) : webhooks.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-sm text-gray-500 mb-4">No webhooks configured</p>
            <button
              onClick={handleCreate}
              disabled={isCreating}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm flex items-center gap-2 mx-auto"
            >
              {isCreating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              Create Webhook
            </button>
          </div>
        ) : (
          <>
            {webhooks.map((webhook) => (
              <div
                key={webhook.webhookId}
                className={`p-3 rounded-lg border ${
                  selectedWebhook?.webhookId === webhook.webhookId
                    ? 'border-blue-500/50 bg-blue-500/10'
                    : 'border-gray-700 bg-gray-800/50'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-white">
                    {webhook.name || 'Unnamed Webhook'}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleToggle(webhook)}
                      className="p-1 hover:bg-gray-700 rounded"
                      title={webhook.isEnabled ? 'Disable' : 'Enable'}
                    >
                      {webhook.isEnabled ? (
                        <ToggleRight className="w-5 h-5 text-green-400" />
                      ) : (
                        <ToggleLeft className="w-5 h-5 text-gray-500" />
                      )}
                    </button>
                    <button
                      onClick={() => handleDelete(webhook)}
                      className="p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-red-400"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2 mb-2">
                  <code className="flex-1 text-xs text-gray-400 truncate bg-gray-900 px-2 py-1 rounded">
                    {webhook.webhookUrl}
                  </code>
                  <button
                    onClick={() => handleCopyUrl(webhook)}
                    className="p-1 hover:bg-gray-700 rounded"
                    title="Copy URL"
                  >
                    {copiedId === webhook.webhookId ? (
                      <Check className="w-4 h-4 text-green-400" />
                    ) : (
                      <Copy className="w-4 h-4 text-gray-400" />
                    )}
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    webhook.isEnabled 
                      ? 'bg-green-500/20 text-green-400' 
                      : 'bg-gray-500/20 text-gray-400'
                  }`}>
                    {webhook.isEnabled ? 'Active' : 'Disabled'}
                  </span>
                  <button
                    onClick={() => handleViewHistory(webhook)}
                    className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
                  >
                    <Clock className="w-3 h-3" />
                    History
                  </button>
                </div>
              </div>
            ))}

            <button
              onClick={handleCreate}
              disabled={isCreating}
              className="w-full px-4 py-2 border border-dashed border-gray-700 hover:border-gray-600 text-gray-400 hover:text-gray-300 rounded-lg text-sm flex items-center justify-center gap-2"
            >
              {isCreating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              Add Webhook
            </button>
          </>
        )}
      </div>

      {/* Call History */}
      {selectedWebhook && (
        <div className="border-t border-gray-800 p-4 max-h-64 overflow-y-auto">
          <h4 className="text-xs font-medium text-gray-400 mb-2">
            Call History - {selectedWebhook.name || 'Webhook'}
          </h4>
          {isLoadingHistory ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
            </div>
          ) : callHistory.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-4">No calls yet</p>
          ) : (
            <div className="space-y-2">
              {callHistory.map((record) => (
                <div
                  key={record.id}
                  className="p-2 bg-gray-800/50 rounded text-xs"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-gray-400">
                      {new Date(record.calledAt).toLocaleString()}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded ${
                      record.responseStatus >= 200 && record.responseStatus < 300
                        ? 'bg-green-500/20 text-green-400'
                        : 'bg-red-500/20 text-red-400'
                    }`}>
                      {record.responseStatus}
                    </span>
                  </div>
                  <div className="text-gray-500">
                    {record.durationMs}ms • {record.ipAddress || 'Unknown IP'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default WebhookPanel;

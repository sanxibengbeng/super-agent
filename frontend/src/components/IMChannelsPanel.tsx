/**
 * IMChannelsPanel
 *
 * Admin panel for managing IM channel bindings on a business scope.
 * Allows connecting Slack, Discord, and generic webhook channels
 * so external users can chat with the scope's agents via IM.
 * Also supports bridge-mode channels (whatsapp-bridge, lark-bridge)
 * that use QR code scanning for personal account connections.
 */

import { useState, useEffect } from 'react'
import { Plus, Trash2, Loader2, ToggleLeft, ToggleRight, MessageSquare, Hash, Copy, CheckCircle2 } from 'lucide-react'
import { useIMChannels } from '@/services/useIMChannels'
import type { CreateIMChannelRequest } from '@/services/useIMChannels'
import { useTranslation } from '@/i18n'
import { getAuthToken } from '@/services/api/restClient'

const CHANNEL_TYPES = [
  { value: 'slack', label: 'Slack', icon: '\u{1F4AC}', description: 'Connect a Slack channel via Events API' },
  { value: 'discord', label: 'Discord', icon: '\u{1F3AE}', description: 'Connect via Discord Gateway (WebSocket)' },
  { value: 'telegram', label: 'Telegram', icon: '✈️', description: 'Connect a Telegram group via Bot API' },
  { value: 'feishu', label: 'Feishu', icon: '\u{1FAB6}', description: 'Connect via Feishu WSClient (WebSocket)' },
  { value: 'dingtalk', label: 'DingTalk', icon: '\u{1F514}', description: 'Connect via DingTalk Stream or Webhook' },
  { value: 'whatsapp', label: 'WhatsApp', icon: '\u{1F4F1}', description: 'Connect via Meta Cloud API' },
  { value: 'whatsapp-bridge', label: 'WhatsApp (Personal)', icon: '\u{1F4F1}', description: 'Connect personal WhatsApp via QR code scan' },
  { value: 'lark-bridge', label: 'Feishu (Personal)', icon: '\u{1FAB6}', description: 'Connect via PersonalAgent app (WebSocket, no public IP needed)' },
  { value: 'webhook', label: 'Generic Webhook', icon: '\u{1F517}', description: 'Any platform via HTTP webhook' },
] as const

const BRIDGE_TYPES = ['whatsapp-bridge', 'lark-bridge']

interface BridgeState {
  bindingId: string;
  channelType: string;
  qr?: string;
  authUrl?: string;
  status: string;
}

interface IMChannelsPanelProps {
  scopeId: string
  scopeName?: string
}

export function IMChannelsPanel({ scopeId, scopeName }: IMChannelsPanelProps) {
  const { bindings, isLoading, error, create, update, remove, clearError } = useIMChannels(scopeId)
  const { t } = useTranslation()
  const [showForm, setShowForm] = useState(false)
  const [formData, setFormData] = useState<CreateIMChannelRequest>({
    channel_type: 'slack',
    channel_id: '',
    channel_name: '',
    bot_token: '',
    webhook_url: '',
    config: {},
  })
  const [isSaving, setIsSaving] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [dingtalkMode, setDingtalkMode] = useState<'stream' | 'webhook'>('webhook')
  const [bridgeState, setBridgeState] = useState<BridgeState | null>(null)
  const [bridgeStatuses, setBridgeStatuses] = useState<Record<string, string>>({})

  const apiBase = import.meta.env.VITE_API_BASE_URL || '';
  const getAuthHeaders = () => {
    const token = getAuthToken();
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  };

  // Poll real connection status for bridge bindings
  useEffect(() => {
    const bridgeBindings = bindings.filter(b => BRIDGE_TYPES.includes(b.channel_type));
    if (bridgeBindings.length === 0) return;

    const fetchStatuses = async () => {
      const results: Record<string, string> = {};
      for (const b of bridgeBindings) {
        try {
          const res = await fetch(`${apiBase}/api/im/bridge/${b.id}/status`, {
            headers: { Authorization: `Bearer ${getAuthToken()}` },
          });
          if (res.ok) {
            const json = await res.json();
            results[b.id] = json.data?.status || json.status || 'disconnected';
          } else {
            results[b.id] = 'disconnected';
          }
        } catch {
          results[b.id] = 'disconnected';
        }
      }
      setBridgeStatuses(results);
    };

    fetchStatuses();
    const interval = setInterval(fetchStatuses, 10000);
    return () => clearInterval(interval);
  }, [bindings, apiBase]);

  const isBridgeType = (type: string) => BRIDGE_TYPES.includes(type)

  const handleCreate = async () => {
    const effectiveData = { ...formData };

    // Bridge types: auto-generate channel_id
    if (isBridgeType(effectiveData.channel_type)) {
      effectiveData.channel_id = `bridge-${Date.now()}`;
    }

    // Auto-fill channel_id for DingTalk webhook mode
    if (effectiveData.channel_type === 'dingtalk' && dingtalkMode === 'webhook') {
      effectiveData.channel_id = '*';
    }
    if (!effectiveData.channel_id) return;
    setIsSaving(true);
    const result = await create(effectiveData);
    setIsSaving(false);
    if (result) {
      // For bridge types, immediately start the connection flow
      if (isBridgeType(effectiveData.channel_type)) {
        handleBridgeConnect(result.id, effectiveData.channel_type);
      }
      setShowForm(false);
      setFormData({ channel_type: 'slack', channel_id: '', channel_name: '', bot_token: '', webhook_url: '', config: {} });
    }
  };

  const handleToggle = async (bindingId: string, currentEnabled: boolean) => {
    await update(bindingId, { is_enabled: !currentEnabled })
  }

  const handleDelete = async (bindingId: string) => {
    if (!confirm(t('im.confirmRemove'))) return
    await remove(bindingId)
  }

  const copyWebhookUrl = (bindingId: string) => {
    const url = `${window.location.origin.replace(/:\d+$/, ':3000')}/api/im/webhook/${bindingId}`
    navigator.clipboard.writeText(url)
    setCopiedId(bindingId)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const handleBridgeConnect = async (bindingId: string, channelType: string) => {
    try {
      await fetch(`${apiBase}/api/im/bridge/${bindingId}/connect`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      setBridgeState({ bindingId, channelType, status: 'waiting_for_qr' });
    } catch (err) {
      console.error('Failed to start bridge connection:', err);
    }
  };

  const handleBridgeDisconnect = async (bindingId: string) => {
    try {
      await fetch(`${apiBase}/api/im/bridge/${bindingId}/disconnect`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      if (bridgeState?.bindingId === bindingId) {
        setBridgeState(null);
      }
    } catch (err) {
      console.error('Failed to disconnect bridge:', err);
    }
  };

  // QR polling effect
  useEffect(() => {
    if (!bridgeState || bridgeState.status === 'connected') return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${apiBase}/api/im/bridge/${bridgeState.bindingId}/qr`, {
          headers: getAuthHeaders(),
        });
        if (res.ok) {
          const json = await res.json();
          const payload = json.data || json;
          setBridgeState(prev => prev ? {
            ...prev,
            qr: payload.qr || prev.qr,
            authUrl: payload.auth_url || prev.authUrl,
            status: payload.status || prev.status,
          } : null);
          if (payload.status === 'connected') {
            clearInterval(interval);
          }
        }
      } catch (err) {
        console.error('QR poll error:', err);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [bridgeState?.bindingId, bridgeState?.status]);

  const channelTypeInfo = (type: string) => CHANNEL_TYPES.find(t => t.value === type)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-gray-400" />
          <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">{t('im.title')}</h3>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors"
        >
          <Plus className="w-3 h-3" />
          {t('im.addChannel')}
        </button>
      </div>
      <p className="text-xs text-gray-500 mt-1 mb-3">
        {t('im.connectDesc').replace('{name}', scopeName || 'this scope')}
      </p>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex items-center justify-between">
          <span className="text-red-400 text-sm">{error}</span>
          <button onClick={clearError} className="text-red-400 hover:text-red-300 text-xs">{t('im.dismiss')}</button>
        </div>
      )}

      {/* Create Form */}
      {showForm && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4 space-y-4">
          <div className="grid grid-cols-3 gap-2">
            {CHANNEL_TYPES.map(ct => (
              <button
                key={ct.value}
                onClick={() => setFormData(prev => ({ ...prev, channel_type: ct.value }))}
                className={`p-3 rounded-lg border text-left transition-colors ${
                  formData.channel_type === ct.value
                    ? 'border-blue-500 bg-blue-500/10'
                    : 'border-gray-700 hover:border-gray-600'
                }`}
              >
                <span className="text-lg">{ct.icon}</span>
                <div className="text-sm font-medium text-white mt-1">{ct.label}</div>
                <div className="text-xs text-gray-400">{ct.description}</div>
              </button>
            ))}
          </div>

          {/* Bridge types: show display name + type-specific fields */}
          {isBridgeType(formData.channel_type) && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('im.displayName')} (optional)</label>
                <input
                  type="text"
                  value={formData.channel_name || ''}
                  onChange={e => setFormData(prev => ({ ...prev, channel_name: e.target.value }))}
                  placeholder={formData.channel_type === 'whatsapp-bridge' ? 'My WhatsApp' : 'My Feishu'}
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              {formData.channel_type === 'lark-bridge' && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">App ID</label>
                      <input
                        type="text"
                        value={(formData.config as Record<string, string>)?.app_id || ''}
                        onChange={e => setFormData(prev => ({
                          ...prev,
                          channel_id: e.target.value,
                          config: { ...prev.config, app_id: e.target.value },
                        }))}
                        placeholder="cli_xxxxxxxxxx"
                        className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">App Secret</label>
                      <input
                        type="password"
                        value={formData.bot_token || ''}
                        onChange={e => setFormData(prev => ({ ...prev, bot_token: e.target.value, config: { ...prev.config, app_secret: e.target.value } }))}
                        placeholder="App Secret"
                        className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                  </div>
                  <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg p-3">
                    <p className="text-xs text-blue-400 font-medium mb-1">How to get App ID / Secret:</p>
                    <p className="text-xs text-gray-400">Run <code className="bg-gray-900 px-1 rounded">npx lark-channel-bridge</code> — it will guide you through QR scan to create a PersonalAgent app and output the credentials.</p>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Channel ID + Display Name — hidden for bridge types and DingTalk webhook mode */}
          {!isBridgeType(formData.channel_type) && !(formData.channel_type === 'dingtalk' && dingtalkMode === 'webhook') && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  {formData.channel_type === 'slack' ? 'Slack Channel ID' :
                   formData.channel_type === 'discord' ? 'Discord Channel ID' :
                   formData.channel_type === 'telegram' ? 'Telegram Chat ID' :
                   formData.channel_type === 'feishu' ? 'Feishu Chat ID' :
                   formData.channel_type === 'dingtalk' ? 'DingTalk Conversation ID' :
                   formData.channel_type === 'whatsapp' ? 'Phone Number ID' : 'Channel Identifier'}
                </label>
                <input
                  type="text"
                  value={formData.channel_id}
                  onChange={e => setFormData(prev => ({ ...prev, channel_id: e.target.value }))}
                  placeholder={formData.channel_type === 'slack' ? 'C0123456789' :
                               formData.channel_type === 'telegram' ? '-1001234567890' : 'channel-id'}
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('im.displayName')}</label>
              <input
                type="text"
                value={formData.channel_name || ''}
                onChange={e => setFormData(prev => ({ ...prev, channel_name: e.target.value }))}
                placeholder="#general"
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>
          )}

          {!isBridgeType(formData.channel_type) && formData.channel_type !== 'webhook' && !(formData.channel_type === 'dingtalk' && dingtalkMode === 'webhook') && (
            <div>
              <label className="block text-xs text-gray-400 mb-1">
                {formData.channel_type === 'feishu' ? 'App Secret' :
                 formData.channel_type === 'dingtalk' ? 'Client Secret (App Secret)' :
                 formData.channel_type === 'whatsapp' ? 'Access Token' : 'Bot Token'}
              </label>
              <input
                type="password"
                value={formData.bot_token || ''}
                onChange={e => setFormData(prev => ({ ...prev, bot_token: e.target.value }))}
                placeholder={formData.channel_type === 'slack' ? 'xoxb-...' :
                             formData.channel_type === 'telegram' ? '123456:ABC-DEF...' :
                             formData.channel_type === 'feishu' ? 'App Secret from Feishu console' :
                             formData.channel_type === 'dingtalk' ? 'App Secret from DingTalk console' :
                             formData.channel_type === 'whatsapp' ? 'Meta permanent access token' : 'Bot token'}
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
          )}

          {/* Platform-specific config fields */}
          {formData.channel_type === 'feishu' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">App ID</label>
                <input
                  type="text"
                  value={(formData.config as Record<string, string>)?.app_id || ''}
                  onChange={e => setFormData(prev => ({
                    ...prev,
                    config: { ...prev.config, app_id: e.target.value },
                  }))}
                  placeholder="cli_a1234567890b"
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Verification Token (optional)</label>
                <input
                  type="password"
                  value={(formData.config as Record<string, string>)?.verification_token || ''}
                  onChange={e => setFormData(prev => ({
                    ...prev,
                    config: { ...prev.config, verification_token: e.target.value },
                  }))}
                  placeholder="Event verification token"
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>
          )}

          {formData.channel_type === 'slack' && (
            <div>
              <label className="block text-xs text-gray-400 mb-1">Signing Secret (optional, for request verification)</label>
              <input
                type="password"
                value={(formData.config as Record<string, string>)?.signing_secret || ''}
                onChange={e => setFormData(prev => ({
                  ...prev,
                  config: { ...prev.config, signing_secret: e.target.value },
                }))}
                placeholder="Slack app signing secret"
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
          )}

          {formData.channel_type === 'discord' && (
            <div>
              <label className="block text-xs text-gray-400 mb-1">Public Key (for interaction verification)</label>
              <input
                type="text"
                value={(formData.config as Record<string, string>)?.public_key || ''}
                onChange={e => setFormData(prev => ({
                  ...prev,
                  config: { ...prev.config, public_key: e.target.value },
                }))}
                placeholder="Discord application public key"
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
          )}

          {formData.channel_type === 'telegram' && (
            <div>
              <label className="block text-xs text-gray-400 mb-1">Webhook Secret Token (optional)</label>
              <input
                type="password"
                value={(formData.config as Record<string, string>)?.secret_token || ''}
                onChange={e => setFormData(prev => ({
                  ...prev,
                  config: { ...prev.config, secret_token: e.target.value },
                }))}
                placeholder="Secret token for webhook verification"
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
          )}

          {formData.channel_type === 'dingtalk' && (
            <div className="space-y-3">
              {/* Mode selector */}
              <div>
                <label className="block text-xs text-gray-400 mb-1">{t('im.connectionMode')}</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setDingtalkMode('webhook')
                      setFormData(prev => ({ ...prev, channel_id: '*', bot_token: '', config: { ...prev.config, client_id: '' } }))
                    }}
                    className={`flex-1 px-3 py-2 rounded-lg border text-sm text-center transition-colors ${
                      dingtalkMode === 'webhook' ? 'border-blue-500 bg-blue-500/10 text-blue-400' : 'border-gray-700 text-gray-400 hover:border-gray-600'
                    }`}
                  >
                    {t('im.outgoingWebhook')}
                    <div className="text-[10px] text-gray-500 mt-0.5">{t('im.simpleHttp')}</div>
                  </button>
                  <button
                    onClick={() => {
                      setDingtalkMode('stream')
                      setFormData(prev => ({ ...prev, channel_id: '', webhook_url: '', config: { ...prev.config } }))
                    }}
                    className={`flex-1 px-3 py-2 rounded-lg border text-sm text-center transition-colors ${
                      dingtalkMode === 'stream' ? 'border-blue-500 bg-blue-500/10 text-blue-400' : 'border-gray-700 text-gray-400 hover:border-gray-600'
                    }`}
                  >
                    {t('im.streamWs')}
                    <div className="text-[10px] text-gray-500 mt-0.5">{t('im.fullFeatured')}</div>
                  </button>
                </div>
              </div>

              {dingtalkMode === 'webhook' ? (
                <>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Robot Webhook URL</label>
                    <input
                      type="text"
                      value={formData.webhook_url || ''}
                      onChange={e => setFormData(prev => ({ ...prev, webhook_url: e.target.value }))}
                      placeholder="https://oapi.dingtalk.com/robot/send?access_token=xxx"
                      className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
                    />
                    <p className="text-[10px] text-gray-500 mt-1">From DingTalk group → Settings → Smart Group Assistant → Add Robot → Custom</p>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Signing Secret (optional)</label>
                    <input
                      type="password"
                      value={(formData.config as Record<string, string>)?.signing_secret || ''}
                      onChange={e => setFormData(prev => ({
                        ...prev,
                        config: { ...prev.config, signing_secret: e.target.value },
                      }))}
                      placeholder="SEC..."
                      className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
                    />
                    <p className="text-[10px] text-gray-500 mt-1">If you enabled "Sign" in the robot security settings</p>
                  </div>
                  <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg p-3">
                    <p className="text-xs text-blue-400 font-medium mb-1">Callback URL (set this in DingTalk robot settings):</p>
                    <code className="text-xs text-blue-300 bg-gray-900 px-2 py-1 rounded block">
                      {window.location.origin.replace(/:\d+$/, ':3001')}/api/im/dingtalk/callback
                    </code>
                  </div>
                </>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Client ID (App Key)</label>
                    <input
                      type="text"
                      value={(formData.config as Record<string, string>)?.client_id || ''}
                      onChange={e => setFormData(prev => ({
                        ...prev,
                        config: { ...prev.config, client_id: e.target.value },
                      }))}
                      placeholder="dingxxxxxxxx"
                      className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Signing Secret (optional)</label>
                    <input
                      type="password"
                      value={(formData.config as Record<string, string>)?.signing_secret || ''}
                      onChange={e => setFormData(prev => ({
                        ...prev,
                        config: { ...prev.config, signing_secret: e.target.value },
                      }))}
                      placeholder="For legacy webhook verification"
                      className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {formData.channel_type === 'whatsapp' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Phone Number ID</label>
                <input
                  type="text"
                  value={(formData.config as Record<string, string>)?.phone_number_id || ''}
                  onChange={e => setFormData(prev => ({
                    ...prev,
                    channel_id: e.target.value,
                    config: { ...prev.config, phone_number_id: e.target.value },
                  }))}
                  placeholder="1234567890"
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Verify Token (for webhook setup)</label>
                <input
                  type="text"
                  value={(formData.config as Record<string, string>)?.verify_token || ''}
                  onChange={e => setFormData(prev => ({
                    ...prev,
                    config: { ...prev.config, verify_token: e.target.value },
                  }))}
                  placeholder="my-verify-token-123"
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-gray-400 mb-1">App Secret (for signature verification)</label>
                <input
                  type="password"
                  value={(formData.config as Record<string, string>)?.app_secret || ''}
                  onChange={e => setFormData(prev => ({
                    ...prev,
                    config: { ...prev.config, app_secret: e.target.value },
                  }))}
                  placeholder="Meta App Secret"
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowForm(false)}
              className="px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleCreate}
              disabled={
                isSaving ||
                (isBridgeType(formData.channel_type)
                  ? false
                  : formData.channel_type === 'dingtalk' && dingtalkMode === 'webhook'
                    ? !formData.webhook_url
                    : !formData.channel_id)
              }
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors"
            >
              {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
              {isBridgeType(formData.channel_type) ? 'Start Connection' : t('im.connectChannel')}
            </button>
          </div>
        </div>
      )}

      {/* QR Code Display for Bridge Connections */}
      {bridgeState && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-6 text-center">
          <p className="text-sm text-gray-300 mb-4">
            {bridgeState.channelType === 'whatsapp-bridge'
              ? 'Scan with WhatsApp to connect'
              : 'Scan with Feishu/Lark to authorize'}
          </p>
          {bridgeState.qr ? (
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(bridgeState.qr)}`}
              className="mx-auto w-64 h-64 rounded-lg"
              alt="QR Code"
            />
          ) : bridgeState.authUrl ? (
            <div>
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(bridgeState.authUrl)}`}
                className="mx-auto w-64 h-64 rounded-lg"
                alt="QR Code"
              />
              <a href={bridgeState.authUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 mt-2 inline-block">
                Or click to open
              </a>
            </div>
          ) : (
            <Loader2 className="w-8 h-8 animate-spin mx-auto text-gray-400" />
          )}
          <p className="text-xs text-gray-500 mt-3">Status: {bridgeState.status}</p>
          <button onClick={() => setBridgeState(null)} className="text-xs text-gray-400 mt-2 hover:text-white">
            Cancel
          </button>
        </div>
      )}

      {/* Bindings List */}
      {bindings.length === 0 && !showForm ? (
        <div className="text-center py-12 text-gray-500">
          <MessageSquare className="w-10 h-10 mx-auto mb-3 opacity-50" />
          <p className="text-sm">{t('im.noChannels')}</p>
          <p className="text-xs mt-1">{t('im.noChannelsHint')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {bindings.map(binding => {
            const info = channelTypeInfo(binding.channel_type)
            const isBridge = isBridgeType(binding.channel_type)
            const realStatus = isBridge ? (bridgeStatuses[binding.id] || 'checking') : null
            const bridgeConnected = realStatus === 'connected'
            const statusColor = bridgeConnected
              ? 'bg-green-500/20 text-green-400'
              : realStatus === 'qr_pending'
                ? 'bg-blue-500/20 text-blue-400'
                : realStatus === 'checking'
                  ? 'bg-gray-500/20 text-gray-400'
                  : 'bg-yellow-500/20 text-yellow-400'
            const statusDot = bridgeConnected
              ? 'bg-green-400'
              : realStatus === 'qr_pending' ? 'bg-blue-400 animate-pulse'
              : realStatus === 'checking' ? 'bg-gray-400 animate-pulse'
              : 'bg-yellow-400'
            const statusLabel = bridgeConnected ? 'Connected'
              : realStatus === 'qr_pending' ? 'Waiting for QR scan'
              : realStatus === 'checking' ? 'Checking...'
              : 'Disconnected'
            return (
              <div
                key={binding.id}
                className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${
                  binding.is_enabled
                    ? 'bg-gray-800/30 border-gray-700'
                    : 'bg-gray-900/50 border-gray-800 opacity-60'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="text-xl">{info?.icon || '\u{1F4E1}'}</span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white">
                        {binding.channel_name || binding.channel_id}
                      </span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-300">
                        {info?.label || binding.channel_type}
                      </span>
                      {isBridge && (
                        <span className={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded ${statusColor}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
                          {statusLabel}
                        </span>
                      )}
                      {!isBridge && !binding.is_enabled && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400">
                          {t('im.disabled')}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Hash className="w-3 h-3 text-gray-500" />
                      <span className="text-xs text-gray-500 font-mono">{binding.channel_id}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {/* Webhook URL copy button (for webhook type or as generic endpoint) */}
                  {binding.channel_type === 'webhook' && (
                    <button
                      onClick={() => copyWebhookUrl(binding.id)}
                      className="p-1.5 text-gray-400 hover:text-white transition-colors"
                      title="Copy webhook URL"
                    >
                      {copiedId === binding.id ? (
                        <CheckCircle2 className="w-4 h-4 text-green-400" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </button>
                  )}

                  {/* Bridge types: Reconnect / Connect buttons */}
                  {isBridge && (
                    <>
                      {!bridgeConnected && (
                        <button
                          onClick={() => handleBridgeConnect(binding.id, binding.channel_type)}
                          className="px-2 py-1 text-xs rounded bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors"
                        >
                          {realStatus === 'disconnected' ? 'Reconnect' : 'Connect'}
                        </button>
                      )}
                      {bridgeConnected && (
                        <button
                          onClick={() => handleBridgeDisconnect(binding.id)}
                          className="px-2 py-1 text-xs rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
                        >
                          Disconnect
                        </button>
                      )}
                    </>
                  )}

                  {/* Toggle enabled/disabled for non-bridge types */}
                  {!isBridge && (
                    <button
                      onClick={() => handleToggle(binding.id, binding.is_enabled)}
                      className="p-1.5 text-gray-400 hover:text-white transition-colors"
                      title={binding.is_enabled ? 'Disable' : 'Enable'}
                    >
                      {binding.is_enabled ? (
                        <ToggleRight className="w-5 h-5 text-green-400" />
                      ) : (
                        <ToggleLeft className="w-5 h-5" />
                      )}
                    </button>
                  )}

                  {/* Delete */}
                  <button
                    onClick={() => handleDelete(binding.id)}
                    className="p-1.5 text-gray-400 hover:text-red-400 transition-colors"
                    title="Remove"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Setup Instructions */}
      {bindings.length > 0 && (
        <div className="bg-gray-800/30 border border-gray-700/50 rounded-lg p-3 space-y-2">
          <p className="text-xs text-gray-400">
            <strong className="text-gray-300">Slack:</strong> Set Event Subscriptions URL to{' '}
            <code className="text-blue-400 bg-gray-900 px-1 rounded">{window.location.origin.replace(/:\d+$/, ':3001')}/api/im/slack/events</code>
            {' '}and subscribe to <code className="text-blue-400 bg-gray-900 px-1 rounded">message.channels</code>.
          </p>
          <p className="text-xs text-gray-400">
            <strong className="text-gray-300">Telegram:</strong> Use the "Register Webhook" button, or call{' '}
            <code className="text-blue-400 bg-gray-900 px-1 rounded">setWebhook</code> with URL{' '}
            <code className="text-blue-400 bg-gray-900 px-1 rounded">{window.location.origin.replace(/:\d+$/, ':3001')}/api/im/telegram/webhook</code>
          </p>
          <p className="text-xs text-gray-400">
            <strong className="text-gray-300">Discord:</strong> Connects automatically via Gateway WebSocket. Just provide the Bot Token.
          </p>
          <p className="text-xs text-gray-400">
            <strong className="text-gray-300">Feishu:</strong> Connects automatically via WSClient. Provide App ID + App Secret.
          </p>
          <p className="text-xs text-gray-400">
            <strong className="text-gray-300">DingTalk:</strong> Webhook mode: paste the robot webhook URL and set callback URL to{' '}
            <code className="text-blue-400 bg-gray-900 px-1 rounded">{window.location.origin.replace(/:\d+$/, ':3001')}/api/im/dingtalk/callback</code>.
            Stream mode: provide Client ID + Client Secret, connects automatically.
          </p>
          <p className="text-xs text-gray-400">
            <strong className="text-gray-300">WhatsApp:</strong> Set webhook URL in Meta Developer Console to{' '}
            <code className="text-blue-400 bg-gray-900 px-1 rounded">{window.location.origin.replace(/:\d+$/, ':3001')}/api/im/whatsapp/webhook</code>
            {' '}and subscribe to <code className="text-blue-400 bg-gray-900 px-1 rounded">messages</code>.
          </p>
          <p className="text-xs text-gray-400">
            <strong className="text-gray-300">WhatsApp (Personal) / Feishu (Personal):</strong> Click "Connect" on the binding card and scan the QR code with your phone app.
          </p>
        </div>
      )}
    </div>
  )
}

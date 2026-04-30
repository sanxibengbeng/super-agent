import { Server, FileText, MessageSquare, Database, Plug, Trash2 } from 'lucide-react'
import type { ScopeIntegrations } from '@/services/scopeGeneratorService'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IntegrationWorkspaceProps {
  integrations: ScopeIntegrations
  onUpdate: (integrations: ScopeIntegrations) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function IntegrationWorkspace({ integrations, onUpdate }: IntegrationWorkspaceProps) {
  const { mcpServers, documentGroups, imChannels, connectors, plugins } = integrations

  // Check if all arrays are empty
  const isEmpty =
    mcpServers.length === 0 &&
    documentGroups.length === 0 &&
    imChannels.length === 0 &&
    connectors.length === 0 &&
    plugins.length === 0

  // Remove handlers
  const removeMcpServer = (index: number) => {
    onUpdate({
      ...integrations,
      mcpServers: mcpServers.filter((_, i) => i !== index),
    })
  }

  const removeDocumentGroup = (index: number) => {
    onUpdate({
      ...integrations,
      documentGroups: documentGroups.filter((_, i) => i !== index),
    })
  }

  const removeImChannel = (index: number) => {
    onUpdate({
      ...integrations,
      imChannels: imChannels.filter((_, i) => i !== index),
    })
  }

  const removeConnector = (index: number) => {
    onUpdate({
      ...integrations,
      connectors: connectors.filter((_, i) => i !== index),
    })
  }

  const removePlugin = (index: number) => {
    onUpdate({
      ...integrations,
      plugins: plugins.filter((_, i) => i !== index),
    })
  }

  // Empty state
  if (isEmpty) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <div className="rounded-xl border-2 border-dashed border-gray-700 bg-gray-800/30 p-8 max-w-md text-center">
          <p className="text-sm text-gray-400">No integrations configured yet.</p>
          <p className="text-xs text-gray-500 mt-2">
            Ask the copilot to add MCP servers, knowledge bases, IM channels, data connectors, or plugins.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-6 overflow-y-auto h-full">
      {/* MCP Servers */}
      {mcpServers.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-blue-400" />
            <h3 className="text-sm font-medium text-gray-300">MCP Servers</h3>
            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">
              {mcpServers.length}
            </span>
          </div>
          <div className="space-y-2">
            {mcpServers.map((server, index) => (
              <div
                key={index}
                className="group flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-800/60 border border-gray-700 hover:border-gray-600 transition-colors"
              >
                <Server className="w-4 h-4 text-blue-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white font-medium truncate">{server.name}</div>
                </div>
                <button
                  onClick={() => removeMcpServer(index)}
                  className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all"
                  aria-label="Remove MCP server"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Knowledge Base (Document Groups) */}
      {documentGroups.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-green-400" />
            <h3 className="text-sm font-medium text-gray-300">Knowledge Base</h3>
            <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-300">
              {documentGroups.length}
            </span>
          </div>
          <div className="space-y-2">
            {documentGroups.map((group, index) => (
              <div
                key={index}
                className="group flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-800/60 border border-gray-700 hover:border-gray-600 transition-colors"
              >
                <FileText className="w-4 h-4 text-green-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white font-medium truncate">{group.name}</div>
                </div>
                <button
                  onClick={() => removeDocumentGroup(index)}
                  className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all"
                  aria-label="Remove document group"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* IM Channels */}
      {imChannels.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-purple-400" />
            <h3 className="text-sm font-medium text-gray-300">IM Channels</h3>
            <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300">
              {imChannels.length}
            </span>
          </div>
          <div className="space-y-2">
            {imChannels.map((channel, index) => (
              <div
                key={index}
                className="group flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-800/60 border border-gray-700 hover:border-gray-600 transition-colors"
              >
                <MessageSquare className="w-4 h-4 text-purple-400 flex-shrink-0" />
                <div className="flex-1 min-w-0 flex items-center gap-2">
                  <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 font-mono">
                    {channel.channelType}
                  </span>
                  <div className="text-sm text-white truncate">
                    {channel.channelName || channel.channelId}
                  </div>
                  {!channel.isEnabled && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-gray-600/50 text-gray-400">
                      disabled
                    </span>
                  )}
                </div>
                <button
                  onClick={() => removeImChannel(index)}
                  className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all"
                  aria-label="Remove IM channel"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Data Connectors */}
      {connectors.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-medium text-gray-300">Data Connectors</h3>
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">
              {connectors.length}
            </span>
          </div>
          <div className="space-y-2">
            {connectors.map((connector, index) => (
              <div
                key={index}
                className="group flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-800/60 border border-gray-700 hover:border-gray-600 transition-colors"
              >
                <Database className="w-4 h-4 text-amber-400 flex-shrink-0" />
                <div className="flex-1 min-w-0 flex items-center gap-2">
                  <div className="text-sm text-white font-medium truncate">{connector.displayName}</div>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-mono">
                    {connector.connectorType}
                  </span>
                </div>
                <button
                  onClick={() => removeConnector(index)}
                  className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all"
                  aria-label="Remove connector"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Plugins */}
      {plugins.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Plug className="w-4 h-4 text-cyan-400" />
            <h3 className="text-sm font-medium text-gray-300">Plugins</h3>
            <span className="text-xs px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300">
              {plugins.length}
            </span>
          </div>
          <div className="space-y-2">
            {plugins.map((plugin, index) => (
              <div
                key={index}
                className="group flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-800/60 border border-gray-700 hover:border-gray-600 transition-colors"
              >
                <Plug className="w-4 h-4 text-cyan-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white font-medium truncate">{plugin.name}</div>
                  <div className="text-xs text-gray-500 truncate font-mono">{plugin.gitUrl}</div>
                </div>
                <button
                  onClick={() => removePlugin(index)}
                  className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all"
                  aria-label="Remove plugin"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

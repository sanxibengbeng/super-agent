/**
 * WebSocket Client for Workspace Events
 *
 * This client handles WebSocket connections for real-time workspace events
 * (task lifecycle, file changes, tool use, etc.) from the backend workspace
 * events gateway at /ws/workspace.
 *
 * Features:
 * - Automatic reconnection with exponential backoff (1s, 2s, 4s, 8s, max 30s)
 * - Session-based subscriptions with multiple handlers per session
 * - Heartbeat ping every 25 seconds to keep connection alive
 * - lastEventId tracking in localStorage for disconnect recovery
 * - Connection state management (connecting, connected, disconnected)
 *
 * @module services/workspaceSocketClient
 */

// ============================================================================
// Types
// ============================================================================

export interface WorkspaceEvent {
  id: string;
  task_id: string;
  session_id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export type WorkspaceEventHandler = (event: WorkspaceEvent) => void;

type ConnectionState = 'disconnected' | 'connecting' | 'connected';

// ============================================================================
// Configuration
// ============================================================================

const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30000;
const PING_INTERVAL = 25000;

// ============================================================================
// Implementation
// ============================================================================

/**
 * WebSocket client for workspace events.
 *
 * Manages a single WebSocket connection and routes incoming workspace events
 * to the appropriate session handlers.
 */
export class WorkspaceSocketClient {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private subscriptions: Map<string, Set<WorkspaceEventHandler>> = new Map();
  private pendingSubscriptions: Set<string> = new Set();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Establish a WebSocket connection to the workspace events gateway.
   * No-op if already connecting or connected.
   */
  connect(): void {
    if (this.state !== 'disconnected') return;

    this.state = 'connecting';
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = import.meta.env.VITE_API_BASE_URL
      ? new URL(import.meta.env.VITE_API_BASE_URL).host
      : window.location.host;

    this.ws = new WebSocket(`${protocol}//${host}/ws/workspace`);

    this.ws.onopen = () => {
      this.state = 'connected';
      this.reconnectAttempt = 0;
      this.startPing();

      // Send any subscriptions queued before the connection was ready
      for (const sessionId of this.pendingSubscriptions) {
        this.sendSubscribe(sessionId);
      }
      this.pendingSubscriptions.clear();

      // Re-subscribe active subscriptions (reconnection case)
      for (const sessionId of this.subscriptions.keys()) {
        this.sendSubscribe(sessionId);
      }
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'workspace_event') {
          this.handleEvent(message.event);
        }
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.state = 'disconnected';
      this.stopPing();
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  /**
   * Gracefully disconnect from the WebSocket server.
   * Cancels reconnection attempts and heartbeat.
   */
  disconnect(): void {
    this.state = 'disconnected';
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Subscribe to workspace events for a given session.
   *
   * @param sessionId - The chat session ID to receive events for
   * @param handler - Callback invoked for each event
   * @returns An unsubscribe function that removes this handler
   */
  subscribe(sessionId: string, handler: WorkspaceEventHandler): () => void {
    let handlers = this.subscriptions.get(sessionId);
    if (!handlers) {
      handlers = new Set();
      this.subscriptions.set(sessionId, handlers);
    }
    handlers.add(handler);

    if (this.state === 'connected') {
      this.sendSubscribe(sessionId);
    } else {
      this.pendingSubscriptions.add(sessionId);
    }

    return () => {
      handlers!.delete(handler);
      if (handlers!.size === 0) {
        this.subscriptions.delete(sessionId);
        if (this.state === 'connected') {
          this.sendUnsubscribe(sessionId);
        }
      }
    };
  }

  /**
   * Whether the client currently has an open WebSocket connection.
   */
  isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * Get the last received event ID for a session (persisted in localStorage).
   * Useful for requesting missed events after a reconnection.
   */
  getLastEventId(sessionId: string): string | null {
    return localStorage.getItem(`workspace:lastEvent:${sessionId}`);
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private handleEvent(event: WorkspaceEvent): void {
    localStorage.setItem(`workspace:lastEvent:${event.session_id}`, event.id);

    const handlers = this.subscriptions.get(event.session_id);
    if (handlers) {
      for (const handler of handlers) {
        handler(event);
      }
    }
  }

  private sendSubscribe(sessionId: string): void {
    this.ws?.send(JSON.stringify({ type: 'subscribe', session_id: sessionId }));
  }

  private sendUnsubscribe(sessionId: string): void {
    this.ws?.send(JSON.stringify({ type: 'unsubscribe', session_id: sessionId }));
  }

  private scheduleReconnect(): void {
    if (this.subscriptions.size === 0) return;

    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_DELAY
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, PING_INTERVAL);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const workspaceSocketClient = new WorkspaceSocketClient();

export default workspaceSocketClient;

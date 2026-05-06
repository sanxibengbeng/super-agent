/**
 * WebSocket Gateway for Workspace Events
 *
 * This gateway handles WebSocket connections for real-time workspace/session events.
 * It allows clients to subscribe/unsubscribe to specific session IDs and broadcasts
 * workspace events (e.g. task_completed, file_changed) to subscribed clients.
 *
 * Used by WorkspaceEventBus to deliver events to connected frontend clients.
 *
 * @module websocket/workspace.gateway
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';

/**
 * Client message types for WebSocket communication
 */
type ClientMessage =
  | { type: 'subscribe'; session_id: string; token?: string }
  | { type: 'unsubscribe'; session_id: string }
  | { type: 'ping' };

/**
 * WebSocket client connection with subscription tracking
 */
interface WorkspaceClient {
  socket: WebSocket;
  subscriptions: Set<string>;
  lastPing: number;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 60_000;

/**
 * Workspace WebSocket Gateway
 *
 * Manages WebSocket connections for workspace session events.
 * Handles subscribe/unsubscribe messages and broadcasts events to subscribed clients.
 */
export class WorkspaceWebSocketGateway {
  /**
   * Map of WebSocket connections to their client info
   */
  private clients: Map<WebSocket, WorkspaceClient> = new Map();

  /**
   * Map of session IDs to subscribed WebSocket connections
   */
  private subscriptions: Map<string, Set<WebSocket>> = new Map();

  /**
   * Heartbeat interval for connection health checks
   */
  private heartbeatInterval: NodeJS.Timeout | null = null;

  /**
   * Register the WebSocket gateway with a Fastify instance
   *
   * @param fastify - Fastify instance to register the gateway on
   */
  async register(fastify: FastifyInstance): Promise<void> {
    fastify.get(
      '/ws/workspace',
      { websocket: true },
      (socket: WebSocket, _request: FastifyRequest) => {
        this.handleConnection(socket);
      }
    );
    this.startHeartbeat();
    fastify.log.info('Workspace WebSocket gateway registered at /ws/workspace');
  }

  /**
   * Handle a new WebSocket connection
   *
   * @param socket - WebSocket connection
   */
  handleConnection(socket: WebSocket): void {
    const client: WorkspaceClient = {
      socket,
      subscriptions: new Set(),
      lastPing: Date.now(),
    };
    this.clients.set(socket, client);

    socket.on('message', (data: Buffer | string) => {
      const c = this.clients.get(socket);
      if (c) c.lastPing = Date.now();

      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        switch (message.type) {
          case 'subscribe':
            this.handleSubscribe(socket, message.session_id);
            break;
          case 'unsubscribe':
            this.handleUnsubscribe(socket, message.session_id);
            break;
          case 'ping':
            this.sendMessage(socket, { type: 'pong' });
            break;
        }
      } catch {
        this.sendMessage(socket, { type: 'error', message: 'Invalid message format' });
      }
    });

    socket.on('close', () => this.handleDisconnect(socket));
    socket.on('error', () => this.handleDisconnect(socket));
  }

  /**
   * Subscribe a socket to a session's workspace events
   *
   * @param socket - WebSocket connection
   * @param sessionId - Session ID to subscribe to
   */
  handleSubscribe(socket: WebSocket, sessionId: string): void {
    const client = this.clients.get(socket);
    if (!client) return;

    client.subscriptions.add(sessionId);

    let subscribers = this.subscriptions.get(sessionId);
    if (!subscribers) {
      subscribers = new Set();
      this.subscriptions.set(sessionId, subscribers);
    }
    subscribers.add(socket);

    this.sendMessage(socket, { type: 'subscribed', session_id: sessionId });
  }

  /**
   * Unsubscribe a socket from a session's workspace events
   *
   * @param socket - WebSocket connection
   * @param sessionId - Session ID to unsubscribe from
   */
  handleUnsubscribe(socket: WebSocket, sessionId: string): void {
    const client = this.clients.get(socket);
    if (!client) return;

    client.subscriptions.delete(sessionId);

    const subscribers = this.subscriptions.get(sessionId);
    if (subscribers) {
      subscribers.delete(socket);
      if (subscribers.size === 0) {
        this.subscriptions.delete(sessionId);
      }
    }

    this.sendMessage(socket, { type: 'unsubscribed', session_id: sessionId });
  }

  /**
   * Handle WebSocket disconnection
   *
   * Cleans up client subscriptions and removes from all tracking maps.
   *
   * @param socket - WebSocket connection
   */
  handleDisconnect(socket: WebSocket): void {
    const client = this.clients.get(socket);
    if (!client) return;

    for (const sessionId of client.subscriptions) {
      const subscribers = this.subscriptions.get(sessionId);
      if (subscribers) {
        subscribers.delete(socket);
        if (subscribers.size === 0) {
          this.subscriptions.delete(sessionId);
        }
      }
    }

    this.clients.delete(socket);
  }

  /**
   * Broadcast an event to all local subscribers of a session
   *
   * @param sessionId - Session ID to broadcast to
   * @param event - Event payload to broadcast
   */
  broadcastToLocal(sessionId: string, event: unknown): void {
    const subscribers = this.subscriptions.get(sessionId);
    if (!subscribers) return;

    const message = JSON.stringify({ type: 'workspace_event', event });

    for (const socket of subscribers) {
      if (socket.readyState === socket.OPEN) {
        socket.send(message);
      } else {
        subscribers.delete(socket);
      }
    }
  }

  /**
   * Get the number of connected clients
   *
   * @returns Number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get the number of subscribers for a session
   *
   * @param sessionId - Session ID
   * @returns Number of subscribers
   */
  getSubscriberCount(sessionId: string): number {
    return this.subscriptions.get(sessionId)?.size ?? 0;
  }

  /**
   * Send a message to a specific WebSocket client
   *
   * @param socket - WebSocket connection
   * @param message - Message to send
   */
  private sendMessage(socket: WebSocket, message: Record<string, unknown>): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  /**
   * Start heartbeat monitoring for connection health
   *
   * Periodically checks for stale connections and removes them.
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      for (const [socket, client] of this.clients.entries()) {
        if (now - client.lastPing > CONNECTION_TIMEOUT_MS) {
          socket.close(1000, 'Connection timeout');
          this.handleDisconnect(socket);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Close all connections and clean up resources
   */
  close(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const [socket] of this.clients) {
      socket.close(1000, 'Server shutdown');
    }
    this.clients.clear();
    this.subscriptions.clear();
  }
}

// Singleton instance
export const workspaceWebSocketGateway = new WorkspaceWebSocketGateway();

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceWebSocketGateway } from '../../src/websocket/workspace.gateway.js';

function createMockSocket() {
  return {
    readyState: 1, // OPEN
    OPEN: 1,
    send: vi.fn(),
    on: vi.fn(),
    close: vi.fn(),
  };
}

describe('WorkspaceWebSocketGateway', () => {
  let gateway: WorkspaceWebSocketGateway;

  beforeEach(() => {
    gateway = new WorkspaceWebSocketGateway();
  });

  describe('handleConnection', () => {
    it('should track the new client', () => {
      const socket = createMockSocket();
      gateway.handleConnection(socket as any);

      expect(gateway.getClientCount()).toBe(1);
    });
  });

  describe('subscribe/unsubscribe', () => {
    it('should track session subscriptions for a client', () => {
      const socket = createMockSocket();
      gateway.handleConnection(socket as any);

      gateway.handleSubscribe(socket as any, 'session-1');

      expect(gateway.getSubscriberCount('session-1')).toBe(1);
    });

    it('should remove subscription on unsubscribe', () => {
      const socket = createMockSocket();
      gateway.handleConnection(socket as any);
      gateway.handleSubscribe(socket as any, 'session-1');

      gateway.handleUnsubscribe(socket as any, 'session-1');

      expect(gateway.getSubscriberCount('session-1')).toBe(0);
    });
  });

  describe('broadcastToLocal', () => {
    it('should send event to all subscribers of a session', () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();
      gateway.handleConnection(socket1 as any);
      gateway.handleConnection(socket2 as any);
      gateway.handleSubscribe(socket1 as any, 'session-1');
      gateway.handleSubscribe(socket2 as any, 'session-1');

      const event = { id: 'evt-1', type: 'task_completed', session_id: 'session-1', payload: {} };
      gateway.broadcastToLocal('session-1', event);

      expect(socket1.send).toHaveBeenCalledWith(JSON.stringify({ type: 'workspace_event', event }));
      expect(socket2.send).toHaveBeenCalledWith(JSON.stringify({ type: 'workspace_event', event }));
    });

    it('should not send to subscribers of other sessions', () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();
      gateway.handleConnection(socket1 as any);
      gateway.handleConnection(socket2 as any);
      gateway.handleSubscribe(socket1 as any, 'session-1');
      gateway.handleSubscribe(socket2 as any, 'session-2');

      // Clear mocks from subscribe confirmations
      socket1.send.mockClear();
      socket2.send.mockClear();

      const event = { id: 'evt-1', type: 'task_completed', session_id: 'session-1', payload: {} };
      gateway.broadcastToLocal('session-1', event);

      expect(socket1.send).toHaveBeenCalled();
      expect(socket2.send).not.toHaveBeenCalled();
    });

    it('should skip closed sockets and clean up', () => {
      const socket = createMockSocket();
      socket.readyState = 3; // CLOSED
      gateway.handleConnection(socket as any);
      gateway.handleSubscribe(socket as any, 'session-1');

      const event = { id: 'evt-1', type: 'task_completed', session_id: 'session-1', payload: {} };
      gateway.broadcastToLocal('session-1', event);

      expect(socket.send).not.toHaveBeenCalled();
    });
  });

  describe('handleDisconnect', () => {
    it('should clean up all subscriptions for a client', () => {
      const socket = createMockSocket();
      gateway.handleConnection(socket as any);
      gateway.handleSubscribe(socket as any, 'session-1');
      gateway.handleSubscribe(socket as any, 'session-2');

      gateway.handleDisconnect(socket as any);

      expect(gateway.getClientCount()).toBe(0);
      expect(gateway.getSubscriberCount('session-1')).toBe(0);
      expect(gateway.getSubscriberCount('session-2')).toBe(0);
    });
  });
});

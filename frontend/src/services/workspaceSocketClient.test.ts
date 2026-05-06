/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkspaceSocketClient } from './workspaceSocketClient';

/**
 * Simple MockWebSocket that we inject into globalThis before each test.
 */
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;
  static CLOSING = 2;
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly CLOSING = 2;
  readyState = 1;
  url: string;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  dispatchEvent = vi.fn(() => true);

  constructor(url: string) {
    this.url = url;
  }
}

describe('WorkspaceSocketClient', () => {
  let client: WorkspaceSocketClient;
  let storage: Record<string, string>;
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');

  beforeEach(() => {
    vi.clearAllMocks();

    // Override WebSocket (MSW makes it read-only, so use defineProperty)
    Object.defineProperty(globalThis, 'WebSocket', {
      value: MockWebSocket,
      writable: true,
      configurable: true,
    });

    // Configure localStorage mock behavior
    storage = {};
    const getItem = vi.mocked(localStorage.getItem);
    const setItem = vi.mocked(localStorage.setItem);
    const removeItem = vi.mocked(localStorage.removeItem);
    const clear = vi.mocked(localStorage.clear);

    getItem.mockImplementation((key: string) => storage[key] ?? null);
    setItem.mockImplementation((key: string, value: string) => { storage[key] = value; });
    removeItem.mockImplementation((key: string) => { delete storage[key]; });
    clear.mockImplementation(() => { storage = {}; });

    client = new WorkspaceSocketClient();
  });

  afterEach(() => {
    client.disconnect();
    // Restore original WebSocket descriptor
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'WebSocket', originalDescriptor);
    }
  });

  describe('connect', () => {
    it('should establish WebSocket connection', () => {
      client.connect();

      expect(client.isConnected()).toBe(false); // not yet until onopen
    });

    it('should set isConnected to true after onopen', () => {
      client.connect();
      const ws = (client as any).ws as MockWebSocket;
      ws.onopen?.(new Event('open'));

      expect(client.isConnected()).toBe(true);
    });

    it('should not create a second connection if already connecting', () => {
      client.connect();
      const ws1 = (client as any).ws;
      client.connect();
      const ws2 = (client as any).ws;

      expect(ws1).toBe(ws2);
    });
  });

  describe('disconnect', () => {
    it('should close the WebSocket and reset state', () => {
      client.connect();
      const ws = (client as any).ws as MockWebSocket;
      ws.onopen?.(new Event('open'));

      client.disconnect();

      expect(ws.close).toHaveBeenCalled();
      expect(client.isConnected()).toBe(false);
    });
  });

  describe('subscribe', () => {
    it('should send subscribe message when connected', () => {
      client.connect();
      const ws = (client as any).ws as MockWebSocket;
      ws.onopen?.(new Event('open'));

      const unsubscribe = client.subscribe('session-1', vi.fn());

      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'subscribe', session_id: 'session-1' })
      );
      expect(typeof unsubscribe).toBe('function');
    });

    it('should queue subscription if not yet connected', () => {
      client.connect();
      client.subscribe('session-1', vi.fn());

      const ws = (client as any).ws as MockWebSocket;
      expect(ws.send).not.toHaveBeenCalled();

      ws.onopen?.(new Event('open'));
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'subscribe', session_id: 'session-1' })
      );
    });

    it('should send unsubscribe when last handler is removed', () => {
      client.connect();
      const ws = (client as any).ws as MockWebSocket;
      ws.onopen?.(new Event('open'));

      const unsubscribe = client.subscribe('session-1', vi.fn());
      ws.send.mockClear();

      unsubscribe();

      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'unsubscribe', session_id: 'session-1' })
      );
    });
  });

  describe('event routing', () => {
    it('should route events to the correct session handler', () => {
      client.connect();
      const ws = (client as any).ws as MockWebSocket;
      ws.onopen?.(new Event('open'));

      const handler1 = vi.fn();
      const handler2 = vi.fn();
      client.subscribe('session-1', handler1);
      client.subscribe('session-2', handler2);

      const event = {
        id: 'evt-1',
        type: 'task_completed',
        session_id: 'session-1',
        payload: {},
        task_id: 't1',
        created_at: '2026-01-01T00:00:00Z',
      };
      ws.onmessage?.(new MessageEvent('message', {
        data: JSON.stringify({ type: 'workspace_event', event }),
      }));

      expect(handler1).toHaveBeenCalledWith(event);
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should support multiple handlers for same session', () => {
      client.connect();
      const ws = (client as any).ws as MockWebSocket;
      ws.onopen?.(new Event('open'));

      const handler1 = vi.fn();
      const handler2 = vi.fn();
      client.subscribe('session-1', handler1);
      client.subscribe('session-1', handler2);

      const event = {
        id: 'evt-1',
        type: 'task_completed',
        session_id: 'session-1',
        payload: {},
        task_id: 't1',
        created_at: '2026-01-01T00:00:00Z',
      };
      ws.onmessage?.(new MessageEvent('message', {
        data: JSON.stringify({ type: 'workspace_event', event }),
      }));

      expect(handler1).toHaveBeenCalledWith(event);
      expect(handler2).toHaveBeenCalledWith(event);
    });

    it('should ignore malformed messages', () => {
      client.connect();
      const ws = (client as any).ws as MockWebSocket;
      ws.onopen?.(new Event('open'));

      client.subscribe('session-1', vi.fn());

      // Should not throw
      ws.onmessage?.(new MessageEvent('message', { data: 'not-json' }));
      ws.onmessage?.(new MessageEvent('message', {
        data: JSON.stringify({ type: 'unknown' }),
      }));
    });
  });

  describe('lastEventId tracking', () => {
    it('should persist lastEventId to localStorage on event', () => {
      client.connect();
      const ws = (client as any).ws as MockWebSocket;
      ws.onopen?.(new Event('open'));
      client.subscribe('session-1', vi.fn());

      const event = {
        id: 'evt-42',
        type: 'task_completed',
        session_id: 'session-1',
        payload: {},
        task_id: 't1',
        created_at: '2026-01-01T00:00:00Z',
      };
      ws.onmessage?.(new MessageEvent('message', {
        data: JSON.stringify({ type: 'workspace_event', event }),
      }));

      expect(localStorage.setItem).toHaveBeenCalledWith(
        'workspace:lastEvent:session-1',
        'evt-42'
      );
      expect(storage['workspace:lastEvent:session-1']).toBe('evt-42');
    });

    it('should return lastEventId via getLastEventId', () => {
      storage['workspace:lastEvent:session-1'] = 'evt-99';

      expect(client.getLastEventId('session-1')).toBe('evt-99');
    });

    it('should return null when no lastEventId exists', () => {
      expect(client.getLastEventId('nonexistent')).toBeNull();
    });
  });

  describe('reconnection', () => {
    it('should schedule reconnection when connection closes with active subscriptions', () => {
      vi.useFakeTimers();

      client.connect();
      const ws = (client as any).ws as MockWebSocket;
      ws.onopen?.(new Event('open'));
      client.subscribe('session-1', vi.fn());

      // Simulate connection close
      ws.onclose?.(new CloseEvent('close'));

      expect(client.isConnected()).toBe(false);

      // After the reconnect delay, connect should be called again
      vi.advanceTimersByTime(1000);
      expect((client as any).ws).not.toBeNull();

      vi.useRealTimers();
    });

    it('should not reconnect if no subscriptions', () => {
      vi.useFakeTimers();

      client.connect();
      const ws = (client as any).ws as MockWebSocket;
      ws.onopen?.(new Event('open'));

      // Close without any subscriptions
      ws.onclose?.(new CloseEvent('close'));

      vi.advanceTimersByTime(60000);
      // State should remain disconnected, no reconnection attempted
      expect((client as any).state).toBe('disconnected');

      vi.useRealTimers();
    });
  });
});

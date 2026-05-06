import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { mockSubscribe, mockConnect, mockGetLastEventId, mockIsConnected, mockFetchRecovery } = vi.hoisted(() => {
  const mockSubscribe = vi.fn().mockReturnValue(vi.fn());
  const mockConnect = vi.fn();
  const mockGetLastEventId = vi.fn().mockReturnValue(null);
  const mockIsConnected = vi.fn().mockReturnValue(true);
  const mockFetchRecovery = vi.fn().mockResolvedValue(null);
  return { mockSubscribe, mockConnect, mockGetLastEventId, mockIsConnected, mockFetchRecovery };
});

vi.mock('@/services/workspaceSocketClient', () => ({
  workspaceSocketClient: {
    subscribe: mockSubscribe,
    connect: mockConnect,
    isConnected: mockIsConnected,
    getLastEventId: mockGetLastEventId,
  },
}));

vi.mock('@/services/workspaceRecoveryApi', () => ({
  fetchRecovery: mockFetchRecovery,
}));

import { useWorkspaceEvents } from './useWorkspaceEvents';

describe('useWorkspaceEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSubscribe.mockReturnValue(vi.fn());
    mockIsConnected.mockReturnValue(true);
    mockGetLastEventId.mockReturnValue(null);
    mockFetchRecovery.mockResolvedValue(null);
  });

  it('should connect and subscribe when sessionId is provided', () => {
    renderHook(() => useWorkspaceEvents({ sessionId: 'session-1' }));

    expect(mockConnect).toHaveBeenCalled();
    expect(mockSubscribe).toHaveBeenCalledWith('session-1', expect.any(Function));
  });

  it('should not subscribe when sessionId is null', () => {
    renderHook(() => useWorkspaceEvents({ sessionId: null }));

    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('should call onFilesChanged when files_changed event arrives', () => {
    const onFilesChanged = vi.fn();
    renderHook(() => useWorkspaceEvents({ sessionId: 'session-1', onFilesChanged }));

    const handler = mockSubscribe.mock.calls[0][1];
    act(() => {
      handler({
        id: 'evt-1',
        type: 'files_changed',
        session_id: 'session-1',
        task_id: 'task-1',
        payload: { files: [{ path: 'scope-config.json', action: 'modified', size: 100, content: '{}' }] },
      });
    });

    expect(onFilesChanged).toHaveBeenCalledWith([
      { path: 'scope-config.json', action: 'modified', size: 100, content: '{}' },
    ]);
  });

  it('should call onTaskCompleted when task_completed event arrives', () => {
    const onTaskCompleted = vi.fn();
    renderHook(() => useWorkspaceEvents({ sessionId: 'session-1', onTaskCompleted }));

    const handler = mockSubscribe.mock.calls[0][1];
    act(() => {
      handler({
        id: 'evt-2',
        type: 'task_completed',
        session_id: 'session-1',
        task_id: 'task-1',
        payload: {},
      });
    });

    expect(onTaskCompleted).toHaveBeenCalledWith({
      id: 'evt-2',
      task_id: 'task-1',
      type: 'task_completed',
      session_id: 'session-1',
      payload: {},
    });
  });

  it('should unsubscribe on unmount', () => {
    const unsubscribe = vi.fn();
    mockSubscribe.mockReturnValue(unsubscribe);

    const { unmount } = renderHook(() => useWorkspaceEvents({ sessionId: 'session-1' }));
    unmount();

    expect(unsubscribe).toHaveBeenCalled();
  });

  it('should call recovery API on mount with lastEventId', async () => {
    mockGetLastEventId.mockReturnValue('evt-5');

    renderHook(() => useWorkspaceEvents({ sessionId: 'session-1' }));

    await vi.waitFor(() => {
      expect(mockFetchRecovery).toHaveBeenCalledWith('session-1', 'evt-5');
    });
  });

  it('should replay missed events from recovery', async () => {
    const onFilesChanged = vi.fn();
    mockFetchRecovery.mockResolvedValue({
      missed_events: [
        {
          id: 'evt-10',
          type: 'files_changed',
          session_id: 'session-1',
          task_id: 'task-2',
          payload: { files: [{ path: 'output.json', action: 'created', size: 50 }] },
          created_at: '2026-05-06T00:00:00Z',
        },
      ],
      current_tasks: [],
      summary: null,
    });

    renderHook(() => useWorkspaceEvents({ sessionId: 'session-1', onFilesChanged }));

    await vi.waitFor(() => {
      expect(onFilesChanged).toHaveBeenCalledWith([
        { path: 'output.json', action: 'created', size: 50 },
      ]);
    });
  });
});

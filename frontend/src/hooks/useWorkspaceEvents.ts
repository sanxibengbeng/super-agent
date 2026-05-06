import { useEffect, useRef, useState, useCallback } from 'react';
import { workspaceSocketClient, type WorkspaceEvent } from '@/services/workspaceSocketClient';
import { fetchRecovery, type RecoverySummary } from '@/services/workspaceRecoveryApi';

export type { RecoverySummary, RecoveryResponse } from '@/services/workspaceRecoveryApi';

export interface FileChange {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  size: number;
  content?: string;
  fetch_url?: string;
}

export interface TaskEvent {
  id: string;
  task_id: string;
  type: string;
  session_id: string;
  payload: Record<string, unknown>;
}

export interface UseWorkspaceEventsOptions {
  sessionId: string | null;
  onFilesChanged?: (files: FileChange[]) => void;
  onTaskStarted?: (task: TaskEvent) => void;
  onTaskCompleted?: (task: TaskEvent) => void;
  onTaskFailed?: (task: TaskEvent) => void;
  onTaskTimeout?: (task: TaskEvent) => void;
}

export function useWorkspaceEvents(options: UseWorkspaceEventsOptions) {
  const { sessionId } = options;
  const [connected, setConnected] = useState(false);
  const [recoverySummary, setRecoverySummary] = useState<RecoverySummary | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const handleEvent = useCallback((event: WorkspaceEvent) => {
    const opts = optionsRef.current;
    switch (event.type) {
      case 'files_changed':
        opts.onFilesChanged?.(
          (event.payload.files as FileChange[]) ?? []
        );
        break;
      case 'task_started':
        opts.onTaskStarted?.(event as TaskEvent);
        break;
      case 'task_completed':
        opts.onTaskCompleted?.(event as TaskEvent);
        break;
      case 'task_failed':
        opts.onTaskFailed?.(event as TaskEvent);
        break;
      case 'task_timeout':
        opts.onTaskTimeout?.(event as TaskEvent);
        break;
    }
  }, []);

  useEffect(() => {
    if (!sessionId) return;

    workspaceSocketClient.connect();
    const unsubscribe = workspaceSocketClient.subscribe(sessionId, handleEvent);
    setConnected(workspaceSocketClient.isConnected());

    const recoverMissedEvents = async () => {
      try {
        const lastEventId = workspaceSocketClient.getLastEventId(sessionId);
        const data = await fetchRecovery(sessionId, lastEventId);

        if (data) {
          for (const event of data.missed_events) {
            handleEvent(event);
          }
          if (data.summary) {
            setRecoverySummary(data.summary);
          }
        }
      } catch {
        // Recovery is best-effort; live subscription will catch up
      }
    };

    recoverMissedEvents();

    return () => {
      unsubscribe();
    };
  }, [sessionId, handleEvent]);

  const dismissRecovery = useCallback(() => {
    setRecoverySummary(null);
  }, []);

  return { connected, recoverySummary, dismissRecovery };
}

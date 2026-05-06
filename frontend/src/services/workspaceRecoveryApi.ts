/**
 * Recovery API for workspace events.
 *
 * Fetches missed events after a WebSocket disconnect, enabling the client
 * to catch up on any events that occurred while offline.
 */

import type { WorkspaceEvent } from '@/services/workspaceSocketClient';

export interface RecoverySummary {
  completed_count: number;
  failed_count: number;
  failed_task_ids: string[];
}

export interface RecoveryResponse {
  missed_events: WorkspaceEvent[];
  current_tasks: unknown[];
  summary: RecoverySummary | null;
}

/**
 * Fetch missed workspace events from the recovery API.
 *
 * @param sessionId - The session to recover events for
 * @param afterEventId - The last known event ID (events after this will be returned)
 * @returns Recovery response with missed events, or null on failure
 */
export async function fetchRecovery(sessionId: string, afterEventId: string | null): Promise<RecoveryResponse | null> {
  const params = new URLSearchParams({ session_id: sessionId });
  if (afterEventId) params.set('after_event_id', afterEventId);

  const baseUrl = import.meta.env.VITE_API_BASE_URL ?? '';
  const response = await fetch(`${baseUrl}/api/workspace-events/recover?${params}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('local_auth_token') ?? ''}`,
    },
  });

  if (response.ok) {
    return response.json();
  }
  return null;
}

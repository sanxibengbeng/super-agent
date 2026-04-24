import { restClient } from './restClient';

export interface TwinSessionSummary {
  id: string;
  project_id: string;
  session_id: string;
  issue_id: string | null;
  created_by: string;
  agent_id: string;
  visibility: 'private' | 'public';
  created_at: string;
  agent: { id: string; name: string; display_name: string | null; avatar: string | null };
  creator: { id: string; username: string | null; full_name: string | null; avatar_url: string | null };
  issue: { id: string; issue_number: number; title: string } | null;
  session: { id: string; status: string };
}

export interface TwinSessionDetail extends TwinSessionSummary {
  agent: TwinSessionSummary['agent'] & { role: string | null };
  issue: (TwinSessionSummary['issue'] & { description: string | null; status: string; priority: string }) | null;
  session: TwinSessionSummary['session'] & { claude_session_id: string | null };
}

export interface ActionEntry {
  id: string;
  type: string;
  action_type: string;
  status: 'pending' | 'confirmed' | 'rejected';
  reason: string;
  created_at: string;
  resolved_at: string | null;
  file: string;
}

export const RestTwinSessionService = {
  async create(
    projectId: string,
    input: { agent_id: string; issue_id?: string; visibility?: string },
  ): Promise<TwinSessionSummary & { chat_session_id: string }> {
    return restClient.post(`/api/projects/${projectId}/twin-sessions`, input);
  },

  async list(
    projectId: string,
    query?: { issue_id?: string; visibility?: string; mine_only?: boolean },
  ): Promise<TwinSessionSummary[]> {
    const params = new URLSearchParams();
    if (query?.issue_id) params.set('issue_id', query.issue_id);
    if (query?.visibility) params.set('visibility', query.visibility);
    if (query?.mine_only) params.set('mine_only', 'true');
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await restClient.get<{ data: TwinSessionSummary[] }>(
      `/api/projects/${projectId}/twin-sessions${qs}`,
    );
    return res.data;
  },

  async getById(projectId: string, twinSessionId: string): Promise<TwinSessionDetail> {
    return restClient.get(`/api/projects/${projectId}/twin-sessions/${twinSessionId}`);
  },

  async updateVisibility(
    projectId: string,
    twinSessionId: string,
    visibility: 'private' | 'public',
  ) {
    return restClient.patch(`/api/projects/${projectId}/twin-sessions/${twinSessionId}/visibility`, {
      visibility,
    });
  },

  async delete(projectId: string, twinSessionId: string): Promise<void> {
    return restClient.delete(`/api/projects/${projectId}/twin-sessions/${twinSessionId}`);
  },

  async confirmAction(projectId: string, twinSessionId: string, actionId: string) {
    return restClient.post(
      `/api/projects/${projectId}/twin-sessions/${twinSessionId}/actions/${actionId}/confirm`,
    );
  },

  async rejectAction(projectId: string, twinSessionId: string, actionId: string) {
    return restClient.post(
      `/api/projects/${projectId}/twin-sessions/${twinSessionId}/actions/${actionId}/reject`,
    );
  },

  async getActiveSessions(projectId: string): Promise<TwinSessionSummary[]> {
    const res = await restClient.get<{ data: TwinSessionSummary[] }>(
      `/api/projects/${projectId}/twin-sessions/active`,
    );
    return res.data;
  },
};

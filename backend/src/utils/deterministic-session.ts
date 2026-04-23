import { v5 as uuidv5 } from 'uuid';

const NAMESPACE = '7a3d4e5f-1b2c-4d5e-8f9a-0b1c2d3e4f5a';

export function computeWorkflowCopilotSessionId(
  workflowId: string,
  version: string,
): string {
  return uuidv5(`workflow_copilot:${workflowId}:${version}`, NAMESPACE);
}

export function computeScopeCopilotSessionId(scopeId: string): string {
  return uuidv5(`scope_copilot:${scopeId}`, NAMESPACE);
}

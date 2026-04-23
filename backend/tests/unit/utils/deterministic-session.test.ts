import { describe, it, expect } from 'vitest';
import {
  computeWorkflowCopilotSessionId,
  computeScopeCopilotSessionId,
} from '../../../src/utils/deterministic-session.js';

describe('deterministic-session', () => {
  describe('computeWorkflowCopilotSessionId', () => {
    it('returns a valid UUID v5', () => {
      const id = computeWorkflowCopilotSessionId('wf-123', '1.0');
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('returns the same ID for the same inputs', () => {
      const a = computeWorkflowCopilotSessionId('wf-123', '1.0');
      const b = computeWorkflowCopilotSessionId('wf-123', '1.0');
      expect(a).toBe(b);
    });

    it('returns different IDs for different versions', () => {
      const a = computeWorkflowCopilotSessionId('wf-123', '1.0');
      const b = computeWorkflowCopilotSessionId('wf-123', '2.0');
      expect(a).not.toBe(b);
    });

    it('returns different IDs for different workflows', () => {
      const a = computeWorkflowCopilotSessionId('wf-111', '1.0');
      const b = computeWorkflowCopilotSessionId('wf-222', '1.0');
      expect(a).not.toBe(b);
    });
  });

  describe('computeScopeCopilotSessionId', () => {
    it('returns a valid UUID v5', () => {
      const id = computeScopeCopilotSessionId('scope-abc');
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('returns the same ID for the same scope', () => {
      const a = computeScopeCopilotSessionId('scope-abc');
      const b = computeScopeCopilotSessionId('scope-abc');
      expect(a).toBe(b);
    });

    it('returns different IDs for different scopes', () => {
      const a = computeScopeCopilotSessionId('scope-aaa');
      const b = computeScopeCopilotSessionId('scope-bbb');
      expect(a).not.toBe(b);
    });
  });
});

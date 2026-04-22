/**
 * AgentCore Runtime Entry Point
 *
 * Implements the AgentCore HTTP protocol contract:
 *   POST /invocations  — run agent, return SSE stream
 *   GET  /ping         — health check
 *
 * Data flow:
 *   1. Backend prepares full workspace locally and uploads to S3
 *   2. Backend invokes AgentCore with S3 bucket/prefix in payload
 *   3. Container downloads entire workspace from S3 → /workspace/
 *   4. Runs Claude Agent SDK with cwd=/workspace
 *   5. SDK hooks (PostToolUse + Stop) sync /workspace changes back to S3
 *
 * Sync strategy:
 *   - /workspace/ writes: SDK hooks (PostToolUse + Stop) in agent-runner.ts
 *   - ~/.claude/ writes: fs.watch in file-watcher.ts (SDK hooks can't see these)
 */

import http from 'http';
import { S3Client } from '@aws-sdk/client-s3';
import { runAgent } from './agent-runner.js';
import { restoreWorkspaceFromS3, restoreClaudeHomeFromS3 } from './workspace-sync.js';
import { startClaudeHomeWatcher } from './file-watcher.js';
import { createGitBaseline } from './agent-runner.js';
import type { AgentPayload, AgentEvent } from './types.js';

const PORT = Number(process.env.PORT ?? 8080);

const DEFAULT_S3_REGION = process.env.WORKSPACE_S3_REGION ?? 'us-east-1';

function createS3Client(region?: string): S3Client {
  return new S3Client({ region: region ?? DEFAULT_S3_REGION });
}

// ---------------------------------------------------------------------------
// /invocations
// ---------------------------------------------------------------------------

async function handleInvocations(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);

  let payload: AgentPayload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
    return;
  }

  const bucket = payload.workspace_s3_bucket;
  const prefix = payload.workspace_s3_prefix;
  const s3 = createS3Client(payload.workspace_s3_region);

  // --- Restore full workspace from S3 → /workspace/ ---
  if (bucket && prefix) {
    try {
      const count = await restoreWorkspaceFromS3(s3, bucket, prefix);
      console.log(`[index] Restored ${count} files from s3://${bucket}/${prefix}`);
    } catch (err) {
      console.error('[index] Workspace restore failed:', err);
    }

    // Restore ~/.claude (session resume data, projects state)
    try {
      const homeCount = await restoreClaudeHomeFromS3(s3, bucket, prefix);
      if (homeCount > 0) {
        console.log(`[index] Restored ${homeCount} ~/.claude files from S3`);
      }
    } catch (err) {
      console.warn('[index] ~/.claude restore failed:', err);
    }

    // Start watching ~/.claude for near-real-time sync to S3
    startClaudeHomeWatcher(s3, bucket, prefix);

    // Create git baseline snapshot for diff tracking
    createGitBaseline();
  }

  // --- SSE streaming response ---
  // /workspace/ sync: SDK hooks (PostToolUse + Stop) in agent-runner.ts
  // ~/.claude/ sync: fs.watch in file-watcher.ts (near-real-time)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  try {
    for await (const event of runAgent(payload)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (err) {
    const errorEvent: AgentEvent = {
      type: 'error',
      code: 'AGENT_EXECUTION_ERROR',
      message: err instanceof Error ? err.message : String(err),
    };
    res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
  }

  res.end();
}

// ---------------------------------------------------------------------------
// /ping
// ---------------------------------------------------------------------------

function handlePing(res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'Healthy',
    time_of_last_update: Math.floor(Date.now() / 1000),
  }));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/invocations') {
      await handleInvocations(req, res);
    } else if (req.method === 'GET' && req.url === '/ping') {
      handlePing(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (err) {
    console.error('[index] Unhandled error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[agentcore-runner] Listening on 0.0.0.0:${PORT}`);
});

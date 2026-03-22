/**
 * AgentCore Runtime Entry Point
 *
 * Implements the AgentCore HTTP protocol contract:
 *   POST /invocations  — run agent, return SSE stream
 *   GET  /ping         — health check
 *
 * Data flow:
 *   1. Backend prepares full workspace locally (skills, agents, CLAUDE.md,
 *      settings.json — same as claude mode) and uploads to S3
 *   2. Backend invokes AgentCore with S3 bucket/prefix in payload
 *   3. Container downloads entire workspace from S3 → /workspace/
 *   4. Runs Claude Agent SDK with cwd=/workspace
 *   5. Syncs /workspace back to S3 (including agent-generated files)
 */

import http from 'http';
import { S3Client } from '@aws-sdk/client-s3';
import { runAgent } from './agent-runner.js';
import { restoreWorkspaceFromS3, syncWorkspaceToS3 } from './workspace-sync.js';
import { startFileWatcher } from './file-watcher.js';
import type { AgentPayload, AgentEvent } from './types.js';

const PORT = Number(process.env.PORT ?? 8080);
const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });

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

  // --- Restore full workspace from S3 → /workspace/ ---
  if (bucket && prefix) {
    try {
      const count = await restoreWorkspaceFromS3(s3, bucket, prefix);
      console.log(`[index] Restored ${count} files from s3://${bucket}/${prefix}`);
    } catch (err) {
      console.error('[index] Workspace restore failed:', err);
    }
  }

  // Start file watcher for incremental S3 sync during execution
  if (bucket && prefix) {
    try { startFileWatcher(s3, bucket, prefix); } catch { /* non-critical */ }
  }

  // --- SSE streaming response ---
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  try {
    for await (const event of runAgent(payload)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);

      // Sync workspace to S3 after assistant/result events (files may have changed)
      if (bucket && prefix && (event.type === 'assistant' || event.type === 'result')) {
        syncWorkspaceToS3(s3, bucket, prefix).catch(() => {});
      }
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

  // Final sync after response completes
  if (bucket && prefix) {
    syncWorkspaceToS3(s3, bucket, prefix).catch(err => {
      console.error('[index] Final workspace sync failed:', err);
    });
  }
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

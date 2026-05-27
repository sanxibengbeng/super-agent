/**
 * AgentCore Runtime Entry Point
 *
 * Simple HTTP server implementing the AgentCore protocol:
 *   POST /invocations  — run agent, return SSE stream
 *   GET  /ping         — health check
 *
 * S3 Files mounts the workspace at /mnt/ws (configured via access point ARN in payload).
 * No S3 restore/sync needed — the filesystem is already mounted when container starts.
 */

import http from 'http';
import { runAgent } from './agent-runner.js';
import type { AgentPayload, AgentEvent } from './types.js';

const PORT = Number(process.env.PORT ?? 8080);

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

  console.log(`[index] Received invocation: session=${payload.session_id}, workspace_access_point=${payload.workspace_access_point_arn?.slice(0, 50)}...`);

  // SSE streaming response
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
  console.log(`[agentcore-runner] WORKSPACE_DIR=${process.env.WORKSPACE_DIR ?? '/mnt/ws'}`);
});

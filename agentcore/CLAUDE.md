# AgentCore — CLAUDE.md

> Lightweight container image for AWS Bedrock AgentCore microVMs. Runs Claude Code in isolated sandboxes with S3 Files workspace mounting.

## Commands

```bash
./build-and-push.sh            # Build ARM64 image and push to ECR (preferred)
npm run build                  # TypeScript compile → dist/
```

## Architecture

```
agentcore/
├── Dockerfile                 # Multi-stage build (ARM64, node:22-slim)
├── build-and-push.sh          # ECR login + build + push script
├── src/
│   ├── index.ts               # HTTP server (POST /invocations, GET /ping)
│   ├── agent-runner.ts        # Wraps Claude Agent SDK query(), streams events
│   └── types.ts               # AgentPayload, AgentEvent, TokenUsage interfaces
├── package.json               # @anthropic-ai/claude-agent-sdk dependency
└── tsconfig.json              # ES2022, NodeNext, strict
```

## How It Works

1. AgentCore invokes container via `POST /invocations` with `AgentPayload` JSON
2. `index.ts` parses payload, starts SSE response stream
3. S3 Files filesystem is pre-mounted at `/mnt/ws` by AgentCore infrastructure
4. `agent-runner.ts` calls Claude Agent SDK `query()` with tools, MCP servers, workspace
5. Session resume attempted first (fast path); falls back to history-injected prompt if microVM recycled
6. Events streamed as `data: {json}\n\n` SSE lines back to caller

**Default tools:** Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task, Skill, TodoWrite, ToolSearch, NotebookEdit

## Build & Deploy

```bash
# Use the script (handles ECR login, platform, BuildKit disable)
cd agentcore && ./build-and-push.sh

# Manual build — DOCKER_BUILDKIT=0 is critical
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin 873543029686.dkr.ecr.us-east-1.amazonaws.com
DOCKER_BUILDKIT=0 docker build --platform linux/arm64 \
  -t 873543029686.dkr.ecr.us-east-1.amazonaws.com/superagenteks-agentcore:latest .
docker push 873543029686.dkr.ecr.us-east-1.amazonaws.com/superagenteks-agentcore:latest
```

## Gotchas

- **ARM64 only.** AgentCore microVMs are Graviton-based. Never cross-compile to amd64.
- **DOCKER_BUILDKIT=0 is required.** BuildKit adds attestation manifests (`unknown/unknown` arch) that break AgentCore startup.
- **S3 Files mount at `/mnt/ws`.** Don't use local filesystem for workspace persistence — it's ephemeral.
- **No direct network access to backend.** Communication is via S3 Files and AgentCore's invoke/response protocol.
- Container must respond within the AgentCore timeout (configurable in the runtime definition).

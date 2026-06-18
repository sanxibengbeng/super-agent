/**
 * AgentCore Command Service
 *
 * Wraps InvokeAgentRuntimeCommandCommand to execute shell commands directly
 * inside AgentCore Runtime containers without going through LLM.
 *
 * Used by Chat module workspace operations (file tree, file read/write/delete)
 * when AGENT_RUNTIME=agentcore.
 *
 * Key constraints:
 *   - Commands must be wrapped in `/bin/bash -c "..."` for shell features
 *   - Session must already exist (created via InvokeAgentRuntime)
 *   - Command body max 64KB, timeout 1-3600s
 *   - Each command is a fresh bash process (stateless between calls)
 */

import { config } from '../config/index.js';

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  status: 'COMPLETED' | 'TIMED_OUT' | null;
}

export class AgentCoreCommandService {
  private client: any;
  private CommandClass: any;
  private sdkLoaded = false;

  private async ensureSDK(): Promise<void> {
    if (this.sdkLoaded) return;
    const mod = await import('@aws-sdk/client-bedrock-agentcore' as string);
    const arnRegion = config.agentcore.runtimeArn?.split(':')[3];
    const region = arnRegion || config.agentcore.region;
    this.client = new mod.BedrockAgentCoreClient({ region });
    this.CommandClass = mod.InvokeAgentRuntimeCommandCommand;
    this.sdkLoaded = true;
  }

  private get runtimeArn(): string {
    const arn = config.agentcore.runtimeArn;
    if (!arn) throw new Error('AGENTCORE_RUNTIME_ARN is not configured');
    return arn;
  }

  /**
   * Execute a shell command inside the AgentCore container.
   * The command is automatically wrapped in `/bin/bash -c "..."`.
   */
  async runCommand(
    sessionId: string,
    command: string,
    timeout = 60,
    options: { clientTimeoutMs?: number } = {}
  ): Promise<CommandResult> {
    await this.ensureSDK();

    // Pad session ID to meet 33-char minimum
    const sid = sessionId.length >= 33 ? sessionId : sessionId.padEnd(33, '_');

    const invoke = async (): Promise<CommandResult> => {
      const response = await this.client.send(
        new this.CommandClass({
          agentRuntimeArn: this.runtimeArn,
          runtimeSessionId: sid,
          contentType: 'application/json',
          accept: 'application/vnd.amazon.eventstream',
          body: {
            command: `/bin/bash -c ${this.shellEscape(command)}`,
            timeout,
          },
        })
      );

      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;
      let status: 'COMPLETED' | 'TIMED_OUT' | null = null;

      for await (const event of response.stream) {
        if (event.chunk?.contentDelta?.stdout) {
          stdout += event.chunk.contentDelta.stdout;
        }
        if (event.chunk?.contentDelta?.stderr) {
          stderr += event.chunk.contentDelta.stderr;
        }
        if (event.chunk?.contentStop) {
          exitCode = event.chunk.contentStop.exitCode;
          status = event.chunk.contentStop.status;
        }
      }

      return { stdout, stderr, exitCode, status };
    };

    // Client-side deadline: the SDK invoke has no client abort and the default
    // server timeout is 60s, so a cold/idle microVM can hang the whole call.
    // For interactive operations (file browser) a short clientTimeoutMs lets the
    // caller fail fast into its S3 fallback instead of blocking.
    if (!options.clientTimeoutMs) {
      return invoke();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`AgentCore command timed out after ${options.clientTimeoutMs}ms`)),
        options.clientTimeoutMs
      );
    });
    try {
      return await Promise.race([invoke(), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // Workspace operations (convenience wrappers)
  // ---------------------------------------------------------------------------

  // Container mount paths (set by CDK AgentCore construct)
  private static readonly WS_DIR = '/mnt/ws';
  private static readonly CLAUDE_HOME = '/mnt/session/.claude';

  // Interactive file-listing tuning. The file browser polls these endpoints,
  // so a cold microVM must fail fast into the S3 fallback rather than hanging.
  private static readonly LIST_CLIENT_TIMEOUT_MS = 4000;
  private static readonly LIST_SERVER_TIMEOUT_S = 10;
  // Bound the find walk: depth for the interactive tree + pruned heavy dirs.
  private static readonly FIND_MAX_DEPTH = 8;
  private static readonly FIND_PRUNE = [
    'node_modules',
    '.git',
    '__pycache__',
    'dist',
    'build',
    '.next',
    '.cache',
    '.venv',
  ]
    .map((d) => `-not -path '*/${d}/*'`)
    .join(' ');

  /** List files in the workspace directory (/mnt/ws). */
  async listWorkspaceFiles(sessionId: string): Promise<WorkspaceFileEntry[]> {
    const { stdout, exitCode } = await this.runCommand(
      sessionId,
      `find ${AgentCoreCommandService.WS_DIR} -maxdepth ${AgentCoreCommandService.FIND_MAX_DEPTH} ${AgentCoreCommandService.FIND_PRUNE} -printf '%y %s %P\\n' 2>/dev/null | sort`,
      AgentCoreCommandService.LIST_SERVER_TIMEOUT_S,
      { clientTimeoutMs: AgentCoreCommandService.LIST_CLIENT_TIMEOUT_MS }
    );

    if (exitCode !== 0 || !stdout.trim()) return [];

    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [type, sizeStr, ...pathParts] = line.split(' ');
        const path = pathParts.join(' ');
        return {
          type: type === 'd' ? ('directory' as const) : ('file' as const),
          size: parseInt(sizeStr ?? '0', 10),
          path,
        };
      })
      .filter((e) => e.path);
  }

  /** List files in ~/.claude (/mnt/session/.claude in AgentCore). */
  async listClaudeHomeFiles(sessionId: string): Promise<WorkspaceFileEntry[]> {
    const { stdout, exitCode } = await this.runCommand(
      sessionId,
      `find ${AgentCoreCommandService.CLAUDE_HOME} -maxdepth ${AgentCoreCommandService.FIND_MAX_DEPTH} ${AgentCoreCommandService.FIND_PRUNE} -printf '%y %s %P\\n' 2>/dev/null | sort`,
      AgentCoreCommandService.LIST_SERVER_TIMEOUT_S,
      { clientTimeoutMs: AgentCoreCommandService.LIST_CLIENT_TIMEOUT_MS }
    );

    if (exitCode !== 0 || !stdout.trim()) return [];

    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [type, sizeStr, ...pathParts] = line.split(' ');
        const path = pathParts.join(' ');
        return {
          type: type === 'd' ? ('directory' as const) : ('file' as const),
          size: parseInt(sizeStr ?? '0', 10),
          path,
        };
      })
      .filter((e) => e.path);
  }

  /** Read a file from workspace (or ~/.claude if prefixed with __claude_home__/). */
  async readFile(sessionId: string, filePath: string): Promise<string | null> {
    let basePath = AgentCoreCommandService.WS_DIR;
    let targetPath = filePath;
    if (filePath.startsWith('__claude_home__/')) {
      basePath = AgentCoreCommandService.CLAUDE_HOME;
      targetPath = filePath.slice('__claude_home__/'.length);
    }
    const safe = this.sanitizePath(targetPath);
    if (!safe) return null;

    const { stdout, exitCode } = await this.runCommand(sessionId, `cat ${basePath}/${safe}`);

    return exitCode === 0 ? stdout : null;
  }

  /** Write content to a file in the workspace. */
  async writeFile(sessionId: string, filePath: string, content: string): Promise<boolean> {
    const safe = this.sanitizePath(filePath);
    if (!safe) return false;

    const ws = AgentCoreCommandService.WS_DIR;
    const { exitCode } = await this.runCommand(
      sessionId,
      `mkdir -p ${ws}/$(dirname ${safe}) && cat > ${ws}/${safe} << 'AGENTCORE_HEREDOC_EOF'\n${content}\nAGENTCORE_HEREDOC_EOF`
    );

    return exitCode === 0;
  }

  /** Delete a file from the workspace. */
  async deleteFile(sessionId: string, filePath: string): Promise<boolean> {
    const safe = this.sanitizePath(filePath);
    if (!safe) return false;

    const { exitCode } = await this.runCommand(
      sessionId,
      `rm -f ${AgentCoreCommandService.WS_DIR}/${safe}`
    );

    return exitCode === 0;
  }

  /** Delete a directory from the workspace. */
  async deleteDirectory(sessionId: string, dirPath: string): Promise<boolean> {
    const safe = this.sanitizePath(dirPath);
    if (!safe) return false;

    const { exitCode } = await this.runCommand(
      sessionId,
      `rm -rf ${AgentCoreCommandService.WS_DIR}/${safe}`
    );

    return exitCode === 0;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Sanitize a workspace-relative path to prevent traversal attacks. */
  private sanitizePath(filePath: string): string | null {
    const normalized = filePath.replace(/\\/g, '/');
    if (normalized.includes('..') || normalized.startsWith('/')) return null;
    // Remove any shell-dangerous characters
    if (/[`$;|&<>]/.test(normalized)) return null;
    return normalized;
  }

  /** Escape a string for use as a bash -c argument. */
  private shellEscape(cmd: string): string {
    // Use $'...' syntax with escaped single quotes
    return `$'${cmd.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
}

interface WorkspaceFileEntry {
  type: 'file' | 'directory';
  size: number;
  path: string;
}

export const agentCoreCommandService = new AgentCoreCommandService();

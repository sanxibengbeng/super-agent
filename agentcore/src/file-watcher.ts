/**
 * File Watcher — monitors ~/.claude for changes, debounces, then syncs to S3.
 *
 * Claude Code writes session state (projects/, sessions/) to ~/.claude/.
 * SDK hooks can't capture these writes (they only see tool-level Write/Edit),
 * so we use fs.watch to get near-real-time sync of ~/.claude → S3.
 *
 * /workspace/ sync is handled by SDK hooks in agent-runner.ts.
 */

import fs from 'fs';
import { S3Client } from '@aws-sdk/client-s3';
import { syncClaudeHomeToS3 } from './workspace-sync.js';

const DEBOUNCE_MS = 3000;
const CLAUDE_HOME_DIR = `${process.env.HOME ?? '/root'}/.claude`;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let watcher: fs.FSWatcher | null = null;
let activeS3: S3Client | null = null;
let activeBucket: string | null = null;
let activePrefix: string | null = null;

export function startClaudeHomeWatcher(s3: S3Client, bucket: string, prefix: string): void {
  stopClaudeHomeWatcher();
  activeS3 = s3;
  activeBucket = bucket;
  activePrefix = prefix;

  if (!fs.existsSync(CLAUDE_HOME_DIR)) {
    fs.mkdirSync(CLAUDE_HOME_DIR, { recursive: true });
  }

  try {
    watcher = fs.watch(CLAUDE_HOME_DIR, { recursive: true }, () => {
      scheduleSync();
    });
    console.log(`[file-watcher] Watching ${CLAUDE_HOME_DIR} for changes`);
  } catch (err) {
    console.warn(`[file-watcher] Failed to watch ${CLAUDE_HOME_DIR}:`, err);
  }
}

export function stopClaudeHomeWatcher(): void {
  if (watcher) {
    try { watcher.close(); } catch { /* ignore */ }
    watcher = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function scheduleSync(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    if (!activeS3 || !activeBucket || !activePrefix) return;
    try {
      const count = await syncClaudeHomeToS3(activeS3, activeBucket, activePrefix);
      if (count > 0) {
        console.log(`[file-watcher] Synced ${count} ~/.claude files → S3`);
      }
    } catch (err) {
      console.warn('[file-watcher] ~/.claude sync failed:', err);
    }
  }, DEBOUNCE_MS);
}

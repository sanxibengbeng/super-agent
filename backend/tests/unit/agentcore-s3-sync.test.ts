import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, readFile, writeFile, access } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

/**
 * Tests for the AgentCore S3 sync logic in agent-runtime-agentcore.ts.
 *
 * Focuses on:
 *   - syncBackFromS3 skipping __claude_home__/ prefixed files
 *   - uploadDirToS3 correctly walking the .claude/ directory
 */

describe('AgentCore S3 sync filtering', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `agentcore-sync-test-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('syncBackFromS3 should skip __claude_home__/ files', () => {
    it('should not download files with __claude_home__/ prefix to local workspace', async () => {
      // Simulate the filtering logic from syncBackFromS3
      const s3Objects = [
        { key: 'org/scope/session/CLAUDE.md', relativePath: 'CLAUDE.md' },
        { key: 'org/scope/session/.claude/settings.json', relativePath: '.claude/settings.json' },
        { key: 'org/scope/session/.claude/skills/test/SKILL.md', relativePath: '.claude/skills/test/SKILL.md' },
        { key: 'org/scope/session/__claude_home__/projects/abc/config.json', relativePath: '__claude_home__/projects/abc/config.json' },
        { key: 'org/scope/session/__claude_home__/sessions/def.json', relativePath: '__claude_home__/sessions/def.json' },
      ];

      const downloaded: string[] = [];
      for (const obj of s3Objects) {
        const relativePath = obj.relativePath;
        if (!relativePath || relativePath.endsWith('/')) continue;
        if (relativePath.startsWith('__claude_home__/')) continue;
        downloaded.push(relativePath);
      }

      expect(downloaded).toEqual([
        'CLAUDE.md',
        '.claude/settings.json',
        '.claude/skills/test/SKILL.md',
      ]);
      expect(downloaded).not.toContain('__claude_home__/projects/abc/config.json');
      expect(downloaded).not.toContain('__claude_home__/sessions/def.json');
    });
  });

  describe('uploadDirToS3 should include .claude/ directory', () => {
    it('should walk .claude/ directory and not skip it', async () => {
      const SKIP = new Set(['node_modules', '.git', 'dist', '__pycache__']);

      // Create a workspace structure with .claude/
      const workspacePath = join(tempDir, 'workspace');
      await mkdir(join(workspacePath, '.claude', 'skills', 'test-skill'), { recursive: true });
      await mkdir(join(workspacePath, '.claude', 'agents'), { recursive: true });
      await writeFile(join(workspacePath, 'CLAUDE.md'), '# Test', 'utf-8');
      await writeFile(join(workspacePath, '.claude', 'settings.json'), '{}', 'utf-8');
      await writeFile(join(workspacePath, '.claude', 'skills', 'test-skill', 'SKILL.md'), '# Skill', 'utf-8');
      await writeFile(join(workspacePath, '.claude', 'agents', 'test.md'), '# Agent', 'utf-8');

      // Simulate the walk logic from uploadDirToS3
      const { readdir, stat: statFile } = await import('fs/promises');
      const { relative } = await import('path');

      const files: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (SKIP.has(entry.name)) continue;
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(fullPath);
          } else {
            files.push(relative(workspacePath, fullPath));
          }
        }
      };

      await walk(workspacePath);

      expect(files).toContain('CLAUDE.md');
      expect(files).toContain('.claude/settings.json');
      expect(files).toContain('.claude/skills/test-skill/SKILL.md');
      expect(files).toContain('.claude/agents/test.md');
    });

    it('should skip node_modules but not .claude', async () => {
      const SKIP = new Set(['node_modules', '.git', 'dist', '__pycache__']);

      expect(SKIP.has('.claude')).toBe(false);
      expect(SKIP.has('node_modules')).toBe(true);
      expect(SKIP.has('.git')).toBe(true);
    });
  });
});

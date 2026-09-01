import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { syncGroupAgentRunnerSrc } from './container-runner.js';

describe('syncGroupAgentRunnerSrc', () => {
  let srcDir: string;
  let destDir: string;

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-sync-'));
    srcDir = path.join(base, 'src');
    destDir = path.join(base, 'group', 'agent-runner-src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'v1-index');
    fs.writeFileSync(path.join(srcDir, 'ipc-mcp-stdio.ts'), 'v1-mcp');
  });

  it('creates the copy and a manifest on first use', () => {
    syncGroupAgentRunnerSrc(srcDir, destDir, 'g');

    expect(fs.readFileSync(path.join(destDir, 'index.ts'), 'utf-8')).toBe(
      'v1-index',
    );
    expect(fs.existsSync(`${destDir}.sync.json`)).toBe(true);
  });

  it('propagates repo changes into an untouched copy', () => {
    syncGroupAgentRunnerSrc(srcDir, destDir, 'g');
    fs.writeFileSync(path.join(srcDir, 'ipc-mcp-stdio.ts'), 'v2-mcp');
    syncGroupAgentRunnerSrc(srcDir, destDir, 'g');

    expect(
      fs.readFileSync(path.join(destDir, 'ipc-mcp-stdio.ts'), 'utf-8'),
    ).toBe('v2-mcp');
  });

  it('keeps a file the group customized', () => {
    syncGroupAgentRunnerSrc(srcDir, destDir, 'g');
    fs.writeFileSync(path.join(destDir, 'index.ts'), 'group-custom');
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'v2-index');
    syncGroupAgentRunnerSrc(srcDir, destDir, 'g');

    expect(fs.readFileSync(path.join(destDir, 'index.ts'), 'utf-8')).toBe(
      'group-custom',
    );
  });

  it('still syncs sibling files when one is customized', () => {
    syncGroupAgentRunnerSrc(srcDir, destDir, 'g');
    fs.writeFileSync(path.join(destDir, 'index.ts'), 'group-custom');
    fs.writeFileSync(path.join(srcDir, 'ipc-mcp-stdio.ts'), 'v2-mcp');
    syncGroupAgentRunnerSrc(srcDir, destDir, 'g');

    expect(
      fs.readFileSync(path.join(destDir, 'ipc-mcp-stdio.ts'), 'utf-8'),
    ).toBe('v2-mcp');
  });

  it('refreshes a pre-existing unmanaged copy and backs up the old file', () => {
    // A copy made before manifests existed: stale content, no manifest.
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, 'index.ts'), 'old-index');
    fs.writeFileSync(path.join(destDir, 'ipc-mcp-stdio.ts'), 'old-mcp');

    syncGroupAgentRunnerSrc(srcDir, destDir, 'g');

    expect(fs.readFileSync(path.join(destDir, 'index.ts'), 'utf-8')).toBe(
      'v1-index',
    );
    const backups = fs
      .readdirSync(destDir)
      .filter((f) => f.startsWith('index.ts.pre-sync-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(destDir, backups[0]), 'utf-8')).toBe(
      'old-index',
    );
  });

  it('adds files that are new in the repo', () => {
    syncGroupAgentRunnerSrc(srcDir, destDir, 'g');
    fs.writeFileSync(path.join(srcDir, 'new-tool.ts'), 'brand-new');
    syncGroupAgentRunnerSrc(srcDir, destDir, 'g');

    expect(fs.readFileSync(path.join(destDir, 'new-tool.ts'), 'utf-8')).toBe(
      'brand-new',
    );
  });

  it('is a no-op when nothing changed', () => {
    syncGroupAgentRunnerSrc(srcDir, destDir, 'g');
    const before = fs.statSync(path.join(destDir, 'index.ts')).mtimeMs;
    syncGroupAgentRunnerSrc(srcDir, destDir, 'g');

    expect(fs.statSync(path.join(destDir, 'index.ts')).mtimeMs).toBe(before);
    expect(
      fs.readdirSync(destDir).filter((f) => f.includes('pre-sync')),
    ).toHaveLength(0);
  });
});

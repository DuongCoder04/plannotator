import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReviewServer as startBunReviewServer } from './review';
import { startReviewServer as startPiReviewServer } from '../../apps/pi-extension/server';

const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
const originalPort = process.env.PLANNOTATOR_PORT;
const originalPath = process.env.PATH;
const tempDirs: string[] = [];

function makeDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'plannotator-call-flow-endpoint-'));
  tempDirs.push(dataDir);
  return dataDir;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
  if (originalPort === undefined) delete process.env.PLANNOTATOR_PORT;
  else process.env.PLANNOTATOR_PORT = originalPort;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Call flow endpoint capability guards', () => {
  for (const [runtime, startServer] of [
    ['Bun', startBunReviewServer],
    ['Pi', startPiReviewServer],
  ] as const) {
    test(`${runtime} returns unsupported for All Files before runtime execution`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeDataDir();
      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());
      const server = await startServer({
        rawPatch: '',
        gitRef: 'All files',
        diffType: 'all',
        origin: runtime === 'Pi' ? 'pi' : 'claude-code',
        htmlContent: '<!doctype html><html><body>review</body></html>',
      });

      try {
        const initial = await fetch(`${server.url}/api/diff`).then((response) => response.json()) as {
          snapshotId: string;
        };
        const settings = await fetch(`${server.url}/api/review-analysis`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ semanticDiff: false, callFlow: true }),
        }).then((response) => response.json()) as { callFlow?: { state: string } };
        expect(settings.callFlow?.state).toBe('unsupported');

        const direct = await fetch(
          `${server.url}/api/call-flow?snapshot=${encodeURIComponent(initial.snapshotId)}`,
        ).then((response) => response.json()) as { status: string; reason: string };
        expect(direct).toMatchObject({ status: 'unsupported', reason: 'view-unsupported' });
      } finally {
        server.stop();
      }
    });

    test.skipIf(process.platform === 'win32')(`${runtime} supersedes an older overlapping settings response`, async () => {
      const dataDir = makeDataDir();
      const binDir = mkdtempSync(join(tmpdir(), 'plannotator-call-flow-node-'));
      tempDirs.push(binDir);
      const startedPath = join(binDir, 'started');
      const releasePath = join(binDir, 'release');
      const nodePath = join(binDir, 'node');
      writeFileSync(nodePath, [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `: > ${JSON.stringify(startedPath)}`,
        `while [ ! -f ${JSON.stringify(releasePath)} ]; do sleep 0.02; done`,
        'echo v24.0.0',
        '',
      ].join('\n'), 'utf8');
      chmodSync(nodePath, 0o755);
      process.env.PLANNOTATOR_DATA_DIR = dataDir;
      process.env.PATH = `${binDir}:${originalPath ?? ''}`;
      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());
      const server = await startServer({
        rawPatch: '',
        gitRef: 'Working tree',
        diffType: 'uncommitted',
        origin: runtime === 'Pi' ? 'pi' : 'claude-code',
        htmlContent: '<!doctype html><html><body>review</body></html>',
      });

      try {
        const older = fetch(`${server.url}/api/review-analysis`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ semanticDiff: false, callFlow: true }),
        });
        await waitForFile(startedPath);
        const current = await fetch(`${server.url}/api/review-analysis`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ semanticDiff: false, callFlow: false }),
        }).then((response) => response.json()) as { callFlow?: { state: string } };
        expect(current.callFlow?.state).toBe('disabled');

        writeFileSync(releasePath, 'release\n', 'utf8');
        await expect(older.then((response) => response.json())).resolves.toEqual({ superseded: true });
      } finally {
        if (!existsSync(releasePath)) writeFileSync(releasePath, 'release\n', 'utf8');
        server.stop();
      }
    }, 10_000);
  }
});

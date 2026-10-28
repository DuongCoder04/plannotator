/**
 * The viewer pin (`packages/core/guide-viewer-manifest.ts`) is generated and
 * gitignored; a checkout holds only the fallback pin (an older viewer). A
 * shipping build that stops running `build:viewer-pin` would still build and
 * pass every test, and silently ship exports pinned to the old viewer. This
 * keeps every shipping path wired to the generator.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const scripts = (file: string) => (JSON.parse(read(file)) as { scripts: Record<string, string> }).scripts;
const PIN = 'build:viewer-pin';

/** The jobs of a workflow, as text, keyed by job id. */
function jobs(workflow: string): Map<string, string> {
  const body = workflow.slice(workflow.indexOf('\njobs:\n'));
  const out = new Map<string, string>();
  const heads = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\n/gm)];
  heads.forEach((m, i) => out.set(m[1]!, body.slice(m.index!, heads[i + 1]?.index ?? body.length)));
  return out;
}

describe('every shipping build pins its own viewer', () => {
  test('root build:viewer-pin builds the viewer, then writes the pin from it', () => {
    expect(scripts('package.json')[PIN]).toMatch(/build:viewer && .*sync:manifest$/);
  });

  test('release.yml pins before compiling binaries and before packing npm packages', () => {
    const release = jobs(read('.github/workflows/release.yml'));
    const shipping = [...release].filter(([, text]) => /apps\/hook\/server\/index\.ts --compile|bun pm pack/.test(text));
    expect(shipping.length).toBeGreaterThanOrEqual(2);
    for (const [id, text] of shipping) {
      const pin = text.indexOf(`bun run ${PIN}`);
      const ship = text.search(/apps\/hook\/server\/index\.ts --compile|bun run build:opencode|bun run build:pi/);
      expect(pin, `release.yml job ${id} ships a pin without running ${PIN} first`).toBeGreaterThan(-1);
      expect(pin, `release.yml job ${id} runs ${PIN} after it builds`).toBeLessThan(ship);
    }
  });

  test('guides-show-deploy.yml pins the Worker to its build before deploying it', () => {
    const deploy = read('.github/workflows/guides-show-deploy.yml');
    const build = deploy.indexOf('build:viewer');
    const sync = deploy.indexOf('sync:manifest');
    expect(build).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(build);
    expect(sync).toBeLessThan(deploy.indexOf('wrangler deploy'));
  });

  test('packages published by hand pin first: core, VS Code, Pi, OpenCode', () => {
    expect(scripts('packages/core/package.json').prepack).toContain(PIN);
    const vscode = scripts('apps/vscode-extension/package.json').package!;
    expect(vscode.indexOf(PIN)).toBeGreaterThan(-1);
    expect(vscode.indexOf(PIN)).toBeLessThan(vscode.indexOf('vsce-package'));
    expect(scripts('apps/pi-extension/package.json').prepublishOnly).toMatch(new RegExp(`${PIN}.*build:pi`));
    expect(scripts('apps/opencode-plugin/package.json').prepublishOnly).toMatch(new RegExp(`${PIN}.*run build`));
  });
});

/**
 * The viewer pin (`packages/core/guide-viewer-manifest.ts`) is generated and
 * gitignored; a checkout holds only the fallback pin (an older viewer). A
 * shipping build that stops running `build:viewer-pin` would still build and
 * pass every test, and silently ship exports pinned to the old viewer. This
 * keeps every shipping path wired to the generator, reading the workflows as
 * YAML (comments are not steps) and the package scripts command by command.
 */
import { describe, expect, test } from 'bun:test';
import { YAML } from 'bun';
import { readFileSync } from 'node:fs';
import path from 'node:path';

interface Step { name?: string; run?: string; if?: unknown; 'continue-on-error'?: unknown }
interface Job { needs?: string | string[]; steps?: Step[] }

const root = path.resolve(import.meta.dirname, '../../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const scripts = (file: string) => (JSON.parse(read(file)) as { scripts: Record<string, string> }).scripts;
const jobs = (file: string) => (YAML.parse(read(file)) as { jobs: Record<string, Job> }).jobs;
/** The commands of a step's `run:` block, one per line, shell comments dropped. */
const commands = (step: Step) => (step.run ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
/** The commands of a package script. */
const chain = (script: string | undefined) => (script ?? '').split('&&').map((c) => c.trim());
const needs = (job: Job) => [job.needs ?? []].flat();

const PIN = 'bun run build:viewer-pin';
const SHIPS = /--compile\b|\bbun pm pack\b|\bbun run build:(opencode|pi)\b/;

/** Index of the first step running `command` as a whole line; fails if that step is conditional. */
function stepRunning(steps: Step[], command: string, where: string): number {
  const at = steps.findIndex((s) => commands(s).includes(command));
  expect(at, `${where} has no step running \`${command}\``).toBeGreaterThan(-1);
  expect(steps[at]!.if, `${where}: the \`${command}\` step must not be conditional`).toBeUndefined();
  expect(steps[at]!['continue-on-error'], `${where}: the \`${command}\` step must not continue on error`).toBeUndefined();
  return at;
}

describe('every shipping build pins its own viewer', () => {
  test('root build:viewer-pin drops the old build manifest, builds the viewer, then writes the pin from it', () => {
    expect(chain(scripts('package.json')['build:viewer-pin'])).toEqual([
      'rm -f apps/guides-show/dist/viewer/manifest.json',
      'bun run --cwd apps/guides-show build:viewer',
      'bun run --cwd apps/guides-show sync:manifest',
    ]);
  });

  test('release.yml pins before every compile and every npm pack', () => {
    const release = jobs('.github/workflows/release.yml');
    const shipping = Object.entries(release).filter(([, job]) => (job.steps ?? []).some((s) => commands(s).some((c) => /--compile\b|\bbun pm pack\b/.test(c))));
    expect(shipping.map(([id]) => id).sort()).toEqual(['build', 'npm-package']);
    for (const [id, job] of shipping) {
      const steps = job.steps!;
      const pin = stepRunning(steps, PIN, `release.yml job ${id}`);
      const ship = steps.findIndex((s) => commands(s).some((c) => SHIPS.test(c)));
      expect(pin, `release.yml job ${id} runs ${PIN} after it builds`).toBeLessThan(ship);
    }
  });

  test('release.yml publishes nothing until guides.show serves the pinned viewer', () => {
    const release = jobs('.github/workflows/release.yml');
    expect(needs(release['viewer-pin-live']!)).toEqual(expect.arrayContaining(['build', 'npm-package']));
    expect(release['viewer-pin-live']!.steps!.some((s) => commands(s).some((c) => c.includes('https://guides.show/v1/')))).toBe(true);
    expect(needs(release.release!)).toContain('viewer-pin-live');
    expect(needs(release['npm-publish']!)).toContain('viewer-pin-live');
  });

  test('guides-show-deploy.yml pins the Worker to its build before deploying it', () => {
    const steps = jobs('.github/workflows/guides-show-deploy.yml').publish!.steps!;
    const build = stepRunning(steps, 'bun run --cwd apps/guides-show build:viewer', 'guides-show-deploy.yml');
    const sync = stepRunning(steps, 'bun run --cwd apps/guides-show sync:manifest', 'guides-show-deploy.yml');
    const deploy = steps.findIndex((s) => commands(s).some((c) => /\bwrangler deploy\b/.test(c)));
    expect(deploy).toBeGreaterThan(-1);
    expect(build).toBeLessThan(sync);
    expect(sync).toBeLessThan(deploy);
  });

  test('packages published by hand pin first: core, VS Code, Pi, OpenCode', () => {
    const PIN_FROM_ROOT = 'bun run --cwd ../.. build:viewer-pin';
    expect(chain(scripts('packages/core/package.json').prepack)).toContain(PIN_FROM_ROOT);
    const vscode = chain(scripts('apps/vscode-extension/package.json').package);
    expect(vscode.indexOf(PIN_FROM_ROOT)).toBeGreaterThan(-1);
    expect(vscode.indexOf(PIN_FROM_ROOT)).toBeLessThan(vscode.indexOf('bun run vsce-package'));
    const pi = chain(scripts('apps/pi-extension/package.json').prepublishOnly);
    expect(pi.indexOf(PIN)).toBeGreaterThan(-1);
    expect(pi.indexOf(PIN)).toBeLessThan(pi.indexOf('bun run build:pi'));
    const opencode = chain(scripts('apps/opencode-plugin/package.json').prepublishOnly);
    expect(opencode.indexOf(PIN_FROM_ROOT)).toBeGreaterThan(-1);
    expect(opencode.indexOf(PIN_FROM_ROOT)).toBeLessThan(opencode.indexOf('bun run build'));
  });
});

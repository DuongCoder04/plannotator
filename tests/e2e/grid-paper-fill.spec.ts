/**
 * The Grid look's paper reaches the bottom of the view. Before, the plan card
 * on the grid sized to its content, so a short plan or file showed a card that
 * stopped halfway down the screen with empty grid below it (owner, 2026-10-27:
 * "the grid paper is never full size"). Now the card runs down to the
 * document area's bottom padding when the content is short; a long document
 * is unchanged (the card is as long as the document and scrolls).
 *
 * Plan review and annotate, a short and a long document, at 1440 by 900 and
 * 390 by 844, against the compiled binary under a temp HOME and
 * PLANNOTATOR_DATA_DIR, headless. Build the binary first (see inbox.spec.ts).
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const SHORT = '# Add retry to the uploader\n\nA short plan.\n\n## Steps\n\n1. Wrap the upload in a retry loop.\n2. Log each failed attempt.\n';
const LONG = '# Migrate the settings store\n\n' + Array.from({ length: 16 }, (_, i) =>
  `## Step ${i + 1}\n\nThis step is long enough that the whole document runs well past one screen.\n\n- First point\n- Second point\n`).join('\n');

// Grid chosen, and every first-run dialog already seen, so the page opens on the plan.
const COOKIES: [string, string][] = [
  ['plannotator-plan-look-choice-resolved', 'true'],
  ['plannotator-grid-enabled', 'true'],
  ['plannotator-look-feel-announcement-seen', '2'],
  ['plannotator-announce-tui-herdr-seen', '1'],
  ['plannotator-announce-ask-session-seen', '1'],
  ['plannotator-announce-agent-tool-seen', '1'],
  ['plannotator-vim-mode-announcement-seen', '2'],
  ['plannotator-plan-ai-announcement-seen', '1'],
  ['plannotator-permission-mode-configured', 'true'],
  ['plannotator-guide-intro-seen', '1'],
  ['plannotator-edit-mode-announcement-seen', '1'],
  ['plannotator-token-hover-announcement-seen', '1'],
];

type Kind = 'plan' | 'annotate';

async function start(root: string, kind: Kind, doc: string, run: number): Promise<{ child: ChildProcess; url: string }> {
  const ready = join(root, `ready-${run}.jsonl`);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '', HOME: root,
    PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_READY_FILE: ready,
    PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER,
    PLANNOTATOR_SKIP_BROWSER_OPEN: '1', PLANNOTATOR_REMOTE: '0', PLANNOTATOR_INBOX_CONNECT: '0',
  };
  let child: ChildProcess;
  if (kind === 'annotate') {
    const file = join(root, `doc-${run}.md`);
    writeFileSync(file, doc);
    child = spawn(binary, ['annotate', file], { cwd: root, stdio: 'ignore', env });
  } else {
    child = spawn(binary, [], { cwd: root, stdio: ['pipe', 'ignore', 'ignore'], env });
    child.stdin!.end(JSON.stringify({
      session_id: 'e2e', transcript_path: join(root, 'transcript.jsonl'), cwd: root, permission_mode: 'plan',
      hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_input: { plan: doc },
    }));
  }
  await expect.poll(() => existsSync(ready) ? readFileSync(ready, 'utf8') : '', { timeout: 30_000 }).toContain('"url"');
  return { child, url: JSON.parse(readFileSync(ready, 'utf8').trim().split('\n')[0]!).url };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  // inbox-guard: own child (the plan review / annotate CLI this test spawned).
  child.kill('SIGKILL');
  await exited;
}

/** The document scroll area and the plan card, in viewport pixels. */
async function geometry(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('main[data-print-region="document"]')!;
    const card = document.querySelector<HTMLElement>('article[data-print-region="article"]')!;
    const m = main.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    return {
      grid: main.classList.contains('bg-grid'),
      mainBottom: m.bottom,
      mainScrollHeight: main.scrollHeight,
      mainClientHeight: main.clientHeight,
      cardBottom: c.bottom,
      cardHeight: c.height,
    };
  });
}

async function check(browser: Browser, url: string, width: number, height: number, long: boolean): Promise<void> {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: 'light' });
  try {
    await context.addCookies(COOKIES.map(([name, value]) => ({ name, value, url })));
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.locator('article[data-print-region="article"]')).toBeVisible();
    await page.waitForTimeout(300); // fonts and the sticky header lane settle
    const g = await geometry(page);
    expect(g.grid, 'the Grid look is on').toBe(true);
    if (long) {
      // A long document is as long as its content: the area scrolls.
      expect(g.mainScrollHeight).toBeGreaterThan(g.mainClientHeight + 200);
      expect(g.cardHeight).toBeGreaterThan(height);
    } else {
      // A short document's card runs to the area's bottom padding (32px on a
      // desktop, 12px on a phone), and does not make the area scroll.
      expect(g.mainBottom - g.cardBottom, `card ends ${Math.round(g.mainBottom - g.cardBottom)}px above the bottom`).toBeLessThanOrEqual(40);
      expect(g.cardBottom).toBeLessThanOrEqual(g.mainBottom);
      expect(g.mainScrollHeight).toBeLessThanOrEqual(g.mainClientHeight + 1);
    }
  } finally {
    await context.close();
  }
}

for (const kind of ['plan', 'annotate'] as const) {
  test(`${kind}: the Grid paper reaches the bottom of the view for a short document, a long one still scrolls`, async ({ browser }) => {
    expect(existsSync(binary), 'build the scratch binary first').toBe(true);
    const root = inboxScratch(`plannotator-grid-paper-${kind}-e2e-`);
    mkdirSync(join(root, 'data'), { recursive: true });
    const children: ChildProcess[] = [];
    try {
      const short = await start(root, kind, SHORT, 1);
      children.push(short.child);
      await check(browser, short.url, 1440, 900, false);
      await check(browser, short.url, 390, 844, false);
      await stop(short.child);

      const long = await start(root, kind, LONG, 2);
      children.push(long.child);
      await check(browser, long.url, 1440, 900, true);
      await check(browser, long.url, 390, 844, true);
    } finally {
      for (const child of children) await stop(child);
      await removeInboxScratch(root);
    }
  });
}

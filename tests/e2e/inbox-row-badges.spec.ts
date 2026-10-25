/**
 * The list rows' badges and their hover card (approval "inbox-row-badges",
 * card A), proved in a real browser against the compiled binary. Nothing is
 * mocked: the binary runs `plannotator inbox --background` under a temp
 * PLANNOTATOR_DATA_DIR and HOME, and agents write through `plannotator inbox
 * mcp` (scripts/inbox-sim.ts).
 *
 *  - Stopped is a red triangle alone, Holds up an amber triangle and its count;
 *    their accessible text stays "Stopped" and "Holds up 3".
 *  - The agent's mark has its own column just before the time: every mark's
 *    right edge lines up, and every subject cell starts on one left edge.
 *  - Card A opens on the badge after the tooltip delay, and while the row has
 *    keyboard focus; a click's focus opens nothing.
 *  - Beside an open thread the two-line rows keep the card and put the mark
 *    before the time on line 1.
 *  - An iPhone (WebKit): icons only, no card, the mark by the time.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs (desktop light and dark, beside a thread, both cards open, keyboard,
 * an iPhone) land in PLANNOTATOR_ROW_BADGES_SHOTS, or .local/proof/row-badges/.
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEMO_MESSAGES, SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(process.env.PLANNOTATOR_ROW_BADGES_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'row-badges'));

interface World {
  url: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  errors: string[];
  stopped: string;
  holding: string;
}

let world: World;

const card = (page: Page) => page.locator('[data-pn-tooltip]:not([data-closed]) [data-wait-card]');

async function shot(page: Page, name: string, before?: () => Promise<void>): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    if (before) await before();
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** Rest the pointer on a row's badge and wait for its card. */
async function hoverBadge(page: Page, threadId: string): Promise<void> {
  await page.mouse.move(5, 5);
  await expect(card(page)).toHaveCount(0);
  await page.locator(`[data-thread-id="${threadId}"] [data-row-badge]`).hover();
  await expect(card(page)).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-row-badges-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const billing = scratchProject(join(root, 'src'), 'billing-svc');
  const docs = scratchProject(join(root, 'src'), 'docs-site');
  const relay = scratchProject(join(root, 'src'), 'relay-worker');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const opencode = await SimAgent.connect({ binary, env, name: 'OpenCode', host: 'opencode' });
  const pi = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' });
  const holding = await opencode.send({ project_path: docs, body: DEMO_MESSAGES.holding, thread: 'install-page' });
  await pi.send({ project_path: relay, subject: 'FCM token migration', body: DEMO_MESSAGES.news });
  await claude.send({ project_path: billing, body: DEMO_MESSAGES.named, thread: 'refund-webhooks' });
  await pi.send({
    project_path: relay,
    subject: 'Push payload over 4 KB',
    body: [':::question', 'Drop the question context from the push, or send ids only?', 'Stopped: the relay cannot deliver without this.', '', '- [ ] Drop the context', '- [ ] Ids only', ':::'].join('\n'),
  });
  const stopped = await claude.send({ project_path: billing, body: DEMO_MESSAGES.stopped, thread: 'retry-worker' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  world = { url, agents: [claude, opencode, pi], context, page, errors, stopped: stopped.thread_id as string, holding: holding.thread_id as string };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    for (const agent of world.agents) await agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('desktop: the triangles, their words for a screen reader, and the marks in their own column', async () => {
  const { page } = world;
  await page.goto(world.url);
  const stop = page.locator(`.ib-row[data-thread-id="${world.stopped}"] [data-row-badge]`);
  const hold = page.locator(`.ib-row[data-thread-id="${world.holding}"] [data-row-badge]`);
  await expect(stop).toHaveText('Stopped');
  await expect(hold).toHaveText('Holds up 3');
  await expect(stop.locator('svg.ib-tri')).toBeVisible();
  // Drawn: the triangle alone; the triangle and "3". The words are visually hidden.
  // The words' box is the visually hidden one (1 px, clipped); the drawn text is the count alone.
  for (const badge of [stop, hold]) expect((await badge.locator('.ib-sr').boundingBox())!.width).toBeLessThanOrEqual(1);
  await expect(hold.locator('.ib-bn')).toHaveText('3');
  expect((await stop.boundingBox())!.width).toBeLessThanOrEqual(30);
  // The badge column narrowed: the badge fits in 48 px.
  expect((await hold.boundingBox())!.width).toBeLessThanOrEqual(48);
  // One accessible name per row, its words short; the card's words as its description.
  const row = page.locator(`.ib-row[data-thread-id="${world.stopped}"]`);
  const described = await row.getAttribute('aria-describedby');
  expect(described).toBeTruthy();
  await expect(page.locator(`[id="${described}"]`)).toHaveText(/^Stopped: The retry worker cannot ship without this\. Also holds up: The retry worker; The admin retry view\.$/);

  // Every mark ends on one right edge, just before the time; every subject cell starts on one left edge.
  const geometry = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.ib-row')].map((r) => ({
      mark: r.querySelector('.ib-mcol')!.getBoundingClientRect().right,
      time: r.querySelector('.ib-t')!.getBoundingClientRect().left,
      subj: r.querySelector('.ib-subj')!.getBoundingClientRect().left,
      inSubject: r.querySelector('.ib-subj .ib-mk') !== null,
    })),
  );
  expect(geometry.length).toBeGreaterThanOrEqual(4);
  expect(new Set(geometry.map((g) => Math.round(g.mark))).size).toBe(1);
  expect(new Set(geometry.map((g) => Math.round(g.subj))).size).toBe(1);
  for (const g of geometry) {
    expect(g.inSubject).toBe(false);
    expect(g.mark).toBeLessThanOrEqual(g.time);
  }
  await shot(page, 'desktop');
  expect(world.errors).toEqual([]);
});

test('card A on hover: Stopped, then Holds up', async () => {
  const { page } = world;
  await page.goto(world.url);
  await hoverBadge(page, world.stopped);
  const stop = card(page);
  await expect(stop.locator('.ib-wc-h')).toHaveText('Stopped');
  await expect(stop.locator('.ib-wc-chip')).toHaveText('retry-worker');
  await expect(stop.locator('.ib-wc-row')).toHaveText(['Q1The retry worker cannot ship without this', 'Q2The retry worker', 'Q2The admin retry view']);
  await expect(stop.locator('.ib-wc-sub')).toHaveText('Also holds up 2');
  await expect(stop.locator('.ib-wc-foot')).toContainText('Claude Code');
  await shot(page, 'card-stopped', () => hoverBadge(page, world.stopped));

  await hoverBadge(page, world.holding);
  const hold = card(page);
  await expect(hold.locator('.ib-wc-h')).toHaveText('Holds up 3');
  await expect(hold.locator('.ib-wc-row')).toHaveText(['The install page', 'The agent table', 'The screenshots']);
  await expect(hold.locator('.ib-wc-q')).toHaveCount(0);
  await expect(hold.locator('.ib-wc-foot')).toContainText('OpenCode');
  await shot(page, 'card-holds', () => hoverBadge(page, world.holding));
  await page.mouse.move(5, 5);
  await expect(card(page)).toHaveCount(0);
});

test("keyboard focus on the row opens the card; a click's focus does not", async () => {
  const { page } = world;
  await page.goto(world.url);
  await page.mouse.move(5, 5);
  const row = page.locator(`.ib-row[data-thread-id="${world.holding}"]`);
  // A key first, so the focus that follows is a keyboard focus (`:focus-visible`).
  await page.keyboard.press('Shift');
  await row.focus();
  expect(await row.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator('.ib-wc-h')).toHaveText('Holds up 3');
  await shot(page, 'keyboard', async () => {
    await page.keyboard.press('Shift');
    await row.focus();
    await expect(card(page)).toBeVisible();
  });
  // Tab on: the card goes with the focus.
  await page.locator('body').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(card(page)).toHaveCount(0);

  // A click on the row's project label: it focuses the row (and opens the thread), with no card.
  await page.locator(`.ib-row[data-thread-id="${world.stopped}"] .ib-p`).click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  await expect(card(page)).toHaveCount(0);
});

test('beside an open thread: the mark before the time on line 1, and the card on keyboard focus', async () => {
  const { page } = world;
  await page.goto(`${world.url}#thread=${world.stopped}`);
  const narrow = page.locator(`.ib-nrow[data-thread-id="${world.holding}"]`);
  await expect(narrow).toBeVisible();
  const order = await narrow.locator('.ib-l1 > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]));
  expect(order.filter((c) => c !== 'ib-c')).toEqual(['ib-p', 'ib-mcol', 'ib-t']);
  await expect(narrow.locator('.ib-l2 .ib-mk')).toHaveCount(0);
  await shot(page, 'beside-thread');
  await page.keyboard.press('Shift');
  await narrow.focus();
  await expect(card(page)).toBeVisible();
  await shot(page, 'beside-thread-card', async () => {
    await page.keyboard.press('Shift');
    await narrow.focus();
    await expect(card(page)).toBeVisible();
  });
  // Escape closes the card, keeps focus on the row and leaves the thread open; the next Escape closes the thread.
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await expect(narrow).toBeFocused();
  await page.waitForTimeout(300);
  expect(page.url()).toContain(`#thread=${world.stopped}`);
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(new RegExp(`thread=${world.stopped}`));
});

test('an iPhone (WebKit): icons only, no card, the mark by the time', async () => {
  let own: Browser | null = null;
  try {
    own = await webkit.launch({ args: [] });
    for (const scheme of ['light', 'dark'] as const) {
      const context = await own.newContext({ ...devices['iPhone 15'], colorScheme: scheme, reducedMotion: 'reduce' });
      const page = await context.newPage();
      await page.goto(world.url);
      const row = page.locator(`.ib-mrow[data-thread-id="${world.holding}"]`);
      await expect(row.locator('[data-row-badge]')).toHaveText('Holds up 3');
      const m1 = await row.locator('.ib-m1 > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]));
      expect(m1).toEqual(['ib-p', 'ib-mcol', 'ib-t']);
      await row.locator('[data-row-badge]').tap();
      await page.waitForTimeout(400);
      await expect(card(page)).toHaveCount(0);
      await page.goto(world.url);
      await expect(page.locator(`.ib-mrow[data-thread-id="${world.stopped}"] [data-row-badge]`)).toHaveText('Stopped');
      await expect(page.locator(`.ib-mrow[data-thread-id="${world.stopped}"]`)).toBeVisible();
      // The rows skip paint until laid out (content-visibility): give WebKit a frame or two.
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(proofDir, `iphone-${scheme}.png`) });
      await context.close();
    }
  } finally {
    await own?.close();
  }
});

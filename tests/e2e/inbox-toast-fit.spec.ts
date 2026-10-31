/**
 * Toasts with the longest real data (design record "inbox-toasts-break-fixes",
 * approved 2026-10-31): a 59-character project, an agent named with its
 * worktree id (47 characters), a 120-character thread name and a file with a
 * long name. Proved in a real browser against the compiled binary, with the
 * agents writing through `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 *  - at 320 and 390 (a touch phone) and 1440, the stopped Mark read, a row's
 *    Mark read naming its thread, Looks good and Draft saved take at most two
 *    lines; the ×, Undo and the Drafts chip are on screen; an agent's name in
 *    a toast is cut at 40 characters with "…", and said whole to a screen
 *    reader and in the thread;
 *  - on a phone a toast keeps above the thread's foot when a thread opens
 *    under it (Back, then another thread: break 01), and above a full-screen
 *    file's bar and name chip (break 02);
 *  - a touch tablet (768 wide, coarse pointer) gets the desktop toast with no
 *    key hint and 44 px targets for Undo and the × (break 14).
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-toast-fit.spec.ts`.
 * PNGs land in .local/proof/toast-fit/.
 */

import { expect, test, type Browser, type BrowserContextOptions, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'toast-fit');

const PROJECT = 'northwind-industries-holdings-billing-reconciliation-service';
const AGENT = 'Claude Code (worktree agent-a0316994da8440ab5)';
const AGENT_SHORT = 'Claude Code (worktree agent-a0316994da8…';
const SUBJECT = 'Fix flaky tests/e2e/inbox-attachment-stepping-save.spec.ts on WebKit after the Bun 1.4.4 upgrade (retry worker race)';
const FILE = 'Q3 Board Deck — FINAL (revised) v12 [approved by legal].md';

const STOPPED = [
  'The retry worker races the save on WebKit. I attached the deck the board asked about.',
  '',
  ':::question',
  'Retry with the same idempotency key?',
  '',
  'Stopped: the worker cannot ship without this.',
  '',
  '- [ ] Yes',
  '- [ ] No',
  ':::',
].join('\n');

interface World {
  url: string;
  agents: SimAgent[];
  /** The stopped thread (the long name, the file), another with no question (Looks good), and one more. */
  threads: { stopped: string; merged: string; other: string };
  file: string;
  errors: string[];
}

let world: World;

const PHONE = (width: number, height: number): BrowserContextOptions => ({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const VIEWPORTS: { name: string; options: BrowserContextOptions; phone: boolean }[] = [
  { name: '320', options: PHONE(320, 640), phone: true },
  { name: '390', options: PHONE(390, 844), phone: true },
  { name: '1440', options: { viewport: { width: 1440, height: 900 } }, phone: false },
];

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 15_000 });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-toast-fit-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  rememberInboxOf(dataDir);
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim().split('\n').pop()!;
  const project = scratchProject(join(root, 'src'), PROJECT);
  writeFileSync(join(project, FILE), `# Q3 board deck\n\nThe numbers, revised.\n\n${'A paragraph of the deck. '.repeat(40)}\n`);
  const claude = await SimAgent.connect({ binary, env, name: AGENT, host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const other = await codex.send({ project_path: project, subject: 'Nightly build is green', body: 'The nightly build is green again.' });
  const merged = await claude.send({ project_path: project, subject: 'Merged the payouts table', thread: 'merged', body: 'Merged the payouts table. Nothing is waiting on you.' });
  const stopped = await claude.send({ project_path: project, subject: SUBJECT, thread: 'stopped', body: STOPPED, attachments: [FILE] });
  const res = await fetch(new URL(`/api/inbox/threads/${encodeURIComponent(stopped.thread_id as string)}/attachments`, url));
  const file = ((await res.json()) as { attachments?: { id: string }[] }).attachments?.[0]?.id ?? '';
  expect(file).not.toBe('');
  world = {
    url,
    agents: [claude, codex],
    threads: { stopped: stopped.thread_id as string, merged: merged.thread_id as string, other: other.thread_id as string },
    file,
    errors: [],
  };
});

test.afterAll(async () => {
  try {
    if (world) await Promise.all(world.agents.map((a) => a.close().catch(() => {})));
  } finally {
    await removeInboxScratch();
  }
});

async function open(browser: Browser, options: BrowserContextOptions): Promise<Page> {
  const context = await browser.newContext({ ...options, colorScheme: 'dark', reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', (error) => world.errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') world.errors.push(message.text());
  });
  return page;
}

/** The toast's lines of text: its words' line boxes, by their distinct tops. */
async function lines(toast: Locator): Promise<number> {
  return toast.locator('.ib-tsay').evaluate((el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const line = parseFloat(style.lineHeight) || 20;
    // The clamp hides lines past the second, so the box (not the line boxes, which run on unseen) is what shows.
    return Math.round((box.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / line);
  });
}

/** `inner` lies within the window. */
async function onScreen(page: Page, inner: Locator): Promise<boolean> {
  const box = await inner.boundingBox();
  const view = page.viewportSize()!;
  return !!box && box.width > 0 && box.x >= 0 && box.y >= 0 && box.x + box.width <= view.width + 0.5 && box.y + box.height <= view.height + 0.5;
}

/** The toast fits: at most two lines, Undo (when it has one), its chip (when it has one) and the × on screen. */
async function expectFits(page: Page, toast: Locator, what: string) {
  await expect(toast).toBeVisible();
  await toast.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined));
  expect(await lines(toast), `${what}: lines`).toBeLessThanOrEqual(2);
  for (const part of ['[data-toast-dismiss]', '[data-toast-undo]', '[data-toast-action]']) {
    if ((await toast.locator(part).count()) === 0) continue;
    expect(await onScreen(page, toast.locator(part)), `${what}: ${part} on screen`).toBe(true);
  }
  expect(await onScreen(page, toast), `${what}: the toast on screen`).toBe(true);
}

/** The boxes of `selector` that are drawn and that the toast overlaps. */
async function overlapsToast(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const toast = document.querySelector('[data-inbox-toast]')!.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>(selector)]
      .filter((el) => !el.closest('[data-inbox-toast]'))
      .map((el) => ({ el, box: el.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.height > 0 && box.top < toast.bottom - 0.5 && box.bottom > toast.top + 0.5 && box.left < toast.right && box.right > toast.left)
      .map(({ el }) => el.className);
  }, selector);
}

const pane = (page: Page) => page.locator('section.ib-pane');
const toastOf = (page: Page) => page.locator('[data-inbox-toast]');
const markRead = (page: Page, phone: boolean) => (phone ? pane(page).locator('.ib-phead .ib-hbtn') : page.locator('[data-mark-read]'));

async function openThread(page: Page, thread: string, heading: RegExp) {
  await page.goto(`${world.url}#thread=${thread}`);
  await expect(pane(page).getByRole('heading', { name: heading })).toBeVisible();
}

for (const vp of VIEWPORTS) {
  test(`${vp.name}: the longest toasts take at most two lines, with Undo, the chip and the × on screen`, async ({ browser }) => {
    const page = await open(browser, vp.options);
    try {
      // Mark read on the stopped thread: the warning names the agent, cut at 40 characters.
      await openThread(page, world.threads.stopped, /Fix flaky tests/);
      const read = markRead(page, vp.phone);
      await expect(read).toHaveAttribute('aria-pressed', 'false');
      await read.click();
      const toast = toastOf(page);
      await expect(toast.locator('.ib-tdetail')).toHaveText(`${AGENT_SHORT} was stopped`);
      await expectFits(page, toast, 'stopped Mark read');
      // Nothing is lost: the live region says it whole, and so does the thread.
      await expect(page.locator('[data-inbox-live]')).toContainText(`${AGENT} was stopped`);
      await expect(pane(page)).toContainText(AGENT);
      await page.screenshot({ path: join(proofDir, `${vp.name}-stopped-mark-read.png`) });
      if (vp.phone) {
        // Clear of the thread's foot (Reply).
        expect(await overlapsToast(page, 'section.ib-pane .ib-pfoot')).toEqual([]);
      }
      await toast.getByRole('button', { name: /Undo/ }).click();
      await expect(read).toHaveAttribute('aria-pressed', 'false');

      if (!vp.phone) {
        // A row's Mark read while another thread is open names the row's thread: its 120 characters held to two lines.
        await openThread(page, world.threads.merged, /Merged the payouts table/);
        const row = page.locator(`.ib-lbody [data-row="${world.threads.stopped}"]`);
        await row.hover();
        await row.locator('[data-row-mark-read]').click();
        await expect(toast.locator('.ib-tdetail')).toContainText('Fix flaky tests');
        await expectFits(page, toast, 'row Mark read');
        // Its words, cut, show whole in the window's component tooltip (never a native title).
        await expect(toast.locator('[title]')).toHaveCount(0);
        await toast.locator('.ib-tsay').hover();
        await expect(page.locator('[data-pn-tooltip]')).toContainText(SUBJECT);
        await page.screenshot({ path: join(proofDir, `${vp.name}-row-mark-read.png`) });
        await toast.getByRole('button', { name: /Undo/ }).click();
      }

      // Looks good: "Goes to <the agent, cut> in 10 s · Moves to Quiet".
      await openThread(page, world.threads.merged, /Merged the payouts table/);
      const ack = pane(page).locator('[data-ack]');
      await ack.click();
      await expect(toast).toContainText(`Goes to ${AGENT_SHORT} in 10 s`);
      await expectFits(page, toast, 'Looks good');
      await page.screenshot({ path: join(proofDir, `${vp.name}-looks-good.png`) });
      await toast.getByRole('button', { name: /Undo/ }).click();
      await expect(ack).toHaveAttribute('aria-pressed', 'false');

      // Draft saved: the Drafts chip on screen beside the words.
      await page.goto(world.url);
      await page.locator('[data-open-compose]:visible').first().click();
      const dialog = page.locator('dialog[data-compose]');
      await dialog.locator('[data-compose-text] textarea').fill(`A draft for ${PROJECT}, kept from ${vp.name} px.`);
      // Closing asks to keep or discard (a phone's sheet has Cancel; a window, Escape).
      if (vp.phone) await dialog.locator('[data-compose-cancel]').click();
      else await page.keyboard.press('Escape');
      await dialog.locator('[data-compose-keep]').click();
      await expect(dialog).toHaveCount(0);
      await expect(toast).toContainText('Draft saved');
      await expectFits(page, toast, 'Draft saved');
      await expect(toast.locator('[data-toast-action]')).toHaveText('Drafts');
      await page.screenshot({ path: join(proofDir, `${vp.name}-draft-saved.png`) });
    } finally {
      await page.context().close();
    }
    expect(world.errors).toEqual([]);
  });
}

test('a phone: a toast raised in a thread keeps above the foot of the next thread opened under it (break 01)', async ({ browser }) => {
  const page = await open(browser, PHONE(390, 844));
  try {
    await openThread(page, world.threads.stopped, /Fix flaky tests/);
    const read = markRead(page, true);
    await read.click();
    const toast = toastOf(page);
    await expect(toast).toBeVisible();
    // Back to the list, then another thread, the toast still up.
    await pane(page).locator('.ib-pback').click();
    await expect(pane(page)).toHaveCount(0);
    await page.locator(`.ib-mrow[data-thread-id="${world.threads.other}"]`).click();
    await expect(pane(page).getByRole('heading', { name: /Nightly build is green/ })).toBeVisible();
    await expect(toast).toBeVisible();
    await expect.poll(() => overlapsToast(page, 'section.ib-pane .ib-pfoot')).toEqual([]);
    const [toastBox, footBox] = await Promise.all([toast.boundingBox(), pane(page).locator('.ib-pfoot').boundingBox()]);
    expect(toastBox!.y + toastBox!.height).toBeLessThanOrEqual(footBox!.y);
    await page.screenshot({ path: join(proofDir, '390-toast-over-next-thread.png') });
    await toast.getByRole('button', { name: /Undo/ }).click();
  } finally {
    await page.context().close();
  }
  expect(world.errors).toEqual([]);
});

test('a phone: a toast keeps above a full-screen file\'s bar and its name chip (break 02)', async ({ browser }) => {
  const page = await open(browser, PHONE(320, 640));
  try {
    await openThread(page, world.threads.stopped, /Fix flaky tests/);
    await markRead(page, true).click();
    const toast = toastOf(page);
    await expect(toast).toBeVisible();
    // The file opens full screen while the toast is up.
    await page.evaluate(({ thread, file }) => {
      location.hash = `thread=${thread}&file=${file}&view=full`;
    }, { thread: world.threads.stopped, file: world.file });
    await expect(page.locator('.ib-fvdock-phone .ib-fvbar')).toBeVisible();
    await expect(toast).toBeVisible();
    await expect.poll(() => overlapsToast(page, '.ib-fvdock-phone .ib-fvbar, .ib-fvdock-phone .ib-fvhandle, .ib-view.ib-phone .ib-fvchip')).toEqual([]);
    await page.screenshot({ path: join(proofDir, '320-toast-over-file.png') });
    await toast.getByRole('button', { name: /Undo/ }).click();
    await expect(toast).toHaveCount(0);
  } finally {
    await page.context().close();
  }
  expect(world.errors).toEqual([]);
});

test('a touch tablet (768, coarse pointer): the desktop toast, no key hint, 44 px targets for Undo and the × (break 14)', async ({ browser }) => {
  const page = await open(browser, { viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  try {
    await openThread(page, world.threads.stopped, /Fix flaky tests/);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse) and (hover: none)').matches)).toBe(true);
    const read = page.locator('[data-mark-read]');
    await expect(read).toHaveAttribute('aria-pressed', 'false');
    await read.click();
    const toast = toastOf(page);
    await expectFits(page, toast, 'tablet Mark read');
    await expect(toast).not.toHaveClass(/ib-toast-phone/);
    // Undo's Z hint is not drawn (a tablet's keyboard may be away); Z still undoes.
    await expect(toast.locator('.ib-tundo kbd')).toBeHidden();
    const target = (selector: string) =>
      toast.locator(selector).evaluate((el) => {
        const box = el.getBoundingClientRect();
        const after = getComputedStyle(el, '::after');
        return Math.min(box.height - parseFloat(after.top) - parseFloat(after.bottom), box.width - parseFloat(after.left) - parseFloat(after.right));
      });
    expect(await target('[data-toast-undo]')).toBeGreaterThanOrEqual(44);
    expect(await target('[data-toast-dismiss]')).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: join(proofDir, '768-touch-tablet.png') });
    await toast.getByRole('button', { name: /Undo/ }).click();
  } finally {
    await page.context().close();
  }
  expect(world.errors).toEqual([]);
});

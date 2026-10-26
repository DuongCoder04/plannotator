/**
 * The thread parity harness's captures (run by scripts/inbox-thread-parity.ts
 * through inbox-thread-parity.config.ts, never by `bun run test:e2e:inbox`).
 *
 * Each project (desktop light, desktop dark, the pane at 360 px, iPhone 15,
 * Pixel 7) copies the seeded data dir (inbox-thread-parity-seed.ts) into its
 * own scratch folder and starts its own Inbox on the copy with
 * PLANNOTATOR_E2E_BINARY, so the reference binary and the candidate binary
 * read the same ids, timestamps, looks and picks. The page clock is fixed at
 * the seed's `frozenAt`, motion is reduced and animations and the caret are
 * off; fonts and images are loaded before a capture.
 *
 * For every seeded thread it captures, in order: the thread as it lands, the
 * thread page by page from the top, Expand all page by page, the open
 * questions list, and the Artifacts view. Each capture is a zero-pixel
 * `toHaveScreenshot` (the reference run writes the PNGs) and the pane's
 * outerHTML, normalized for the port, the server session and blob URLs,
 * written for the script to diff.
 */

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parityEnv, readParitySeed, type ParitySeed } from './inbox-thread-parity-seed';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const seedRoot = process.env.PLANNOTATOR_PARITY_SEED;
const out = resolve(process.env.PLANNOTATOR_PARITY_OUT ?? '');
const role = process.env.PLANNOTATOR_PARITY_ROLE === 'reference' ? 'reference' : 'candidate';
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? '');

/** At most this many pages of one thread (a page is the scroller's height less an overlap). */
const MAX_PAGES = 12;
const NARROW_CSS = 'section.ib-pane { flex: 0 0 360px !important; width: 360px !important; max-width: 360px !important; }';

interface Run {
  seed: ParitySeed;
  url: string;
  serverSession: string;
}

let run: Run;

test.beforeAll(async ({}, info) => {
  expect(seedRoot, 'PLANNOTATOR_PARITY_SEED: run scripts/inbox-thread-parity.ts').toBeTruthy();
  expect(existsSync(binary), `the binary: ${binary}`).toBe(true);
  const seed = readParitySeed(seedRoot!);
  const root = inboxScratch(`plannotator-thread-parity-${role}-${info.project.name}-`);
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(home);
  // The seeded data, never the seeding Inbox's registry or log.
  cpSync(seed.dataDir, dataDir, { recursive: true, filter: (src) => !/[/\\]inbox[/\\]inbox\.(json|log)$/.test(src) });
  const started = spawnSync(binary, ['inbox', '--background'], { env: parityEnv(home, dataDir), cwd: root, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim().replace(/\/?$/, '/');
  const health = (await (await fetch(`${url}api/inbox/health`)).json()) as { serverSession: string };
  run = { seed, url, serverSession: health.serverSession };
});

test.afterAll(async () => {
  // Every Inbox this project started, then its folder (inbox-scratch.ts).
  await removeInboxScratch();
});

function normalize(html: string): string {
  return html
    .replace(/http:\/\/(127\.0\.0\.1|localhost):\d+/g, 'http://127.0.0.1:PORT')
    .replace(/blob:[^"'\s)]+/g, 'blob:URL')
    // An HTML attachment's asset base carries a token minted per Inbox run.
    .replace(/\/api\/html-assets\/[0-9a-f]+\//g, '/api/html-assets/TOKEN/')
    .split(run.serverSession)
    .join('SERVER_SESSION')
    .replace(/></g, '>\n<');
}

/** Fonts, images and two frames: what a capture waits for beyond toHaveScreenshot's own two equal shots. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].filter((img) => !img.complete).map((img) => new Promise((done) => {
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
      })),
    );
    // Decoded too, so no image paints in a later frame than its tile.
    await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}

async function capture(page: Page, info: TestInfo, thread: string, state: string, dom = 'section.ib-pane'): Promise<void> {
  await settle(page);
  await expect.soft(page).toHaveScreenshot(`${thread}-${state}.png`);
  const html = await page.locator(dom).evaluateAll((els) => els.map((el) => el.outerHTML).join('\n'));
  const metrics = await page.evaluate(() => {
    const scroller = document.querySelector('section.ib-pane .ib-pbody');
    return scroller ? { scrollTop: Math.round(scroller.scrollTop), scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight } : null;
  });
  const dir = join(out, role, 'dom', info.project.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${thread}-${state}.html`), `<!-- ${JSON.stringify(metrics)} -->\n${normalize(html)}\n`);
}

/** The thread from the top, a page at a time. */
async function pages(page: Page, info: TestInfo, thread: string, prefix: string): Promise<void> {
  const scroller = page.locator('section.ib-pane .ib-pbody');
  if ((await scroller.count()) === 0) return;
  const { height, client } = await scroller.evaluate((el) => ({ height: el.scrollHeight, client: el.clientHeight }));
  const step = Math.max(200, client - 80);
  for (let i = 0, top = 0; i < MAX_PAGES; i++, top += step) {
    await scroller.evaluate((el, y) => el.scrollTo({ top: y, behavior: 'instant' }), Math.min(top, height - client));
    await capture(page, info, thread, `${prefix}${i}`);
    if (top + client >= height) break;
  }
}

async function open(page: Page, hash: string): Promise<void> {
  await page.goto('about:blank');
  await page.goto(`${run.url}#${hash}`);
  await expect(page.locator('section.ib-pane')).toBeVisible();
}

/** The seeded threads, in capture order (the list reads earlier threads as looked at). */
const THREADS = ['folding', 'questions', 'replaced', 'files', 'actions', 'ack', 'delivery', 'worst'];

// One test per project: a capture that differs fails softly and every later thread is still captured
// in the same Inbox, so the list beside each thread reads the same looks as in the reference run.
test('every seeded thread', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.setFixedTime(new Date(run.seed.frozenAt));
  if (info.project.name === 'narrow-360') {
    await page.addInitScript((css) => {
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.dataset.parity = 'narrow';
        style.textContent = css;
        document.head.appendChild(style);
      });
    }, NARROW_CSS);
  }
  const dir = join(out, role, 'dom', info.project.name);
  mkdirSync(dir, { recursive: true });

  for (const name of THREADS) {
    await test.step(name, async () => {
      errors.length = 0;
      const id = run.seed.threads[name];
      expect(id, `the seed has no ${name} thread`).toBeTruthy();

      // As it lands (a new message: at "New since you looked"), then page by page.
      await open(page, `thread=${id}`);
      await capture(page, info, name, 'land');
      await pages(page, info, name, 'page-');

      // Expand all, when the thread folds.
      const expand = page.locator('section.ib-pane [data-expand-all]');
      if ((await expand.count()) > 0 && (await expand.getAttribute('aria-label')) === 'Expand all messages') {
        await expand.click();
        await page.mouse.move(0, 0);
        await pages(page, info, name, 'expanded-');
      }

      // The open questions list.
      const questions = page.locator('section.ib-pane .ib-pfoot [data-open-questions]');
      if ((await questions.count()) > 0 && (await questions.isVisible())) {
        await questions.click();
        await expect(page.locator('[data-open-questions-list]')).toBeVisible();
        await capture(page, info, name, 'open-questions', 'section.ib-pane, [data-open-questions-list]');
        await page.keyboard.press('Escape');
      }

      // The Artifacts view, when the thread has one.
      if ((await page.locator('section.ib-pane [data-artifacts-button]').count()) > 0) {
        await open(page, `thread=${id}&artifacts`);
        await capture(page, info, name, 'artifacts');
      }

      writeFileSync(join(dir, `${name}-errors.txt`), `${errors.map((e) => normalize(e)).join('\n')}\n`);
    });
  }
});

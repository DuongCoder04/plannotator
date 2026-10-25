/**
 * The onboarding tour (approval "inbox-onboarding-tour"), proved in a real
 * browser against the compiled binary: `plannotator inbox --background` under
 * a temp PLANNOTATOR_DATA_DIR, a scratch HOME and a PATH of the system's own
 * tools only (no agent CLI is ever run), notifications recorded by an init
 * script.
 *
 *  - The paced newcomer walk, timed as the brief's outside check timed it
 *    (220 words a minute, 1.5 s to find each control, 3 s for the closer
 *    look, 5 s in the mock), from the first-run entry screen (Two paths) to
 *    Finish: every step shot desktop light and dark, one headless video.
 *  - Keyboard only: Tab and Enter, focus never on the page.
 *  - An iPhone in WebKit: taps, 44 px targets, the sheet never over its target.
 *  - Reduced motion: no pulse, the replay a little shorter.
 *  - A stacked window (900 px): the thread covers the list.
 *  - Exit at every step: the person's Inbox comes back exactly as it was
 *    (its list read before and after is the same), and the entry screen does
 *    not come back.
 *  - A real message mid-tour: a chip in the tour bar, no notification, no
 *    interruption; the chip leaves the tour to it.
 *  - Leaving by the chip or the tour sidebar's Settings: Back never reopens
 *    the tour; a tour reached by a link exits to the Inbox, not to an earlier
 *    tour's start point.
 *  - Step 6: How to allow opens Settings → General and the real sidebar's rows
 *    end the tour, both recorded as finished; Exit after a reload goes to the
 *    Inbox; Back never reopens the tour in any of them.
 *  - A pick other than the real answer: replayed with an honest note.
 *  - The fixture routes: read only, embedded in the binary, sandboxed.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * Shots and the video go to PLANNOTATOR_TOUR_SHOTS (default .local/proof/tour).
 */
import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_TOUR_SHOTS ?? join(repo, '.local/proof/tour'));
const DESKTOP = { width: 1440, height: 900 };
const REAL = 'A · Our guide reader in one tab';

interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
}

function startWorld(name: string): World {
  const root = inboxScratch(`plannotator-tour-${name}-`);
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  for (const dir of [home, dataDir]) mkdirSync(dir, { recursive: true });
  const env: Record<string, string> = {
    // The system's own tools only: never the agents installed on the machine running the spec.
    PATH: '/usr/bin:/bin',
    HOME: home,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  return { root, dataDir, env, url: started.stdout.trim() };
}

/** An agent writes to the person's Inbox through the real stdio entry. */
async function agentWrites(w: World, body: string, subject: string): Promise<string> {
  const agent = await SimAgent.connect({ binary, env: w.env, name: 'Claude Code', host: 'claude-code' });
  try {
    const project = scratchProject(join(w.root, 'src'), 'billing-svc');
    const sent = await agent.send({ project_path: project, body, subject });
    return sent.thread_id as string;
  } finally {
    await agent.close();
  }
}

function config(w: World): Record<string, any> {
  const file = join(w.dataDir, 'config.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

/** The person's list as the server holds it, without what moves on its own. */
async function ownList(w: World): Promise<string> {
  const res = await fetch(new URL('api/inbox/threads', w.url));
  const model = (await res.json()) as Record<string, any>;
  const { cursor: _cursor, serverSession: _session, update: _update, notice: _notice, version: _version, ...rest } = model;
  return JSON.stringify(rest);
}

function recordNotifications(): void {
  const calls: string[] = [];
  (window as unknown as { __calls: string[] }).__calls = calls;
  const Real = window.Notification;
  // iOS Safari has no Notification at all.
  if (!Real) return;
  class Recorded extends Real {
    constructor(title: string, options?: NotificationOptions) {
      super(title, options);
      calls.push(title);
    }
  }
  window.Notification = Recorded as typeof Notification;
}

async function open(browser: Browser, w: World, errors: string[], options: Parameters<Browser['newContext']>[0] = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: DESKTOP, colorScheme: 'light', ...options });
  await context.addInitScript(recordNotifications);
  const page = await context.newPage();
  // PLANNOTATOR_E2E_CPU_THROTTLE=6: a slow CI runner on a fast laptop (Chromium only).
  const throttle = Number(process.env.PLANNOTATOR_E2E_CPU_THROTTLE ?? '');
  if (throttle > 1 && browser.browserType().name() === 'chromium') {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  }
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(w.url);
  return { context, page };
}

const coach = (page: Page) => page.locator('[data-tour-coach]');
const step = (page: Page) => page.locator('[data-tour-bar] .ib-tour-steps');
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** Reads the coach card as a newcomer would: 220 words a minute, then 1.5 s to find the control. */
async function read(page: Page, paced: boolean): Promise<void> {
  if (!paced) return;
  const text = await coach(page).innerText();
  await page.waitForTimeout(Math.round((words(text) / 220) * 60_000) + 1500);
}

/** Time spent taking screenshots, left out of the walk's timings (a newcomer takes none). */
let shooting = 0;

async function shoot(page: Page, name: string, themes: readonly ('light' | 'dark')[] = ['light', 'dark']): Promise<void> {
  const began = Date.now();
  try {
    await shootThemes(page, name, themes);
  } finally {
    shooting += Date.now() - began;
  }
}

async function shootThemes(page: Page, name: string, themes: readonly ('light' | 'dark')[]): Promise<void> {
  mkdirSync(shots, { recursive: true });
  // Never a coach card caught in its fade-in, or before it is placed.
  await page.waitForFunction(() => {
    const coach = document.querySelector<HTMLElement>('[data-tour-coach]');
    return !coach || (coach.style.visibility !== 'hidden' && coach.getAnimations().every((a) => a.playState !== 'running'));
  });
  await page.waitForTimeout(250);
  for (const scheme of themes) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForFunction((dark) => document.documentElement.classList.contains('light') !== dark, scheme === 'dark', { timeout: 3000 });
    // Past the theme's 150 ms crossfade and any entrance (WebKit headless can leave a colour transition mid-way).
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      for (const a of document.getAnimations()) {
        try {
          a.finish();
        } catch {
          // An endless animation (the Tater sprite, a spinner) has no end to finish at.
        }
      }
      // WebKit can keep an inherited colour from before an emulated scheme change: restyle the page once.
      const root = document.getElementById('root') ?? document.body;
      const scrolled = [...document.querySelectorAll<HTMLElement>('*')].filter((el) => el.scrollTop > 0).map((el) => [el, el.scrollTop] as const);
      root.style.display = 'none';
      void root.offsetHeight;
      root.style.display = '';
      for (const [el, top] of scrolled) el.scrollTop = top;
      // The restyle restarts CSS animations (the coach card's entrance): finish them again.
      for (const a of document.getAnimations()) {
        try {
          a.finish();
        } catch {
          // Endless.
        }
      }
    });
    await page.waitForTimeout(100);
    await page.screenshot({ path: join(shots, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** Focus is never left on the page after a step changes. */
async function focusKept(page: Page): Promise<string> {
  const where = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      return !el || el === document.body ? 'body' : `${el.tagName.toLowerCase()} ${el.textContent?.trim().slice(0, 40) ?? ''}`;
    });
  // Within a few frames of the change (the screen that took the control's place renders first), and still held a
  // moment later: focus on a control that is about to go would pass the first look and then drop to the page.
  await expect.poll(where, { timeout: 3000 }).not.toBe('body');
  await page.waitForTimeout(600);
  await expect.poll(where, { timeout: 3000 }).not.toBe('body');
  return where();
}

test.beforeAll(() => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
});
test.afterAll(async () => {
  await removeInboxScratch();
});

test('the paced newcomer walk: Two paths, the six steps, the aha under 2 minutes; shots and a video', async ({ browser }) => {
  const w = startWorld('walk');
  const errors: string[] = [];
  const videoDir = join(w.root, 'video');
  const { context, page } = await open(browser, w, errors, { recordVideo: { dir: videoDir, size: DESKTOP } });
  const before = await ownList(w);
  // The entry screen: two equal cards.
  await expect(page.getByRole('heading', { name: 'Two ways to start' })).toBeVisible();
  await expect(page.locator('.ib-te-card')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Start the tour' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect my agents' })).toBeVisible();
  await page.waitForTimeout(1200);
  await shoot(page, '00-entry');
  await page.waitForTimeout(Math.round((words(await page.locator('.ib-te-tour').innerText()) / 220) * 60_000) + 1500);

  const started = Date.now();
  const shotsBefore = shooting;
  const at: Record<string, number> = {};
  // Seconds from Start, the screenshots' time left out.
  const mark = (name: string) => (at[name] = Math.round((Date.now() - started - (shooting - shotsBefore)) / 100) / 10);
  await page.getByRole('button', { name: 'Start the tour' }).click();
  await expect(page).toHaveURL(/#tour=1$/);
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '1');
  expect(await focusKept(page)).toContain('An agent came back');
  expect(config(w).inboxTour.seen_at).toBeTruthy();
  await shoot(page, '01-step1-open');
  await read(page, true);

  // 1 → 2: open the question.
  await page.locator('[data-thread-id="tour-vscode"]').first().click();
  mark('open');
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '2');
  await expect(page.locator('[data-tour-message="ask"] [data-question-tile]')).toHaveCount(4);
  // Every picture says what it is: a mockup of VS Code, never the Inbox itself.
  await expect(page.locator('[data-tour-message="ask"] [data-question-picture-badge]')).toHaveText(['Mockup · VS Code', 'Mockup · VS Code', 'Mockup · VS Code']);
  await shoot(page, '02-step2-pictures');
  await read(page, true);
  // The closer look: the magnifier opens the viewer, which offers the pick; Escape closes it, focus back on the magnifier.
  await page.locator('[data-tour-message="ask"] [data-question-zoom]').first().click();
  await expect(page.locator('[data-tour-viewer]')).toBeVisible();
  await expect(page.locator('[data-tour-viewer] img')).toHaveAttribute('src', /vs-a\.webp$/);
  await shoot(page, '02-step2-closer-look');
  await page.waitForTimeout(3000);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-tour-viewer]')).toHaveCount(0);
  await expect(page.locator('[data-tour-message="ask"] [data-question-zoom]').first()).toBeFocused();
  await page.waitForTimeout(1500);

  // 2 → 3: pick the picture.
  await page.locator('[data-tour-message="ask"] [data-question-tile] label').first().click();
  mark('pick');
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '3');
  await expect(page.locator('[data-tour-send]')).toBeVisible();
  await shoot(page, '03-step3-send');
  await read(page, true);

  // 3 → 4: Send (a replay: nothing reaches any agent), then the replay arrives.
  await page.locator('[data-tour-send]').click();
  mark('send');
  await expect(page.locator('[data-tour-delivered]')).toContainText('Sending to Claude Code');
  await expect(page.locator('[data-tour-delivered]')).toContainText('Delivered to Claude Code', { timeout: 5000 });
  await shoot(page, '04-step4-delivered');
  await expect(page.locator('[data-tour-arrival="1"]')).toBeVisible({ timeout: 6000 });
  mark('aha');
  await expect(page.locator('[data-tour-arrival="1"]')).toContainText('A it is');
  await expect(page.locator('[data-tour-arrival="2"]')).toBeVisible({ timeout: 6000 });
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '4-works');
  // The real answer was picked: no note.
  await expect(page.locator('[data-tour-differs]')).toHaveCount(0);
  await shoot(page, '04-step4-keeps-working');
  await read(page, true);
  await page.locator('[data-tour-next]').click();

  // 5: the mock behind the pictures, live and sandboxed.
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '5');
  await shoot(page, '05-step5-mock-tile');
  await read(page, true);
  await page.locator('[data-tour-mock-tile]').click();
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '5-mock');
  const frame = page.locator('[data-tour-file] iframe');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(page.frameLocator('[data-tour-file] iframe').getByRole('tab').first()).toBeVisible();
  await shoot(page, '05-step5-mock-open');
  await page.frameLocator('[data-tour-file] iframe').getByRole('tab').nth(1).click();
  await page.waitForTimeout(5000);
  await read(page, true);
  await page.locator('[data-tour-next]').click();
  mark('steps1to5');

  // 6: the person's own Inbox, real.
  await expect(page).toHaveURL(/#tour=6$/);
  await expect(page.getByRole('heading', { name: 'Now, let’s connect your agents' })).toBeFocused();
  await expect(page.locator('[data-tour-bar]')).toContainText('Your own Inbox');
  await expect(page.locator('[data-tour-exit="finish"]')).toHaveText('Finish the tour');
  await expect(page.locator('.ib-cn')).toBeVisible();
  await expect(page.locator('[data-first-run-ask] [data-notification-ask], .ib-try [data-notification-ask]').first()).toBeVisible();
  await shoot(page, '06-step6-connect');
  // About 35 s to read step 6's screen (the brief's estimate), then Finish.
  await page.waitForTimeout(35_000);
  await page.locator('[data-tour-exit="finish"]').click();
  mark('finish');
  await expect(page).not.toHaveURL(/#tour/);
  await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
  await expect(page.locator('.ib-toast')).toContainText('Tour finished');
  // The entry screen does not come back; a quiet link to the tour stays.
  await expect(page.getByRole('heading', { name: 'No agent has written yet' })).toBeVisible();
  await expect(page.locator('[data-tour-again]')).toBeVisible();
  await focusKept(page);
  await shoot(page, '07-finished');
  expect(config(w).inboxTour.finished_at).toBeTruthy();
  // Nothing from the tour reached the person's store.
  expect(await ownList(w)).toBe(before);
  expect(errors).toEqual([]);

  // Timings, as the outside check reported them.
  console.log(`tour timings (s from Start): ${JSON.stringify(at)}`);
  expect(at.aha!).toBeLessThan(120);
  const video = page.video();
  await context.close();
  if (video) {
    mkdirSync(shots, { recursive: true });
    copyFileSync(await video.path(), join(shots, 'inbox-tour-walk.webm'));
  }
});

test('keyboard only: Tab and Enter through every step, focus never on the page', async ({ browser }) => {
  const w = startWorld('keys');
  const errors: string[] = [];
  const { context, page } = await open(browser, w, errors);
  await expect(page.getByRole('heading', { name: 'Two ways to start' })).toBeVisible();
  const tabTo = async (selector: string, max = 60) => {
    for (let i = 0; i < max; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate((s) => document.activeElement?.matches(s) ?? false, selector)) return;
    }
    throw new Error(`Tab never reached ${selector}`);
  };
  await tabTo('[data-tour-start]');
  await page.keyboard.press('Enter');
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '1');
  await focusKept(page);
  await tabTo('[data-thread-id="tour-vscode"]');
  await page.keyboard.press('Enter');
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '2');
  await focusKept(page);
  // The zoom by keyboard, Escape back to it.
  await tabTo('[data-tour-message="ask"] [data-question-zoom]');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-tour-viewer-close]')).toBeFocused();
  // Pick from the viewer: focus goes to Send.
  await tabTo('[data-tour-viewer-pick]', 4);
  await page.keyboard.press('Enter');
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '3');
  await expect(page.locator('[data-tour-send]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '4-works', { timeout: 10_000 });
  await focusKept(page);
  await tabTo('[data-tour-next]');
  await page.keyboard.press('Enter');
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '5');
  await focusKept(page);
  await tabTo('[data-tour-mock-tile]');
  await page.keyboard.press('Enter');
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '5-mock');
  await focusKept(page);
  await tabTo('[data-tour-back]');
  await page.keyboard.press('Enter');
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '4-works');
  await focusKept(page);
  await tabTo('[data-tour-next]');
  await page.keyboard.press('Enter');
  await tabTo('[data-tour-mock-tile]');
  await page.keyboard.press('Enter');
  await tabTo('[data-tour-next]');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Now, let’s connect your agents' })).toBeFocused();
  await tabTo('[data-tour-exit="finish"]', 120);
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
  await focusKept(page);
  expect(errors).toEqual([]);
  await context.close();
});

test('an iPhone in WebKit: taps, 44 px targets, the sheet never over what it asks for; light and dark shots', async () => {
  const w = startWorld('phone');
  const errors: string[] = [];
  const browser = await webkit.launch({ args: [] });
  try {
    const { context, page } = await open(browser, w, errors, { ...devices['iPhone 15'], colorScheme: 'light' });
    await expect(page.getByRole('heading', { name: 'Two ways to start' })).toBeVisible();
    await shoot(page, 'phone-00-entry');
    const box = async (selector: string) => {
      const b = await page.locator(selector).first().boundingBox();
      expect(b, selector).not.toBeNull();
      return b!;
    };
    // The hit area: the box, and the ::before / ::after a small control reaches out with.
    const big = async (selector: string) => {
      const hit = await page.locator(selector).first().evaluate((el) => {
        const r = el.getBoundingClientRect();
        let w = r.width;
        let h = r.height;
        for (const pseudo of ['::before', '::after']) {
          const s = getComputedStyle(el, pseudo);
          if (s.content === 'none' || s.position !== 'absolute') continue;
          w = Math.max(w, r.width - parseFloat(s.left) - parseFloat(s.right));
          h = Math.max(h, r.height - parseFloat(s.top) - parseFloat(s.bottom));
        }
        return { w, h };
      });
      expect(hit.h, selector).toBeGreaterThanOrEqual(44);
      expect(hit.w, selector).toBeGreaterThanOrEqual(44);
    };
    const clear = async (target: string) => {
      // The sheet and its target do not overlap once the card has settled.
      await page.waitForTimeout(900);
      const c = await box('[data-tour-coach]');
      const t = await box(target);
      const visibleTop = Math.max(t.y, 0);
      expect(c.y + c.height <= visibleTop + 1 || c.y >= visibleTop + Math.min(t.height, 44) - 1, `${target} under the sheet`).toBe(true);
    };
    await page.locator('[data-tour-start]').tap();
    await big('[data-tour-exit]');
    await clear('[data-thread-id="tour-vscode"]');
    await shoot(page, 'phone-01-step1');
    await page.locator('[data-thread-id="tour-vscode"]').first().tap();
    await expect(coach(page)).toHaveAttribute('data-tour-coach', '2');
    await clear('[data-tour-message="ask"] [data-question-tiles]');
    await expect(page.locator('[data-tour-message="ask"] [data-question-picture-badge]').first()).toHaveText('Mockup');
    await big('[data-tour-message="ask"] [data-question-zoom]');
    await shoot(page, 'phone-02-step2');
    await page.locator('[data-tour-message="ask"] [data-question-tile] label').nth(1).tap();
    await expect(coach(page)).toHaveAttribute('data-tour-coach', '3');
    await big('[data-tour-back]');
    await clear('[data-tour-send]');
    await shoot(page, 'phone-03-step3');
    await page.locator('[data-tour-send]').tap();
    await expect(coach(page)).toHaveAttribute('data-tour-coach', '4-works', { timeout: 10_000 });
    // B was picked: the replay says the real answer was A.
    await expect(page.locator('[data-tour-differs]')).toContainText('In the real thread the answer was A');
    await big('[data-tour-next]');
    await shoot(page, 'phone-04-step4');
    await page.locator('[data-tour-next]').tap();
    await clear('[data-tour-mock-tile]');
    await shoot(page, 'phone-05-step5');
    await page.locator('[data-tour-mock-tile]').tap();
    await expect(page.locator('[data-tour-file]')).toBeVisible();
    await big('[data-tour-file-back]');
    await shoot(page, 'phone-05-step5-mock');
    await page.locator('[data-tour-next]').tap();
    await expect(page.getByRole('heading', { name: 'Now, let’s connect your agents' })).toBeVisible();
    await shoot(page, 'phone-06-step6');
    await page.locator('[data-tour-exit]').tap();
    await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
    // No sideways scroll anywhere on the way.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await browser.close();
  }
});

test('reduced motion: every state, no pulse, a shorter replay; a stacked window: the thread covers the list', async ({ browser }) => {
  const w = startWorld('reduced');
  const errors: string[] = [];
  const { context, page } = await open(browser, w, errors, { reducedMotion: 'reduce', viewport: { width: 900, height: 800 } });
  await page.getByRole('button', { name: 'Start the tour' }).click();
  await expect(page.locator('.ib-tour-target')).toHaveCount(1);
  expect(await page.locator('.ib-tour-target').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  await page.locator('[data-thread-id="tour-vscode"]').first().click();
  // Stacked: the thread covers the list, its way back leads.
  await expect(page.locator('.ib-listcol')).toHaveCount(0);
  await expect(page.locator('[data-tour-thread-back]')).toBeVisible();
  await page.locator('[data-tour-message="ask"] [data-question-tile] label').first().click();
  const sent = Date.now();
  await page.locator('[data-tour-send]').click();
  await expect(page.locator('[data-tour-arrival="2"]')).toBeVisible();
  expect(Date.now() - sent).toBeLessThan(5600);
  await page.locator('[data-tour-next]').click();
  await page.locator('[data-tour-mock-tile]').click();
  // Stacked: the mock covers the thread.
  await expect(page.locator('[data-tour-thread]')).toHaveCount(0);
  await shoot(page, 'stacked-05-mock', ['light']);
  await page.locator('[data-tour-file-back]').click();
  await expect(page.locator('[data-tour-thread]')).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

test('Exit at every step gives the person’s Inbox back exactly as it was; a real message mid-tour is a chip, never a notification', async ({ browser }) => {
  const w = startWorld('exit');
  // A returning person: one real thread, waiting on them.
  const threadId = await agentWrites(w, 'Which retry policy for the export job?\n\n:::question\nWhich retry policy?\n- [ ] Exponential\n- [ ] Fixed\n:::', 'Export job retries');
  const errors: string[] = [];
  const { context, page } = await open(browser, w, errors);
  await expect(page.locator(`[data-thread-id="${threadId}"]`).first()).toBeVisible();
  const before = await ownList(w);
  // Returning people take the tour from Settings → General.
  const enter = async () => {
    await page.goto(`${w.url}#settings/general`);
    await page.locator('[data-settings-take-tour]').click();
    await expect(page).toHaveURL(/#tour=1$/);
  };
  const walkTo = async (n: number) => {
    if (n >= 2) await page.locator('[data-thread-id="tour-vscode"]').first().click();
    if (n >= 3) await page.locator('[data-tour-message="ask"] [data-question-tile] label').nth(2).click();
    if (n >= 4) await page.locator('[data-tour-send]').click();
    if (n >= 5) {
      await expect(page.locator('[data-tour-next]')).toBeVisible({ timeout: 10_000 });
      await page.locator('[data-tour-next]').click();
    }
    await expect(step(page)).toHaveAttribute('aria-label', `Step ${n} of 6`);
  };
  for (const n of [1, 2, 3, 4, 5]) {
    await enter();
    await walkTo(n);
    await page.locator('[data-tour-exit="exit"]').click();
    await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
    // Started in Settings: Exit returns to Settings, as the browser's Back (no new entry).
    await expect(page).toHaveURL(/#settings\/general$/);
    await expect(page.locator('[data-settings-take-tour]')).toBeVisible();
    await focusKept(page);
    expect(await ownList(w), `after Exit at step ${n}`).toBe(before);
  }
  const skipped = config(w).inboxTour.skipped_at;
  expect(skipped).toBeTruthy();
  // Back after Exit goes to the screen before Settings, never into the tour again, and records no second skip.
  await page.goBack();
  await expect(page).not.toHaveURL(/#tour/);
  await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(config(w).inboxTour.skipped_at).toBe(skipped);
  await page.goto(w.url);
  await expect(page.locator(`[data-thread-id="${threadId}"]`).first()).toBeVisible();
  // The side thread's pictures are screenshots of the Inbox, and say so.
  await enter();
  await page.locator('[data-thread-id="tour-graphite"]').first().click();
  await expect(page.locator('[data-tour-thread] [data-question-picture-badge]').first()).toHaveText('Screenshot · Inbox');
  await page.locator('[data-tour-exit="exit"]').click();
  await expect(page.locator('[data-tour-bar]')).toHaveCount(0);

  // A real message lands mid-tour: a chip in the bar, the tour goes on, no notification and no sound.
  await enter();
  await page.locator('[data-thread-id="tour-vscode"]').first().click();
  const arrived = await agentWrites(w, 'Build finished: the export job retries now.', 'Export job: build finished');
  await expect(page.locator('[data-tour-arrivals]')).toHaveText('1 new message in your Inbox', { timeout: 10_000 });
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '2');
  expect(await page.evaluate(() => (window as unknown as { __calls: string[] }).__calls)).toEqual([]);
  await shoot(page, 'chip-mid-tour', ['light']);
  await page.locator('[data-tour-arrivals]').click();
  await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`thread=${arrived}`));
  expect(errors).toEqual([]);
  await context.close();
});

test('leaving by the chip or the tour sidebar’s Settings: Back never reopens the tour; a tour reached by a link forgets an earlier start point', async ({ browser }) => {
  const w = startWorld('leave');
  const first = await agentWrites(w, 'A first real message.', 'First one');
  const errors: string[] = [];
  const { context, page } = await open(browser, w, errors);
  const fromSettings = async () => {
    await page.goto(`${w.url}#settings/general`);
    await page.locator('[data-settings-take-tour]').click();
    await expect(page).toHaveURL(/#tour=1$/);
  };
  const neverTheTour = async () => {
    await page.goBack();
    await page.waitForTimeout(400);
    await expect(page).not.toHaveURL(/#tour/);
    await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
  };

  // The chip: the new thread takes the tour's entry; Back goes to Settings, where the tour started.
  await fromSettings();
  const arrived = await agentWrites(w, 'Build finished.', 'Build finished');
  await page.locator('[data-tour-arrivals]').click();
  await expect(page).toHaveURL(new RegExp(`thread=${arrived}`));
  await neverTheTour();

  // The tour sidebar's Settings: the same.
  await fromSettings();
  await page.locator('.ib-setrow .ib-nav').click();
  await expect(page).toHaveURL(/#settings$/);
  await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
  await neverTheTour();

  // A tour reached by a link after one started from Settings: Exit goes to the Inbox, not to that old start point.
  await fromSettings();
  await page.locator('[data-tour-exit="exit"]').click();
  await expect(page).toHaveURL(/#settings\/general$/);
  await page.goto(`${w.url}#tour=2`);
  await expect(page.locator('[data-tour-coach]')).toHaveAttribute('data-tour-coach', '2');
  await page.locator('[data-tour-exit="exit"]').click();
  await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
  await expect(page).not.toHaveURL(/#settings/);
  // The person's own Inbox list (a thread that arrived during the tour may wait behind "N new").
  await expect(page.locator(`[data-thread-id="${first}"]`).first()).toBeVisible();
  await focusKept(page);
  expect(errors).toEqual([]);
  await context.close();
});

test('step 6 and after a reload: every way out leaves the tour behind; from step 6 it counts as finished, How to allow opens Settings → General', async ({ browser }) => {
  const w = startWorld('step6');
  const first = await agentWrites(w, 'A first real message.', 'First one');
  const errors: string[] = [];
  // The browser blocked notifications for this address: step 6 offers How to allow.
  const { context, page } = await open(browser, w, errors);
  await context.addInitScript(() => {
    if (window.Notification) Object.defineProperty(window.Notification, 'permission', { get: () => 'denied' });
  });
  await page.reload();
  const fromSettings = async () => {
    await page.goto(`${w.url}#settings/general`);
    await page.locator('[data-settings-take-tour]').click();
    await expect(page).toHaveURL(/#tour=1$/);
  };
  const toStep6 = async () => {
    await page.locator('[data-thread-id="tour-vscode"]').first().click();
    await page.locator('[data-tour-message="ask"] [data-question-tile] label').nth(2).click();
    await page.locator('[data-tour-send]').click();
    await expect(page.locator('[data-tour-next]')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-tour-next]').click();
    await page.locator('[data-tour-mock-tile]').click();
    await page.locator('[data-tour-next]').click();
    await expect(step(page)).toHaveAttribute('aria-label', 'Step 6 of 6');
  };
  const neverTheTour = async () => {
    await page.goBack();
    await page.waitForTimeout(400);
    await expect(page).not.toHaveURL(/#tour/);
    await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
  };
  const finishedAt = () => config(w).inboxTour?.finished_at ?? null;

  // How to allow: Settings → General, recorded as finished; Back never reopens the tour.
  await fromSettings();
  await toStep6();
  const before = finishedAt();
  await page.getByRole('button', { name: 'How to allow' }).click();
  await expect(page).toHaveURL(/#settings\/general$/);
  await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
  await expect.poll(finishedAt).not.toBe(before);
  await focusKept(page);
  await neverTheTour();

  // Step 6's real sidebar: its Inbox row and its Settings row end the tour (finished) in the tour's own entry.
  for (const row of ['[data-inbox-nav]', '.ib-setrow .ib-nav']) {
    await fromSettings();
    await toStep6();
    const was = finishedAt();
    await page.locator(row).first().click();
    await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
    await expect(page).not.toHaveURL(/#tour/);
    await expect.poll(finishedAt).not.toBe(was);
    await neverTheTour();
  }

  // A reload forgets where the tour started: Exit goes to the Inbox, in the tour's own entry.
  await fromSettings();
  await page.locator('[data-thread-id="tour-vscode"]').first().click();
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '2');
  await page.reload();
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '2');
  await page.locator('[data-tour-exit="exit"]').click();
  await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
  await expect(page.locator(`[data-thread-id="${first}"]`).first()).toBeVisible();
  await focusKept(page);
  await neverTheTour();
  expect(errors).toEqual([]);
  await context.close();
});

test('the fixture routes: read only, embedded in the binary, the mock sandboxed, nothing outside the manifest', async () => {
  const w = startWorld('routes');
  const fixture = await fetch(new URL('api/inbox/tour/fixture.json', w.url));
  expect(fixture.status).toBe(200);
  expect(((await fixture.json()) as { v: number }).v).toBe(1);
  const mock = await fetch(new URL('api/inbox/tour/assets/vscode-mockups.html', w.url));
  expect(mock.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
  expect(mock.headers.get('content-security-policy')).not.toContain('allow-same-origin');
  expect(mock.headers.get('x-content-type-options')).toBe('nosniff');
  const picture = await fetch(new URL('api/inbox/tour/assets/vs-a.webp', w.url));
  expect(picture.headers.get('content-type')).toBe('image/webp');
  expect((await picture.arrayBuffer()).byteLength).toBeGreaterThan(10_000);
  const etag = picture.headers.get('etag')!;
  expect((await fetch(new URL('api/inbox/tour/assets/vs-a.webp', w.url), { headers: { 'if-none-match': etag } })).status).toBe(304);
  for (const bad of ['api/inbox/tour/assets/..%2F..%2Fconfig.json', 'api/inbox/tour/assets/inbox.json', 'api/inbox/tour/other']) {
    expect((await fetch(new URL(bad, w.url))).status, bad).toBe(404);
  }
  expect((await fetch(new URL('api/inbox/tour/fixture.json', w.url), { method: 'POST' })).status).toBe(405);
  expect((await fetch(new URL('api/inbox/tour/fixture.json', w.url), { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
  // The window carries no tour content of its own: inbox.html holds no picture of it.
  const html = await (await fetch(w.url)).text();
  expect(html).not.toContain('Honestly I’m just struggling with this UX');
  // What the binary serves is the shipped content, byte for byte: the fixture, every picture and the mock.
  const content = join(repo, 'packages/inbox/tour/content');
  for (const name of readdirSync(content)) {
    const path = name === 'fixture.json' ? 'api/inbox/tour/fixture.json' : `api/inbox/tour/assets/${name}`;
    const served = Buffer.from(await (await fetch(new URL(path, w.url))).arrayBuffer());
    expect(served.equals(readFileSync(join(content, name))), name).toBe(true);
  }
});

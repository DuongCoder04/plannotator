/**
 * The VS Code Guides answer tab shows the agent's answer page as the agent
 * wrote it, scripts included (owner's decision, 2026-10-23), in a sandboxed
 * frame (apps/vscode-extension/src/guides/webview/answer-frame.ts). This
 * proof runs that module, bundled as the extension bundles its webview, in
 * real Chromium under the answer tab's own CSP (webview-csp.ts): the page's
 * scripts run; they cannot reach the tab, the network or the top window; its
 * guide links reach the tab as messages. No binary or VS Code is needed.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { webviewCsp } from '../../apps/vscode-extension/src/guides/webview-csp';

const EXTENSION = resolve(__dirname, '../../apps/vscode-extension');
const WEBVIEW = join(EXTENSION, 'src/guides/webview');
let bundle = '';
let work = '';

test.beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'pn-guides-answer-'));
  const entry = join(work, 'entry.ts');
  writeFileSync(entry, `
import { answerFrame } from ${JSON.stringify(join(WEBVIEW, 'answer-frame.ts'))};
(window as any).__got = [];
(window as any).__answer = {
  mount(html: string) {
    const frame = answerFrame(html, {
      link: (link) => (window as any).__got.push({ link }),
      external: (url) => (window as any).__got.push({ url }),
    });
    document.getElementById('host')!.replaceChildren(frame);
  },
};
`);
  const out = join(work, 'bundle.js');
  const build = join(work, 'build.ts');
  writeFileSync(build, `
import { build } from ${JSON.stringify(join(EXTENSION, 'node_modules/esbuild/lib/main.js'))};
import { configs } from ${JSON.stringify(join(EXTENSION, 'scripts/esbuild.config.ts'))};
const webview = configs.find((c) => String(c.outdir ?? '').endsWith('dist') && c.format === 'iife');
if (!webview) throw new Error('no webview build config');
const { entryPoints: _e, outdir: _o, ...options } = webview;
await build({ ...options, absWorkingDir: ${JSON.stringify(EXTENSION)}, entryPoints: [${JSON.stringify(entry)}], outfile: ${JSON.stringify(out)}, logLevel: 'silent' });
`);
  execFileSync('bun', [build], { cwd: EXTENSION, stdio: 'pipe' });
  bundle = readFileSync(out, 'utf8');
});

test.afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

async function open(page: Page, mode: 'answer' | 'guide' = 'answer') {
  const nonce = 'pn-test-nonce';
  const csp = webviewCsp("'self'", nonce, mode);
  await page.setContent(`<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="${csp}">
</head><body class="vscode-dark"><div id="host"></div>
<script nonce="${nonce}">window.acquireVsCodeApi = () => ({ postMessage() {} }); window.__secret = 'tab';</script>
<script nonce="${nonce}">${bundle.replace(/<\/script/gi, '<\\/script')}</script>
</body></html>`);
  await page.waitForFunction(() => !!(window as any).__answer, null, { timeout: 30_000 });
}

async function answerFrameOf(page: Page): Promise<Frame> {
  await page.waitForFunction(() => !!document.querySelector('iframe.pn-answer-frame')?.getAttribute('srcdoc'));
  const handle = await page.locator('iframe.pn-answer-frame').elementHandle();
  const frame = await handle!.contentFrame();
  await frame!.waitForLoadState();
  return frame!;
}

const PAGE = `
<p id="out">not run</p>
<p><a id="code" href="code:src/webhooks/deliver.ts#L25-L31">lines 25–31</a> · <a id="web" href="https://example.com/docs">docs</a> · <a id="js" href="javascript:document.title='pwned'">js</a></p>
<svg width="200" height="60"><g id="box" data-link="symbol:computeBackoff" tabindex="0"><rect width="120" height="40" fill="var(--card)" stroke="var(--accent)"/></g></svg>
<div style="height: 900px"></div>
<script>
  document.getElementById('out').textContent = 'ran';
  let parentDoc = 'reachable';
  try { void window.parent.document.body; } catch (e) { parentDoc = 'blocked'; }
  let api = 'reachable';
  try { window.parent.acquireVsCodeApi(); } catch (e) { api = 'blocked'; }
  document.body.dataset.parentDoc = parentDoc;
  document.body.dataset.api = api;
  fetch('https://example.com/x').then(() => { document.body.dataset.net = 'reached'; }, () => { document.body.dataset.net = 'blocked'; });
  try { window.top.location.href = 'https://example.com/hijack'; } catch (e) { document.body.dataset.top = 'blocked'; }
</script>`;

test("the agent's scripts run in the answer frame, and reach neither the tab nor the network", async ({ page }) => {
  await open(page);
  await page.evaluate((html) => (window as any).__answer.mount(html), PAGE);
  const frame = await answerFrameOf(page);
  await expect(frame.locator('#out')).toHaveText('ran');
  await expect(frame.locator('body')).toHaveAttribute('data-parent-doc', 'blocked');
  await expect(frame.locator('body')).toHaveAttribute('data-api', 'blocked');
  await expect(frame.locator('body')).toHaveAttribute('data-net', 'blocked');
  // The top window stays where it is.
  expect(page.url()).not.toContain('hijack');
  expect(await page.evaluate(() => (window as any).__secret)).toBe('tab');
  // The theme variables are there for the page to use.
  expect(await frame.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).not.toBe('');
});

test('guide links and web links reach the tab as messages; a javascript: link does nothing', async ({ page }) => {
  await open(page);
  await page.evaluate((html) => (window as any).__answer.mount(html), PAGE);
  const frame = await answerFrameOf(page);
  await frame.locator('#code').click();
  await frame.locator('#box rect').click();
  await frame.locator('#web').click();
  await frame.locator('#js').click();
  await expect.poll(() => page.evaluate(() => (window as any).__got)).toEqual([
    { link: 'code:src/webhooks/deliver.ts#L25-L31' },
    { link: 'symbol:computeBackoff' },
    { url: 'https://example.com/docs' },
  ]);
  expect(await frame.evaluate(() => document.title)).not.toBe('pwned');
});

test('the frame grows with its page', async ({ page }) => {
  await open(page);
  await page.evaluate((html) => (window as any).__answer.mount(html), PAGE);
  await answerFrameOf(page);
  await expect.poll(async () => parseInt(await page.locator('iframe.pn-answer-frame').evaluate((f) => (f as HTMLElement).style.height), 10)).toBeGreaterThan(950);
});

test("why the answer tab's policy differs: under the other tabs' nonce policy the page's scripts would not run", async ({ page }) => {
  await open(page, 'guide');
  await page.evaluate((html) => (window as any).__answer.mount(html), PAGE);
  const frame = await answerFrameOf(page);
  await page.waitForTimeout(500);
  await expect(frame.locator('#out')).toHaveText('not run');
});

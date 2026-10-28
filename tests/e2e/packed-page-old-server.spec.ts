/**
 * A Pi or Oh My Pi session that was running when Plannotator was updated in
 * place can read the new packed plannotator.html / review-editor.html from
 * disk (it reads each on first use) and serve it with its old server, which
 * knows no pack: it answers every non-API path with the whole file as HTML.
 * The page must then say what happened instead of rendering the pack (25 MB
 * of index, code and base64 as text) or a blank page.
 *
 * Proved against the built apps (apps/hook/dist: run
 * `bun run --cwd apps/review build && bun run build:hook` first), in headless
 * Chromium:
 *  - served the old way, the message shows, and none of the pack renders;
 *  - served by a current server, the app loads and no message shows;
 *  - a failed lazy chunk shows the message only when the server no longer
 *    serves the page's entry as JavaScript (a server of another version).
 */

import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { UPDATED_WHILE_OPEN_MESSAGE } from '../../build/pack-app';
import { openPackedApp } from '../../packages/shared/packed-app';

const repo = resolve(__dirname, '../..');
const builds = ['index.html', 'review.html'].map((name) => join(repo, 'apps/hook/dist', name));

type Handler = (path: string, method: string) => { status: number; headers: Record<string, string>; body: string | Buffer } | Promise<{ status: number; headers: Record<string, string>; body: string | Buffer }>;

async function serve(handle: { current: Handler }): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const answer = await handle.current(path, req.method ?? 'GET');
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

/** The Pi server before the pack (apps/pi-extension/server/helpers.ts `html`): the file as-is for every non-API path. */
const oldServer = (bundle: string): Handler => (path) =>
  path.startsWith('/api/')
    ? { status: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Not found', path }) }
    : { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: bundle };

const currentServer = (bundle: string): Handler => {
  const app = openPackedApp(bundle);
  return (path, method) =>
    path.startsWith('/api/')
      ? { status: 404, headers: { 'Content-Type': 'application/json' }, body: '{}' }
      : app.answer(path, method, null, false);
};

for (const file of builds) {
  const name = file.split('/').pop();

  test(`${name} served whole by an old server says it was updated, and renders none of the pack`, async ({ page }) => {
    test.skip(!existsSync(file), 'build the apps first');
    const bundle = readFileSync(file, 'utf8');
    const { server, url } = await serve({ current: oldServer(bundle) });
    try {
      await page.goto(url);
      await expect(page.locator('#plannotator-updated')).toHaveText(UPDATED_WHILE_OPEN_MESSAGE);
      await expect(page.locator('#plannotator-updated')).toBeVisible();
      await expect(page.locator('plaintext')).toBeHidden();
      const text = await page.evaluate(() => document.body.innerText);
      expect(text.trim()).toBe(UPDATED_WHILE_OPEN_MESSAGE);
      expect(await page.locator('#root').innerHTML()).toBe('');
    } finally {
      server.close();
    }
  });

  test(`${name} served by a current server loads without the message; a lazy chunk failure shows it only once the entry is gone`, async ({ page }) => {
    test.skip(!existsSync(file), 'build the apps first');
    const bundle = readFileSync(file, 'utf8');
    const handle = { current: currentServer(bundle) };
    const { server, url } = await serve(handle);
    try {
      await page.goto(url);
      await expect(page.locator('#root > *').first()).toBeAttached();
      // The app's own handling owns a lazy failure while the entry still loads.
      await page.evaluate(() => dispatchEvent(new Event('vite:preloadError')));
      await page.waitForTimeout(500);
      await expect(page.locator('#plannotator-updated')).toHaveCount(0);
      // A server of another version: this page's chunks are gone.
      handle.current = () => ({ status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'Not found' });
      await page.evaluate(() => dispatchEvent(new Event('vite:preloadError')));
      await expect(page.locator('#plannotator-updated')).toHaveText(UPDATED_WHILE_OPEN_MESSAGE);
    } finally {
      server.close();
    }
  });
}

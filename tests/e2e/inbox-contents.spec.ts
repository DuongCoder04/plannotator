/**
 * An open plan in the real Inbox shows its Contents (the headings list plan
 * review shows): beside the thread at the top of the comments column, the
 * page keeping its width; in full screen as a rail on the left, the
 * Select / Markup toolstrip over the page and clear of the rail. A click on a
 * heading scrolls the document to it.
 */
import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { forgetFileViewChoice } from './file-view';

const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? '.local/plannotator');
const HEADINGS = ['Refund worker plan', 'Context', 'Design', 'Idempotency keys', 'Rollout', 'Risks'];
const plan = [
  '# Refund worker plan',
  'Move refunds to a background worker.',
  '## Context',
  ...Array.from({ length: 12 }, (_, i) => `Context paragraph ${i + 1}: refunds run inline in the admin request today.`),
  '## Design',
  ...Array.from({ length: 12 }, (_, i) => `Design paragraph ${i + 1}: a worker claims each job and calls Stripe.`),
  '### Idempotency keys',
  'One key per charge and request.',
  '## Rollout',
  ...Array.from({ length: 12 }, (_, i) => `Rollout paragraph ${i + 1}: a shadow week before the switch.`),
  '## Risks',
  // Enough below Rollout that a click can bring it to the top of the page.
  ...Array.from({ length: 30 }, (_, i) => `Risk paragraph ${i + 1}: Stripe rate limits and a slow dead-letter queue.`),
].join('\n\n');

async function contentsEntries(list: ReturnType<Page['locator']>): Promise<string[]> {
  return list.locator('nav[aria-label="Table of contents"] button').allTextContents();
}

for (const layout of ['side', 'full'] as const) {
  test(`${layout}: a plan attachment shows its Contents list, and a heading click scrolls to it`, async ({ browser }) => {
    const root = inboxScratch('plannotator-contents-');
    const home = join(root, 'home');
    mkdirSync(home);
    const env = {
      PATH: process.env.PATH ?? '', HOME: home, PLANNOTATOR_DATA_DIR: join(root, 'data'),
      PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER,
      PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_TAILSCALE: '0', PLANNOTATOR_INBOX_PHONES: '0',
      PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_NOTES: '0',
    };
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    let agent: SimAgent | undefined;
    try {
      const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
      expect(started.status, started.stderr).toBe(0);
      const url = started.stdout.trim();
      const project = scratchProject(join(root, 'src'), 'billing');
      writeFileSync(join(project, 'refund-plan.md'), plan);
      agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
      const sent = await agent.send({ project_path: project, subject: 'Refund worker plan', body: 'The plan is attached.', attachments: ['refund-plan.md'] });
      const model = await (await fetch(new URL(`/api/inbox/threads/${sent.thread_id}/attachments`, url))).json() as { attachments: { id: string }[] };
      const page = await context.newPage();
      await page.goto(`${url}#thread=${sent.thread_id}&file=${model.attachments[0]!.id}&view=${layout}`);
      const pane = page.locator('[data-attachment-pane]');
      const scroller = pane.locator('.ib-docscroll');
      await expect(pane.locator('#rollout')).toHaveCount(1);

      const list = pane.locator(layout === 'side' ? '.ib-apanel [data-contents="column"]' : '.ib-docarea > [data-contents="rail"]');
      await expect(list).toBeVisible();
      expect(await contentsEntries(list)).toEqual(HEADINGS);
      const listBox = (await list.boundingBox())!;
      const pageBox = (await scroller.boundingBox())!;
      if (layout === 'side') {
        // Above Annotations in the comments column: the page keeps the width it had without the list.
        await expect(pane.locator('.ib-apanel [data-annotation-panel]')).toBeVisible();
        expect(listBox.x).toBeGreaterThanOrEqual(pageBox.x + pageBox.width - 1);
        expect(pageBox.width).toBeGreaterThan(600);
      } else {
        // The rail on the left; the page and the toolstrip start right of it.
        expect(listBox.x).toBeLessThan(pageBox.x);
        expect(pageBox.x).toBeGreaterThanOrEqual(listBox.x + listBox.width - 1);
        const strip = (await pane.locator('.ib-toolstrip').boundingBox())!;
        expect(strip.x).toBeGreaterThanOrEqual(listBox.x + listBox.width);
      }

      await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
      await list.getByRole('button', { name: 'Rollout', exact: true }).click();
      await expect.poll(async () => {
        const heading = (await pane.locator('#rollout').boundingBox())!;
        return heading.y >= pageBox.y && heading.y < pageBox.y + pageBox.height / 2;
      }).toBe(true);
      // The heading read now is the one marked in the list, as in plan review.
      await expect(list.locator('button[aria-current="location"]')).toHaveText('Rollout');
      await forgetFileViewChoice(page);
    } finally {
      try {
        await agent?.close();
        await context.close();
      } finally {
        await removeInboxScratch(root);
      }
    }
  });
}

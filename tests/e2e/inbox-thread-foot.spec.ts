/**
 * The thread's foot with the reply box closed keeps ONE row where it can
 * (the owner on the stacked foot beside a file, 2026-10-25: "We can make the
 * text shorter before we start multi-lining buttons and stuff on top of each
 * other"). Before the draft status wraps above the buttons, the row shortens,
 * in this order: the skip chip ("1 open · Skip"), Edit draft ("Edit"), the open
 * questions button (its icon and the count), then the words after the Draft
 * pill. Only when even that does not fit does the status take its own line.
 *
 * A real Chromium against the compiled binary: picks, a comment on an attached
 * file and an open question, with and without the file beside the thread, at
 * 1440, 1280, 900, 810 (stacked) and 390 (a phone), and a thread with 12
 * questions left open. Screenshots in $PLANNOTATOR_THREAD_FOOT_SHOTS (default
 * .local/proof/thread-foot/). The first test only takes them, so it also runs
 * against an older binary for "before" pictures (`--grep pictures`).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_THREAD_FOOT_SHOTS ?? join(repo, '.local/proof/thread-foot'));

const question = (prompt: string, a: string, b: string) => [':::question', prompt, '', `- [ ] ${a}`, `- [ ] ${b}`, ':::'].join('\n');

const CHECKOUT = ['The checkout copy is in copy.md. Two calls before I ship it.', '', question('Ship the new checkout copy?', 'Yes', 'No, revise'), '', question('Keep the yearly price first?', 'Yes', 'No')].join('\n');

const MANY = [
  'The onboarding flow has a lot of open calls; take them as you can.',
  '',
  ...Array.from({ length: 13 }, (_, i) => question(`Onboarding call ${i + 1}: keep step ${i + 1}?`, 'Keep', 'Drop')).flatMap((q) => [q, '']),
].join('\n');

type Sent = { message_id: string; thread_id: string; questions: { key: string; prompt: string; kind: string }[]; attachments?: { id: string }[] };

interface World {
  url: string;
  context: BrowserContext;
  page: Page;
  agent: SimAgent;
  checkout: { thread: string; file: string };
  many: { thread: string; file: string };
}

let world: World;

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${world.url.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.status, await response.clone().text()).toBe(200);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-threadfoot-e2e-');
  const dataDir = join(root, 'data');
  const trap = join(root, 'bin');
  mkdirSync(trap);
  writeFileSync(join(trap, 'tailscale'), "#!/bin/sh\necho 'inbox-thread-foot.spec: tailscale must not run' >&2\nexit 97\n");
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = { PATH: `${trap}:${process.env.PATH ?? ''}`, HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const project = scratchProject(join(root, 'src'), 'acme-checkout');
  writeFileSync(join(project, 'copy.md'), '# Checkout copy\n\nPro plan, billed yearly.\n\nTaxes calculated at the next step.\n');
  const agent = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  world = { url, context, page, agent, checkout: { thread: '', file: '' }, many: { thread: '', file: '' } };
  const checkout = (await agent.send({ project_path: project, subject: 'Checkout redesign is running locally', thread: 'checkout', body: CHECKOUT, attachments: ['copy.md'] })) as Sent;
  const many = (await agent.send({ project_path: project, subject: 'Onboarding: thirteen calls', thread: 'onboarding', body: MANY, attachments: ['copy.md'] })) as Sent;
  await post(`/api/inbox/messages/${checkout.message_id}/picks`, {
    questions: [{ key: checkout.questions[0]!.key, revision: 0, answer: { v: 1, key: checkout.questions[0]!.key, kind: 'single', prompt: checkout.questions[0]!.prompt, selected: ['Yes'] } }],
  });
  await post(`/api/inbox/messages/${many.message_id}/picks`, {
    questions: [{ key: many.questions[0]!.key, revision: 0, answer: { v: 1, key: many.questions[0]!.key, kind: 'single', prompt: many.questions[0]!.prompt, selected: ['Keep'] } }],
  });
  for (const [sent, id] of [[checkout, 'ann-checkout'], [many, 'ann-many']] as const) {
    await post('/api/inbox/annotations', {
      attachment_id: sent.attachments![0]!.id,
      version: 'current',
      annotation: { id, type: 'COMMENT', text: 'Say "billed yearly" once.', originalText: 'Pro plan, billed yearly.', blockId: 'block-1', startOffset: 0, endOffset: 0, createdA: 1 },
    });
  }
  world.checkout = { thread: checkout.thread_id, file: checkout.attachments![0]!.id };
  world.many = { thread: many.thread_id, file: many.attachments![0]!.id };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

type Layout = { width: number; file: boolean; thread: 'checkout' | 'many' };

const LAYOUTS: Layout[] = [
  { width: 1440, file: false, thread: 'checkout' },
  { width: 1440, file: true, thread: 'checkout' },
  { width: 1280, file: false, thread: 'checkout' },
  { width: 1280, file: true, thread: 'checkout' },
  { width: 900, file: false, thread: 'checkout' },
  { width: 810, file: false, thread: 'checkout' },
  { width: 390, file: false, thread: 'checkout' },
  { width: 1440, file: true, thread: 'many' },
  { width: 1280, file: true, thread: 'many' },
  { width: 810, file: false, thread: 'many' },
];

const nameOf = (l: Layout) => `${l.thread}-${l.width}${l.file ? '-file' : ''}`;

/** Opens the thread (with its file beside it) at that width, and waits for the foot's draft status. */
async function open(l: Layout): Promise<void> {
  const { page } = world;
  const t = world[l.thread];
  await page.setViewportSize({ width: l.width, height: l.width < 500 ? 844 : 900 });
  await page.goto(`${world.url}#thread=${t.thread}${l.file ? `&file=${t.file}&view=side` : ''}`);
  await expect(page.locator('.ib-pfoot [data-foot-status] [data-draft-foot]')).toBeVisible();
  if (l.file) await expect(page.locator('.ib-view').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

/** The foot in one frame: every box of the row on one line, what the row shows, and the thread column's width. */
function measure(page: Page) {
  return page.evaluate(() => {
    const row = document.querySelector('.ib-pfoot [data-foot-row]')!;
    const parts = [...row.querySelectorAll<HTMLElement>('[data-foot-buttons] > *, [data-foot-status] > *')].filter((el) => el.getBoundingClientRect().width > 0);
    const mids = parts.map((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    const pane = document.querySelector('section.ib-pane')!.getBoundingClientRect();
    return {
      oneRow: mids.every((m) => Math.abs(m - mids[0]!) < 4),
      text: (row as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
      fit: row.getAttribute('data-fit'),
      pane: Math.round(pane.width),
      overflow: row.scrollWidth > row.clientWidth + 1,
    };
  });
}

test('pictures: the foot at every width and state', async () => {
  for (const l of LAYOUTS) {
    await open(l);
    await world.page.locator('.ib-pfoot').screenshot({ path: join(shotsDir, `foot-${nameOf(l)}.png`) });
    await world.page.screenshot({ path: join(shotsDir, `window-${nameOf(l)}.png`) });
    console.log(nameOf(l), JSON.stringify(await measure(world.page)));
  }
});

test('one row beside a file and in every wide layout; it shortens before it wraps', async () => {
  const { page } = world;
  for (const l of LAYOUTS.filter((x) => x.width >= 810)) {
    await open(l);
    const m = await measure(page);
    expect(m.oneRow, `${nameOf(l)}: ${m.text} (fit ${m.fit}, pane ${m.pane})`).toBe(true);
    expect(m.overflow, nameOf(l)).toBe(false);
  }
  // Beside a file at 1280 the long words give way: never "Edit draft" on two lines, never the status above Send.
  await open({ width: 1280, file: true, thread: 'checkout' });
  const beside = await measure(page);
  expect(beside.oneRow).toBe(true);
  // The accessible names keep the full words whatever is drawn.
  const foot = page.locator('.ib-pfoot [data-foot-buttons]');
  await expect(foot.getByRole('button', { name: 'Edit draft' })).toBeVisible();
  await expect(foot.locator('[data-open-questions]')).toHaveAccessibleName('2 open questions');
  await expect(page.locator('.ib-pfoot [data-skip-toggle]')).toHaveAccessibleName('Skip it');
  await expect(foot.locator('.ib-btn.ib-pri')).toHaveAccessibleDescription(/1 pick, 1 comment.*1 question stays open/);
});

test('a phone: the buttons stay on one line, the status beside them or on its own line above', async () => {
  const { page } = world;
  await open({ width: 390, file: false, thread: 'checkout' });
  const phone = await page.evaluate(() => {
    const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
    const [status, send, oq] = ['[data-foot-status]', '[data-foot-buttons] .ib-btn.ib-pri', '[data-foot-buttons] [data-open-questions]'].map((s) => r(`.ib-pfoot ${s}`));
    return { buttonsOneLine: Math.abs(oq!.top - send!.top) < 2, statusPlaced: status!.bottom <= send!.top + 1 || Math.abs(status!.top + status!.height / 2 - (send!.top + send!.height / 2)) < 4 };
  });
  expect(phone).toEqual({ buttonsOneLine: true, statusPlaced: true });
});

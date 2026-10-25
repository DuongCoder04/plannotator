/**
 * The onboarding tour in the window (approval "inbox-onboarding-tour"): the
 * whole window over a REAL Inbox in a temp data dir, one per test (its own
 * process, tests/helpers/inbox-dom-server.ts `first-run-tour`: no project yet, so
 * the window opens on the entry screen). The tour's fixture is the real one,
 * served by the real fixture route.
 *
 * - Two paths: the entry screen's two cards; Connect my agents opens the
 *   real first-run screen and is remembered (`tour.skipped_at`).
 * - The walk: open, pick a picture, Send (a replay that writes nothing to the
 *   person's store and calls no route that writes but the `tour` setting),
 *   the replay's messages, the mock, step 6, Finish.
 * - Exit at any step: back to the person's Inbox, the entry screen gone, a
 *   quiet "Take the tour" link.
 * - A real message mid-tour: a chip, no interruption.
 * - A pick other than the real answer: the honest note.
 * - Returning users: Settings → General → Take the tour.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

let child: ReturnType<typeof Bun.spawn> | null = null;
let childOut: ReadableStreamDefaultReader<Uint8Array> | null = null;
let port = 0;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedMatchMedia: typeof window.matchMedia;
let pushRecord: ((data: unknown) => void) | null = null;
let tailnetPage = false;
let savedNotification: unknown;
let savedHasFocus: typeof document.hasFocus;
/** The browser's answer for this origin, and every notification raised (its title). */
let permission: NotificationPermission = 'default';
const notices: string[] = [];
const posts: { path: string; body: Record<string, unknown> }[] = [];

function loopback(path: string, method = 'GET', body?: string): Promise<{ status: number; text: string; type: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), type: String(res.headers['content-type'] ?? 'application/json') }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

async function readLine(): Promise<string> {
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await childOut!.read();
    if (done) throw new Error('the Inbox stopped');
    line += new TextDecoder().decode(value);
  }
  return line.trim();
}

beforeEach(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-tour-dom-')));
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1', 'first-run-tour'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  childOut = (child.stdout as ReadableStream<Uint8Array>).getReader();
  port = (JSON.parse(await readLine()) as { port: number }).port;
  posts.length = 0;
  tailnetPage = false;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    let body = init?.body ? String(init.body) : undefined;
    if (body?.startsWith('{')) {
      const { serverSession: _session, ...rest } = JSON.parse(body) as Record<string, unknown>;
      body = JSON.stringify(rest);
    }
    if (method === 'POST') posts.push({ path, body: body ? (JSON.parse(body) as Record<string, unknown>) : {} });
    if (path.startsWith('/api/inbox/agents') && tailnetPage) return Response.json({ error: 'local only', code: 'local_only' }, { status: 403 });
    const answer = await loopback(path, method, body);
    if (method === 'GET' && path.startsWith('/api/inbox/settings') && answer.status === 200 && tailnetPage) {
      return Response.json({ ...(JSON.parse(answer.text) as Record<string, unknown>), via: 'tailnet' });
    }
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': answer.type } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
      if (type === 'record') pushRecord = (data) => listener({ data: JSON.stringify(data), lastEventId: '999' } as MessageEvent<string>);
    }
    close() {}
  };
  // Reduced motion: the replay runs in under 4 s.
  savedMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => {
    const real = savedMatchMedia.call(window, query);
    if (!query.includes('prefers-reduced-motion')) return real;
    return { ...real, matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} } as MediaQueryList;
  }) as typeof window.matchMedia;
  savedNotification = (window as unknown as Record<string, unknown>).Notification;
  permission = 'default';
  notices.length = 0;
  (window as unknown as Record<string, unknown>).Notification = class {
    static get permission() {
      return permission;
    }
    static async requestPermission() {
      return permission;
    }
    onclick: unknown = null;
    constructor(title: string) {
      notices.push(title);
    }
    close() {}
  };
  // The page is in front (visible, focused) unless a test says otherwise.
  savedHasFocus = document.hasFocus.bind(document);
  document.hasFocus = () => true;
  window.location.hash = '';
});

afterEach(async () => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  pushRecord = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  window.matchMedia = savedMatchMedia;
  (window as unknown as Record<string, unknown>).Notification = savedNotification;
  document.hasFocus = savedHasFocus;
  window.location.hash = '';
  childOut?.releaseLock();
  child?.kill();
  await child?.exited;
  child = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function until(check: () => boolean, what: string, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function renderApp(): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  return host;
}

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
}

const $ = (el: ParentNode, s: string) => el.querySelector<HTMLElement>(s);
const radios = (el: ParentNode) => el.querySelectorAll<HTMLInputElement>('[data-tour-message="ask"] input[type="radio"]');
const coachKey = (el: ParentNode) => $(el, '[data-tour-coach]')?.getAttribute('data-tour-coach') ?? null;
const config = () => JSON.parse(readFileSync(join(dir!, 'data', 'config.json'), 'utf8')) as Record<string, any>;
/** What the tour may write: the `tour` setting, and nothing else (no picks, reply, annotation or MCP route). */
const writes = () => posts.filter((p) => !(p.path === '/api/inbox/settings' && Object.keys(p.body).every((k) => k === 'tour')) && p.path !== '/api/inbox/window');

/** An agent's first message, written to the real store: its folder becomes the Inbox's first project. */
async function firstMessage(body: string, subject: string): Promise<string> {
  (child!.stdin as import('bun').FileSink).write(`${JSON.stringify({ first: { root: join(dir!, 'projects', 'billing'), session: 'ses_first', body, subject } })}\n`);
  (child!.stdin as import('bun').FileSink).flush();
  return (JSON.parse(await readLine()) as { sent: string }).sent;
}

/** What the event stream would say about that message's first line. */
function recordOf(id: string) {
  return { seq: 1, kind: 'message', id, first: true, message: { id, thread_id: id, project_id: 'p', reply_to: null, subject: null, body: '', created_at: new Date().toISOString(), resolved_at: null, idempotency_key: null, author: { kind: 'agent', host: 'claude-code', session: 'ses_first', name: null } } };
}

async function openOnEntry(): Promise<HTMLElement> {
  const el = await renderApp();
  await until(() => $(el, '[data-tour-entry]') !== null, 'the entry screen');
  return el;
}

/** Start the tour (the entry screen's button, else the first-run screen's quiet link) and walk to `step`. */
async function walkTo(el: HTMLElement, step: number) {
  await click($(el, '[data-tour-start]') ?? $(el, '[data-tour-again] button'));
  await until(() => coachKey(el) === '1', 'step 1');
  if (step === 1) return;
  await click($(el, '[data-thread-id="tour-vscode"]'));
  // happy-dom loads no picture, so the card draws its text rows (the e2e spec proves the tiles).
  await until(() => coachKey(el) === '2' && radios(el).length === 4, 'step 2 and its choices');
  if (step === 2) return;
  await click(radios(el)[0]);
  await until(() => coachKey(el) === '3', 'step 3');
  if (step === 3) return;
  await click($(el, '[data-tour-send]'));
  await until(() => coachKey(el) === '4-works', 'the replay', 160);
  if (step === 4) return;
  await click($(el, '[data-tour-next]'));
  await until(() => coachKey(el) === '5', 'step 5');
}

test.skipIf(!hasDom)('Two paths: two equal cards; Connect my agents opens the real first-run screen and is remembered', async () => {
  const el = await openOnEntry();
  expect(el.querySelectorAll('.ib-te-card')).toHaveLength(2);
  expect($(el, '[data-tour-start]')!.textContent).toContain('Start the tour');
  expect($(el, '[data-tour-connect]')!.textContent).toContain('Connect my agents');
  await click($(el, '[data-tour-connect]'));
  await until(() => $(el, '[data-inbox-empty]') !== null && $(el, '[data-tour-entry]') === null, 'the first-run screen');
  await until(() => !!config().inboxTour?.skipped_at, 'the skip remembered');
  // Once decided, the first-run screen keeps a quiet way to the tour.
  expect($(el, '[data-tour-again]')!.textContent).toContain('Take the 2-minute tour');
  // A new load opens on the first-run screen, never the entry screen again.
  act(() => root?.unmount());
  host?.remove();
  const again = await renderApp();
  await until(() => $(again, '[data-inbox-empty]') !== null, 'the first-run screen after a reload');
  expect($(again, '[data-tour-entry]')).toBeNull();
}, 90_000);

test.skipIf(!hasDom)('the walk: a replay that writes nothing but the tour setting, step 6 real, Finish', async () => {
  const el = await openOnEntry();
  await walkTo(el, 4);
  // The replay: the person's reply, delivered, then the two messages the real thread got next.
  expect($(el, '[data-tour-delivered]')!.textContent).toContain('Delivered to Claude Code');
  expect($(el, '[data-tour-arrival="1"]')!.textContent).toContain('A it is');
  expect($(el, '[data-tour-arrival="2"]')!.textContent).toContain('PR #2134');
  expect(el.querySelectorAll('.ib-tour-realtime').length).toBeGreaterThanOrEqual(3);
  expect($(el, '[data-tour-differs]')).toBeNull();
  // The card now reads as sent, locked.
  expect($(el, '[data-tour-message="ask"] .ib-qfoot-st')!.textContent).toContain('Sent');
  expect(window.location.hash).toBe('#tour=4');
  await click($(el, '[data-tour-next]'));
  await until(() => coachKey(el) === '5', 'step 5');
  await click($(el, '[data-tour-mock-tile]'));
  await until(() => coachKey(el) === '5-mock', 'the mock open');
  const frame = $(el, '[data-tour-file] iframe') as HTMLIFrameElement;
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  expect(frame.getAttribute('src')).toBe('/api/inbox/tour/assets/vscode-mockups.html');
  await click($(el, '[data-tour-next]'));
  await until(() => window.location.hash === '#tour=6', 'step 6');
  await until(() => $(el, '.ib-empty h2')?.textContent === 'Now, let’s connect your agents', 'step 6’s screen');
  expect($(el, '[data-tour-bar]')!.textContent).toContain('Your own Inbox');
  expect($(el, '.ib-tour-lead')!.textContent).toContain('Nothing from the tour was kept');
  // Nothing of the tour reached a route that writes.
  expect(writes()).toEqual([]);
  await click($(el, '[data-tour-exit="finish"]'));
  await until(() => $(el, '[data-tour-bar]') === null, 'the tour ended');
  await until(() => !!config().inboxTour?.finished_at, 'finished remembered');
  // Finished without notifications on: the first real thread asks once more.
  expect(config().inboxTour.notify_again).toBe(true);
  expect($(el, '[data-tour-again]')).not.toBeNull();
  const list = JSON.parse((await loopback('/api/inbox/threads')).text) as { sections: { threads: unknown[] }[] };
  expect(list.sections.flatMap((s) => s.threads)).toEqual([]);
}, 90_000);

test.skipIf(!hasDom)('Exit at any step gives the Inbox back; a pick other than the real answer is replayed with a note', async () => {
  const el = await openOnEntry();
  for (const step of [1, 2, 3, 4, 5]) {
    await walkTo(el, step);
    await click($(el, '[data-tour-exit="exit"]'));
    await until(() => $(el, '[data-tour-bar]') === null && $(el, '[data-inbox-empty]') !== null, `the Inbox after Exit at step ${step}`);
    expect(window.location.hash).toBe('');
    // The entry screen is gone for good; the quiet link starts the tour again.
    expect($(el, '[data-tour-entry]')).toBeNull();
    expect($(el, '[data-tour-again] button')).not.toBeNull();
  }
  expect(config().inboxTour.skipped_at).toBeTruthy();
  // B, not the real answer: the replay says so.
  await click($(el, '[data-tour-again] button'));
  await until(() => coachKey(el) === '1', 'step 1');
  await click($(el, '[data-thread-id="tour-vscode"]'));
  await until(() => radios(el).length === 4, 'the choices');
  await click(radios(el)[1]);
  await until(() => coachKey(el) === '3', 'step 3');
  await click($(el, '[data-tour-send]'));
  await until(() => $(el, '[data-tour-differs]') !== null, 'the note', 160);
  expect($(el, '[data-tour-differs]')!.textContent).toBe('You picked B · Our reader beside a live native diff. In the real thread the answer was A, so this is what Claude Code built.');
}, 90_000);

test.skipIf(!hasDom)('a real message mid-tour is a chip in the bar; the tour goes on; the chip leaves the tour to it', async () => {
  const el = await openOnEntry();
  await walkTo(el, 2);
  await act(async () =>
    pushRecord!({
      seq: 999,
      kind: 'message',
      id: 'msg_01REALMESSAGE000000000000',
      first: true,
      message: { id: 'msg_01REALMESSAGE000000000000', thread_id: 'msg_01REALMESSAGE000000000000', author: { kind: 'agent', host: 'claude-code', session: 'ses_x', name: null } },
    }),
  );
  await until(() => $(el, '[data-tour-arrivals]') !== null, 'the chip');
  expect($(el, '[data-tour-arrivals]')!.textContent).toBe('1 new message in your Inbox');
  expect(coachKey(el)).toBe('2');
  await click($(el, '[data-tour-arrivals]'));
  await until(() => $(el, '[data-tour-bar]') === null, 'out of the tour');
  expect(window.location.hash).toContain('thread=msg_01REALMESSAGE000000000000');
}, 90_000);

test.skipIf(!hasDom)('returning users: Settings → General → Take the tour; over the tailnet step 6 says where to connect', async () => {
  tailnetPage = true;
  const el = await openOnEntry();
  await act(async () => {
    window.location.hash = '#settings/general';
  });
  await until(() => $(el, '[data-settings-take-tour]') !== null, 'Getting started');
  expect($(el, '[data-settings-tour]')!.textContent).toContain('See how the Inbox works through real threads from building Plannotator');
  await click($(el, '[data-settings-take-tour]'));
  await until(() => coachKey(el) === '1', 'the tour');
  // Steps 1 to 5 play in full over the tailnet; step 6 cannot read the agents there.
  await act(async () => {
    window.location.hash = '#tour=6';
  });
  await until(() => $(el, '.ib-empty h2')?.textContent === 'Now, let’s connect your agents', 'step 6');
  await until(() => (el.textContent ?? '').includes('Open the Inbox on the computer to connect agents with one click.'), 'the tailnet line');
}, 90_000);

test.skipIf(!hasDom)('notifications: quiet over the replay in front (the chip says it), as always on step 6 and in the background', async () => {
  permission = 'granted';
  const el = await openOnEntry();
  // Steps 1 to 5 in front: the chip, no notification.
  await walkTo(el, 2);
  const first = await firstMessage('A first real question.', 'Real one');
  await act(async () => pushRecord!(recordOf(first)));
  await until(() => $(el, '[data-tour-arrivals]') !== null, 'the chip');
  await wait(600);
  expect(notices).toEqual([]);
  // The tab in the background: what arrives notifies as always, even over the replay.
  document.hasFocus = () => false;
  const second = await firstMessage('Another real one.', 'Background one');
  await act(async () => pushRecord!(recordOf(second)));
  await until(() => notices.length === 1, 'the background notification');
  document.hasFocus = () => true;
  // Step 6 (where the person gets their first question): notifications as always, in front too.
  await act(async () => {
    window.location.hash = '#tour=6';
  });
  await until(() => $(el, '.ib-empty h2')?.textContent === 'Now, let’s connect your agents', 'step 6');
  const third = await firstMessage('The question you asked for.', 'Step six one');
  await act(async () => pushRecord!(recordOf(third)));
  await until(() => notices.length === 2, 'the step 6 notification');
  // Step 6 carries the brief's prompt: one real question, with pictures.
  expect($(el, '.ib-try-quote')!.textContent).toContain('Send me one real question in my Plannotator Inbox');
}, 90_000);

test.skipIf(!hasDom)('the first real thread asks once more, inline, in a real thread’s words; never when off or dismissed', async () => {
  const threadId = await firstMessage(':::question\nWhich retry policy?\n- [ ] Exponential\n- [ ] Fixed\n:::', 'Export job retries');
  const notifyAgain = () => loopback('/api/inbox/settings', 'POST', JSON.stringify({ tour: { notify_again: true } }));
  await notifyAgain();
  const el = await renderApp();
  await until(() => $(el, `[data-thread-id="${threadId}"]`) !== null, 'the list');
  await act(async () => {
    window.location.hash = `#thread=${threadId}`;
  });
  await until(() => $(el, '[data-tour-notify-again]') !== null, 'the inline ask');
  const ask = $(el, '[data-tour-notify-again]')!;
  expect(ask.textContent).toContain('Get a desktop notice when an agent needs you.');
  expect(ask.textContent).not.toContain('first question');
  // One ask on screen: the list's line stands down while it shows.
  expect(el.querySelectorAll('[data-notification-ask]')).toHaveLength(1);
  // Shown once: leaving the thread ends it.
  await act(async () => {
    window.location.hash = '';
  });
  await until(() => config().inboxTour?.notify_again === false, 'notify_again cleared');
  await act(async () => {
    window.location.hash = `#thread=${threadId}`;
  });
  await wait(600);
  expect($(el, '[data-tour-notify-again]')).toBeNull();
  // Off, or dismissed: never, as for the ask above the list.
  for (const change of [{ enabled: false }, { enabled: true, dismissed: true }]) {
    await loopback('/api/inbox/settings', 'POST', JSON.stringify({ notifications: change }));
    await notifyAgain();
    act(() => root?.unmount());
    host?.remove();
    const again = await renderApp();
    await act(async () => {
      window.location.hash = `#thread=${threadId}`;
    });
    await until(() => $(again, 'section.ib-pane h2.ib-subject') !== null, 'the thread');
    await wait(600);
    expect($(again, '[data-tour-notify-again]'), JSON.stringify(change)).toBeNull();
  }
}, 90_000);

test.skipIf(!hasDom)('⌘K does not open search over the replay (it shows the person’s own threads); on step 6 it does', async () => {
  const el = await openOnEntry();
  await walkTo(el, 2);
  const { isMac } = await import('@plannotator/ui/utils/platform');
  const chord = () => act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: isMac, ctrlKey: !isMac, bubbles: true, cancelable: true })));
  await chord();
  await wait(500);
  expect(document.querySelector('[data-search-palette]')).toBeNull();
  expect(window.location.hash).toBe('#tour=2');
  await act(async () => {
    window.location.hash = '#tour=6';
  });
  await until(() => $(el, '.ib-empty h2')?.textContent === 'Now, let’s connect your agents', 'step 6');
  await chord();
  await until(() => document.querySelector('[data-search-palette]') !== null, 'search');
}, 90_000);

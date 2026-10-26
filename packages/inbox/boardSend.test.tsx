/**
 * Send to an agent and Start on the Board (approval "inbox-board", step 2)
 * against a REAL Inbox (its own process, tests/helpers/inbox-dom-server.ts),
 * with a live agent session polling the bridge as a connection does. What is
 * proved, with the window's own code (BoardPage) doing the calls:
 *
 *  - Start on an agent's Backlog card sends that agent ONE message in the
 *    card's thread naming the card, and marks the card sent; the card does
 *    not move. When the answer to the send is lost, pressing Start again
 *    sends nothing more: the message and the send replay.
 *  - New card, Send to an agent: the card is made first (so the message can
 *    name it), then a thread to the session, then the send. When the answer
 *    to the thread is lost, pressing Send again makes no second card and no
 *    second thread. The agent's wake carries the card's id.
 *
 * What regresses: a retry that sends a second message or makes a second
 * card, a message that says "it is yours now" for a card that does not
 * exist, or a Start that moves the card.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxCardWire } from '@plannotator/core/inbox-types';
import type { BoardPageProps } from './board/BoardPage';

const hasDom = typeof document !== 'undefined';
const { BoardPage } = (hasDom ? await import('./board/BoardPage') : {}) as typeof import('./board/BoardPage');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
type World = { project: string; stopped: string };

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let world: World;
let index = 0;
let dir: string | null = null;
let root: Root | null = null;
let savedFetch: typeof fetch;
let reader: ReadableStreamDefaultReader<Uint8Array>;
let buffered = '';
/** The next request whose answer the test throws away after the server handled it (a lost answer). */
let loseAnswerOf: { method: string; path: RegExp } | null = null;

function loopback(path: string, method = 'GET', body?: string): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

async function readLine(): Promise<Record<string, unknown>> {
  while (!buffered.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('the Inbox stopped');
    buffered += new TextDecoder().decode(value);
  }
  const at = buffered.indexOf('\n');
  const line = buffered.slice(0, at);
  buffered = buffered.slice(at + 1);
  return JSON.parse(line) as Record<string, unknown>;
}

async function ask(command: Record<string, unknown>): Promise<Record<string, unknown>> {
  (child!.stdin as import('bun').FileSink).write(`${JSON.stringify(command)}\n`);
  (child!.stdin as import('bun').FileSink).flush();
  return readLine();
}

const get = async <T,>(path: string) => JSON.parse((await loopback(path)).text) as T;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-board-send-dom-')));
  // The Board is off by default: this person turned it on (config.json `inboxBoard`), so agents get the card action.
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'config.json'), JSON.stringify({ inboxBoard: true }));
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '2'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const started = (await readLine()) as { port: number; worlds: World[] };
  port = started.port;
  worlds = started.worlds;
});

afterAll(async () => {
  if (!hasDom) return;
  child?.kill();
  await child?.exited;
  child = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

beforeEach(() => {
  if (!hasDom) return;
  world = worlds[index]!;
  index += 1;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const answer = await loopback(path, method, init?.body ? String(init.body) : undefined);
    if (loseAnswerOf && loseAnswerOf.method === method && loseAnswerOf.path.test(path)) {
      loseAnswerOf = null;
      throw new TypeError('Failed to fetch');
    }
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  globalThis.fetch = savedFetch;
  loseAnswerOf = null;
  document.body.innerHTML = '';
});

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The Board as App draws it, over the real Inbox: the cards, the projects, the opened card. */
async function drawBoard(openCard: string | null) {
  const model = await get<NonNullable<BoardPageProps['model']>>('/api/inbox/cards');
  const { projects } = await get<{ projects: BoardPageProps['projects'] }>('/api/inbox/projects');
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  const props: BoardPageProps = {
    view: 'lanes',
    mcpCommand: null,
    claimIntro: false,
    model,
    error: null,
    visitLook: model.seen_seq ?? null,
    handled: new Set(),
    projects,
    defaultProject: world.project,
    home: null,
    phone: false,
    openCard,
    onOpenCard: () => {},
    rowOf: () => null,
    onView: () => {},
    onMove: async () => null,
    onChanged: () => {},
    onSeeDrops: () => {},
    onOpenThread: () => {},
  };
  act(() => root!.render(<SidebarProvider><BoardPage {...props} /></SidebarProvider>));
}

const cardsTitled = async (title: string) => (await get<{ cards: InboxCardWire[] }>('/api/inbox/cards')).cards.filter((c) => c.title === title);

test.if(hasDom)('Start tells the card’s live agent once, in the card’s thread, naming the card; a retry after a lost answer sends nothing more', async () => {
  const session = `ses_a${index - 1}`;
  // The agent's connection polls: it is live. It makes a card in Backlog, linked to its thread.
  await ask({ poll: { session, body: {} } });
  const { carded } = (await ask({ card: { project: world.project, session, title: 'Retry budget', say: 'Not started', thread: world.stopped } })) as { carded: string };
  await drawBoard(carded);
  await until(() => !!document.querySelector<HTMLButtonElement>('[data-card-start]:not([disabled])'), 'Start, with the agent live');
  // The send's answer is lost: the window says so, the server has done it.
  loseAnswerOf = { method: 'POST', path: new RegExp(`^/api/inbox/cards/${carded}$`) };
  await act(async () => document.querySelector<HTMLButtonElement>('[data-card-start]')!.click());
  await until(() => !document.querySelector('[data-card-start][disabled]'), 'Start done');
  // The answer was lost (the server sent the message and marked the card), so the window tries again.
  expect(loseAnswerOf).toBeNull();
  // Press it again: the same message and the same send replay.
  await act(async () => document.querySelector<HTMLButtonElement>('[data-card-start]')?.click());
  await until(async () => (await cardsTitled('Retry budget'))[0]?.sent !== null, 'the card sent');
  const [card] = await cardsTitled('Retry budget');
  expect(card!.column).toBe('backlog');
  expect(card!.sent).toMatchObject({ to: { session }, thread_id: world.stopped });
  const thread = await get<{ thread: { messages: { author: { kind: string }; body: string; to?: { session: string } | null }[] } }>(`/api/inbox/threads/${world.stopped}`);
  const mine = thread.thread.messages.filter((m) => m.author.kind === 'person');
  expect(mine).toHaveLength(1);
  expect(mine[0]!.body).toContain(`Board card ${carded}`);
  // The agent's wake: one message, naming the card.
  const { commands } = (await ask({ poll: { session, body: {} } })) as { commands: { type: string; body: string }[] };
  expect(commands.filter((c) => c.body.includes(carded))).toHaveLength(1);
  // History says the Start went into the card's own thread.
  const { history } = await get<{ history: { kind: string; existing_thread?: boolean }[] }>(`/api/inbox/cards/${carded}`);
  expect(history.find((h) => h.kind === 'sent')).toMatchObject({ existing_thread: true });
});

test.if(hasDom)('New card, Send to an agent: the card first and named in the message; a retry after a lost answer makes no second card or thread', async () => {
  const session = `ses_a${index - 1}`;
  await ask({ poll: { session, body: {} } });
  await drawBoard(null);
  act(() => document.querySelector<HTMLButtonElement>('[data-board-new]')!.click());
  await until(() => !!document.querySelector('[data-new-card-title]'), 'New card');
  const title = document.querySelector<HTMLInputElement>('[data-new-card-title]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'Sent from the Board');
    title.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Send to an agent: the radio, then the live session in the picker.
  await act(async () => document.querySelector<HTMLInputElement>('[data-new-card-mode="send"] input')!.click());
  await until(() => document.querySelectorAll('[role="option"]').length > 0, 'the live sessions');
  await act(async () => document.querySelector<HTMLElement>('[role="option"]')!.click());
  // The thread's answer is lost once.
  loseAnswerOf = { method: 'POST', path: /^\/api\/inbox\/messages$/ };
  const send = () => [...document.querySelectorAll<HTMLButtonElement>('[data-new-card-add]')].at(-1)!;
  await act(async () => send().click());
  await until(() => !!document.querySelector('[data-new-card-error]'), 'the error');
  // One card already, unsent, in Backlog (the message names it when it goes).
  expect(await cardsTitled('Sent from the Board')).toHaveLength(1);
  await act(async () => send().click());
  await until(() => !document.querySelector('[data-new-card-title]'), 'the dialog closed');
  const cards = await cardsTitled('Sent from the Board');
  expect(cards).toHaveLength(1);
  expect(cards[0]!.sent).toMatchObject({ to: { session } });
  // One thread to the session, its message naming the card.
  const { commands } = (await ask({ poll: { session, body: {} } })) as { commands: { type: string; body: string; thread_id: string }[] };
  const mine = commands.filter((c) => c.body.includes(`card ${cards[0]!.id}`));
  expect(mine).toHaveLength(1);
  expect(mine[0]!.thread_id).toBe(cards[0]!.sent!.thread_id);
});

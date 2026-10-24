/**
 * Decision mode (experimental; approval "inbox-decision-mode", the Queue
 * direction), as the window draws it: the whole window (InboxApp) over a REAL
 * Inbox server in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts in its `decisions` mode, which turns the
 * feature on in the scratch config.json and seeds Claude Code asking two
 * questions, one Stopped, and Codex asking one). What is proved: the ways in
 * (the sidebar's "Decide N", the list header's button) and that nothing of it
 * renders with the gate off; walking the queue (a pick saves through the
 * picks route at once and the next card shows); the per-agent Send after the
 * Hold (one reply for the session, in its thread); Undo and Previous; Later;
 * a question the agent replaces while it is on screen; closing with an agent
 * half answered.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxDecisionsModel, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; root: string; decide: { a: string; b: string; sessionA: string; sessionB: string } };
let child: ReturnType<typeof Bun.spawn> | null = null;
let childOut: ReadableStreamDefaultReader<Uint8Array> | null = null;
let port = 0;
let worlds: World[] = [];
let all: World[] = [];
let world: World = { project: '', root: '', decide: { a: '', b: '', sessionA: '', sessionB: '' } };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let posted: { path: string; body: Record<string, unknown> }[] = [];
/** The window's event stream, fired by hand: `poke(json)` is one record frame. */
let poke: ((data: string) => void) | null = null;

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
const api = async <T,>(path: string): Promise<T> => JSON.parse((await loopback(path)).text) as T;
const apiPost = (path: string, body: Record<string, unknown>) => loopback(path, 'POST', JSON.stringify(body));

async function readLine(): Promise<string> {
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await childOut!.read();
    if (done) throw new Error('the Inbox stopped');
    line += new TextDecoder().decode(value);
  }
  return line.trim();
}

/** An agent writing while the test runs (the server's stdin). */
async function agentSends(send: Record<string, unknown>): Promise<string> {
  (child!.stdin as { write: (s: string) => void; flush?: () => void }).write(`${JSON.stringify({ send })}\n`);
  (child!.stdin as { flush?: () => void }).flush?.();
  return (JSON.parse(await readLine()) as { sent: string }).sent;
}

const TESTS = 8;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-decide-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS), 'decisions'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), PLANNOTATOR_EXPERIMENTAL: '', HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  childOut = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const started = JSON.parse(await readLine()) as { port: number; worlds: World[] };
  port = started.port;
  worlds = started.worlds;
  all = [...worlds];
});

afterAll(async () => {
  if (!hasDom) return;
  child?.kill();
  await child?.exited;
  child = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

beforeEach(async () => {
  if (!hasDom) return;
  world = worlds.shift()!;
  // Only this test's decisions wait: the other worlds' threads are archived.
  for (const other of all) {
    if (other === world) continue;
    for (const id of [other.decide.a, other.decide.b]) await apiPost(`/api/inbox/messages/${id}/resolve`, { resolved: true });
  }
  await apiPost(`/api/inbox/messages/${world.decide.a}/resolve`, { resolved: false });
  await apiPost(`/api/inbox/messages/${world.decide.b}/resolve`, { resolved: false });
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? String(init.body) : undefined;
    if (method === 'POST') posted.push({ path, body: body ? JSON.parse(body) : {} });
    const answer = await loopback(path, method, body);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
      if (type === 'record') poke = (data) => listener({ data } as MessageEvent<string>);
    }
    close() {}
  };
  posted = [];
  window.location.hash = '';
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  poke = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
});

async function settle(ms = 40) {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function renderApp(hash = '') {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await settle();
  return host;
}

function button(el: ParentNode, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === text);
  if (!found) throw new Error(`no button "${text}" in ${[...el.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')}`);
  return found as HTMLButtonElement;
}

const dialog = () => document.querySelector('[data-decision-mode]') as HTMLDialogElement | null;
const prompt = () => dialog()?.querySelector('[data-decision-prompt]')?.textContent?.trim() ?? null;

/** A click on a choice, as a pointer makes it (a press, then the click). */
function choose(label: string) {
  const choice = [...dialog()!.querySelectorAll('.ib-dm-choice')].find((c) => c.querySelector('.ib-dm-chl')?.textContent?.trim() === label) as HTMLElement;
  if (!choice) throw new Error(`no choice ${label}`);
  act(() => {
    choice.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    (choice.querySelector('input') as HTMLInputElement).click();
  });
}

async function questionsOf(messageId: string, threadId = messageId): Promise<InboxQuestion[]> {
  const model = await api<{ thread: InboxThread }>(`/api/inbox/threads/${threadId}`);
  return model.thread.messages.find((m) => m.id === messageId)?.questions ?? [];
}

async function openDecide(el: HTMLElement) {
  await until(() => el.querySelector('[data-decide-nav]') !== null, 'the Decide row');
  act(() => (el.querySelector('[data-decide-nav]') as HTMLButtonElement).click());
  await until(() => prompt() !== null, 'the first card');
}

test.skipIf(!hasDom)('the ways in show from two decisions; with the gate off nothing of decision mode renders and the route is gone', async () => {
  const el = await renderApp();
  await until(() => el.querySelector('[data-decide-nav]') !== null, 'the Decide row');
  expect(el.querySelector('[data-decide-nav]')!.textContent).toContain('Decide3');
  expect(el.querySelector('[data-decide-head]')!.textContent).toBe('Decide 3');
  act(() => root?.unmount());
  host?.remove();
  // Off: Settings' switch, then a fresh window.
  expect((await apiPost('/api/inbox/settings', { experimental: { decision_mode: false } })).status).toBe(200);
  try {
    expect((await loopback('/api/inbox/decisions')).status).toBe(404);
    const off = await renderApp();
    await until(() => off.querySelector('[data-inbox-nav]') !== null, 'the sidebar');
    await settle();
    expect(off.querySelector('[data-decide-nav]')).toBeNull();
    expect(off.querySelector('[data-decide-head]')).toBeNull();
    expect(document.querySelector('[data-decision-mode]')).toBeNull();
    // Settings → General shows the switch, off.
    act(() => root?.unmount());
    host?.remove();
    const settings = await renderApp('#settings/general');
    await until(() => settings.querySelector('[data-settings-experimental]') !== null, 'the Experimental group');
    const sw = settings.querySelector('[data-settings-experimental] [role="switch"]') as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    act(() => sw.click());
    await until(async () => (await loopback('/api/inbox/decisions')).status === 200, 'the switch to turn it on');
    expect(posted.some((p) => p.path === '/api/inbox/settings' && (p.body.experimental as { decision_mode?: boolean })?.decision_mode === true)).toBe(true);
  } finally {
    await apiPost('/api/inbox/settings', { experimental: { decision_mode: true } });
  }
}, 30_000);

test.skipIf(!hasDom)('walks the queue: Stopped first, a pick saves at once, the next card shows; the session sends one reply after the Hold', async () => {
  const el = await renderApp();
  await openDecide(el);
  expect(dialog()!.querySelector('[data-decision-head]')!.textContent).toContain('1 of 3 · 2 agents waiting');
  expect(prompt()).toBe('Which way should the worker go on a Stripe 409?');
  expect(dialog()!.querySelector('[data-decision-stopped]')!.textContent).toContain('the refund worker cannot ship without this.');
  choose('Retry with the same key');
  await until(async () => (await questionsOf(world.decide.a))[0]?.state === 'picked', 'the pick saved');
  expect((await questionsOf(world.decide.a))[0]!.answer?.selected).toEqual(['Retry with the same key']);
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
  expect(dialog()!.querySelector('[data-decision-live]')!.textContent).toContain('Answered: Retry with the same key. 2 left.');
  choose('Yes, page on-call');
  // Claude Code's last decision here is handled: its chip holds the reply for 5 s.
  await until(() => dialog()!.querySelector('[data-decision-hold]') !== null, 'the Hold');
  expect(dialog()!.querySelector('[data-decision-hold]')!.textContent).toMatch(/Sending in \d s · Hold/);
  act(() => button(dialog()!.querySelector('[data-decision-hold]')!, 'Hold').click());
  await until(() => dialog()!.querySelector('[data-decision-held]') !== null, 'Held');
  expect(posted.some((p) => p.path.endsWith('/reply'))).toBe(false);
  expect((await questionsOf(world.decide.a)).map((q) => q.state)).toEqual(['picked', 'picked']);
  act(() => button(dialog()!.querySelector('[data-decision-held]')!, 'Send').click());
  await until(async () => (await questionsOf(world.decide.a)).every((q) => q.state === 'sent'), 'the reply');
  // One reply for the session in its thread, carrying both answers; Codex's question is untouched.
  const replies = posted.filter((p) => p.path.endsWith('/reply'));
  expect(replies).toHaveLength(1);
  expect(replies[0]!.path).toBe(`/api/inbox/messages/${world.decide.a}/reply`);
  expect((replies[0]!.body.questions as unknown[]).length).toBe(2);
  expect(replies[0]!.body.words).toBe('');
  expect((await questionsOf(world.decide.b))[0]!.state).toBe('open');
  await until(() => prompt() === 'Ship the new flag off by default?', "Codex's card");
}, 30_000);

test.skipIf(!hasDom)('Undo puts the last pick back and returns to its card; Previous goes back a card', async () => {
  const el = await renderApp();
  await openDecide(el);
  choose('Fail to the dead-letter queue');
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
  await until(async () => (await questionsOf(world.decide.a))[0]?.state === 'picked', 'the pick saved');
  act(() => (dialog()!.querySelector('[data-decision-undo]') as HTMLButtonElement).click());
  await until(() => prompt() === 'Which way should the worker go on a Stripe 409?', 'back to the first card');
  await until(async () => (await questionsOf(world.decide.a))[0]?.state === 'open', 'the pick taken back');
  // Previous: from the second card back to the first.
  choose('Retry with the same key');
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
  const prev = dialog()!.querySelector('[data-decision-previous]') as HTMLButtonElement;
  expect(prev.disabled).toBe(false);
  act(() => prev.click());
  await settle();
  expect(prompt()).toBe('Which way should the worker go on a Stripe 409?');
  // The saved pick shows on the card it was made on.
  expect(dialog()!.querySelector('.ib-dm-choice[data-saved] .ib-dm-chl')?.textContent?.trim()).toBe('Retry with the same key');
}, 30_000);

test.skipIf(!hasDom)('Later puts a decision at the end: the others first, then it comes back; its session does not send meanwhile', async () => {
  const el = await renderApp();
  await openDecide(el);
  act(() => (dialog()!.querySelector('[data-decision-later]') as HTMLButtonElement).click());
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the next card');
  choose('No, a daily digest');
  await until(() => prompt() === 'Ship the new flag off by default?', "Codex's card");
  // Claude Code still has a decision put off: no Hold for it.
  const chipA = dialog()!.querySelector(`[data-decision-chip="s:claude-code:${world.decide.sessionA}"]`) as HTMLElement;
  expect(chipA.querySelector('[data-decision-hold]')).toBeNull();
  choose('No');
  await until(() => prompt() === 'Which way should the worker go on a Stripe 409?', 'the card put off');
  // Nothing was sent for Claude Code while its decision was put off (Codex's own reply may have gone after its Hold).
  expect(posted.filter((p) => p.path === `/api/inbox/messages/${world.decide.a}/reply`)).toHaveLength(0);
  expect((await questionsOf(world.decide.a)).map((q) => q.state)).toEqual(['open', 'picked']);
}, 30_000);

test.skipIf(!hasDom)('a question the agent replaces while it is on screen swaps in with a banner; the old pick is not sent', async () => {
  const el = await renderApp();
  await openDecide(el);
  const old = (await questionsOf(world.decide.a))[0]!;
  const replacement = await agentSends({
    project: world.project,
    session: world.decide.sessionA,
    reply_to: world.decide.a,
    body: [':::question', 'Retry on 409 with the same key, or fail it?', '', '- [ ] Same key', '- [ ] Fail it', ':::'].join('\n'),
    supersedes: [`${world.decide.a}/${old.key}`],
  });
  const superseded = (await questionsOf(world.decide.a))[0]!;
  expect(superseded.state).toBe('superseded');
  // The event stream's question line (the window reads the projection again with it).
  await act(async () => {
    poke!(JSON.stringify({ seq: 999, kind: 'question', id: `${world.decide.a}/${old.key}`, question: superseded }));
  });
  await until(() => dialog()!.querySelector('[data-decision-replaced]') !== null, 'the banner');
  expect(dialog()!.querySelector('[data-decision-replaced]')!.textContent).toContain('Claude Code replaced this question just now.');
  await until(() => prompt() === 'Retry on 409 with the same key, or fail it?', 'the replacement');
  expect(replacement).toMatch(/^msg_/);
}, 30_000);

test.skipIf(!hasDom)('closing with an agent half answered asks first: Keep as a draft leaves the pick saved and sends nothing', async () => {
  const el = await renderApp();
  await openDecide(el);
  choose('Retry with the same key');
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
  act(() => (dialog()!.querySelector('[data-decision-close]') as HTMLButtonElement).click());
  await until(() => (dialog()?.querySelector('[data-decision-confirm]') ?? null) !== null, 'the question');
  // Escape closes the question first, not the dialog.
  act(() => {
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await settle();
  expect(dialog()?.querySelector('[data-decision-confirm]')).toBeNull();
  expect(dialog()).not.toBeNull();
  act(() => (dialog()!.querySelector('[data-decision-close]') as HTMLButtonElement).click());
  await until(() => (dialog()?.querySelector('[data-decision-keep-draft]') ?? null) !== null, 'the question again');
  act(() => (dialog()!.querySelector('[data-decision-keep-draft]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'the dialog to close');
  expect(posted.filter((p) => p.path.endsWith('/reply'))).toHaveLength(0);
  expect((await questionsOf(world.decide.a)).map((q) => q.state)).toEqual(['picked', 'open']);
  const model = await api<InboxDecisionsModel>('/api/inbox/decisions');
  expect(model.decisions.map((d) => d.question.state)).toEqual(['picked', 'open', 'open']);
}, 30_000);

test.skipIf(!hasDom)('Open the thread tucks decision mode into a pill; Resume brings it back on the same card', async () => {
  const el = await renderApp();
  await openDecide(el);
  act(() => (dialog()!.querySelector('[data-decision-open-thread]') as HTMLButtonElement).click());
  await until(() => el.querySelector('[data-decision-pill]') !== null, 'the pill');
  expect(window.location.hash).toContain(`thread=${world.decide.a}`);
  expect(el.querySelector('[data-decision-pill]')!.textContent).toContain('3 left');
  expect(dialog()!.open).toBe(false);
  act(() => (el.querySelector('[data-decision-resume]') as HTMLButtonElement).click());
  await settle();
  expect(dialog()!.open).toBe(true);
  expect(prompt()).toBe('Which way should the worker go on a Stripe 409?');
}, 30_000);

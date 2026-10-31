/**
 * The one-time list options dialog as drawn (components/ListLookIntro.tsx, approval "inbox-list-options-intro"): it
 * opens at the defaults; the preview turns the options on in turn while the switches are inert (no pointer, no focus,
 * not announced); any key ends the preview at once, back to the defaults; none under reduced motion; Done hands over
 * the switches as they stand; Escape and Keep as it is hand over nothing.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { ListLook } from './listLook';
import type { ListIntroGroup } from './components/ListLookIntro';

const hasDom = typeof document !== 'undefined';
const { ListLookIntro } = (hasDom ? await import('./components/ListLookIntro') : {}) as typeof import('./components/ListLookIntro');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realMatchMedia = hasDom ? window.matchMedia : undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  if (hasDom) window.matchMedia = realMatchMedia!;
});

function row(id: string): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject: `Subject ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    created_at: '2026-10-10T10:00:00.000Z',
    last_at: '2026-10-10T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: true,
    project: { id: 'prj_1', name: 'billing' },
    thread_name: `Name of ${id}`,
    section: 'waiting',
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
  };
}

const GROUPS: ListIntroGroup[] = [{ id: 'waiting', label: 'Waiting on you', rows: [row('a'), row('b'), row('c')] }];

/** Reduced motion on or off for the next render (the dialog reads it when it opens). */
function motion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({ matches: reduce && query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
}

function render() {
  const seen: (ListLook | 'keep')[] = [];
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<ListLookIntro groups={GROUPS} phone={false} onDone={(look) => seen.push(look)} onKeep={() => seen.push('keep')} />);
  });
  const dialog = host.querySelector('dialog[data-dialog="list-look-intro"]') as HTMLDialogElement;
  return { dialog, seen };
}

const checked = (dialog: HTMLElement) =>
  Object.fromEntries([...dialog.querySelectorAll('[data-list-intro-option]')].map((sw) => [sw.getAttribute('data-list-intro-option'), sw.getAttribute('aria-checked') === 'true']));
const group = (dialog: HTMLElement) => dialog.querySelector('[role="group"][aria-label="List options"]') as HTMLElement;
const preview = (dialog: HTMLElement) => dialog.querySelector('[data-list-intro-preview]') as HTMLElement;
const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

describe.skipIf(!hasDom)('the list options dialog', () => {
  test('the preview: options on in turn, switches inert meanwhile; a key ends it at once, back to the defaults', async () => {
    motion(false);
    const { dialog } = render();
    expect(checked(dialog)).toEqual({ highlight: false, compact: false, hideAgents: false });
    // The switches are out of reach and out of the accessibility tree while it plays.
    expect(group(dialog).hasAttribute('inert')).toBe(true);
    await wait(450);
    expect(checked(dialog)).toEqual({ highlight: true, compact: false, hideAgents: false });
    expect(preview(dialog).classList.contains('ib-lk-pill')).toBe(true);
    await wait(450);
    expect(checked(dialog)).toEqual({ highlight: true, compact: true, hideAgents: false });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    });
    expect(checked(dialog)).toEqual({ highlight: false, compact: false, hideAgents: false });
    expect(group(dialog).hasAttribute('inert')).toBe(false);
    expect([...preview(dialog).classList].filter((c) => c.startsWith('ib-lk-'))).toEqual([]);
    // Nothing plays on after it: the rest of the steps were cancelled.
    await wait(1700);
    expect(checked(dialog)).toEqual({ highlight: false, compact: false, hideAgents: false });
  });

  test('left alone, the preview ends with every option off and the switches usable', async () => {
    motion(false);
    const { dialog } = render();
    await wait(1450);
    expect(checked(dialog)).toEqual({ highlight: true, compact: true, hideAgents: true });
    expect(preview(dialog).classList.contains('ib-lk-noagents')).toBe(true);
    await wait(700);
    expect(checked(dialog)).toEqual({ highlight: false, compact: false, hideAgents: false });
    expect(group(dialog).hasAttribute('inert')).toBe(false);
  });

  test('reduced motion: no preview; the switches work at once and Done hands them over', async () => {
    motion(true);
    const { dialog, seen } = render();
    expect(group(dialog).hasAttribute('inert')).toBe(false);
    await wait(450);
    expect(checked(dialog)).toEqual({ highlight: false, compact: false, hideAgents: false });
    act(() => (dialog.querySelector('[data-list-intro-option="compact"]') as HTMLElement).click());
    expect(preview(dialog).classList.contains('ib-lk-compact')).toBe(true);
    act(() => (dialog.querySelector('[data-list-intro-done]') as HTMLElement).click());
    expect(seen).toEqual([{ highlight: false, compact: true, hideAgents: false }]);
  });

  test('Escape and Keep as it is hand over nothing', () => {
    motion(true);
    const first = render();
    act(() => {
      first.dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    act(() => (first.dialog.querySelector('[data-list-intro-keep]') as HTMLElement).click());
    expect(first.seen).toEqual(['keep', 'keep']);
  });
});

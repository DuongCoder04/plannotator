/**
 * An open Markdown document shows its Contents (contents.ts, ContentsPanel.tsx):
 * the list of its headings that plan review shows (ui's DocumentContents over
 * TableOfContents). Beside the thread it is the top of the comments column, in
 * full screen a rail on the left, on a phone a button and a sheet. A click on
 * a heading scrolls the document to it. Fewer than 3 headings, no list. Hide
 * is remembered.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import { CONTENTS_COOKIE } from './contents';

const hasDom = typeof document !== 'undefined';
// The pane pulls in the Viewer, which reads `window` at module-eval time.
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');
const { storage } = (hasDom ? await import('@plannotator/ui/utils/storage') : {}) as typeof import('@plannotator/ui/utils/storage');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

beforeAll(() => {
  // A page on localhost, as the Inbox is served: about:blank keeps no readable cookies (the hide choice is one).
  if (hasDom) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  if (hasDom) storage.removeItem(CONTENTS_COOKIE);
});

const PLAN = [
  '# Refund worker',
  '',
  'Move refunds to a background worker.',
  '',
  '## Context',
  '',
  'Refunds run inline today.',
  '',
  '## Design',
  '',
  'A worker claims each job.',
  '',
  '### Idempotency keys',
  '',
  'One key per charge.',
  '',
  '## Rollout',
  '',
  'A shadow week first.',
  '',
].join('\n');

const attachment: InboxAttachmentState = {
  id: 'att_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
  path: '/work/api/refund-plan.md',
  named_path: null,
  name: 'refund-plan.md',
  kind: 'markdown',
  sent_sha256: 'a'.repeat(64),
  size: PLAN.length,
  sent_at: '2026-10-10T10:00:00.000Z',
  sent_mtime: '2026-10-10T10:00:00.000Z',
  message_id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
  current: { sha256: 'a'.repeat(64), size: PLAN.length, mtime: '2026-10-10T10:00:00.000Z' },
  changed_since_sent: false,
  unavailable: null,
};

/** The pane for the attachment whose view route answers `text`, once its document has drawn. */
async function renderPane(text: string, layout: { full?: boolean; phone?: boolean } = {}): Promise<void> {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ serverSession: 's', attachment, version: 'current', text, html: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
  const noop = () => {};
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <AttachmentPane
        attachment={attachment}
        attachments={[attachment]}
        records={[]}
        agent="Claude Code"
        projectName="api"
        projectRoot="/work/api"
        version="current"
        onVersion={noop}
        full={layout.full === true}
        phone={layout.phone}
        onToggleFull={noop}
        focusId={null}
        readOnly={false}
        onSaved={noop}
        onRemoved={noop}
        onOpenAt={noop}
        onClose={noop}
        strip={{ picks: 0, annotations: 0, onWriteReply: noop }}
      />,
    );
  });
  await act(async () => {
    for (let i = 0; i < 200 && !host!.querySelector('.ib-docscroll article')?.textContent?.includes('Refund worker'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
}

function entries(list: Element | null): string[] {
  return [...(list?.querySelectorAll('nav[aria-label="Table of contents"] button') ?? [])].map((b) => b.textContent ?? '');
}

/** Records the document scroll's scrollTo calls; the heading named `text` reads at `top` px below the scroll's top. */
function watchScroll(text: string, top: number): ScrollToOptions[] {
  const scroll = host!.querySelector<HTMLElement>('.ib-docscroll')!;
  const calls: ScrollToOptions[] = [];
  scroll.scrollTo = ((options: ScrollToOptions) => void calls.push(options)) as typeof scroll.scrollTo;
  const heading = [...scroll.querySelectorAll<HTMLElement>('[data-block-type="heading"]')].find((h) => h.textContent === text)!;
  heading.getBoundingClientRect = () => new DOMRect(0, top, 600, 30);
  return calls;
}

function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  act(() => (el as HTMLElement).click());
}

test.skipIf(!hasDom)('beside the thread, the comments column lists the headings, and a click scrolls the document to one', async () => {
  await renderPane(PLAN);
  const column = host!.querySelector('.ib-apanel [data-contents="column"]');
  expect(entries(column)).toEqual(['Refund worker', 'Context', 'Design', 'Idempotency keys', 'Rollout']);
  // Above the Annotations list, in the same column: the page keeps its width.
  expect(column!.nextElementSibling?.matches('[data-annotation-panel]')).toBe(true);

  const calls = watchScroll('Rollout', 900);
  click([...column!.querySelectorAll('nav button')].find((b) => b.textContent === 'Rollout'));
  // TableOfContents' offset: the heading's top less 80 px for the toolstrip.
  expect(calls).toEqual([{ top: 820, behavior: 'smooth' }]);
});

test.skipIf(!hasDom)('a document with fewer than 3 headings has no Contents', async () => {
  await renderPane('# Refund worker\n\nShort.\n\n## Context\n\nStill short.\n');
  expect(host!.querySelector('[data-contents]')).toBeNull();
  expect(host!.querySelector('[data-contents-open]')).toBeNull();
});

test.skipIf(!hasDom)('full screen docks a rail on the left; hiding it is remembered for the next file', async () => {
  await renderPane(PLAN, { full: true });
  const rail = host!.querySelector('.ib-docarea > [data-contents="rail"]');
  expect(entries(rail)).toContain('Idempotency keys');
  // The page and the toolstrip move right of the rail (inbox.css keys on this).
  expect(host!.querySelector('.ib-docarea')!.hasAttribute('data-contents-rail')).toBe(true);

  click(host!.querySelector('[data-contents-hide]'));
  expect(host!.querySelector('[data-contents="rail"]')).toBeNull();
  expect(host!.querySelector('.ib-docarea')!.hasAttribute('data-contents-rail')).toBe(false);
  expect(host!.querySelector('[data-contents-show]')).not.toBeNull();

  act(() => root?.unmount());
  host!.remove();
  await renderPane(PLAN, { full: true });
  expect(storage.getItem(CONTENTS_COOKIE)).toBe('hidden');
  expect(host!.querySelector('[data-contents="rail"]')).toBeNull();
  click(host!.querySelector('[data-contents-show]'));
  expect(host!.querySelector('[data-contents="rail"]')).not.toBeNull();
});

test.skipIf(!hasDom)('on a phone a Contents button opens the list as a sheet; a pick scrolls there and closes it', async () => {
  await renderPane(PLAN, { phone: true });
  expect(host!.querySelector('.ib-apanel [data-contents]')).toBeNull();
  click(host!.querySelector('[data-contents-open]'));
  const sheet = document.querySelector('[data-contents="sheet"][role="dialog"]');
  expect(entries(sheet)).toEqual(['Refund worker', 'Context', 'Design', 'Idempotency keys', 'Rollout']);

  const calls = watchScroll('Design', 500);
  click([...sheet!.querySelectorAll('nav button')].find((b) => b.textContent === 'Design'));
  expect(calls).toEqual([{ top: 420, behavior: 'smooth' }]);
  expect(document.querySelector('[data-contents="sheet"]')).toBeNull();
});

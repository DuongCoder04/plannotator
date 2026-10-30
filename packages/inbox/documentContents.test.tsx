/**
 * An open Markdown document shows its Contents (contents.ts, ContentsPanel.tsx):
 * the list of its headings that plan review shows (ui's DocumentContents over
 * TableOfContents). Beside the thread it is the top of the comments column, in
 * full screen a rail on the left, on a phone a button and a sheet. A click on
 * a heading scrolls the document to it. Fewer than 3 headings, no list. Hide
 * is remembered. A list mounted mid-document (a sheet that opens, a column
 * shown again) marks the section being read; the capped column keeps the mark
 * in view. Full screen with under 1000 px of file area falls back to the
 * sheet, which holds focus and takes Escape first. The phone surface has the
 * same button and sheet.
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
const realObserver = hasDom ? globalThis.IntersectionObserver : undefined;
const realRect = hasDom ? HTMLElement.prototype.getBoundingClientRect : undefined;

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
  if (hasDom) {
    storage.removeItem(CONTENTS_COOKIE);
    globalThis.IntersectionObserver = realObserver!;
    HTMLElement.prototype.getBoundingClientRect = realRect!;
  }
});

/**
 * An IntersectionObserver that reports nothing until told: as a real one does when no heading sits in
 * useActiveSection's band (80 px down to 20% of the scroll's height), which is most of a long document.
 * `report` makes the open observers say a heading entered the band, as a scroll would.
 */
function stubObserver(): { report: (target: Element) => void } {
  const open: { callback: IntersectionObserverCallback; targets: Element[]; self: IntersectionObserver }[] = [];
  globalThis.IntersectionObserver = class {
    private entry: (typeof open)[number];
    constructor(callback: IntersectionObserverCallback) {
      this.entry = { callback, targets: [], self: this as unknown as IntersectionObserver };
      open.push(this.entry);
    }
    observe(el: Element) {
      this.entry.targets.push(el);
    }
    unobserve() {}
    disconnect() {
      open.splice(open.indexOf(this.entry), 1);
    }
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
  return {
    report: (target) => {
      for (const o of open.filter((o) => o.targets.includes(target))) {
        act(() => o.callback([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], o.self));
      }
    },
  };
}

/** Lay the document's headings out as if scrolled: `tops` gives each heading's top, px below the scroll's top. */
function layOut(tops: Record<string, number>, within: ParentNode = host!) {
  for (const heading of within.querySelectorAll<HTMLElement>('[data-block-type="heading"]')) {
    const top = tops[heading.textContent ?? ''];
    if (top !== undefined) heading.getBoundingClientRect = () => new DOMRect(0, top, 600, 30);
  }
}

/** Halfway into "Design": every heading above it is read past, none sits in the band. */
const MID_DESIGN = { 'Refund worker': -900, Context: -520, Design: -140, 'Idempotency keys': 420, Rollout: 940 };

/** The file area (`.ib-docarea`) measures `width` px; the body around it (with the comments drawer) is wider. */
function fileAreaWidth(width: number) {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains('ib-docarea')) return new DOMRect(0, 0, width, 800);
    if (this.classList.contains('ib-vbody')) return new DOMRect(0, 0, width + 320, 800);
    return realRect!.call(this);
  };
}

function marked(list: Element | null): string[] {
  return [...(list?.querySelectorAll('nav button[aria-current="location"]') ?? [])].map((b) => b.textContent ?? '');
}

function key(target: EventTarget, init: KeyboardEventInit) {
  act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
}

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
async function renderPane(
  text: string,
  layout: { full?: boolean; phone?: boolean } = {},
  on: { toggleFull?: () => void; close?: () => void } = {},
): Promise<void> {
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
        onToggleFull={on.toggleFull ?? noop}
        focusId={null}
        readOnly={false}
        onSaved={noop}
        onRemoved={noop}
        onOpenAt={noop}
        onClose={on.close ?? noop}
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

function heading(text: string): Element {
  return [...host!.querySelectorAll('[data-block-type="heading"]')].find((h) => h.textContent === text)!;
}

test.skipIf(!hasDom)('a sheet opened mid-document marks the section being read, and the observer takes over as it scrolls', async () => {
  const observer = stubObserver();
  await renderPane(PLAN, { phone: true });
  layOut(MID_DESIGN);
  click(host!.querySelector('[data-contents-open]'));
  const sheet = document.querySelector('[data-contents="sheet"]');
  expect(marked(sheet)).toEqual(['Design']);

  // A scroll brings "Rollout" into the band: the mark follows it.
  observer.report(heading('Rollout'));
  expect(marked(sheet)).toEqual(['Rollout']);

  // Closed, scrolled on, and opened again: it marks where the reader is now.
  click(sheet!.querySelector('[aria-label="Close contents"]'));
  layOut({ ...MID_DESIGN, Design: -700, 'Idempotency keys': -200, Rollout: 300 });
  click(host!.querySelector('[data-contents-open]'));
  expect(marked(document.querySelector('[data-contents="sheet"]'))).toEqual(['Idempotency keys']);
});

test.skipIf(!hasDom)('the column hidden and shown again mid-document marks the section being read', async () => {
  stubObserver();
  await renderPane(PLAN);
  click(host!.querySelector('[data-contents-toggle]'));
  layOut(MID_DESIGN);
  click(host!.querySelector('[data-contents-toggle]'));
  expect(marked(host!.querySelector('[data-contents="column"]'))).toEqual(['Design']);
});

test.skipIf(!hasDom)('the capped column scrolls its own list to the marked heading, at once', async () => {
  const observer = stubObserver();
  await renderPane(PLAN);
  const list = host!.querySelector<HTMLElement>('[data-contents="column"] .ib-contents-list')!;
  // inbox.css caps it and lets it scroll; happy-dom lays nothing out, so the sizes are given here:
  // a 100 px list of 300 px of entries, "Idempotency keys" drawn 130 px down.
  list.style.overflowY = 'auto';
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 100 });
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 300 });
  list.getBoundingClientRect = () => new DOMRect(0, 0, 300, 100);
  const keys = [...list.querySelectorAll<HTMLElement>('nav button')].find((b) => b.textContent === 'Idempotency keys')!;
  keys.getBoundingClientRect = () => new DOMRect(0, 130 - list.scrollTop, 300, 30);
  const pageScroll = host!.querySelector<HTMLElement>('.ib-docscroll')!.scrollTop;

  observer.report(heading('Idempotency keys'));
  expect(marked(list)).toEqual(['Idempotency keys']);
  // Just enough to show it (its bottom at the list's bottom); the document does not move.
  expect(list.scrollTop).toBe(60);
  expect(host!.querySelector<HTMLElement>('.ib-docscroll')!.scrollTop).toBe(pageScroll);
});

test.skipIf(!hasDom)('full screen whose file area is under 1000 px (the comments drawer open beside it) opens Contents as a sheet, not a rail', async () => {
  fileAreaWidth(880);
  await renderPane(PLAN, { full: true });
  expect(host!.querySelector('[data-contents="rail"]')).toBeNull();
  expect(host!.querySelector('.ib-docarea')!.hasAttribute('data-contents-rail')).toBe(false);
  click(host!.querySelector('[data-contents-open]'));
  expect(entries(document.querySelector('[data-contents="sheet"]'))).toContain('Rollout');
});

test.skipIf(!hasDom)('the sheet holds focus: Tab wraps inside it, Escape closes it before full screen sees the key, focus goes back', async () => {
  fileAreaWidth(880);
  let left = 0;
  await renderPane(PLAN, { full: true }, { toggleFull: () => left++, close: () => left++ });
  const opener = host!.querySelector<HTMLElement>('[data-contents-open]')!;
  click(opener);
  const sheet = document.querySelector<HTMLElement>('[data-contents="sheet"]')!;
  expect(sheet.getAttribute('aria-modal')).toBe('true');
  const close = sheet.querySelector<HTMLElement>('[aria-label="Close contents"]')!;
  const last = [...sheet.querySelectorAll<HTMLElement>('nav button')].at(-1)!;
  expect(document.activeElement).toBe(close);

  // Tab past the last entry comes back to Close; Shift+Tab from Close goes to the last entry.
  act(() => last.focus());
  key(last, { key: 'Tab' });
  expect(document.activeElement).toBe(close);
  key(close, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(last);

  // Focus off the sheet (a click on the page's chrome behind it): Escape still closes the sheet, not full screen.
  act(() => last.blur());
  key(document.body, { key: 'Escape' });
  expect(document.querySelector('[data-contents="sheet"]')).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(left).toBe(0);
  // The next Escape is full screen's again (its ladder's last rung leaves it).
  // (Without the sheet's own Escape the first one would have gone here.)
  key(document.body, { key: 'Escape' });
  expect(left).toBe(1);
});

test.skipIf(!hasDom)('the phone surface: a Contents button opens the sheet at the section being read; a pick scrolls there and closes it', async () => {
  stubObserver();
  const { SurfaceDocument } = await import('./surface/SurfaceDocument');
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <SurfaceDocument
        open={{ v: 1, type: 'open_attachment', attachment, version: 'current', text: PLAN, html: null, annotations: [], focus: null }}
        records={[]}
        interact={false}
      />,
    );
  });
  const scroll = host.querySelector<HTMLElement>('.sf-docscroll')!;
  expect(scroll.querySelector('article')?.textContent).toContain('Refund worker');
  layOut(MID_DESIGN, scroll);
  click(host.querySelector('[data-contents-open]'));
  const sheet = host.querySelector('[data-contents="sheet"][role="dialog"]');
  expect(entries(sheet)).toEqual(['Refund worker', 'Context', 'Design', 'Idempotency keys', 'Rollout']);
  expect(marked(sheet)).toEqual(['Design']);

  const calls: ScrollToOptions[] = [];
  scroll.scrollTo = ((options: ScrollToOptions) => void calls.push(options)) as typeof scroll.scrollTo;
  click([...sheet!.querySelectorAll('nav button')].find((b) => b.textContent === 'Rollout'));
  // "Rollout" reads 940 px down: TableOfContents' offset leaves 80 px above it.
  expect(calls).toEqual([{ top: 860, behavior: 'smooth' }]);
  expect(host.querySelector('[data-contents="sheet"]')).toBeNull();
});

/**
 * The document Contents rail (moved from the Workspaces app's
 * test/dom/markdown-contents-rail.test.tsx with the rail, approved
 * 2026-10-03) is a semantic overlay in the document's RIGHT gutter. These pins
 * cover the failure-prone parts of that contract: no document-layout
 * reservation, width-qualified markers, active-section roving focus,
 * heading-depth indentation, and the reduced-motion scroll path.
 *
 * Port: the heading being read now comes from the package's one scroll-spy
 * (`useActiveSection`'s band, 80 px down to 20% of the pane), so a pick
 * scrolls to 80 px above the heading, not 52, and the scroll positions below
 * put a heading in that band. Added: the rail and `DocumentContents` mark the
 * same heading; Escape closes the open panel from anywhere; the host seams
 * (`hidden`, `onAvailableChange`, `panelAction`, `contentSelector`).
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { installBandIntersectionObserver } from '../test-setup/bandIntersectionObserver';

const hasDom = typeof document !== 'undefined';
const rail = (hasDom ? await import('./MarkdownContentsRail') : {}) as typeof import('./MarkdownContentsRail');
const { DocumentContents } = (hasDom ? await import('./DocumentContents') : {}) as typeof import('./DocumentContents');
const { parseMarkdownToBlocks } = (hasDom ? await import('../utils/parser') : {}) as typeof import('../utils/parser');
const { buildMarkdownContentsModel, canShowContentsRail, condenseMarkdownContentsMarkers, MarkdownContentsRail, resolveContentsRailGeometry } = rail;

const MARKDOWN = `# Overview

Opening context.

## Planning

Planning details.

### Risks

Risk details.

## Review

Review details.

#### Evidence

Evidence details.
`;

function rect({ top = 0, left = 0, width = 0, height = 0 }: { top?: number; left?: number; width?: number; height?: number }): DOMRect {
  return new DOMRect(left, top, width, height);
}

interface Fixture {
  readonly root: Root;
  readonly viewport: HTMLElement;
  readonly scrollTo: ReturnType<typeof mock>;
  readonly headings: readonly HTMLElement[];
  readonly mount: HTMLElement;
}

type RailProps = Partial<import('./MarkdownContentsRail').MarkdownContentsRailProps>;

function mountRail({
  contentRight = 858,
  markdown = MARKDOWN,
  reducedMotion = false,
  scrollbarWidth = 0,
  viewportLeft = 320,
  viewportWidth = 800,
  contentAttribute = 'documentReadContent',
  props = {},
  withContents = false,
}: {
  contentRight?: number;
  markdown?: string;
  reducedMotion?: boolean;
  scrollbarWidth?: number;
  viewportLeft?: number;
  viewportWidth?: number;
  contentAttribute?: string;
  props?: RailProps;
  withContents?: boolean;
} = {}): Fixture {
  window.matchMedia = ((query: string) =>
    ({
      matches: reducedMotion && query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;

  const frame = document.createElement('div');
  const viewport = document.createElement('div');
  const content = document.createElement('div');
  const mount = document.createElement('div');
  viewport.dataset.markdownReadSurface = '';
  content.dataset[contentAttribute] = '';
  frame.append(viewport, mount);
  viewport.append(content);
  document.body.append(frame);

  viewport.getBoundingClientRect = () => rect({ left: viewportLeft, width: viewportWidth, height: 600 });
  const model = buildMarkdownContentsModel(markdown);
  const contentHeight = Math.max(1200, model.length * 220 + 100);
  content.getBoundingClientRect = () => rect({ left: viewportLeft, width: contentRight - viewportLeft, height: contentHeight });
  if (scrollbarWidth > 0) {
    Object.defineProperty(viewport, 'offsetWidth', { configurable: true, value: viewportWidth });
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: viewportWidth - scrollbarWidth });
  }
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 600 });
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: contentHeight });

  const headings = model.map((item, index) => {
    const heading = document.createElement(`h${item.level}`);
    heading.dataset.blockType = 'heading';
    heading.dataset.blockId = item.blockId;
    heading.id = `section-${index}`;
    heading.textContent = item.label;
    const absoluteTop = 40 + index * 220;
    heading.getBoundingClientRect = () => rect({ top: absoluteTop - viewport.scrollTop, left: 80, width: 500, height: 32 });
    Object.defineProperty(heading, 'animate', { configurable: true, value: mock(() => {}) });
    content.append(heading);
    return heading;
  });

  const scrollTo = mock((options: ScrollToOptions) => {
    viewport.scrollTop = Math.min(Number(options.top ?? 0), Math.max(0, viewport.scrollHeight - viewport.clientHeight));
    viewport.dispatchEvent(new Event('scroll'));
  });
  Object.defineProperty(viewport, 'scrollTo', { configurable: true, value: scrollTo });

  const root = createRoot(mount);
  act(() => {
    root.render(
      <>
        <MarkdownContentsRail markdown={markdown} scrollViewport={viewport} documentPath="reviews/readiness.md" {...props} />
        {withContents && (
          <DocumentContents blocks={parseMarkdownToBlocks(markdown)} annotations={[]} scrollViewport={viewport} />
        )}
      </>,
    );
  });
  return { root, viewport, scrollTo, headings, mount };
}

async function settleRail(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

function contentMarkers(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[data-contents-index]'));
}

function railElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[aria-label="Document contents"]');
}

function key(target: EventTarget, init: KeyboardEventInit) {
  act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
}

async function scrollViewportTo(fixture: Fixture, top: number) {
  act(() => {
    fixture.viewport.scrollTop = top;
    fixture.viewport.dispatchEvent(new Event('scroll'));
  });
  await settleRail();
}

let restoreObserver: (() => void) | null = null;
const realRaf = hasDom ? globalThis.requestAnimationFrame : undefined;
const realCaf = hasDom ? globalThis.cancelAnimationFrame : undefined;
const realMatchMedia = hasDom ? window.matchMedia : undefined;

beforeAll(() => {
  if (!hasDom) return;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0)) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((handle: number) => window.clearTimeout(handle)) as typeof cancelAnimationFrame;
});

afterAll(() => {
  if (!hasDom) return;
  globalThis.requestAnimationFrame = realRaf!;
  globalThis.cancelAnimationFrame = realCaf!;
  window.matchMedia = realMatchMedia!;
});

beforeEach(() => {
  if (!hasDom) return;
  document.body.innerHTML = '';
  restoreObserver = installBandIntersectionObserver();
});

afterEach(() => {
  if (!hasDom) return;
  document.body.innerHTML = '';
  restoreObserver?.();
  restoreObserver = null;
});

describe.if(hasDom)('Markdown Contents rail', () => {
  test('builds paths and excerpts from the shared Markdown parse', () => {
    const model = buildMarkdownContentsModel(`${MARKDOWN}\n##### Hidden depth\n\nNot indexed.\n`);
    expect(model.map((item) => item.label)).toEqual(['Overview', 'Planning', 'Risks', 'Review', 'Evidence']);
    expect(model[2]).toMatchObject({
      breadcrumb: 'Overview / Planning / Risks',
      excerpt: 'Risk details.',
    });
    expect(new Set(model.map((item) => item.key)).size).toBe(model.length);
    const duplicateTitles = buildMarkdownContentsModel('## Same\n\nOne.\n\n## Same\n\nTwo.');
    expect(duplicateTitles.map((item) => item.label)).toEqual(['Same', 'Same']);
    expect(new Set(duplicateTitles.map((item) => item.key)).size).toBe(2);
    // The excerpt is the first text after the heading, cut at 180 characters.
    const long = buildMarkdownContentsModel(`## Long\n\n${'word '.repeat(60)}`)[0]!;
    expect(long.excerpt!.length).toBeLessThanOrEqual(178);
    expect(long.excerpt!.endsWith('…')).toBe(true);
  });

  test('condenses long documents into ten ordered spans with semantic representatives', () => {
    const items = Array.from({ length: 30 }, (_, index) => ({
      key: `section-${index}`,
      blockId: `section-${index}`,
      label: `Section ${index}`,
      level: index === 1 || index === 28 ? 2 : 4,
      breadcrumb: `Section ${index}`,
      excerpt: null,
    }));
    const markers = condenseMarkdownContentsMarkers(items);

    expect(markers).toHaveLength(10);
    expect(markers[0]).toEqual({ itemIndex: 1, rangeStart: 0, rangeEnd: 2 });
    expect(markers[9]).toEqual({ itemIndex: 28, rangeStart: 27, rangeEnd: 29 });
    expect(markers.map((marker) => marker.itemIndex)).toEqual([1, 4, 7, 10, 13, 16, 19, 22, 25, 28]);

    const unevenItems = Array.from({ length: 35 }, (_, index) => ({
      key: `uneven-${index}`,
      blockId: `uneven-${index}`,
      label: `Uneven ${index}`,
      level: 3,
      breadcrumb: `Uneven ${index}`,
      excerpt: null,
    }));
    const unevenMarkers = condenseMarkdownContentsMarkers(unevenItems);
    for (let itemIndex = 0; itemIndex < unevenItems.length; itemIndex++) {
      expect(unevenMarkers.filter((marker) => itemIndex >= marker.rangeStart && itemIndex <= marker.rangeEnd)).toHaveLength(1);
    }
  });

  test('anchors the dock 24px right of the reading column without sizing the panel', () => {
    // `left` is the dock's left edge.
    expect(resolveContentsRailGeometry(1120, 858, 32, 700)).toEqual({ left: 882, top: 382 });
    expect(resolveContentsRailGeometry(1000, 800, 32, 700)).toEqual({ left: 824, top: 382 });
    expect(resolveContentsRailGeometry(1000, 960, 32, 700)).toEqual({ left: 956, top: 382 });
    expect(canShowContentsRail(800, 1120, 858)).toBe(true);
    expect(canShowContentsRail(479, 1000, 800)).toBe(false);
    expect(canShowContentsRail(800, 1120, 1053)).toBe(false);
    expect(canShowContentsRail(480, 1000, 932)).toBe(true);
  });

  test('keeps the dock after content while the fixed panel opens left over it', async () => {
    const fixture = mountRail();
    await settleRail();
    const nav = railElement();
    expect(nav).not.toBeNull();
    // The nav box is [panel 256][gap 6][dock 36]; the dock starts at 858 + 24.
    expect(nav?.style.left).toBe('620px');
    expect(nav?.style.getPropertyValue('--pn-contents-dock-width')).toBe('36px');
    expect(nav?.style.getPropertyValue('--pn-contents-panel-gap')).toBe('6px');
    expect(nav?.style.getPropertyValue('--pn-contents-panel-width')).toBe('256px');
    // Vertically centred on the pane.
    expect(nav?.style.top).toBe('300px');
    act(() => fixture.root.unmount());
  });

  // The comments column docks as the document pane's right sibling, so the
  // pane's right edge IS the column's edge. With comments open the gutter is
  // 64px at a 1440 window (the rail hides) and 70px at 1600 (it fits, clear of
  // the column and its resize edge).
  test('hides beside an open comments column at 1440', async () => {
    const fixture = mountRail({ viewportLeft: 275, viewportWidth: 877, contentRight: 1088 });
    await settleRail();
    expect(railElement()).toBeNull();
    act(() => fixture.root.unmount());
  });

  test('fits beside an open comments column at 1600 without touching its edge', async () => {
    const fixture = mountRail({ viewportLeft: 275, viewportWidth: 1037, contentRight: 1242 });
    await settleRail();
    const nav = railElement();
    expect(nav).not.toBeNull();
    const dockLeft = Number.parseFloat(nav!.style.left) + 256 + 6;
    expect(dockLeft).toBe(1242 + 24);
    // The column starts at 1312; the 16px resize edge straddles it by 8px.
    expect(dockLeft + 36).toBeLessThanOrEqual(1312 - 8);
    act(() => fixture.root.unmount());
  });

  test('measures the marker lane inside the scroll surface’s scrollbar', async () => {
    const fixture = mountRail({ viewportLeft: 275, viewportWidth: 1037, contentRight: 1242, scrollbarWidth: 15 });
    await settleRail();
    expect(railElement()).toBeNull();
    act(() => fixture.root.unmount());
  });

  test('hides the rail in compact document panes', async () => {
    const fixture = mountRail({ contentRight: 120, viewportLeft: 0, viewportWidth: 320 });
    await settleRail();
    expect(railElement()).toBeNull();
    act(() => fixture.root.unmount());
  });

  test('hides the rail when the document padding cannot hold its marker lane', async () => {
    const fixture = mountRail({ contentRight: 1070, viewportLeft: 320, viewportWidth: 800 });
    await settleRail();
    expect(railElement()).toBeNull();
    act(() => fixture.root.unmount());
  });

  test('hides with fewer than four headings', async () => {
    const fixture = mountRail({ markdown: '# One\n\nA.\n\n## Two\n\nB.\n\n## Three\n\nC.\n' });
    await settleRail();
    expect(railElement()).toBeNull();
    act(() => fixture.root.unmount());
  });

  test('uses one active tab stop and supports keyboard section navigation', async () => {
    const fixture = mountRail();
    await settleRail();
    const nav = railElement();
    const markers = contentMarkers();
    expect(markers).toHaveLength(5);
    expect(markers[0].getAttribute('aria-current')).toBe('location');
    expect(markers.map((marker) => marker.tabIndex)).toEqual([0, -1, -1, -1, -1]);

    act(() => markers[0].focus());
    key(markers[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(markers[1]);

    key(markers[1], { key: 'Enter' });
    expect(nav?.dataset.revealed).toBe('');
    expect(fixture.scrollTo).not.toHaveBeenCalled();

    key(markers[1], { key: 'Enter' });
    // The heading (260 px down) lands on the scroll-spy band's top, 80 px below the pane's top.
    expect(fixture.scrollTo).toHaveBeenCalledWith({ top: 180, behavior: 'smooth' });
    expect(markers[1].getAttribute('aria-current')).toBe('location');

    // "Risks" (480 px down) scrolled to 60 px: it reaches the band.
    await scrollViewportTo(fixture, 420);
    expect(markers[2].getAttribute('aria-current')).toBe('location');
    act(() => fixture.root.unmount());
  });

  test('uses instant scrolling and no heading highlight under reduced motion', async () => {
    const fixture = mountRail({ reducedMotion: true });
    await settleRail();
    const nav = railElement();
    const markers = contentMarkers();
    act(() => markers[2].click());
    expect(nav?.dataset.revealed).toBe('');
    expect(fixture.scrollTo).not.toHaveBeenCalled();
    act(() => markers[2].click());
    expect(fixture.scrollTo).toHaveBeenCalledWith({ top: 400, behavior: 'auto' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(fixture.headings[2].animate).not.toHaveBeenCalled();
    act(() => fixture.root.unmount());
  });

  test('keeps the closed map still and reserves the local hover lens for open contents', async () => {
    const fixture = mountRail();
    await settleRail();
    const nav = railElement();
    const markers = contentMarkers();
    const labels = Array.from(document.querySelectorAll<HTMLElement>('.pn-contents-rail-label'));
    expect(nav).not.toBeNull();
    expect(nav?.dataset.revealed).toBeUndefined();
    expect(nav?.style.left).toBe('620px');
    expect(nav?.style.getPropertyValue('--pn-contents-panel-width')).toBe('256px');
    expect(labels.map((label) => label.textContent)).toEqual(['Overview', 'Planning', 'Risks', 'Review', 'Evidence']);

    act(() => {
      markers[0].dispatchEvent(new Event('pointerover', { bubbles: true }));
    });
    expect(nav?.dataset.revealed).toBeUndefined();
    expect(markers[0].dataset.highlighted).toBeUndefined();

    act(() => markers[0].click());
    expect(nav?.dataset.revealed).toBe('');
    act(() => {
      markers[0].dispatchEvent(new Event('pointerover', { bubbles: true }));
    });
    expect(markers[0].dataset.highlighted).toBe('');
    expect(markers.every((marker) => marker.getAttribute('aria-expanded') === 'true')).toBe(true);
    expect(fixture.scrollTo).not.toHaveBeenCalled();
    expect(document.querySelector('.pn-contents-rail-surface')).not.toBeNull();
    expect(markers.map((marker) => marker.dataset.depth)).toEqual(['0', '1', '2', '1', '3']);
    expect(markers.map((marker) => marker.dataset.level)).toEqual(['1', '2', '3', '2', '4']);
    // Each heading's breadcrumb is its accessible name.
    expect(markers[2].getAttribute('aria-label')).toBe('Go to Overview / Planning / Risks');
    expect(document.querySelector('[role=tooltip]')).toBeNull();

    act(() => labels[1].click());
    expect(fixture.scrollTo).toHaveBeenCalledWith({ top: 180, behavior: 'smooth' });

    act(() => markers[1].focus());
    key(markers[1], { key: 'Escape' });
    expect(nav?.dataset.revealed).toBeUndefined();
    expect(document.activeElement).not.toBe(markers[1]);
    act(() => fixture.root.unmount());
  });

  test('maps long-document scroll progress across ten closed markers', async () => {
    const markdown = Array.from({ length: 35 }, (_, index) => `## Section ${index + 1}\n\nDetails for section ${index + 1}.`).join('\n\n');
    const fixture = mountRail({ markdown });
    await settleRail();
    const nav = railElement();

    expect(contentMarkers()).toHaveLength(10);
    expect(contentMarkers()[0].getAttribute('aria-current')).toBe('location');

    // Section 18 (index 17) on the band's top.
    await scrollViewportTo(fixture, 40 + 17 * 220 - 80);
    expect(contentMarkers()).toHaveLength(10);
    expect(contentMarkers().findIndex((marker) => marker.getAttribute('aria-current') === 'location')).toBe(4);
    expect(contentMarkers()[4].dataset.contentsIndex).toBe('17');
    expect(new Set(contentMarkers().map((marker) => marker.dataset.contentsIndex)).size).toBe(10);

    // The end of the document: the last heading in the band (index 33; 34 sits below it) is current, in the last slot.
    await scrollViewportTo(fixture, fixture.viewport.scrollHeight - fixture.viewport.clientHeight);
    expect(contentMarkers().findIndex((marker) => marker.getAttribute('aria-current') === 'location')).toBe(9);
    expect(contentMarkers()[9].dataset.contentsIndex).toBe('33');

    act(() => contentMarkers()[9].click());
    expect(nav?.dataset.revealed).toBe('');
    expect(contentMarkers()).toHaveLength(35);
    act(() => fixture.root.unmount());
  });

  test('dismisses an opened contents panel with an outside pointer', async () => {
    const fixture = mountRail();
    await settleRail();
    const nav = railElement();
    act(() => contentMarkers()[0]?.click());
    expect(nav?.dataset.revealed).toBe('');
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(nav?.dataset.revealed).toBeUndefined();
    act(() => fixture.root.unmount());
  });

  test('Escape closes the open panel wherever focus is, before a host’s own Escape', async () => {
    const fixture = mountRail();
    await settleRail();
    const hostEscapes: string[] = [];
    const onHostKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) hostEscapes.push('host');
    };
    document.addEventListener('keydown', onHostKey);
    try {
      act(() => contentMarkers()[0]?.click());
      expect(railElement()?.dataset.revealed).toBe('');
      key(document.body, { key: 'Escape' });
      expect(railElement()?.dataset.revealed).toBeUndefined();
      expect(hostEscapes).toEqual([]);
      // Closed, the next Escape is the host's.
      key(document.body, { key: 'Escape' });
      expect(hostEscapes).toEqual(['host']);
    } finally {
      document.removeEventListener('keydown', onHostKey);
    }
    act(() => fixture.root.unmount());
  });

  test('marks the same heading as DocumentContents (TableOfContents) at every scroll position', async () => {
    const fixture = mountRail({ withContents: true });
    await settleRail();
    const railMarked = () => {
      const current = document.querySelector<HTMLElement>('[data-contents-index][aria-current="location"] .pn-contents-rail-label');
      return current?.textContent ?? null;
    };
    const listMarked = () => document.querySelector('nav[aria-label="Table of contents"] button[aria-current="location"]')?.textContent ?? null;
    // Mounted at the top: both read the band the same way.
    expect(railMarked()).toBe('Overview');
    expect(listMarked()).toBe('Overview');
    for (const [top, expected] of [
      [200, 'Planning'],
      [250, 'Planning'],
      [420, 'Risks'],
      [600, 'Review'],
      [300, 'Review'],
    ] as const) {
      await scrollViewportTo(fixture, top);
      expect(railMarked()).toBe(expected);
      // TableOfContents lists levels 1 to 3 only; the rail adds level 4 (Evidence), which is never reached here.
      expect(listMarked()).toBe(expected);
    }
    act(() => fixture.root.unmount());
  });

  test('host seams: a hidden rail still reports whether it fits; panelAction shows only in the open panel', async () => {
    const reports: boolean[] = [];
    const fixture = mountRail({ props: { hidden: true, onAvailableChange: (fits) => reports.push(fits) } });
    await settleRail();
    expect(railElement()).toBeNull();
    expect(reports).toEqual([true]);
    act(() => fixture.root.unmount());
    document.body.innerHTML = '';

    const narrowReports: boolean[] = [];
    const narrow = mountRail({ contentRight: 1070, props: { onAvailableChange: (fits) => narrowReports.push(fits) } });
    await settleRail();
    expect(narrowReports).toEqual([false]);
    act(() => narrow.root.unmount());
    document.body.innerHTML = '';

    const shown = mountRail({ props: { panelAction: <button type="button" data-host-action="">Hide</button> } });
    await settleRail();
    expect(document.querySelector('[data-host-action]')).toBeNull();
    act(() => contentMarkers()[0]?.click());
    const action = document.querySelector<HTMLElement>('[data-host-action]');
    expect(action).not.toBeNull();
    expect(railElement()?.contains(action)).toBe(true);
    // Focus moving from a heading to the host's control keeps the panel open.
    act(() => contentMarkers()[0]?.focus());
    act(() => action!.focus());
    expect(railElement()?.dataset.revealed).toBe('');
    act(() => shown.root.unmount());
  });

  test('a host names its reading column with contentSelector', async () => {
    const fixture = mountRail({ contentAttribute: 'docTextRoot', props: { contentSelector: '[data-doc-text-root]' } });
    await settleRail();
    expect(railElement()?.style.left).toBe('620px');
    act(() => fixture.root.unmount());
  });
});

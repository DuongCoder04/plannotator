// Moved from the Workspaces app's MarkdownContentsRail (apps/web/src/plannotator/
// MarkdownContentsRail.tsx), the document contents rail approved 2026-10-03
// ("it should just be on the right side": the ticks in the document's right
// gutter, the Contents panel on click, no hover reveal, no Left/Right setting).
// The owner approved the move into @plannotator/ui on 2026-10-30 so the
// Plannotator Inbox can use it. Port:
// - Workspaces-only imports moved into the package: the shared parse memo
//   (utils/blockParse) and usePrefersReducedMotion (hooks/); `cn` had nothing
//   left to join once the `floating-surface` chrome and the EYEBROW title
//   became the rail's own
//   `pn-contents-rail-*` rules in theme.css, on the same tokens
//   (--popover, --shadow-menu, --geometry-floating-radius, ...) with fallbacks.
//   The `ws-markdown-contents-*` classes and `--ws-contents-*` properties are
//   `pn-contents-rail-*` and `--pn-contents-*`.
// - ONE scroll-spy: the heading being read comes from the package's
//   `useDocumentActiveSection` (over `useActiveSection`, plan review's), not
//   the rail's own activation line, so the rail and every `TableOfContents`
//   mark the same heading. A pick scrolls the heading to that band's top.
// - The headings come from `tocHeadings(blocks, 4)`.
// - Host seams, all optional (Workspaces passes none and is unchanged):
//   `blocks` (a host that parsed already), `contentSelector` (the reading
//   column), `hidden` + `onAvailableChange` (a host's own hide choice and
//   fallback), `panelAction` (one control in the open panel's title row).
// - Escape closes an open panel wherever focus is (the approved shape:
//   "Escape closes"), before a host's own Escape handling sees the key.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import type { Block } from '../types';
import { extractFrontmatter } from '../utils/parser';
import { parseBlocksShared } from '../utils/blockParse';
import { CONTENTS_RAIL_MAX_LEVEL, CONTENTS_RAIL_MIN_HEADINGS, tocHeadings } from '../utils/annotationHelpers';
import { ACTIVE_SECTION_BAND_TOP, useDocumentActiveSection } from '../hooks/useActiveSection';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';

const MIN_HEADING_COUNT = CONTENTS_RAIL_MIN_HEADINGS;
const COLLAPSED_MARKER_LIMIT = 10;
const PANEL_WIDTH = 256;
const DOCK_WIDTH = 36;
const PANEL_GAP = 6;
const CONTENT_GAP = 24;
const VIEWPORT_EDGE_INSET = 8;
const MIN_RAIL_VIEWPORT_WIDTH = 480;
const SMOOTH_SCROLL_SETTLE = 350;
const SCROLL_CORRECTION_THRESHOLD = 24;
/** The reading column, by default: the element Workspaces marks around its document. */
const DEFAULT_CONTENT_SELECTOR = '[data-document-read-content]';

export interface MarkdownContentsItem {
  readonly key: string;
  readonly blockId: string;
  readonly label: string;
  readonly level: number;
  readonly breadcrumb: string;
  readonly excerpt: string | null;
}

interface HeadingBinding {
  readonly itemIndex: number;
  readonly node: HTMLElement;
  readonly top: number;
}

interface RailGeometry {
  readonly left: number;
  readonly top: number;
}

export interface CondensedContentsMarker {
  readonly itemIndex: number;
  readonly rangeStart: number;
  readonly rangeEnd: number;
}

/** Place only the persistent marker dock in the document's existing right
 * padding, 24px right of the reading column (owner ruling 2026-10-03: the
 * rail returns to the right gutter it held from PR 76 until PR 241). The
 * Contents surface opens to the LEFT as an overlay, away from a docked
 * comments column, so this accessory never changes document width. `left`
 * is the dock's left edge. */
export function resolveContentsRailGeometry(
  viewportRight: number,
  contentRight: number,
  viewportTop: number,
  viewportHeight: number,
): RailGeometry {
  return {
    left: Math.min(
      Math.floor(viewportRight - VIEWPORT_EDGE_INSET - DOCK_WIDTH),
      Math.floor(contentRight + CONTENT_GAP),
    ),
    top: Math.round(viewportTop + viewportHeight / 2),
  };
}

/** Keep the rail out of compact document panes and require a complete marker
 * lane in the document's existing right padding. The pane's right edge is the
 * docked comments (or people) column's edge when one is open, so the rail
 * yields to the column instead of overlapping it or its resize edge. The
 * panel itself may still overlay the prose once the marker lane qualifies. */
export function canShowContentsRail(
  viewportWidth: number,
  viewportRight: number,
  contentRight: number,
): boolean {
  return (
    viewportWidth >= MIN_RAIL_VIEWPORT_WIDTH &&
    viewportRight - contentRight >= VIEWPORT_EDGE_INSET + DOCK_WIDTH + CONTENT_GAP
  );
}

function plainText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_, target: string, label?: string) => label ?? target,
    )
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`~>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function excerptAfterHeading(blocks: readonly Block[], headingIndex: number): string | null {
  for (let index = headingIndex + 1; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.type === 'heading') return null;
    if (block.type === 'code' || block.type === 'html' || block.type === 'hr') continue;
    const text = plainText(block.content);
    if (text.length === 0) continue;
    return text.length > 180 ? `${text.slice(0, 177).trimEnd()}…` : text;
  }
  return null;
}

interface ContentsIndex {
  readonly items: readonly MarkdownContentsItem[];
  /** Every heading's block id to the item it reads under (a level 5 or 6 heading: the item above it). */
  readonly sectionOf: ReadonlyMap<string, number>;
}

function buildContentsIndex(blocks: readonly Block[]): ContentsIndex {
  const listed = new Set(tocHeadings(blocks, CONTENTS_RAIL_MAX_LEVEL));
  const parents: Array<{ level: number; label: string }> = [];
  const items: MarkdownContentsItem[] = [];
  const sectionOf = new Map<string, number>();

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.type !== 'heading') continue;
    if (!listed.has(block)) {
      if (items.length > 0) sectionOf.set(block.id, items.length - 1);
      continue;
    }
    const level = Math.min(6, Math.max(1, block.level ?? 1));
    const label = plainText(block.content) || 'Untitled section';
    while (parents.length > 0 && parents.at(-1)!.level >= level) parents.pop();
    const breadcrumb = [...parents.map((entry) => entry.label), label].join(' / ');
    sectionOf.set(block.id, items.length);
    items.push({
      key: block.id,
      blockId: block.id,
      label,
      level,
      breadcrumb,
      excerpt: excerptAfterHeading(blocks, index),
    });
    parents.push({ level, label });
  }

  return { items, sectionOf };
}

function markdownBlocks(markdown: string): Block[] {
  return parseBlocksShared(extractFrontmatter(markdown).content);
}

/**
 * Build the semantic index from the same cached parse the Viewer consumes.
 * DOM binding happens later, after the package has assigned its duplicate-safe
 * heading anchors. Scroll never reparses or searches the document.
 */
export function buildMarkdownContentsModel(markdown: string): readonly MarkdownContentsItem[] {
  return buildContentsIndex(markdownBlocks(markdown)).items;
}

/**
 * Divide a long document into ten ordered spans, then represent each span with
 * its shallowest heading nearest the span midpoint. This is one O(n) pass when
 * the Markdown model changes; scroll updates only map the active index to a
 * slot with arithmetic.
 */
export function condenseMarkdownContentsMarkers(
  items: readonly MarkdownContentsItem[],
): readonly CondensedContentsMarker[] {
  if (items.length <= COLLAPSED_MARKER_LIMIT) {
    return items.map((_, itemIndex) => ({
      itemIndex,
      rangeStart: itemIndex,
      rangeEnd: itemIndex,
    }));
  }

  return Array.from({ length: COLLAPSED_MARKER_LIMIT }, (_, slotIndex) => {
    const rangeStart = Math.ceil((slotIndex * items.length) / COLLAPSED_MARKER_LIMIT);
    const rangeEnd = Math.ceil(((slotIndex + 1) * items.length) / COLLAPSED_MARKER_LIMIT) - 1;
    const midpoint = (rangeStart + rangeEnd) / 2;
    let itemIndex = rangeStart;

    for (let candidateIndex = rangeStart + 1; candidateIndex <= rangeEnd; candidateIndex++) {
      const candidate = items[candidateIndex];
      const current = items[itemIndex];
      if (
        candidate.level < current.level ||
        (candidate.level === current.level &&
          Math.abs(candidateIndex - midpoint) < Math.abs(itemIndex - midpoint))
      ) {
        itemIndex = candidateIndex;
      }
    }

    return { itemIndex, rangeStart, rangeEnd };
  });
}

function condensedSlotForItem(itemIndex: number, itemCount: number, slotCount: number): number {
  if (itemCount <= 0 || slotCount <= 1) return 0;
  const boundedIndex = Math.min(itemCount - 1, Math.max(0, itemIndex));
  return Math.min(slotCount - 1, Math.floor((boundedIndex * slotCount) / itemCount));
}

function topInsideViewport(node: HTMLElement, viewport: HTMLElement): number {
  const viewportRect = viewport.getBoundingClientRect();
  return node.getBoundingClientRect().top - viewportRect.top + viewport.scrollTop;
}

function setViewportScroll(viewport: HTMLElement, top: number, behavior: ScrollBehavior): void {
  viewport.scrollTo({ top: Math.max(0, top), behavior });
}

export interface MarkdownContentsRailProps {
  /** The document's Markdown (frontmatter is skipped). Ignored when `blocks` is given. */
  readonly markdown?: string;
  /** The document's parsed blocks, for a host that already has them (the Viewer's). */
  readonly blocks?: readonly Block[];
  /** The element the document scrolls in; the rail sits in its right gutter. */
  readonly scrollViewport: HTMLElement | null;
  /** Unused by the rail; kept so Workspaces' call site compiles unchanged. */
  readonly documentPath?: string;
  /**
   * The reading column inside `scrollViewport`: the dock goes 24 px right of
   * its right edge. Default `[data-document-read-content]` (Workspaces). The
   * Plannotator Inbox passes the Viewer's `[data-doc-text-root]`.
   */
  readonly contentSelector?: string;
  /**
   * The host's own hide choice: the rail keeps measuring (so
   * `onAvailableChange` still reports) but draws nothing. Default false.
   */
  readonly hidden?: boolean;
  /**
   * Whether the rail can show: enough headings, a pane at least 480 px wide
   * and a 68 px gutter. Called when it changes, so a host can offer its own
   * way to Contents when the rail yields.
   */
  readonly onAvailableChange?: (available: boolean) => void;
  /**
   * One host control drawn at the right of the open panel's "Contents" title
   * (the Inbox's Hide). Shown only while the panel is open; Tab reaches it
   * after the headings. Default: none.
   */
  readonly panelAction?: ReactNode;
}

export function MarkdownContentsRail({
  markdown = '',
  blocks: hostBlocks,
  scrollViewport,
  contentSelector = DEFAULT_CONTENT_SELECTOR,
  hidden = false,
  onAvailableChange,
  panelAction,
}: MarkdownContentsRailProps) {
  const { items, sectionOf } = useMemo(
    () => buildContentsIndex(hostBlocks ?? markdownBlocks(markdown)),
    [hostBlocks, markdown],
  );
  const reducedMotion = usePrefersReducedMotion();
  // null until the first measure: nothing is reported before the rail knows.
  const [available, setAvailable] = useState<boolean | null>(null);
  const [interactionIndex, setInteractionIndex] = useState<number | null>(null);
  const [titlesVisible, setTitlesVisible] = useState(false);
  const [railGeometry, setRailGeometry] = useState<RailGeometry>({
    left: VIEWPORT_EDGE_INSET,
    top: 0,
  });
  // The package's one scroll-spy (plan review's): the same heading every TableOfContents marks.
  const activeBlockId = useDocumentActiveSection(scrollViewport, items.length);
  const activeIndex = (activeBlockId === null ? undefined : sectionOf.get(activeBlockId)) ?? 0;
  const visible = available === true && !hidden;
  const condensedMarkers = useMemo(() => condenseMarkdownContentsMarkers(items), [items]);
  const safeActiveIndex = Math.min(Math.max(0, activeIndex), Math.max(0, items.length - 1));
  const collapsedActiveSlot = condensedSlotForItem(
    safeActiveIndex,
    items.length,
    condensedMarkers.length,
  );
  const renderedItemIndexes = useMemo(
    () =>
      titlesVisible
        ? items.map((_, itemIndex) => itemIndex)
        : condensedMarkers.map((marker, slotIndex) =>
            slotIndex === collapsedActiveSlot ? safeActiveIndex : marker.itemIndex,
          ),
    [collapsedActiveSlot, condensedMarkers, items, safeActiveIndex, titlesVisible],
  );
  const bindingsRef = useRef<readonly HeadingBinding[]>([]);
  const markerRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const measureFrameRef = useRef<number | null>(null);
  const correctionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrubbingRef = useRef(false);
  const scrubbedIndexRef = useRef<number | null>(null);
  const onAvailableChangeRef = useRef(onAvailableChange);
  onAvailableChangeRef.current = onAvailableChange;

  const measure = useCallback(() => {
    if (scrollViewport === null || items.length < MIN_HEADING_COUNT) {
      bindingsRef.current = [];
      setAvailable(false);
      return;
    }

    const renderedHeadings = Array.from(
      scrollViewport.querySelectorAll<HTMLElement>('[data-block-type="heading"]'),
    );
    const nodesByBlockId = new Map(
      renderedHeadings.map((node) => [node.dataset.blockId ?? '', node]),
    );
    const bindings = items.flatMap<HeadingBinding>((item, itemIndex) => {
      const node = nodesByBlockId.get(item.blockId);
      return node === undefined
        ? []
        : [{ itemIndex, node, top: topInsideViewport(node, scrollViewport) }];
    });
    bindings.sort((left, right) => left.top - right.top);
    bindingsRef.current = bindings;

    const viewportRect = scrollViewport.getBoundingClientRect();
    // The scroll surface's own scrollbar sits in the right gutter: measure
    // the lane up to the scrollbar, never under it.
    const scrollbarWidth =
      scrollViewport.clientWidth > 0
        ? Math.max(
            0,
            scrollViewport.offsetWidth - scrollViewport.clientWidth - scrollViewport.clientLeft,
          )
        : 0;
    const viewportRight = viewportRect.right - scrollbarWidth;
    const content = scrollViewport.querySelector<HTMLElement>(contentSelector);
    const contentRect = content?.getBoundingClientRect();
    const hasRailSpace =
      contentRect !== undefined &&
      canShowContentsRail(viewportRect.width, viewportRight, contentRect.right);
    const geometry = resolveContentsRailGeometry(
      viewportRight,
      contentRect?.right ?? viewportRight - VIEWPORT_EDGE_INSET - DOCK_WIDTH - CONTENT_GAP,
      viewportRect.top,
      viewportRect.height,
    );
    setRailGeometry((current) =>
      current.left === geometry.left && current.top === geometry.top ? current : geometry,
    );
    setAvailable(bindings.length >= MIN_HEADING_COUNT && hasRailSpace);
  }, [contentSelector, items, scrollViewport]);

  const scheduleMeasure = useCallback(() => {
    if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current);
    measureFrameRef.current = requestAnimationFrame(() => {
      measureFrameRef.current = null;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    setInteractionIndex(null);
    setTitlesVisible(false);
  }, [items]);

  useEffect(() => {
    if (available !== null) onAvailableChangeRef.current?.(available);
  }, [available]);

  useEffect(() => {
    if (scrollViewport === null || items.length < MIN_HEADING_COUNT) {
      setAvailable(false);
      return;
    }

    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(measure);
    });
    scrollViewport.addEventListener('load', scheduleMeasure, true);
    window.addEventListener('resize', scheduleMeasure);

    const content = scrollViewport.querySelector<HTMLElement>(contentSelector);
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMeasure);
    resizeObserver?.observe(scrollViewport);
    if (content !== null) resizeObserver?.observe(content);

    const mutationObserver =
      content === null || typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(scheduleMeasure);
    if (content !== null) mutationObserver?.observe(content, { childList: true, subtree: true });

    const fonts = typeof document === 'undefined' ? undefined : document.fonts;
    if (fonts !== undefined) void fonts.ready.then(scheduleMeasure);

    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current);
      scrollViewport.removeEventListener('load', scheduleMeasure, true);
      window.removeEventListener('resize', scheduleMeasure);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [contentSelector, items.length, measure, scheduleMeasure, scrollViewport]);

  useEffect(() => {
    const list = listRef.current;
    const marker = markerRefs.current[activeIndex];
    if (!visible || !titlesVisible || list === null || marker === null || marker === undefined)
      return;
    const markerTop = marker.offsetTop;
    const markerBottom = markerTop + marker.offsetHeight;
    if (markerTop < list.scrollTop) {
      list.scrollTop = markerTop;
    } else if (markerBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = markerBottom - list.clientHeight;
    }
  }, [activeIndex, titlesVisible, visible]);

  useEffect(
    () => () => {
      if (correctionTimerRef.current !== null) clearTimeout(correctionTimerRef.current);
    },
    [],
  );

  const closeTitles = useCallback(() => {
    setTitlesVisible(false);
    setInteractionIndex(null);
  }, []);

  useEffect(() => {
    if (!titlesVisible) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && railRef.current?.contains(target)) return;
      closeTitles();
    };
    // Escape closes the open panel wherever focus is (a tick press never takes focus),
    // before a host's own Escape (a full-screen view's) sees the key.
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && railRef.current?.contains(focused)) focused.blur();
      closeTitles();
    };
    document.addEventListener('pointerdown', closeOnOutsidePointerDown, true);
    window.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointerDown, true);
      window.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [closeTitles, titlesVisible]);

  const highlightHeading = useCallback(
    (node: HTMLElement) => {
      if (reducedMotion || typeof node.animate !== 'function') return;
      node.animate(
        [
          { backgroundColor: 'color-mix(in oklch, var(--primary) 16%, transparent)' },
          { backgroundColor: 'transparent' },
        ],
        { duration: 1400, easing: 'ease-out' },
      );
    },
    [reducedMotion],
  );

  const navigateTo = useCallback(
    (itemIndex: number, scrubbing: boolean) => {
      if (scrollViewport === null) return;
      const binding = bindingsRef.current.find((entry) => entry.itemIndex === itemIndex);
      if (binding === undefined) return;
      const behavior: ScrollBehavior = reducedMotion || scrubbing ? 'auto' : 'smooth';
      // The scroll-spy band's top: the heading lands in the band, so it is the one marked.
      const targetTop = topInsideViewport(binding.node, scrollViewport) - ACTIVE_SECTION_BAND_TOP;
      setViewportScroll(scrollViewport, targetTop, behavior);
      setInteractionIndex(itemIndex);

      if (correctionTimerRef.current !== null) clearTimeout(correctionTimerRef.current);
      correctionTimerRef.current = setTimeout(
        () => {
          const correctedTop =
            topInsideViewport(binding.node, scrollViewport) - ACTIVE_SECTION_BAND_TOP;
          if (Math.abs(scrollViewport.scrollTop - correctedTop) > SCROLL_CORRECTION_THRESHOLD) {
            setViewportScroll(scrollViewport, correctedTop, 'auto');
          }
          highlightHeading(binding.node);
        },
        behavior === 'smooth' ? SMOOTH_SCROLL_SETTLE : 0,
      );
    },
    [highlightHeading, reducedMotion, scrollViewport],
  );

  const openTitles = useCallback((index: number) => {
    setInteractionIndex(index);
    setTitlesVisible(true);
  }, []);

  const scrubAtPoint = useCallback(
    (clientX: number, clientY: number) => {
      const target = document.elementFromPoint(clientX, clientY);
      const marker = target?.closest<HTMLElement>('[data-contents-index]');
      if (marker === null || marker === undefined) return;
      const index = Number(marker.dataset.contentsIndex);
      if (!Number.isInteger(index) || scrubbedIndexRef.current === index) return;
      scrubbedIndexRef.current = index;
      navigateTo(index, true);
    },
    [navigateTo],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, index: number) => {
      if (!titlesVisible) {
        event.preventDefault();
        openTitles(index);
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      scrubbingRef.current = true;
      scrubbedIndexRef.current = index;
      navigateTo(index, true);
    },
    [navigateTo, openTitles, titlesVisible],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!scrubbingRef.current) return;
      scrubAtPoint(event.clientX, event.clientY);
    },
    [scrubAtPoint],
  );

  const endScrub = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    scrubbingRef.current = false;
    scrubbedIndexRef.current = null;
  }, []);

  const onMarkerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      const markerPosition = renderedItemIndexes.indexOf(index);
      let nextPosition: number | null = null;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeTitles();
        event.currentTarget.blur();
        return;
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        nextPosition = Math.min(renderedItemIndexes.length - 1, markerPosition + 1);
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        nextPosition = Math.max(0, markerPosition - 1);
      } else if (event.key === 'Home') {
        nextPosition = 0;
      } else if (event.key === 'End') {
        nextPosition = renderedItemIndexes.length - 1;
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (!titlesVisible) {
          openTitles(index);
          return;
        }
        navigateTo(index, false);
        return;
      }
      if (nextPosition === null || markerPosition < 0) return;
      event.preventDefault();
      const nextIndex = renderedItemIndexes[nextPosition];
      if (nextIndex !== undefined) markerRefs.current[nextIndex]?.focus();
    },
    [closeTitles, navigateTo, openTitles, renderedItemIndexes, titlesVisible],
  );

  /** Focus left the rail (not for another of its controls): the panel closes. */
  const closeWhenFocusLeaves = useCallback(
    (relatedTarget: EventTarget | null) => {
      if (!(relatedTarget instanceof Node) || !railRef.current?.contains(relatedTarget)) {
        closeTitles();
      }
    },
    [closeTitles],
  );

  if (!visible) return null;
  const baseLevel = Math.min(...items.map((item) => item.level));
  const railStyle = {
    // The nav box is [panel][gap][dock]; its left edge sits a panel and a
    // gap left of the dock so the surface opens over the prose margin.
    left: `${railGeometry.left - PANEL_GAP - PANEL_WIDTH}px`,
    top: `${railGeometry.top}px`,
    '--pn-contents-dock-width': `${DOCK_WIDTH}px`,
    '--pn-contents-panel-gap': `${PANEL_GAP}px`,
    '--pn-contents-panel-width': `${PANEL_WIDTH}px`,
  } as CSSProperties;

  // Layering: the rail is document chrome and renders in place, inside the
  // document pane, not portalled to <body>. A host keeps the pane its own
  // stacking context (an `isolate` ancestor) at the document level, so the
  // host's floaters and overlays cover the rail, and inside the pane the
  // diagram lightbox (z-50) covers it too. z-index 20 (theme.css) keeps it
  // above the read surface.
  return (
    <nav
      ref={railRef}
      className="pn-contents-rail"
      aria-label="Document contents"
      data-revealed={titlesVisible ? '' : undefined}
      style={railStyle}
      onPointerLeave={() => setInteractionIndex(null)}
    >
      <div className="pn-contents-rail-dock" aria-hidden="true" />
      <div className="pn-contents-rail-surface" aria-hidden="true" />
      <div className="pn-contents-rail-title" aria-hidden="true">
        Contents
      </div>
      <div ref={listRef} className="pn-contents-rail-list" role="list">
        {renderedItemIndexes.map((index, markerPosition) => {
          const item = items[index];
          if (item === undefined) return null;
          const current = titlesVisible
            ? index === activeIndex
            : markerPosition === collapsedActiveSlot;
          const highlighted = index === interactionIndex;
          return (
            <button
              key={item.key}
              ref={(node) => {
                markerRefs.current[index] = node;
              }}
              type="button"
              className="pn-contents-rail-marker"
              data-contents-index={index}
              data-current={current ? '' : undefined}
              data-highlighted={highlighted ? '' : undefined}
              data-level={item.level}
              data-depth={Math.min(3, Math.max(0, item.level - baseLevel))}
              aria-label={
                titlesVisible
                  ? `Go to ${item.breadcrumb}`
                  : `Open document contents at ${item.breadcrumb}`
              }
              aria-expanded={titlesVisible}
              aria-current={current ? 'location' : undefined}
              tabIndex={current ? 0 : -1}
              onClick={(event) => {
                if (!titlesVisible) {
                  openTitles(index);
                  return;
                }
                if (event.detail === 0) navigateTo(index, false);
              }}
              onFocus={() => {
                if (titlesVisible) setInteractionIndex(index);
              }}
              onBlur={(event) => closeWhenFocusLeaves(event.relatedTarget)}
              onPointerEnter={(event) => {
                if (titlesVisible && event.pointerType !== 'touch') {
                  setInteractionIndex(index);
                }
              }}
              onPointerDown={(event) => onPointerDown(event, index)}
              onPointerMove={onPointerMove}
              onPointerUp={endScrub}
              onPointerCancel={endScrub}
              onKeyDown={(event) => onMarkerKeyDown(event, index)}
            >
              <span className="pn-contents-rail-tick" aria-hidden="true">
                <span className="pn-contents-rail-line" />
              </span>
              <span className="pn-contents-rail-label" aria-hidden="true">
                {item.label}
              </span>
            </button>
          );
        })}
      </div>
      {titlesVisible && panelAction !== undefined && (
        <div
          className="pn-contents-rail-action"
          onBlur={(event) => closeWhenFocusLeaves(event.relatedTarget)}
        >
          {panelAction}
        </div>
      )}
    </nav>
  );
}

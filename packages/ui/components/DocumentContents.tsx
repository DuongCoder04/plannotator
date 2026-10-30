import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Annotation, Block } from '../types';
import { tocHeadings } from '../utils/annotationHelpers';
import { useActiveSection } from '../hooks/useActiveSection';
import { TableOfContents } from './TableOfContents';

interface DocumentContentsProps {
  blocks: Block[];
  annotations: Annotation[];
  /**
   * The element the document scrolls in. The current heading is read from it
   * and a click scrolls it. `null` until it has mounted.
   */
  scrollViewport: HTMLElement | null;
  /** Called with the heading's block id after a click (a sheet closes itself here). */
  onNavigate?: (blockId: string) => void;
  className?: string;
}

/**
 * `useActiveSection`'s band starts this far below the scroll element's top
 * (its `rootMargin` of -80px): a heading above it is one already read past.
 */
const BAND_TOP = 80;

/**
 * A document's Contents list for a host without plan review's sidebar: the
 * same `TableOfContents` (headings from `tocHeadings`, click to scroll, the
 * current heading highlighted) bound to one scroll element through
 * `useActiveSection`. It draws no chrome; the host places it and titles it.
 *
 * The host mounts it afresh (a sheet that opens, a list shown again, a new
 * placement), often mid-document, where no heading sits in the observer's
 * band. So on mount it marks the last heading already scrolled above the band
 * (the section being read) until the observer reports one. The marked entry
 * is kept in view inside the list's own scroll box (a capped column, a sheet).
 *
 * Key it by the document: the active-heading observer reads the headings
 * that are drawn when it mounts or when their count changes.
 */
export function DocumentContents({ blocks, annotations, scrollViewport, onNavigate, className = '' }: DocumentContentsProps) {
  // useActiveSection reads headings from the ref's element, else from the scroll element.
  const noContainer = useRef<HTMLElement | null>(null);
  const headings = useMemo(() => tocHeadings(blocks), [blocks]);
  const observed = useActiveSection(noContainer, headings.length, scrollViewport);
  const [seed, setSeed] = useState<string | null>(null);
  useLayoutEffect(() => {
    setSeed(scrollViewport ? headingReadIn(scrollViewport, new Set(headings.map((h) => h.id))) : null);
  }, [scrollViewport, headings]);
  const activeId = observed ?? seed;

  const wrapRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const item = wrapRef.current?.querySelector<HTMLElement>('[aria-current="location"]');
    if (item) revealInList(item);
  }, [activeId]);

  return (
    <div ref={wrapRef} style={{ display: 'contents' }}>
      <TableOfContents
        blocks={blocks}
        annotations={annotations}
        activeId={activeId}
        onNavigate={onNavigate ?? noop}
        scrollViewport={scrollViewport}
        className={className}
      />
    </div>
  );
}

/** The last listed heading whose top is above the band in `viewport` (the section being read), or null. */
function headingReadIn(viewport: HTMLElement, ids: ReadonlySet<string>): string | null {
  const bandTop = viewport.getBoundingClientRect().top + BAND_TOP;
  let read: string | null = null;
  for (const heading of viewport.querySelectorAll<HTMLElement>('[data-block-type="heading"][data-block-id]')) {
    const id = heading.getAttribute('data-block-id')!;
    if (!ids.has(id)) continue;
    if (heading.getBoundingClientRect().top > bandTop) break;
    read = id;
  }
  return read;
}

/**
 * Scroll the list's own scroll box (the nearest ancestor that scrolls) just
 * enough to show `item`, at once. Never the page or the document behind it.
 */
function revealInList(item: HTMLElement) {
  let box = item.parentElement;
  while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  if (!box || box.scrollHeight <= box.clientHeight) return;
  const area = box.getBoundingClientRect();
  const rect = item.getBoundingClientRect();
  if (rect.top < area.top) box.scrollTop -= area.top - rect.top;
  else if (rect.bottom > area.bottom) box.scrollTop += Math.min(rect.bottom - area.bottom, rect.top - area.top);
}

function noop() {}

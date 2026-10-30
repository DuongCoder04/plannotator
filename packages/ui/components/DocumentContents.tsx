import { useLayoutEffect, useMemo, useRef } from 'react';
import type { Annotation, Block } from '../types';
import { tocHeadings } from '../utils/annotationHelpers';
import { useDocumentActiveSection } from '../hooks/useActiveSection';
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
 * A document's Contents list for a host without plan review's sidebar: the
 * same `TableOfContents` (headings from `tocHeadings`, click to scroll, the
 * current heading highlighted) bound to one scroll element through the
 * package's one scroll-spy (`useDocumentActiveSection`, over
 * `useActiveSection`). It draws no chrome; the host places it and titles it.
 *
 * The host mounts it afresh (a sheet that opens), often mid-document, where
 * no heading sits in the observer's band; the scroll-spy reads the band once
 * on mount for that. The marked entry is kept in view inside the list's own
 * scroll box (a sheet).
 *
 * Key it by the document: the active-heading observer reads the headings
 * that are drawn when it mounts or when their count changes.
 */
export function DocumentContents({ blocks, annotations, scrollViewport, onNavigate, className = '' }: DocumentContentsProps) {
  const headings = useMemo(() => tocHeadings(blocks), [blocks]);
  const activeId = useDocumentActiveSection(scrollViewport, headings.length);

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

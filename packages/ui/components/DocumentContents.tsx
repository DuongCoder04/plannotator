import { useMemo, useRef } from 'react';
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
 * A document's Contents list for a host without plan review's sidebar: the
 * same `TableOfContents` (headings from `tocHeadings`, click to scroll, the
 * current heading highlighted) bound to one scroll element through
 * `useActiveSection`. It draws no chrome; the host places it and titles it.
 *
 * Key it by the document: the active-heading observer reads the headings
 * that are drawn when it mounts or when their count changes.
 */
export function DocumentContents({ blocks, annotations, scrollViewport, onNavigate, className = '' }: DocumentContentsProps) {
  // useActiveSection reads headings from the ref's element, else from the scroll element.
  const noContainer = useRef<HTMLElement | null>(null);
  const headingCount = useMemo(() => tocHeadings(blocks).length, [blocks]);
  const activeId = useActiveSection(noContainer, headingCount, scrollViewport);
  return (
    <TableOfContents
      blocks={blocks}
      annotations={annotations}
      activeId={activeId}
      onNavigate={onNavigate ?? noop}
      scrollViewport={scrollViewport}
      className={className}
    />
  );
}

function noop() {}

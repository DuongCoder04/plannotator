import { useEffect, useLayoutEffect, useState, useRef } from 'react';
import { getScrollViewportIntersectionRoot, getScrollViewportRect } from './useScrollViewport';

/**
 * The scroll-spy's band starts this far below the scroll element's top and
 * ends at 20% of its height (the observer's `rootMargin`). A heading in the
 * band is the one being read. `TableOfContents` and the contents rail scroll
 * a picked heading to this line, so it lands in the band and is marked.
 */
export const ACTIVE_SECTION_BAND_TOP = 80;
/** The band's bottom, as a fraction of the scroll element's height (the rootMargin's -80%). */
const ACTIVE_SECTION_BAND_BOTTOM = 0.2;

/**
 * THE scroll-spy of `@plannotator/ui`: plan review's Contents list
 * (`TableOfContents`, fed by App), `DocumentContents` and the contents rail
 * (`MarkdownContentsRail`) all read the heading being read from it, so they
 * never disagree.
 *
 * Track which heading section is currently visible in the viewport
 * Uses Intersection Observer to detect when headings enter/leave view
 */
export function useActiveSection(
  containerRef: React.RefObject<HTMLElement | null>,
  headingCount: number,
  /** Optional explicit scroll element. When provided, takes precedence over
   *  containerRef.current and re-runs the effect when it changes — needed
   *  for OverlayScrollArea, whose viewport is only available after mount. */
  scrollElement?: HTMLElement | null,
) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    const contentContainer = containerRef.current ?? scrollElement;
    const viewport = scrollElement ?? contentContainer;
    if (!contentContainer || !viewport) return;
    
    // Only document headings: a heading inside a question card's context has
    // no block id and is not a TOC section.
    const headings = contentContainer.querySelectorAll('[data-block-type="heading"][data-block-id]');
    if (headings.length === 0) return;
    
    // Track which headings are currently intersecting
    const intersectingHeadings = new Map<Element, boolean>();
    
    // Create observer with configuration to detect headings near top of viewport
    observerRef.current = new IntersectionObserver(
      (entries) => {
        // Update intersection state
        entries.forEach(entry => {
          intersectingHeadings.set(entry.target, entry.isIntersecting);
        });
        
        // Find the first intersecting heading (topmost in viewport)
        let topHeading: Element | null = null;
        let topPosition = Infinity;
        
        for (const [heading, isIntersecting] of intersectingHeadings) {
          if (isIntersecting) {
            const rect = heading.getBoundingClientRect();
            if (rect.top < topPosition) {
              topPosition = rect.top;
              topHeading = heading;
            }
          }
        }
        
        // Update active ID
        if (topHeading) {
          const blockId = topHeading.getAttribute('data-block-id');
          if (blockId) {
            setActiveId(blockId);
          }
        }
      },
      {
        root: getScrollViewportIntersectionRoot(viewport),
        // The band: ACTIVE_SECTION_BAND_TOP px down to ACTIVE_SECTION_BAND_BOTTOM (20%) of the height.
        rootMargin: `-${ACTIVE_SECTION_BAND_TOP}px 0px -80% 0px`, // Activate when heading is near top
        threshold: [0, 0.1, 0.5, 1.0],
      }
    );
    
    // Observe all headings
    headings.forEach(heading => {
      observerRef.current?.observe(heading);
    });
    
    // Cleanup
    return () => {
      observerRef.current?.disconnect();
    };
  }, [containerRef, headingCount, scrollElement]);

  return activeId;
}

/**
 * `useActiveSection` for a list that mounts afresh mid-document (a sheet
 * that opens, a rail that loads after the page is interactive). The observer
 * only reports a heading once one crosses the band, so until it does, this
 * reads the band once on mount: the topmost heading in it, else the last
 * heading already scrolled above it (the section being read). After that the
 * observer's answer wins. The same rule as the observer, so a list mounted
 * now and one mounted at the top agree.
 */
export function useDocumentActiveSection(scrollViewport: HTMLElement | null, headingCount: number): string | null {
  // useActiveSection reads the headings from the ref's element, else from the scroll element.
  const noContainer = useRef<HTMLElement | null>(null);
  const observed = useActiveSection(noContainer, headingCount, scrollViewport);
  const [seed, setSeed] = useState<string | null>(null);
  useLayoutEffect(() => {
    setSeed(scrollViewport ? sectionReadIn(scrollViewport) : null);
  }, [scrollViewport, headingCount]);
  return observed ?? seed;
}

/** The heading the band holds in `viewport` now (see useDocumentActiveSection), or null above the first one. */
export function sectionReadIn(viewport: HTMLElement): string | null {
  const area = getScrollViewportRect(viewport);
  const bandTop = area.top + ACTIVE_SECTION_BAND_TOP;
  const bandBottom = area.top + area.height * ACTIVE_SECTION_BAND_BOTTOM;
  let above: string | null = null;
  for (const heading of viewport.querySelectorAll<HTMLElement>('[data-block-type="heading"][data-block-id]')) {
    const rect = heading.getBoundingClientRect();
    const id = heading.getAttribute('data-block-id')!;
    if (bandBottom > bandTop && rect.bottom >= bandTop && rect.top <= bandBottom) return id;
    if (rect.top > bandTop) break;
    above = id;
  }
  return above;
}

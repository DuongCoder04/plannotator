/**
 * What regresses if this fails: plan review's Contents list marks a different
 * heading at the same scroll position. `useActiveSection` is the package's one
 * scroll-spy (the contents rail and `DocumentContents` read it too), so its
 * answer is pinned here at a few positions of plan review's own wiring (App:
 * the plan area as the container, the OverlayScrollArea viewport as the
 * scroll element): the band runs from 80 px below the top to 20% of the
 * height, the topmost heading in it wins, and with none in it the last answer
 * stays (scrolling back up included). The same expectations pass on the code
 * before the rail moved into the package.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { installBandIntersectionObserver } from '../test-setup/bandIntersectionObserver';

const hasDom = typeof document !== 'undefined';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let restoreObserver: (() => void) | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  restoreObserver?.();
  restoreObserver = null;
});

/** Headings 30 px tall at these offsets in the plan; the viewport is 600 px tall, so the band is 80 to 120 px. */
const TOPS = { Overview: 0, Context: 300, Design: 700, Rollout: 1100, Risks: 1500 };

describe.if(hasDom)('useActiveSection at fixed scroll positions (plan review)', () => {
  test('marks the topmost heading in the band and keeps it while none is there', async () => {
    restoreObserver = installBandIntersectionObserver();
    const { useActiveSection } = await import('./useActiveSection');
    let active: string | null = 'unset';
    let viewportEl: HTMLDivElement | null = null;

    function Plan() {
      const planAreaRef = useRef<HTMLDivElement>(null);
      const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
      active = useActiveSection(planAreaRef, Object.keys(TOPS).length, viewport);
      return (
        <div
          ref={(el) => {
            viewportEl = el;
            if (el && el !== viewport) setViewport(el);
          }}
        >
          <div ref={planAreaRef}>
            {Object.keys(TOPS).map((name) => (
              <h2 key={name} data-block-id={name} data-block-type="heading">
                {name}
              </h2>
            ))}
          </div>
        </div>
      );
    }

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<Plan />));
    const viewport = viewportEl!;
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    for (const heading of viewport.querySelectorAll<HTMLElement>('h2')) {
      const top = TOPS[heading.textContent as keyof typeof TOPS];
      heading.getBoundingClientRect = () => new DOMRect(0, top - viewport.scrollTop, 600, 30);
    }

    const at = async (scrollTop: number) => {
      await act(async () => {
        viewport.scrollTop = scrollTop;
        viewport.dispatchEvent(new Event('scroll'));
      });
      return active;
    };

    // The observer was created before the layout above: nothing was in the band then.
    expect(await at(0)).toBeNull();
    expect(await at(200)).toBe('Context'); // Context at 100 px: in the band
    expect(await at(260)).toBe('Context'); // Context at 40 px, above the band; Design far below: kept
    expect(await at(610)).toBe('Design'); // Design at 90 px
    expect(await at(450)).toBe('Design'); // back up: Context at -150, Design at 250, none in the band: kept
    expect(await at(1000)).toBe('Rollout'); // Rollout at 100 px
    expect(await at(1010)).toBe('Rollout');
  });
});

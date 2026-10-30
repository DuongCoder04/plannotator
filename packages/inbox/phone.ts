/**
 * The Inbox on a phone (reached over the tailnet with `plannotator inbox
 * --tailscale`): one screen at a time, list, then thread, then file, like a
 * mail app. A phone is a narrow window, or a short touch screen under 1024 px
 * wide (a phone in
 * landscape is wider than the narrow break but only about 400 px tall; a short
 * iPad or Stage Manager window, wider than that, keeps the two panes).
 *
 * The same query is spelled out in inbox.css (a media query cannot read a
 * constant): keep the two equal.
 */

import { useSyncExternalStore } from 'react';

export const PHONE_QUERY = '(max-width: 767px), (max-height: 500px) and (max-width: 1023px) and (pointer: coarse)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(PHONE_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

export function isPhone(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
}

/**
 * A real touch phone: the phone layout on a screen whose main pointer is a finger (coarse, no hover). Single keys
 * are off there (a stray key from a hardware keyboard or voice input acts on nothing shown); a desktop window
 * narrower than 768 px has the phone layout but keeps its keys, as it always had (the owner's ruling on #2257).
 */
export const TOUCH_QUERY = '(pointer: coarse) and (hover: none)';

export function isTouchPhone(): boolean {
  return isPhone() && window.matchMedia(TOUCH_QUERY).matches;
}

function subscribeTouch(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const off = subscribe(onChange);
  const mql = window.matchMedia(TOUCH_QUERY);
  mql.addEventListener('change', onChange);
  return () => {
    off();
    mql.removeEventListener('change', onChange);
  };
}

/** Whether the window is a real touch phone now, and again whenever that changes. */
export function useTouchPhone(): boolean {
  return useSyncExternalStore(subscribeTouch, isTouchPhone, () => false);
}

/** Whether the window is a phone now, and again whenever that changes (a rotation, a resize). */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, isPhone, () => false);
}

/**
 * What the window does for one reading of the visual viewport: the box to pin
 * the window to while the keyboard covers the bottom (null: the full window),
 * and whether to undo a pan to the focused field. Pinch-zoom also shrinks the
 * visual viewport, by its scale: a zoomed page is the person reading closer,
 * never a keyboard, so it is left alone (no shrink, and no scroll back that
 * would yank the zoomed view to the corner).
 *
 * The box is the visual viewport itself: `top` its offsetTop, `height` its
 * height, so the window's bottom is where the keyboard starts. offsetTop is
 * not always a pan: iOS 26 Safari, with its address bar at the top over the
 * page, starts the visual viewport below the bar (offsetTop is the bar, with
 * scrollY 0), and a window sized from the page's top ended that far above the
 * keyboard, its own top bar under Safari's. A pan moves scrollY too (iOS
 * scrolls the page to the field): that is undone by the scroll back, and the
 * next reading pins the window where the visual viewport rests.
 */
export function keyboardLayout(
  vv: { height: number; offsetTop: number; scale: number },
  innerHeight: number,
  scrollY: number,
  phone: boolean,
): { height: number | null; top: number; resetScroll: boolean } {
  const unzoomed = Math.abs(vv.scale - 1) < 0.01;
  const covered = phone && unzoomed && innerHeight - vv.height > 80;
  if (!covered) return { height: null, top: 0, resetScroll: false };
  const top = scrollY === 0 ? Math.max(0, Math.min(Math.round(vv.offsetTop), innerHeight - Math.round(vv.height))) : 0;
  return { height: Math.round(vv.height), top, resetScroll: scrollY !== 0 || vv.offsetTop !== 0 };
}

/**
 * Keeps the window on the visual viewport while a phone's keyboard is up:
 * `--ib-vvh` its height and `--ib-vvt` its top (keyboardLayout), on the
 * document element, so the reply box and compose sit directly on the keyboard
 * and their top bars stay in view. iOS Safari does not resize the layout for
 * the keyboard; it pans the page instead, which the reset to the top undoes
 * (the window never scrolls as a whole). Chrome on Android resizes the layout
 * itself (index.html's interactive-widget=resizes-content), so nothing is
 * covered there and this stays idle. Returns the cleanup.
 */
export function trackKeyboard(): () => void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return () => {};
  const root = document.documentElement;
  let frame = 0;
  const apply = () => {
    frame = 0;
    // The keyboard covers the bottom of the layout viewport (not a pinch-zoom: keyboardLayout).
    const layout = keyboardLayout(vv, window.innerHeight, window.scrollY, isPhone());
    if (layout.height !== null) {
      root.style.setProperty('--ib-vvh', `${layout.height}px`);
      root.style.setProperty('--ib-vvt', `${layout.top}px`);
      root.dataset.ibKeyboard = '';
      if (layout.resetScroll) window.scrollTo(0, 0);
    } else {
      root.style.removeProperty('--ib-vvh');
      root.style.removeProperty('--ib-vvt');
      delete root.dataset.ibKeyboard;
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  apply();
  return () => {
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
    if (frame) cancelAnimationFrame(frame);
    root.style.removeProperty('--ib-vvh');
    root.style.removeProperty('--ib-vvt');
    delete root.dataset.ibKeyboard;
  };
}

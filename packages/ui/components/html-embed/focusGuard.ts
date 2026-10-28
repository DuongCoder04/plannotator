/**
 * Who may hold the keyboard: the window decides, never an embedded page
 * (review of #2288, finding 1). A page can call `focus()` on itself at any
 * time (a timer, an autofocus input), and a frame with focus gets every key
 * the person types: words meant for the reply box would go to the page, which
 * may send them over https. `inert` does not stop this in Chromium.
 *
 * So when focus moves into an embed frame, the window checks that the person
 * chose it: the pointer is over that frame and they are not typing (a key in
 * the window within `TYPING_MS`), or they just pressed Tab. Anything else is a
 * grab: the window takes focus back to where it was at once, and tells the
 * frame's owner (`onGrab`), which stops a page that keeps grabbing.
 *
 * Probed in Chromium and WebKit, mouse and touch: the window sees
 * `pointerover`/`mouseover` on the iframe element when the pointer (or a tap)
 * reaches the frame, `blur` fires on the window with the frame already the
 * active element, and `focus()` on one of the window's elements takes the
 * keyboard back. A slow poll covers the cases with no window blur (focus moving
 * from one frame straight to another).
 */

/** A key pressed in the window this recently means the person is typing there. */
const TYPING_MS = 700;
/** A Tab this recent explains focus arriving in a frame. */
const TAB_MS = 1000;
/** The poll for a grab no event announced. */
const POLL_MS = 250;

interface Guarded {
  onGrab: () => void;
}

const frames = new Map<HTMLIFrameElement, Guarded>();
/** The frame the pointer is over (as the window sees it), if any. */
let hovered: HTMLIFrameElement | null = null;
/** The frame the person chose: it keeps focus until focus leaves it. */
let chosen: HTMLIFrameElement | null = null;
let lastKeyAt = Number.NEGATIVE_INFINITY;
let lastTabAt = Number.NEGATIVE_INFINITY;
/** The window's own element that had focus last, where a grab sends it back. */
let lastFocus: HTMLElement | null = null;
let uninstall: (() => void) | null = null;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function restoreFocus(frame: HTMLIFrameElement): void {
  const back = lastFocus;
  // After the frame's own focus change has settled: a focus() made while the frame is still taking
  // focus moves the window's active element in Chromium but leaves the keyboard in the frame (and
  // the element then counts as focused, so a second focus() would do nothing).
  setTimeout(() => {
    frame.blur();
    const target = back && back.isConnected && back !== frame ? back : null;
    if (target && document.activeElement === target) target.blur();
    window.focus();
    target?.focus({ preventScroll: true });
  }, 0);
}

/** Focus is in `frame` now: keep it if the person chose it, else take it back. */
function arrived(frame: HTMLIFrameElement): void {
  if (chosen === frame) return;
  const t = now();
  const byTab = t - lastTabAt < TAB_MS;
  const byPointer = hovered === frame && t - lastKeyAt >= TYPING_MS;
  if (byTab || byPointer) {
    chosen = frame;
    return;
  }
  restoreFocus(frame);
  frames.get(frame)?.onGrab();
}

function check(): void {
  const active = document.activeElement;
  if (active instanceof HTMLIFrameElement && frames.has(active)) {
    arrived(active);
    return;
  }
  chosen = null;
}

function install(): () => void {
  // The element that had focus before any embed was guarded (the reply box the person is in).
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && !(active instanceof HTMLIFrameElement)) lastFocus = active;
  const onOver = (event: Event) => {
    const target = event.target;
    hovered = target instanceof HTMLIFrameElement && frames.has(target) ? target : null;
  };
  const onLeaveWindow = () => {
    hovered = null;
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Tab') lastTabAt = now();
    else lastKeyAt = now();
  };
  const onFocusIn = (event: FocusEvent) => {
    const target = event.target;
    if (target instanceof HTMLIFrameElement && frames.has(target)) {
      arrived(target);
      return;
    }
    if (target instanceof HTMLElement) lastFocus = target;
    chosen = null;
  };
  const onBlur = () => {
    // The frame is already the active element when the window blurs into it.
    check();
  };
  document.addEventListener('pointerover', onOver, true);
  document.addEventListener('mouseover', onOver, true);
  document.documentElement.addEventListener('mouseleave', onLeaveWindow);
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('focusin', onFocusIn, true);
  window.addEventListener('blur', onBlur);
  const poll = window.setInterval(check, POLL_MS);
  return () => {
    document.removeEventListener('pointerover', onOver, true);
    document.removeEventListener('mouseover', onOver, true);
    document.documentElement.removeEventListener('mouseleave', onLeaveWindow);
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('focusin', onFocusIn, true);
    window.removeEventListener('blur', onBlur);
    window.clearInterval(poll);
  };
}

/**
 * Guard one embed frame while it is mounted. `onGrab` runs each time the page
 * took the keyboard without the person choosing it (focus is already back).
 */
export function guardEmbedFocus(frame: HTMLIFrameElement, onGrab: () => void): () => void {
  frames.set(frame, { onGrab });
  if (!uninstall) uninstall = install();
  // A page may have grabbed before the guard was in place.
  if (document.activeElement === frame) arrived(frame);
  return () => {
    frames.delete(frame);
    if (hovered === frame) hovered = null;
    if (chosen === frame) chosen = null;
    if (frames.size === 0 && uninstall) {
      uninstall();
      uninstall = null;
    }
  };
}

/** Tests only: forget everything the guard learned. */
export function resetEmbedFocusGuardForTests(): void {
  frames.clear();
  hovered = null;
  chosen = null;
  lastKeyAt = Number.NEGATIVE_INFINITY;
  lastTabAt = Number.NEGATIVE_INFINITY;
  lastFocus = null;
  uninstall?.();
  uninstall = null;
}

/**
 * Who may hold the keyboard: the window decides, never an embedded page
 * (reviews of #2288). A page can call `focus()` at any time (a timer, an
 * autofocus input, the moment the pointer moves over it), and a frame with
 * focus gets every key the person types: words meant for the reply box would
 * go to the page, which may send them over https. `inert` does not stop this
 * in Chromium, and the page sees its own pointer moves, so hovering can never
 * count as the person choosing it.
 *
 * So a frame holds the keyboard only when the person gave it:
 * - a click or tap on the frame, which the window sees because an inline
 *   frame sits under a window-owned shield until then (`HtmlEmbedBlock`
 *   forwards the click, pointer moves and sideways scrolling to the page,
 *   so it still reacts on the first click; `chooseEmbedFrame`);
 * - Tab, when focus goes from the window straight into the frame (a Tab that
 *   lands on any window element, leaves the window, or a window handler
 *   cancelled, lends nothing);
 * - a frame the window trusts outright: the Full screen view, which is modal,
 *   so there is no window field to type into behind it.
 * Anything else is a grab: the window takes focus back to where it was,
 * after the frame's own focus change settles, and tells the frame's owner
 * (`onGrab`), which stops a page that keeps grabbing.
 *
 * Probed in Chromium and WebKit, mouse and touch: `blur` fires on the window
 * with the frame already the active element; a `focus()` made during that
 * blur moves the window's active element but leaves the keyboard in the frame
 * (Chromium), so the restore runs on the next task. A slow poll covers focus
 * moving from one frame straight to another.
 */

/** A Tab this recent explains focus arriving in a frame (only if the Tab moved focus nowhere else). */
const TAB_MS = 500;
/** The poll for a grab no event announced. */
const POLL_MS = 250;

interface Guarded {
  onGrab: () => void;
  /** Focus here is always the person's (the modal Full screen view). */
  trusted: boolean;
}

const frames = new Map<HTMLIFrameElement, Guarded>();
/** The frame the person chose: it keeps focus until focus leaves it. */
let chosen: HTMLIFrameElement | null = null;
/** A Tab pressed in the window that has not yet landed on a window element. */
let tabAt: number | null = null;
/** The window's own element that had focus last, where a grab sends it back. */
let lastFocus: HTMLElement | null = null;
const listeners = new Set<() => void>();
let uninstall: (() => void) | null = null;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function setChosen(frame: HTMLIFrameElement | null): void {
  if (chosen === frame) return;
  chosen = frame;
  for (const listener of listeners) listener();
}

function restoreFocus(frame: HTMLIFrameElement): void {
  const back = lastFocus;
  // On the next task: a focus() made while the frame is still taking focus moves the window's
  // active element in Chromium but leaves the keyboard in the frame (and the element then counts
  // as focused, so a second focus() would do nothing).
  setTimeout(() => {
    if (chosen === frame) return;
    frame.blur();
    const target = back && back.isConnected && back !== frame ? back : null;
    if (target && document.activeElement === target) target.blur();
    window.focus();
    target?.focus({ preventScroll: true });
  }, 0);
}

/** Focus is in `frame` now: keep it if the person gave it, else take it back. */
function arrived(frame: HTMLIFrameElement): void {
  if (chosen === frame) return;
  const guarded = frames.get(frame);
  if (!guarded) return;
  if (guarded.trusted || (tabAt !== null && now() - tabAt < TAB_MS)) {
    tabAt = null;
    setChosen(frame);
    return;
  }
  restoreFocus(frame);
  guarded.onGrab();
}

function check(): void {
  const active = document.activeElement;
  if (active instanceof HTMLIFrameElement && frames.has(active)) {
    arrived(active);
    return;
  }
  setChosen(null);
}

function install(): () => void {
  // The element that had focus before any embed was guarded (the reply box the person is in).
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && !(active instanceof HTMLIFrameElement)) lastFocus = active;
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const at = now();
    tabAt = at;
    // A Tab the window cancelled (a field that keeps Tab) moves focus nowhere: it lends nothing.
    setTimeout(() => {
      if (event.defaultPrevented && tabAt === at) tabAt = null;
    }, 0);
  };
  const onFocusIn = (event: FocusEvent) => {
    const target = event.target;
    if (target instanceof HTMLIFrameElement && frames.has(target)) {
      arrived(target);
      return;
    }
    // Focus landed in the window: a Tab that brought it here lends no frame anything.
    tabAt = null;
    if (target instanceof HTMLElement) lastFocus = target;
    setChosen(null);
  };
  // A press anywhere in the window (plain text included, which moves no focus) or the window
  // regaining focus means the person left the frame they chose.
  const onWindowPress = () => setChosen(null);
  const onWindowFocus = () => setChosen(null);
  // The frame is already the active element when the window blurs into it. Focus that left the
  // window for something else (Tab out to the browser) ends what a Tab could lend.
  const onBlur = () => {
    if (!(document.activeElement instanceof HTMLIFrameElement)) tabAt = null;
    check();
  };
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('pointerdown', onWindowPress, true);
  window.addEventListener('focus', onWindowFocus);
  window.addEventListener('blur', onBlur);
  const poll = window.setInterval(check, POLL_MS);
  return () => {
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('pointerdown', onWindowPress, true);
    window.removeEventListener('focus', onWindowFocus);
    window.removeEventListener('blur', onBlur);
    window.clearInterval(poll);
  };
}

/**
 * Guard one embed frame while it is mounted. `onGrab` runs each time the page
 * took the keyboard without the person giving it (focus is already on its
 * way back). `trusted`: the modal Full screen view, where focus is the page's.
 */
export function guardEmbedFocus(frame: HTMLIFrameElement, onGrab: () => void, trusted = false): () => void {
  frames.set(frame, { onGrab, trusted });
  if (!uninstall) uninstall = install();
  // A page may have grabbed before the guard was in place.
  if (document.activeElement === frame) arrived(frame);
  return () => {
    frames.delete(frame);
    if (chosen === frame) setChosen(null);
    if (frames.size === 0 && uninstall) {
      uninstall();
      uninstall = null;
    }
  };
}

/** The person clicked or tapped the frame (on the window's shield): it gets the keyboard. */
export function chooseEmbedFrame(frame: HTMLIFrameElement): void {
  if (!frames.has(frame)) return;
  setChosen(frame);
  frame.focus({ preventScroll: true });
  frame.contentWindow?.focus();
}

/** Whether `frame` holds the keyboard the person gave it (its shield is down). */
export function isEmbedFrameChosen(frame: HTMLIFrameElement | null): boolean {
  return frame !== null && chosen === frame;
}

/** Called whenever the chosen frame changes. */
export function subscribeEmbedFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests only: forget everything the guard learned. */
export function resetEmbedFocusGuardForTests(): void {
  frames.clear();
  chosen = null;
  tabAt = null;
  lastFocus = null;
  listeners.clear();
  uninstall?.();
  uninstall = null;
}

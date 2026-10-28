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
 * - the shield's button ("Use this page"): pressed, or left by focus going
 *   straight from it into its frame (a screen reader moving on into the page);
 * - Tab, when focus goes from the window straight into the frame (a Tab that
 *   lands on any window element, leaves the window, or a window handler
 *   cancelled, lends nothing);
 * - the Full screen view's frame. That dialog is not modal (`PopoutDialog`),
 *   but it closes as soon as focus leaves it, so no window field takes typing
 *   while that page holds the keyboard.
 * Anything else is a grab: the window takes focus back to where it was,
 * after the frame's own focus change settles, and tells the frame's owner
 * (`onGrab`), which stops a page that keeps grabbing.
 *
 * Where the page shares the window's thread (WebKit always; Chromium without
 * site isolation, as on Android) a page can grab and then block that thread:
 * the restore cannot run, and keys typed meanwhile reach the page. Only
 * removing the frame in the same task wins that race (probed: blurring,
 * hiding or `inert` do not), so:
 * - a grab while the person is typing (a key in the window within
 *   `TYPING_MS`) stops the page at once, in the event that announced the grab
 *   (`onGrab('typing')`: the owner removes the frame before returning);
 * - a restore that ran late (`LATE_MS` after the grab: the page held the
 *   thread) stops the page (`onGrab('late', ms)`);
 * - a key that reached a page the person is not using stops it (the page's
 *   bootstrap reports each key, never which: `reportEmbedKeys`), and the
 *   notice counts them;
 * - a page that took focus where the window saw nothing (from another page,
 *   which fires no event in the window) is stopped when its bootstrap reports
 *   the focus (`reportEmbedFocus`), and focus goes back to the page the person
 *   chose.
 * So a page that grabs while the person is not typing and then blocks the
 * thread still gets the keys typed during that block; then it is stopped and
 * told about, with their count (keys that reached a web frame the page framed
 * itself are not counted). Desktop Chrome runs the frame in its own process,
 * so there the restore is never held up.
 *
 * Probed in Chromium and WebKit, mouse and touch: `blur` fires on the window
 * with the frame already the active element; a `focus()` made during that
 * blur moves the window's active element but leaves the keyboard in the frame
 * (Chromium), so the restore runs on the next task. A slow poll covers focus
 * moving from one frame straight to another.
 */

/**
 * Why a grab is reported: one more grab, one while the person typed, a restore the page held up,
 * keys that reached a page the person is not using, or focus taken where the window saw nothing.
 */
export type EmbedGrab = 'grab' | 'typing' | 'late' | 'keys' | 'unseen';

/** A Tab this recent explains focus arriving in a frame (only if the Tab moved focus nowhere else). */
const TAB_MS = 500;
/** The poll for a grab no event announced. */
const POLL_MS = 250;
/** A key in the window this recent means the person is typing: a grab now stops the page at once. */
const TYPING_MS = 2000;
/** A restore this late means the page held the thread while it had the keyboard. */
const LATE_MS = 250;
/** A page's report of its focus this soon after the window handled that grab is the same grab. */
const HANDLED_MS = 2000;
/** Keys that are not typing: Tab moves focus, a modifier alone types nothing. */
const NOT_TYPING = new Set(['Tab', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'OS', 'AltGraph']);

interface Guarded {
  onGrab: (why: EmbedGrab, heldMs?: number) => void;
  /** Focus here is always the person's (the Full screen view). */
  trusted: boolean;
  /** The shield's button: focus going from it straight into the frame is the person's. */
  door: () => HTMLElement | null;
}

const frames = new Map<HTMLIFrameElement, Guarded>();
/** The frame the person chose: it keeps focus until focus leaves it. */
let chosen: HTMLIFrameElement | null = null;
/** A Tab pressed in the window that has not yet landed on a window element. */
let tabAt: number | null = null;
/** The window's own element that had focus last, where a grab sends it back. */
let lastFocus: HTMLElement | null = null;
/** The frame whose shield button holds focus now. */
let atDoor: HTMLIFrameElement | null = null;
/** The person's last key (or other input, such as dictation) in the window. */
let lastKeyAt: number | null = null;
/** The frame the person chose last, until they focus a window element (pressing a scrollbar keeps it). */
let lastChosen: HTMLIFrameElement | null = null;
/** When each frame stopped being the chosen one: its reports sent before that may still arrive. */
const releasedAt = new Map<HTMLIFrameElement, number>();
/** How long a page's reports may trail the person leaving it. */
const TRAIL_MS = 500;
/** When the window last handled each frame's grab. */
const handledAt = new Map<HTMLIFrameElement, number>();
const listeners = new Set<() => void>();
let uninstall: (() => void) | null = null;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function setChosen(frame: HTMLIFrameElement | null): void {
  if (frame) lastChosen = frame;
  if (chosen === frame) return;
  if (chosen) releasedAt.set(chosen, now());
  chosen = frame;
  for (const listener of listeners) listener();
}

function focusBack(frame: HTMLIFrameElement, back: HTMLElement | null): void {
  frame.blur();
  const target = back && back.isConnected && back !== frame ? back : null;
  if (target && document.activeElement === target) target.blur();
  window.focus();
  target?.focus({ preventScroll: true });
}

function restoreFocus(frame: HTMLIFrameElement): void {
  const back = lastFocus;
  const grabbedAt = now();
  // On the next task: a focus() made while the frame is still taking focus moves the window's
  // active element but leaves the keyboard in the frame in Chromium (and the element then counts
  // as focused, so a second focus() would do nothing).
  setTimeout(() => {
    if (chosen === frame) return;
    handledAt.set(frame, now());
    focusBack(frame, back);
    // Late: the page blocked the thread it shares with the window while it held the keyboard
    // (a hidden window's timers are slowed, so only a visible one counts).
    const held = now() - grabbedAt;
    const guarded = frames.get(frame);
    if (guarded && held > LATE_MS && document.visibilityState === 'visible') guarded.onGrab('late', held);
  }, 0);
}

/** Focus is in `frame` now: keep it if the person gave it, else take it back. */
function arrived(frame: HTMLIFrameElement): void {
  const fromDoor = atDoor === frame;
  atDoor = null;
  if (chosen === frame) return;
  const guarded = frames.get(frame);
  if (!guarded) return;
  // Still the person's: they chose it and focus never left it for the window since (a press on a
  // scrollbar ends the choice but leaves focus in the page).
  if (lastChosen === frame) {
    setChosen(frame);
    return;
  }
  handledAt.set(frame, now());
  if (guarded.trusted || fromDoor || (tabAt !== null && now() - tabAt < TAB_MS)) {
    tabAt = null;
    setChosen(frame);
    return;
  }
  if (chosen && chosen !== frame && frames.has(chosen)) {
    // Straight from the page the person chose into another one: that page took the keys meant
    // for the first. It goes, and the keyboard goes back to the chosen page.
    guarded.onGrab('unseen');
    backToChosen(frame);
    return;
  }
  if (lastKeyAt !== null && now() - lastKeyAt < TYPING_MS) {
    // The person is typing: the page goes in this task, before a key can reach it even if it
    // blocks the thread next. Then focus goes back (now for Chromium, again later for WebKit).
    const back = lastFocus;
    guarded.onGrab('typing');
    focusBack(frame, back);
    restoreFocus(frame);
    return;
  }
  restoreFocus(frame);
  guarded.onGrab('grab');
}

function check(): void {
  const active = document.activeElement;
  if (active instanceof HTMLIFrameElement && frames.has(active)) {
    arrived(active);
    return;
  }
  setChosen(null);
}

function doorOf(element: EventTarget | null): HTMLIFrameElement | null {
  for (const [frame, guarded] of frames) if (element !== null && guarded.door() === element) return frame;
  return null;
}

function install(): () => void {
  // The element that had focus before any embed was guarded (the reply box the person is in).
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && !(active instanceof HTMLIFrameElement)) lastFocus = active;
  const onKey = (event: KeyboardEvent) => {
    if (!NOT_TYPING.has(event.key)) lastKeyAt = now();
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
    // Focus landed in the window: a Tab that brought it here lends no frame anything, and the
    // frame the person chose before is left.
    tabAt = null;
    lastChosen = null;
    atDoor = doorOf(target);
    if (target instanceof HTMLElement) lastFocus = target;
    setChosen(null);
  };
  // A press anywhere in the window (plain text included, which moves no focus) or the window
  // regaining focus means the person left the frame they chose.
  const onWindowPress = () => {
    atDoor = null;
    setChosen(null);
  };
  // The window regaining focus with the chosen frame still active is the person coming back to
  // it (from another app): it stays theirs.
  const onWindowFocus = () => {
    const active = document.activeElement;
    if (active instanceof HTMLIFrameElement && (active === chosen || active === lastChosen)) return;
    // Focus came back to the window itself (plain text was clicked): the page is left.
    lastChosen = null;
    setChosen(null);
  };
  const onInput = () => {
    lastKeyAt = now();
  };
  // The frame is already the active element when the window blurs into it. Focus that left the
  // window for something else (Tab out to the browser) ends what a Tab or the door could lend.
  const onBlur = () => {
    if (!(document.activeElement instanceof HTMLIFrameElement)) {
      tabAt = null;
      atDoor = null;
    }
    check();
  };
  window.addEventListener('keydown', onKey, true);
  // Dictation and other input that sends no key.
  document.addEventListener('beforeinput', onInput, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('pointerdown', onWindowPress, true);
  window.addEventListener('focus', onWindowFocus);
  window.addEventListener('blur', onBlur);
  const poll = window.setInterval(check, POLL_MS);
  return () => {
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('beforeinput', onInput, true);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('pointerdown', onWindowPress, true);
    window.removeEventListener('focus', onWindowFocus);
    window.removeEventListener('blur', onBlur);
    window.clearInterval(poll);
  };
}

/**
 * Guard one embed frame while it is mounted. `onGrab` runs each time the page
 * took the keyboard without the person giving it (focus is on its way back);
 * for `'typing'` the owner must remove the frame before returning. `trusted`:
 * the Full screen view, where focus is the page's. `door`: the shield's button.
 */
export function guardEmbedFocus(
  frame: HTMLIFrameElement,
  onGrab: (why: EmbedGrab, heldMs?: number) => void,
  trusted = false,
  door: () => HTMLElement | null = () => null,
): () => void {
  frames.set(frame, { onGrab, trusted, door });
  if (!uninstall) uninstall = install();
  // A page may have grabbed before the guard was in place.
  if (document.activeElement === frame) arrived(frame);
  return () => {
    frames.delete(frame);
    handledAt.delete(frame);
    releasedAt.delete(frame);
    if (chosen === frame) setChosen(null);
    if (lastChosen === frame) lastChosen = null;
    if (atDoor === frame) atDoor = null;
    if (frames.size === 0 && uninstall) {
      uninstall();
      uninstall = null;
    }
  };
}

/** The person clicked or tapped the frame (on the window's shield), or pressed its button: it gets the keyboard. */
export function chooseEmbedFrame(frame: HTMLIFrameElement): void {
  if (!frames.has(frame)) return;
  atDoor = null;
  setChosen(frame);
  frame.focus({ preventScroll: true });
  frame.contentWindow?.focus();
}

/** Whether a report from `frame`'s page comes from a page the person is using; it may choose it again. */
function inUse(frame: HTMLIFrameElement): boolean {
  if (chosen === frame || frames.get(frame)?.trusted) return true;
  // A report the page sent while the person was still using it (a key just before they left).
  const released = releasedAt.get(frame);
  if (released !== undefined && now() - released < TRAIL_MS) return true;
  // Still theirs: they chose it and focus never went to a window element since (a press on a
  // scrollbar, the window coming back from another app).
  if (lastChosen === frame && document.activeElement === frame) {
    setChosen(frame);
    return true;
  }
  return false;
}

/** Give the keyboard back to the page the person chose, after another page took it. */
function backToChosen(stray: HTMLIFrameElement): void {
  const mine = chosen ?? lastChosen;
  if (!mine || mine === stray || !mine.isConnected) return;
  setChosen(mine);
  mine.focus({ preventScroll: true });
  mine.contentWindow?.focus();
}

/**
 * The page in `frame` reports that its document gained focus. True when that
 * was a grab the window never saw (from another page): the caller stops it.
 */
export function reportEmbedFocus(frame: HTMLIFrameElement): boolean {
  if (!frames.has(frame) || inUse(frame)) return false;
  const handled = handledAt.get(frame);
  if (handled !== undefined && now() - handled < HANDLED_MS) return false;
  backToChosen(frame);
  return true;
}

/**
 * The page in `frame` reports that a key reached it. True when the person
 * was not using it (a grab got the key): the caller stops it.
 */
export function reportEmbedKeys(frame: HTMLIFrameElement): boolean {
  if (!frames.has(frame) || inUse(frame)) return false;
  backToChosen(frame);
  return true;
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
  atDoor = null;
  lastKeyAt = null;
  lastChosen = null;
  handledAt.clear();
  releasedAt.clear();
  listeners.clear();
  uninstall?.();
  uninstall = null;
}

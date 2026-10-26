/**
 * Pull down to refresh the list on a phone (the owner: "it's a natural
 * behavior we should support, same way clicking title works"). The page sets
 * `overscroll-none` and the list scrolls in its own box (`.ib-lbody`), so the
 * browser's own gesture never fires there; this is the Inbox's own, and it
 * calls the same refresh the list's title does (App.tsx refreshInbox).
 *
 * One finger dragging down from the very top of the list moves the list down
 * at a damped rate and reveals a small ↻ under the header, which turns with the
 * pull and is ready past PULL_READY_PX of damped travel. Released ready, the
 * list holds at PULL_HOLD_PX and the ↻ spins until the read lands, then both
 * spring back; released short, they spring back. A sideways move, a second
 * finger, or a start while the list is not at its top is not a pull. Only a
 * pull's own touchmoves are cancelled, so scrolling is never blocked.
 *
 * Everything moves by writing styles (never a React render per frame): the
 * list's transform, and on the indicator `--ib-pull` (the travel in px) and
 * `--ib-pull-turn` (the ↻'s rotation), with `data-state` naming the phase
 * (`pull`, `ready`, `refreshing`, `settling`). Under reduced motion nothing
 * turns, spins or springs: the ↻ shows, then hides.
 *
 * The gesture is an extra: the title button stays the accessible way, the
 * indicator is aria-hidden, and the live region says "Inbox refreshed" as for
 * the title.
 */

/** Damped travel at which a release refreshes. */
export const PULL_READY_PX = 64;
/** Where the list holds while the read is in flight. */
export const PULL_HOLD_PX = 52;
/** Finger travel before a move counts as a pull (a tap's jitter never does). */
export const PULL_SLOP_PX = 4;
/** The spring back. */
export const PULL_SETTLE_MS = 320;
/** The rubber band's limit: travel approaches it and never reaches it. */
const PULL_LIMIT_PX = 240;

/** The finger's travel, damped: about half at first, then less and less (Apple's rubber band). */
export function dampPull(raw: number): number {
  if (raw <= 0) return 0;
  return PULL_LIMIT_PX * (1 - 1 / ((raw * 0.55) / PULL_LIMIT_PX + 1));
}

export interface PullRefreshOptions {
  /** The refresh: the promise settles when the read has landed. */
  onRefresh: () => Promise<unknown> | unknown;
  /** Whether motion is reduced now (read at each phase, so a change applies at once). */
  reduced?: () => boolean;
}

type Phase = 'idle' | 'maybe' | 'pull' | 'refreshing' | 'settling';

/**
 * Attaches the gesture to the list's scroll box. `indicator` is the ↻'s
 * holder (drawn under the header, behind the list). Returns the cleanup.
 */
export function attachPullToRefresh(body: HTMLElement, indicator: HTMLElement, options: PullRefreshOptions): () => void {
  let phase: Phase = 'idle';
  let startX = 0;
  let startY = 0;
  let travel = 0;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const reduced = () => options.reduced?.() ?? false;

  const paint = (px: number, state: string | null, animate: boolean) => {
    const motion = animate && !reduced();
    body.style.transition = motion ? `transform ${PULL_SETTLE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)` : '';
    indicator.style.transition = motion ? `opacity ${PULL_SETTLE_MS}ms ease-out, --ib-pull ${PULL_SETTLE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)` : '';
    body.style.transform = px > 0 ? `translate3d(0, ${px}px, 0)` : '';
    indicator.style.setProperty('--ib-pull', `${px}px`);
    // The ↻ keeps the turn it had at the release while it spins and settles.
    if (state !== 'refreshing' && state !== 'settling') indicator.style.setProperty('--ib-pull-turn', reduced() ? '0deg' : `${Math.round(Math.min(1, px / PULL_READY_PX) * 270)}deg`);
    indicator.style.opacity = state ? String(state === 'pull' ? Math.min(1, px / 40) : 1) : '0';
    if (state) {
      indicator.dataset.state = state;
      body.dataset.pull = state;
    } else {
      delete indicator.dataset.state;
      delete body.dataset.pull;
    }
  };

  const settle = () => {
    if (settleTimer) clearTimeout(settleTimer);
    phase = 'settling';
    travel = 0;
    if (reduced()) {
      paint(0, null, false);
      phase = 'idle';
      return;
    }
    paint(0, 'settling', true);
    indicator.style.opacity = '0';
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (phase !== 'settling') return;
      phase = 'idle';
      paint(0, null, false);
    }, PULL_SETTLE_MS);
  };

  const release = () => {
    if (phase === 'maybe') {
      phase = 'idle';
      return;
    }
    if (phase !== 'pull') return;
    if (travel < PULL_READY_PX) {
      settle();
      return;
    }
    phase = 'refreshing';
    paint(PULL_HOLD_PX, 'refreshing', true);
    void Promise.resolve()
      .then(() => options.onRefresh())
      .catch(() => {})
      .then(() => {
        if (!disposed && phase === 'refreshing') settle();
      });
  };

  const cancel = () => {
    if (phase === 'pull') settle();
    else if (phase === 'maybe') phase = 'idle';
  };

  const onStart = (event: TouchEvent) => {
    if (phase === 'refreshing' || phase === 'settling') return;
    if (event.touches.length !== 1) {
      cancel();
      return;
    }
    // Only from the very top (iOS can report a negative scrollTop mid-bounce).
    if (body.scrollTop > 0) return;
    const touch = event.touches[0]!;
    startX = touch.clientX;
    startY = touch.clientY;
    travel = 0;
    phase = 'maybe';
  };

  const onMove = (event: TouchEvent) => {
    if (phase !== 'maybe' && phase !== 'pull') return;
    if (event.touches.length !== 1) {
      cancel();
      return;
    }
    const touch = event.touches[0]!;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (phase === 'maybe') {
      // Upward (the list scrolls) or sideways: not a pull.
      if (dy < -PULL_SLOP_PX || (Math.abs(dx) > PULL_SLOP_PX && Math.abs(dx) > dy)) {
        phase = 'idle';
        return;
      }
      if (dy <= PULL_SLOP_PX) return;
      // The browser started scrolling already (it will not let this move be cancelled), or the list moved: let it go.
      if (!event.cancelable || body.scrollTop > 0) {
        phase = 'idle';
        return;
      }
      phase = 'pull';
    }
    // A pull that turns sideways is let go.
    if (Math.abs(dx) > 30 && Math.abs(dx) > dy) {
      if (event.cancelable) event.preventDefault();
      settle();
      return;
    }
    if (event.cancelable) event.preventDefault();
    travel = dampPull(dy - PULL_SLOP_PX);
    paint(travel, travel >= PULL_READY_PX ? 'ready' : 'pull', false);
  };

  const onEnd = (event: TouchEvent) => {
    // One finger of two lifted: what is left is not this pull.
    if (event.touches.length > 0) {
      cancel();
      return;
    }
    release();
  };

  const onCancel = () => cancel();

  body.addEventListener('touchstart', onStart, { passive: true });
  // Not passive: a pull cancels its own moves (only those), so the list does not scroll or bounce under it.
  body.addEventListener('touchmove', onMove, { passive: false });
  body.addEventListener('touchend', onEnd, { passive: true });
  body.addEventListener('touchcancel', onCancel, { passive: true });
  return () => {
    disposed = true;
    if (settleTimer) clearTimeout(settleTimer);
    body.removeEventListener('touchstart', onStart);
    body.removeEventListener('touchmove', onMove);
    body.removeEventListener('touchend', onEnd);
    body.removeEventListener('touchcancel', onCancel);
    phase = 'idle';
    paint(0, null, false);
  };
}

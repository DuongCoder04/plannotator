/**
 * Where focus lands after the browser's Back or Forward (approval
 * "inbox-keyboard-shortcuts", finding F1): where that page's own key puts it,
 * never on the page itself. The Board: its heading (G B). The list: the row
 * of the thread just left (or the Quiet band folding it), else the first row (G I). A thread: its row, else
 * its subject. A file: its pane. Settings: its heading (G S).
 *
 * Focus kept in the sidebar or the list stays there (both stay across a
 * traversal); anywhere else, what had it was replaced, so it moves.
 */
export interface BackFocusRoute {
  page: string;
  thread: string | null;
  file?: unknown;
}

const row = (thread: string) => `.ib-main .ib-lbody [data-thread-id="${CSS.escape(thread)}"]`;

/** The selectors to try, in order, after a traversal from `from` to `to`. */
export function backFocusTargets(to: BackFocusRoute, from: BackFocusRoute): string[] {
  if (to.page === 'board') return ['.ib-bpage h1'];
  if (to.page === 'settings') return ['.ib-spage h1'];
  if (to.page !== 'inbox') return ['.ib-main h1'];
  if (to.thread && to.file) return ['[data-attachment-pane]', row(to.thread), 'section.ib-pane h2.ib-subject'];
  if (to.thread) return [row(to.thread), 'section.ib-pane h2.ib-subject'];
  // The thread just left, else (folded away in Quiet) the band that holds it.
  const left =
    from.page === 'inbox' && from.thread
      ? [row(from.thread), `.ib-main .ib-lbody [data-section-id]:has([data-thread-id="${CSS.escape(from.thread)}"]) button.ib-band`]
      : [];
  return [...left, '.ib-main .ib-lbody [data-thread-id]', '.ib-main .ib-lbody button.ib-band', '.ib-main .ib-empty h2', '.ib-main h1'];
}

/** Focus was taken by the traversal: nothing has it, or what has it left the page or is no longer drawn. */
export function focusLost(active: Element | null): boolean {
  return !active || active === document.body || !active.isConnected || active.getClientRects().length === 0;
}

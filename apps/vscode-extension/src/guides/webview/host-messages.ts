/** Which window messages the Guides webviews act on. */

/**
 * Only VS Code's webview host drives this page. The answer tab holds the
 * agent's page in a sandboxed child frame (opaque origin), whose messages must
 * never reach here: a forged `state` could draw a fake approval prompt. That
 * frame talks only to `answer-frame.ts`, which checks its own source.
 *
 * VS Code's host messages do not always come from `window.parent` (in VS Code
 * for the Web their `source` is another window), but they carry the webview's
 * own origin. So a message is dropped when:
 * - it comes from a frame inside this page (its `parent` chain reaches this
 *   window; `parent` is readable across origins), whatever origin it claims; or
 * - its origin is opaque ("null", every sandboxed frame and anything nested in
 *   it) and it is not from this page's parent or this page itself (a harness
 *   page on about:blank or file:// posts to itself).
 */
export interface MessageWindow {
  readonly parent: MessageWindow | null | undefined;
}

export function fromWebviewHost(event: { source: unknown; origin: string }, self: MessageWindow = window as unknown as MessageWindow): boolean {
  const source = event.source as MessageWindow | null;
  if (source && source !== self && isInside(source, self)) return false;
  if (event.origin === "null" && source !== self.parent && source !== self) return false;
  return true;
}

/** Whether `w` is a frame nested (at any depth) in `self`. */
function isInside(w: MessageWindow, self: MessageWindow): boolean {
  let cur: MessageWindow | null | undefined = w;
  for (let hops = 0; hops < 32 && cur; hops++) {
    let next: MessageWindow | null | undefined;
    try {
      next = cur.parent;
    } catch {
      return false;
    }
    if (!next || next === cur) return false;
    if (next === self) return true;
    cur = next;
  }
  return false;
}

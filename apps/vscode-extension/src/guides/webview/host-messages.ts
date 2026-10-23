/** Which window messages the Guides webviews act on. */

/**
 * Only VS Code's webview host drives this page: it posts from the frame that
 * holds this document (`window.parent`; the page itself when it is opened on
 * its own, as the screenshot and e2e harnesses do). The answer tab holds the
 * agent's page in a sandboxed child frame, whose messages must never reach
 * here (a forged `state` could draw a fake approval prompt); that frame talks
 * only to `answer-frame.ts`, which checks its own source.
 */
export function fromWebviewHost(event: Pick<MessageEvent, "source">, self: Pick<Window, "parent"> = window): boolean {
  // The source alone decides: a child frame's window is never this page's parent, whatever
  // origin it claims (a sandboxed frame's is "null", and so is a harness page's on file://).
  return event.source === self.parent;
}

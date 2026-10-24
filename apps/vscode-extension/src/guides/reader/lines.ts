/**
 * Lines of the reader's diffs: which side a selection asks about, and the
 * row of a line (for a jump to it). Pierre's `deletions` are base lines,
 * `additions` and unchanged lines head lines. No React.
 */

import type { SelectedLineRange } from "@pierre/diffs";

/**
 * The lines a selection asks about, on one side of the diff: Pierre's
 * `deletions` are base lines, `additions` (and unchanged lines) head lines.
 * A selection across both sides is not asked (the lines would not be one
 * stretch of either version).
 */
export function askLines(range: SelectedLineRange): { side: "old" | "new"; start: number; end: number } | null {
  const startSide = range.side === "deletions" ? "old" : "new";
  const endSide = (range.endSide ?? range.side) === "deletions" ? "old" : "new";
  if (startSide !== endSide) return null;
  return { side: startSide, start: Math.min(range.start, range.end), end: Math.max(range.start, range.end) };
}

/** Every root under `shell`, Pierre's shadow roots included. */
function diffRoots(shell: Element): ParentNode[] {
  const roots: ParentNode[] = [];
  const stack: ParentNode[] = [shell];
  while (stack.length) {
    const root = stack.pop()!;
    roots.push(root);
    for (const el of Array.from(root.querySelectorAll("*"))) if (el.shadowRoot) stack.push(el.shadowRoot);
  }
  return roots;
}

/**
 * A line row of a file's diff, on one side. A changed row carries its own
 * side's number (`data-line`); an unchanged row carries one side's number in
 * `data-line` and the other's in `data-alt-line`, so it is found by either.
 */
export function findDiffLine(shell: Element, side: "old" | "new", line: number): HTMLElement | null {
  const changed = side === "new" ? ["addition", "change-addition"] : ["deletion", "change-deletion"];
  const roots = diffRoots(shell);
  for (const root of roots) {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[data-line="${line}"]`))) {
      if (changed.includes(el.getAttribute("data-line-type") ?? "")) return el;
    }
  }
  for (const root of roots) {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[data-line="${line}"], [data-alt-line="${line}"]`))) {
      if ((el.getAttribute("data-line-type") ?? "").startsWith("context")) return el;
    }
  }
  return null;
}


/**
 * The person's last way of acting: a key, or a pointer (a mouse, a finger,
 * a pen). The window moves focus for the person (to a closed thread's row, to
 * the row now in a gone row's slot, to the first row Show brought in) only
 * after a key: after a mouse or a tap it would put a row under the keyboard
 * that the person never chose, and `E` would mark it read. The same goes for
 * a file's tile when a file closes (Thread.tsx).
 */
let last: 'keyboard' | 'pointer' | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', () => (last = 'keyboard'), true);
  window.addEventListener('pointerdown', () => (last = 'pointer'), true);
  // A screen reader (or switch access) presses a control with a click that no key or pointer came
  // before, and that counts no clicks (`detail` 0): the person is not using a mouse.
  window.addEventListener('click', (event) => {
    if (event.detail === 0) last = 'keyboard';
  }, true);
}

export function lastInput(): 'keyboard' | 'pointer' | null {
  return last;
}

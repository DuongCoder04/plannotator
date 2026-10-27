import { describe, expect, test } from 'bun:test';
import { askArrivalFocus, takeArrivalFocus, threadStep } from './threadStep';

describe('next and previous thread (Shift+J / Shift+K)', () => {
  const order = ['a', 'b', 'c'];

  test('follows the list order both ways', () => {
    expect(threadStep(order, 'b', 1)).toEqual({ to: 'c' });
    expect(threadStep(order, 'b', -1)).toEqual({ to: 'a' });
  });

  test('stops at the ends, never wraps', () => {
    expect(threadStep(order, 'c', 1)).toEqual({ end: 'last' });
    expect(threadStep(order, 'a', -1)).toEqual({ end: 'first' });
  });

  test('a thread not in the list on screen (folded in Quiet) goes nowhere', () => {
    expect(threadStep(order, 'quiet-one', 1)).toBeNull();
  });

  test('the focus asked for goes to that thread once, and to no other', () => {
    askArrivalFocus('b');
    expect(takeArrivalFocus('c')).toBe(false);
    expect(takeArrivalFocus('b')).toBe(true);
    expect(takeArrivalFocus('b')).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';
import { legacyBadgesMaxWidth, type BoxEdges } from './docBadgesWidth';

const badges: BoxEdges = { left: 380, right: 600, top: 150, bottom: 166 };

describe('legacyBadgesMaxWidth', () => {
  test('stops the badges short of actions on the same row', () => {
    const actions: BoxEdges = { left: 850, right: 1170, top: 146, bottom: 182 };
    expect(legacyBadgesMaxWidth(badges, actions)).toBe(850 - 380 - 8);
  });

  test('leaves the badges unbounded when the actions sit on a row below them', () => {
    const actions: BoxEdges = { left: 200, right: 340, top: 190, bottom: 226 };
    expect(legacyBadgesMaxWidth(badges, actions)).toBeNull();
  });

  test('leaves the badges unbounded until the actions have a measured width', () => {
    const unmeasured: BoxEdges = { left: 1170, right: 1170, top: 146, bottom: 146 };
    expect(legacyBadgesMaxWidth(badges, unmeasured)).toBeNull();
    expect(legacyBadgesMaxWidth(badges, null)).toBeNull();
  });

  test('never returns a negative width when the actions overlap the badges', () => {
    const actions: BoxEdges = { left: 370, right: 500, top: 146, bottom: 182 };
    expect(legacyBadgesMaxWidth(badges, actions)).toBe(0);
  });
});

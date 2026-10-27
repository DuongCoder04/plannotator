/**
 * The plan look default (Grid vs Clean).
 *
 * Clean is the default (owner, 2026-10-27). The catch: ConfigStore writes a
 * setting's default into its cookie on first load, so every browser that ran
 * an older build holds `plannotator-grid-enabled=true` without anyone having
 * picked Grid. These tests guard both halves: a person who never chose gets
 * Clean even with that seeded cookie, and a person who did choose Grid (the
 * chooser dialog or its legacy v2 marker) keeps Grid. The Settings switch is
 * covered in `components/Settings.gridChoice.test.tsx`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import { ConfigStoreForTest } from './configStore';

const GRID = 'plannotator-grid-enabled';
const RESOLVED = 'plannotator-plan-look-choice-resolved';
const LEGACY_SEEN = 'plannotator-look-feel-announcement-seen';

function installBackend(seed: Record<string, string> = {}): Map<string, string> {
  const values = new Map(Object.entries(seed));
  setStorageBackend({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  });
  return values;
}

afterEach(() => {
  resetStorageBackend();
});

describe('gridEnabled default', () => {
  test('a first visit opens Clean', () => {
    installBackend();
    expect(new ConfigStoreForTest().get('gridEnabled')).toBe(false);
  });

  test('a cookie seeded by an older build (Grid default, no choice made) opens Clean', () => {
    const values = installBackend({ [GRID]: 'true' });
    expect(new ConfigStoreForTest().get('gridEnabled')).toBe(false);
    // ...and stays Clean on the next load: the seeded value is replaced.
    expect(values.get(GRID)).toBe('false');
    expect(new ConfigStoreForTest().get('gridEnabled')).toBe(false);
  });

  test('Grid picked in the chooser survives', () => {
    installBackend({ [GRID]: 'true', [RESOLVED]: 'true' });
    expect(new ConfigStoreForTest().get('gridEnabled')).toBe(true);
  });

  test('Grid kept in the old 0.20.0 chooser (legacy v2 marker) survives', () => {
    installBackend({ [GRID]: 'true', [LEGACY_SEEN]: '2' });
    expect(new ConfigStoreForTest().get('gridEnabled')).toBe(true);
  });
});

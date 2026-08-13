import { afterEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '@plannotator/ui/utils/storage';
import { ConfigStoreForTest } from '../../ui/config/configStore';
import { initializeReviewSetup, needsReviewSetup } from './reviewSetup';

function installMemoryBackend(initial: Readonly<Record<string, string>> = {}): Map<string, string> {
  const values = new Map(Object.entries(initial));
  setStorageBackend({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  });
  return values;
}

function makeStore(): ConfigStoreForTest {
  const store = new ConfigStoreForTest();
  store.setServerSync(() => {});
  return store;
}

afterEach(() => {
  resetStorageBackend();
});

describe('initializeReviewSetup', () => {
  test('a genuinely new reviewer starts with Tree while keeping the since-base diff default', () => {
    installMemoryBackend();
    const store = makeStore();

    expect(initializeReviewSetup(store)).toBe(true);
    expect(store.get('reviewPanelView')).toBe('tree');
    expect(store.get('reviewPanelViewLastUsed')).toBe('tree');
    expect(store.get('defaultDiffType')).toBe('since-base');
    expect(needsReviewSetup()).toBe(false);
  });

  test('an unseen reviewer inherits an existing classic diff default', () => {
    installMemoryBackend({
      'plannotator-default-diff-type': 'uncommitted',
    });
    const store = makeStore();

    expect(initializeReviewSetup(store)).toBe(true);
    expect(store.get('reviewPanelView')).toBe('tree');
    expect(store.get('reviewPanelViewLastUsed')).toBe('tree');
    expect(store.get('defaultDiffType')).toBe('uncommitted');
  });

  test('a returning reviewer keeps both the persisted view and last-used memo', () => {
    installMemoryBackend({
      'plannotator-review-setup-seen': 'true',
      'plannotator-review-panel-view': 'sections',
      'plannotator-review-panel-view-last-used': 'tree',
      'plannotator-default-diff-type': 'since-base',
    });
    const store = makeStore();

    expect(initializeReviewSetup(store)).toBe(false);
    expect(store.get('reviewPanelView')).toBe('sections');
    expect(store.get('reviewPanelViewLastUsed')).toBe('tree');
    expect(store.get('defaultDiffType')).toBe('since-base');
  });
});

/**
 * Chrome persistence for raw-HTML annotate sessions (DOM-gated).
 *
 * Contract under test: the FIRST-EVER HTML session opens minimal (all chrome
 * hidden, sidebar closed); from then on a session opens with exactly the
 * chrome state the user last left — showing tools persists across a fresh
 * mount, and re-hiding them persists too.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend, type StorageBackend } from './storage';

const hasDom = typeof document !== 'undefined';
const htmlChromeModule = hasDom ? await import('./htmlChrome') : null;

// In-memory storage so tests don't depend on happy-dom cookie semantics
// (the codebase-standard pattern for persistence tests).
const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

beforeEach(() => {
  if (!hasDom) return;
  memory.clear();
  setStorageBackend(memoryBackend);
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)('resolveHtmlChromeState (pure)', () => {
  test('first run (nothing saved): everything hidden', () => {
    expect(htmlChromeModule!.resolveHtmlChromeState(null)).toEqual({
      toolsHidden: true,
      sidebarOpen: false,
    });
  });

  test('malformed cookie values fall back to the minimal default', () => {
    expect(htmlChromeModule!.resolveHtmlChromeState('not-json')).toEqual({
      toolsHidden: true,
      sidebarOpen: false,
    });
    expect(htmlChromeModule!.resolveHtmlChromeState('"just-a-string"')).toEqual({
      toolsHidden: true,
      sidebarOpen: false,
    });
    expect(htmlChromeModule!.resolveHtmlChromeState('{"toolsHidden":"yes"}')).toEqual({
      toolsHidden: true,
      sidebarOpen: false,
    });
  });

  test('partial state merges over the defaults', () => {
    expect(htmlChromeModule!.resolveHtmlChromeState('{"toolsHidden":false}')).toEqual({
      toolsHidden: false,
      sidebarOpen: false,
    });
  });
});

describe.if(hasDom)('getHtmlChromeState / saveHtmlChromeState (cookie round trip)', () => {
  test('first run reads the minimal default', () => {
    expect(htmlChromeModule!.getHtmlChromeState()).toEqual({
      toolsHidden: true,
      sidebarOpen: false,
    });
  });

  test('a "user showed tools" state persists across a fresh mount', () => {
    // Session 1: user shows tools and opens the sidebar, then leaves.
    htmlChromeModule!.saveHtmlChromeState({ toolsHidden: false, sidebarOpen: true });
    // Session 2 (fresh mount, same cookies): opens exactly as left.
    expect(htmlChromeModule!.getHtmlChromeState()).toEqual({
      toolsHidden: false,
      sidebarOpen: true,
    });
  });

  test('a "user re-hid everything" state persists too', () => {
    htmlChromeModule!.saveHtmlChromeState({ toolsHidden: false, sidebarOpen: true });
    htmlChromeModule!.saveHtmlChromeState({ toolsHidden: true, sidebarOpen: false });
    expect(htmlChromeModule!.getHtmlChromeState()).toEqual({
      toolsHidden: true,
      sidebarOpen: false,
    });
  });
});

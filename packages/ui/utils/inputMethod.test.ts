/**
 * Pinpoint default resolution for the raw-HTML annotate surface (DOM-gated).
 *
 * Decision under test: HTML sessions keep a SEPARATE input-method preference
 * from markdown sessions. First-ever HTML session defaults to Pinpoint even
 * when a markdown-era "drag" cookie exists; an explicit choice made inside an
 * HTML session persists for later HTML sessions only.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend, type StorageBackend } from './storage';

const hasDom = typeof document !== 'undefined';
const inputMethodModule = hasDom ? await import('./inputMethod') : null;

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

describe.if(hasDom)('resolveInputMethod (pure)', () => {
  test('HTML surface with nothing saved defaults to pinpoint', () => {
    expect(inputMethodModule!.resolveInputMethod('html', null, null)).toBe('pinpoint');
  });

  test('markdown surface with nothing saved keeps the drag default', () => {
    expect(inputMethodModule!.resolveInputMethod('markdown', null, null)).toBe('drag');
  });

  test('a markdown-era saved preference never suppresses the HTML default', () => {
    expect(inputMethodModule!.resolveInputMethod('html', 'drag', null)).toBe('pinpoint');
  });

  test('an explicit HTML-session choice wins over the HTML default', () => {
    expect(inputMethodModule!.resolveInputMethod('html', null, 'drag')).toBe('drag');
    expect(inputMethodModule!.resolveInputMethod('html', 'pinpoint', 'drag')).toBe('drag');
  });

  test('HTML choice never leaks into markdown resolution', () => {
    expect(inputMethodModule!.resolveInputMethod('markdown', null, 'pinpoint')).toBe('drag');
    expect(inputMethodModule!.resolveInputMethod('markdown', 'pinpoint', 'drag')).toBe('pinpoint');
  });

  test('garbage saved values fall back to the surface default', () => {
    expect(inputMethodModule!.resolveInputMethod('html', 'bogus', 'bogus')).toBe('pinpoint');
    expect(inputMethodModule!.resolveInputMethod('markdown', 'bogus', 'bogus')).toBe('drag');
  });
});

describe.if(hasDom)('getInputMethod / saveInputMethod (cookie round trip)', () => {
  test('first run: HTML resolves pinpoint, markdown resolves drag', () => {
    expect(inputMethodModule!.getInputMethod('html')).toBe('pinpoint');
    expect(inputMethodModule!.getInputMethod('markdown')).toBe('drag');
    expect(inputMethodModule!.getInputMethod()).toBe('drag');
  });

  test('saving on the HTML surface persists for HTML only', () => {
    inputMethodModule!.saveInputMethod('drag', 'html');
    expect(inputMethodModule!.getInputMethod('html')).toBe('drag');
    expect(inputMethodModule!.getInputMethod('markdown')).toBe('drag');

    inputMethodModule!.saveInputMethod('pinpoint', 'html');
    expect(inputMethodModule!.getInputMethod('html')).toBe('pinpoint');
    expect(inputMethodModule!.getInputMethod('markdown')).toBe('drag');
  });

  test('saving on the markdown surface leaves the HTML default intact', () => {
    inputMethodModule!.saveInputMethod('drag', 'markdown');
    expect(inputMethodModule!.getInputMethod('markdown')).toBe('drag');
    expect(inputMethodModule!.getInputMethod('html')).toBe('pinpoint');
  });
});

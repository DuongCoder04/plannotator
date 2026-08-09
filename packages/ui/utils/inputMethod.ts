import { storage } from './storage';
import type { InputMethod } from '../types';

const STORAGE_KEY = 'plannotator-input-method';
const HTML_STORAGE_KEY = 'plannotator-input-method-html';
const DEFAULT_METHOD: InputMethod = 'drag';
/**
 * Raw-HTML sessions default to Pinpoint: arbitrary pages are element-shaped,
 * not prose-shaped, so click-an-element is the natural first gesture.
 */
const DEFAULT_HTML_METHOD: InputMethod = 'pinpoint';

/** Which document surface the input method applies to. */
export type InputMethodSurface = 'markdown' | 'html';

function parseInputMethod(value: string | null): InputMethod | null {
  return value === 'drag' || value === 'pinpoint' ? value : null;
}

/**
 * Pure resolution logic (exported for tests).
 *
 * Persistence decision: the two surfaces keep SEPARATE preferences. The legacy
 * shared key was only ever written from markdown sessions, so honoring it for
 * HTML would let a markdown-era "drag" choice silently suppress the new HTML
 * default. HTML sessions therefore read/write their own key: first run
 * defaults to Pinpoint, and an explicit switch made inside an HTML session
 * wins on every later HTML session — without touching the markdown default.
 */
export function resolveInputMethod(
  surface: InputMethodSurface,
  savedShared: string | null,
  savedHtml: string | null,
): InputMethod {
  if (surface === 'html') {
    return parseInputMethod(savedHtml) ?? DEFAULT_HTML_METHOD;
  }
  return parseInputMethod(savedShared) ?? DEFAULT_METHOD;
}

export function getInputMethod(surface: InputMethodSurface = 'markdown'): InputMethod {
  return resolveInputMethod(
    surface,
    storage.getItem(STORAGE_KEY),
    storage.getItem(HTML_STORAGE_KEY),
  );
}

export function saveInputMethod(
  method: InputMethod,
  surface: InputMethodSurface = 'markdown',
): void {
  storage.setItem(surface === 'html' ? HTML_STORAGE_KEY : STORAGE_KEY, method);
}

import { storage } from './storage';

/**
 * Cross-session chrome visibility for raw-HTML annotate sessions.
 *
 * A raw-HTML session should open as close to "just the page" as possible, so
 * the FIRST-EVER open hides everything the header's "Hide tools" toggle
 * controls (toolstrip, tongue tabs, floating action cluster) and keeps the
 * sidebar closed. From then on the session opens with exactly the chrome the
 * user last left: showing tools persists, re-hiding them persists, and the
 * sidebar's open state rides along. Persisted as a cookie (like every other
 * cross-session UI pref — hook servers run on random ports, and cookies are
 * scoped by domain, not port). Markdown sessions are untouched.
 */

const STORAGE_KEY = 'plannotator-html-chrome';

export interface HtmlChromeState {
  /** The header "Hide tools" toggle — true hides all annotation chrome. */
  toolsHidden: boolean;
  /** Whether the left sidebar was open when the user last left. */
  sidebarOpen: boolean;
}

/** First-run default: minimal paint — everything hidden. */
export const DEFAULT_HTML_CHROME_STATE: HtmlChromeState = {
  toolsHidden: true,
  sidebarOpen: false,
};

/** Pure resolution logic (exported for tests): raw cookie value → state. */
export function resolveHtmlChromeState(raw: string | null): HtmlChromeState {
  if (!raw) return DEFAULT_HTML_CHROME_STATE;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return DEFAULT_HTML_CHROME_STATE;
    }
    const record = parsed as Record<string, unknown>;
    return {
      toolsHidden: typeof record.toolsHidden === 'boolean'
        ? record.toolsHidden
        : DEFAULT_HTML_CHROME_STATE.toolsHidden,
      sidebarOpen: typeof record.sidebarOpen === 'boolean'
        ? record.sidebarOpen
        : DEFAULT_HTML_CHROME_STATE.sidebarOpen,
    };
  } catch {
    return DEFAULT_HTML_CHROME_STATE;
  }
}

export function getHtmlChromeState(): HtmlChromeState {
  return resolveHtmlChromeState(storage.getItem(STORAGE_KEY));
}

export function saveHtmlChromeState(state: HtmlChromeState): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

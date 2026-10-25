/**
 * The onboarding tour's content, loaded whole before the tour shows (the
 * owner, on #2178: the tour never shows an error, so failures are made
 * unlikely up front). The fixture, every picture and prototype.html are
 * fetched once per page into memory: pictures as blob URLs (the window's CSP
 * allows `img-src blob:`), the mock as its text (drawn in a sandboxed srcdoc
 * frame). A server that stops mid-tour then changes nothing.
 *
 * What still is not here degrades quietly: a picture falls back to the
 * server's URL (and, failing that, the card's own labelled row), the mock to
 * a still picture of it, else the coach card describes it.
 */
import type { TourFixture } from './model';

const ASSET_BASE = '/api/inbox/tour/assets/';
/** The still the mock pane shows when prototype.html is not here: direction A, the prototype's first view. */
export const TOUR_MOCK_STILL = 'vs-a.webp';
export const TOUR_MOCK = 'vscode-mockups.html';
const NAME_RE = /^[a-z0-9][a-z0-9.-]*\.(webp|html)$/;
const BODY_IMAGE_RE = /\]\(([a-z0-9][a-z0-9.-]*\.webp)\)/g;

const urls = new Map<string, string>();
let mockHtml: string | null = null;

/** The URL a tour asset loads from: its copy in memory when the tour loaded it, else the read-only asset route. */
export function tourAssetUrl(name: string): string {
  return urls.get(name) ?? `${ASSET_BASE}${encodeURIComponent(name)}`;
}

/** The picture is in memory (loaded when the tour started). */
export function tourAssetLoaded(name: string): boolean {
  return urls.has(name);
}

/** prototype.html's text, when the tour loaded it. */
export function tourMockHtml(): string | null {
  return mockHtml;
}

/** Every asset the fixture names: its pictures (galleries, their larger versions, the question's tiles) and the mock. */
export function tourAssetNames(fixture: TourFixture): string[] {
  const names = new Set<string>();
  const add = (name: string | undefined) => name && NAME_RE.test(name) && names.add(name);
  for (const [thumb, full] of Object.entries(fixture.full)) {
    add(thumb);
    add(full);
  }
  for (const thread of fixture.threads) {
    for (const m of thread.messages) {
      for (const p of m.gallery ?? []) {
        add(p.asset);
        add(p.full);
      }
      for (const a of m.attachments ?? []) add(a.mock);
      for (const match of (m.body ?? '').matchAll(BODY_IMAGE_RE)) add(match[1]);
    }
  }
  add(TOUR_MOCK_STILL);
  return [...names];
}

/**
 * Load every asset the fixture names (at most `waitMs` in all: whatever has
 * not come by then is left to the asset route). Never throws; a name that did
 * not load is simply not in memory.
 */
export async function preloadTourAssets(fixture: TourFixture, waitMs = 10_000): Promise<void> {
  const one = async (name: string) => {
    if (name.endsWith('.html') ? mockHtml !== null : urls.has(name)) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${ASSET_BASE}${encodeURIComponent(name)}`);
        if (!res.ok) continue;
        if (name.endsWith('.html')) mockHtml = await res.text();
        else urls.set(name, URL.createObjectURL(await res.blob()));
        return;
      } catch {
        // Tried once more, then left to the asset route.
      }
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(tourAssetNames(fixture).map(one)),
    new Promise((done) => (timer = setTimeout(done, waitMs))),
  ]);
  clearTimeout(timer);
}

/** For tests: forget what was loaded. */
export function __forgetTourAssetsForTests(): void {
  for (const url of urls.values()) URL.revokeObjectURL?.(url);
  urls.clear();
  mockHtml = null;
}

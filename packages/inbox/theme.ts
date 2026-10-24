/**
 * Light and dark in the Inbox: the sidebar's toggle and Settings' Theme row.
 *
 * Both write Plannotator's own theme mode (`themePair.mode` in
 * @plannotator/ui's config store): the `plannotator-theme` cookie at once,
 * and config.json `theme` through POST /api/inbox/settings, the value plan
 * review, code review and annotate read through /api/config. So a choice made
 * here holds in the next plan review, and one made there holds here.
 *
 * Settings' Colors row picks the palette for the light half and the dark half
 * (useInboxPalettes), the same choices as plan review's Theme tab. Only the
 * part the person changed goes to the server: a mode, or one half's palette.
 */

import { useCallback } from 'react';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { useThemePaletteHalves, type ThemePaletteHalves } from '@plannotator/ui/components/ThemeTab';
import { themeSupportsHalf, type ThemeHalf } from '@plannotator/ui/utils/themeRegistry';
import { configStore, type ServerSyncFn } from '@plannotator/ui/config';
import type { Mode } from '@plannotator/ui/theme-modes';
import { inboxApi, type InboxThemeConfig } from './api';

/**
 * The config store's server write-back, for the Inbox: it has no /api/config,
 * so only what the Inbox itself changes goes anywhere, through its settings
 * route (which merges per field): the parts of the theme the person changed
 * in this page (config.json `theme`) and the guided review's diff layout
 * (config.json `diffOptions.diffStyle`, diffStyle.ts). Every other
 * server-synced setting stays in the page's cookies. The store hands over the
 * whole theme pair, but this tab's copy of the parts the person did not touch
 * can be days old (a palette picked in plan review since this tab loaded) or
 * the defaults (a page with no cookies): sending them would undo the person's
 * choices. So only the fields marked by `choose` (the mode) and
 * `choosePalette` (one half) go; with none marked (a write the Inbox did not
 * make), only the mode, as before palettes could be picked here.
 */
const changedThemeFields = new Set<'mode' | ThemeHalf>();

export const inboxServerSync: ServerSyncFn = (payload) => {
  const theme = payload.theme as InboxThemeConfig | undefined;
  if (theme) {
    const fields = changedThemeFields.size > 0 ? [...changedThemeFields] : (['mode'] as const);
    changedThemeFields.clear();
    const send: InboxThemeConfig = {};
    for (const field of fields) {
      const value = theme[field];
      if (field === 'mode') {
        if (value === 'light' || value === 'dark' || value === 'system') send.mode = value;
      } else if (typeof value === 'string' && value) {
        send[field] = value;
      }
    }
    if (Object.keys(send).length > 0) void inboxApi.saveTheme(send).catch(() => {});
  }
  const diffStyle = (payload.diffOptions as { diffStyle?: unknown } | undefined)?.diffStyle;
  if (diffStyle === 'split' || diffStyle === 'unified') {
    void inboxApi.saveDiffStyle(diffStyle).catch(() => {});
  }
};

let adopted = false;
let chosenHere = false;

/**
 * config.json's `theme` wins over the cookie, as it does in plan review, but
 * only from the first settings read, and never over a choice made in this
 * page before that read answered.
 */
export function adoptSavedTheme(theme: InboxThemeConfig | null | undefined): void {
  if (adopted) return;
  adopted = true;
  if (theme && !chosenHere) configStore.init({ theme });
}

/** Tests only: forget the first settings read and any choice, as a fresh page would. */
export function resetInboxThemeForTests(): void {
  adopted = false;
  chosenHere = false;
  changedThemeFields.clear();
}

/**
 * Under reduced motion the switch lands in one frame: the global colour
 * crossfade (theme.css's 150 ms `*` transition) is held off until the new
 * colours are painted. Otherwise it crossfades, as plan review does.
 */
function landInstantlyIfReducedMotion(): void {
  if (typeof window === 'undefined' || !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const root = document.documentElement;
  root.classList.add('ib-theme-instant');
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('ib-theme-instant')));
}

export interface InboxTheme {
  /** The stored choice: light, dark, or system (follow this computer). */
  mode: Mode;
  /** What is on screen now. */
  shown: 'light' | 'dark';
  choose: (mode: Mode) => void;
  /** The sidebar's toggle: an explicit light or dark, the opposite of what is shown. */
  flip: () => void;
}

export function useInboxTheme(): InboxTheme {
  const { mode, resolvedMode, setMode } = useTheme();
  const choose = useCallback(
    (next: Mode) => {
      chosenHere = true;
      changedThemeFields.add('mode');
      landInstantlyIfReducedMotion();
      setMode(next);
    },
    [setMode],
  );
  const flip = useCallback(() => choose(resolvedMode === 'dark' ? 'light' : 'dark'), [choose, resolvedMode]);
  return { mode, shown: resolvedMode, choose, flip };
}

export interface InboxPalettes extends ThemePaletteHalves {
  /** The half on screen now (its palette is the one the window shows). */
  shown: ThemeHalf;
}

/**
 * Settings' Colors row: plan review's palette choices (ThemeTab's
 * useThemePaletteHalves, the registry's palettes for each half), with a pick
 * applied at once and only that half sent to config.json.
 */
export function useInboxPalettes(): InboxPalettes {
  const halves = useThemePaletteHalves();
  const { resolvedMode } = useTheme();
  const { choose: assign } = halves;
  const choose = useCallback(
    (half: ThemeHalf, id: string) => {
      // A palette that cannot draw this half is refused by the provider, so nothing would be written.
      if (!themeSupportsHalf(id, half)) return;
      chosenHere = true;
      changedThemeFields.add(half);
      landInstantlyIfReducedMotion();
      assign(half, id);
    },
    [assign],
  );
  return { ...halves, choose, shown: resolvedMode };
}

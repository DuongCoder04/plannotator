/**
 * Tracks whether the user has explicitly resolved the Grid/Clean plan choice.
 * This is separate from `gridEnabled`: ConfigStore seeds that preference with
 * its default on first access, which is not evidence that the user chose it.
 * So `gridEnabled` trusts its stored value only once this decision is resolved
 * (see `config/settings.ts`); before that, everyone gets the default, Clean.
 *
 * Two generations of marker:
 *  - v1: `plannotator-plan-look-choice-resolved=true`, or the 0.20.0 chooser's
 *    `plannotator-look-feel-announcement-seen=2`. Both choosers opened with
 *    Grid preselected, so a v1 marker next to a stored Grid does not tell a
 *    real Grid choice from a Continue on the preselected default.
 *  - v2: `plannotator-plan-look-v2` = `resolved` (a choice made since Clean
 *    became the default: the chooser's Continue or Escape, or the Settings
 *    switch) or `notice` (moved to Clean once, the notice not yet seen).
 *
 * The owner's decision (2026-10-27): everyone holding only a v1 marker with
 * Grid stored moves to Clean once and sees a one-time notice (the chooser,
 * Clean preselected); Clean users are marked v2 silently. v2 lives under its
 * own key, and resolving still writes the v1 key, so an older Plannotator
 * build sharing the cookie jar never re-asks and can never write a v1 marker
 * over a v2 choice (which would move that person again).
 */

import { storage } from './storage';

const CHOICE_RESOLVED_KEY = 'plannotator-plan-look-choice-resolved';
const LEGACY_ANNOUNCEMENT_KEY = 'plannotator-look-feel-announcement-seen';
const V2_KEY = 'plannotator-plan-look-v2';
const GRID_KEY = 'plannotator-grid-enabled';

/** Which plan-look dialog this person needs: the first-run chooser, the one-time "moved to Clean" notice, or none. */
export type PlanLookPrompt = 'first-run' | 'moved' | null;

function hasV1Marker(): boolean {
  return storage.getItem(CHOICE_RESOLVED_KEY) === 'true'
    || storage.getItem(LEGACY_ANNOUNCEMENT_KEY) === '2';
}

/**
 * Upgrade a v1 marker to v2, once. Grid stored → Clean, notice pending;
 * anything else → resolved, silently. Idempotent: does nothing once v2 is set
 * or when there is no marker at all (a first run).
 */
export function migratePlanLookChoice(): void {
  if (storage.getItem(V2_KEY) !== null) return;
  if (!hasV1Marker()) return;
  if (storage.getItem(GRID_KEY) === 'true') {
    storage.setItem(GRID_KEY, 'false');
    storage.setItem(V2_KEY, 'notice');
  } else {
    storage.setItem(V2_KEY, 'resolved');
  }
}

/** True once the person picked Grid or Clean under the Clean default (chooser, notice or Settings). */
export function isLookChoiceResolved(): boolean {
  migratePlanLookChoice();
  return storage.getItem(V2_KEY) === 'resolved';
}

export function planLookPrompt(): PlanLookPrompt {
  migratePlanLookChoice();
  const v2 = storage.getItem(V2_KEY);
  if (v2 === 'resolved') return null;
  return v2 === 'notice' ? 'moved' : 'first-run';
}

export function needsLookAndFeelAnnouncement(): boolean {
  return planLookPrompt() !== null;
}

export function markLookAndFeelChoiceResolved(): void {
  storage.setItem(V2_KEY, 'resolved');
  // Older builds read only this key; without it they would ask again.
  storage.setItem(CHOICE_RESOLVED_KEY, 'true');
}

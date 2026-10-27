/**
 * Tracks whether the user has explicitly resolved the Grid/Clean plan choice.
 * This is separate from `gridEnabled`: ConfigStore seeds that preference with
 * its default on first access, which is not evidence that the user chose it.
 * So `gridEnabled` trusts its stored value only once this decision is resolved
 * (see `config/settings.ts`); before that, everyone gets the default, Clean.
 */

import { storage } from './storage';

const CHOICE_RESOLVED_KEY = 'plannotator-plan-look-choice-resolved';
const LEGACY_ANNOUNCEMENT_KEY = 'plannotator-look-feel-announcement-seen';

/** True once the person picked Grid or Clean (the chooser dialog or Settings). */
export function isLookChoiceResolved(): boolean {
  if (storage.getItem(CHOICE_RESOLVED_KEY) === 'true') return true;
  // v2 was the old Grid/Clean chooser wrapped in the 0.20.0 announcement.
  // A dismissal there resolved the same decision; migrate it without showing
  // another dialog merely because the release framing was removed.
  return storage.getItem(LEGACY_ANNOUNCEMENT_KEY) === '2';
}

export function needsLookAndFeelAnnouncement(): boolean {
  return !isLookChoiceResolved();
}

export function markLookAndFeelChoiceResolved(): void {
  storage.setItem(CHOICE_RESOLVED_KEY, 'true');
}

/**
 * The dot on the sidebar toggle while the sidebar is closed (the owner,
 * 2026-10-24: "Yes, add the dot"): the Update button lives in the sidebar's
 * foot, so a closed sidebar hid it. It follows what that button invites:
 * Available and Ready in the primary colour, Failed in a neutral tone (the
 * button's rule: never the error colour). Updating and Restarting are in
 * progress and invite nothing; no update (up to date, snoozed, a page opened
 * over the tailnet) is no dot.
 */
import type { InboxHealth } from '@plannotator/core/inbox-types';
import type { SidebarToggleNotice } from './shell/sidebar';

type UpdateState = NonNullable<InboxHealth['update']>['state'];

export function sidebarUpdateNotice(state: UpdateState | null | undefined, restarting: boolean): SidebarToggleNotice | null {
  if (!state || restarting) return null;
  switch (state) {
    case 'available':
      return { tone: 'primary', label: 'update available' };
    case 'ready':
      return { tone: 'primary', label: 'update ready' };
    case 'failed':
      return { tone: 'neutral', label: 'update failed' };
    default:
      return null;
  }
}

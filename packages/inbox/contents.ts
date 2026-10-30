import { useState } from 'react';
import type { Block } from '@plannotator/ui/types';
import { tocHeadings } from '@plannotator/ui/utils/annotationHelpers';
import { storage } from '@plannotator/ui/utils/storage';

/**
 * An open document's Contents list (components/ContentsPanel.tsx): plan
 * review's list of headings, drawn by `@plannotator/ui`'s DocumentContents.
 * A Markdown file shows it when it has this many headings of levels 1 to 3
 * (`tocHeadings`, what the list shows); a shorter file reads whole without it.
 */
export const CONTENTS_MIN_HEADINGS = 3;

/** Whether a document's blocks give it a Contents list. */
export function showsContents(blocks: readonly Block[]): boolean {
  return tocHeadings(blocks).length >= CONTENTS_MIN_HEADINGS;
}

/** Whether the docked list is shown or hidden, remembered across files and windows (the comments drawer's way). */
export const CONTENTS_COOKIE = 'plannotator-inbox-contents';

/**
 * Below this width of the file's body (`.ib-vbody`) full screen draws the list
 * as a button and a sheet, not a 240 px rail: the rail and a 760 px page need it.
 */
export const CONTENTS_RAIL_BELOW = 1000;

/** The docked list (the rail in full screen, the top of the comments column beside the thread): shown until hidden. */
export function useContentsShown(): [boolean, (shown: boolean) => void] {
  const [shown, setShownState] = useState(() => storage.getItem(CONTENTS_COOKIE) !== 'hidden');
  const setShown = (next: boolean) => {
    setShownState(next);
    storage.setItem(CONTENTS_COOKIE, next ? 'shown' : 'hidden');
  };
  return [shown, setShown];
}

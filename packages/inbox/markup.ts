/**
 * Drawing on an image or a video frame (approval "inbox-markup-flow",
 * 2026-10-26): the ✓ adds the drawing to the reply at once, as its own
 * comment; words are optional and go onto that same comment.
 */
import type { Annotation } from '@plannotator/ui/types';

/**
 * The words a drawing with none carries, for the agent: the feedback still
 * says it, while the window shows the drawing's picture in its place.
 */
export const MARKUP_ONLY_TEXT = 'See the marked-up image.';

/** A comment that is only a drawing: a picture, and the stand-in words (or none). */
export function isWordlessMarkup(annotation: Pick<Annotation, 'text' | 'images'> | null | undefined): boolean {
  if (!annotation?.images?.length) return false;
  const text = (annotation.text ?? '').trim();
  return text === '' || text === MARKUP_ONLY_TEXT;
}

/** The words a comment carries: a drawing's stand-in when the person wrote none. */
export function markupWords(words: string, hasDrawing: boolean): string {
  const trimmed = words.trim();
  return trimmed || (hasDrawing ? MARKUP_ONLY_TEXT : '');
}

/**
 * The action item marks on their way to the server (approval
 * "inbox-action-items-in-reply"): a Done, a Can't do it or a note typed under
 * a marked row is saved as the person goes, and a Send waits for them first,
 * so the reply carries the mark and the note as the person left them. A note
 * still inside its typing pause is saved at once by its flush, before a Send
 * and when its row goes away (the pane closed, the thread changed).
 */
const inFlight = new Set<Promise<unknown>>();
const flushes = new Set<() => void>();

/** Track one save; it resolves (or rejects) as `save` does. */
export function trackActionSave<T>(save: Promise<T>): Promise<T> {
  inFlight.add(save);
  const done = () => inFlight.delete(save);
  save.then(done, done);
  return save;
}

/** A note field's "save what is typed now" (a no-op when nothing waits); returns its removal. */
export function registerActionFlush(flush: () => void): () => void {
  flushes.add(flush);
  return () => flushes.delete(flush);
}

/** Saves every note still in its typing pause, then resolves once every save has answered (a refused one included). */
export async function actionSavesSettled(): Promise<void> {
  for (const flush of [...flushes]) flush();
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

/**
 * The action item marks on their way to the server (approval
 * "inbox-action-items-in-reply"): a Done, a Can't do it or a note typed under
 * a marked row is saved as the person goes, and a Send waits for them first,
 * so the reply carries the mark and the note as the person left them (a note
 * saved on leaving its field is on its way when the Send button is pressed).
 */
const inFlight = new Set<Promise<unknown>>();

/** Track one save; it resolves (or rejects) as `save` does. */
export function trackActionSave<T>(save: Promise<T>): Promise<T> {
  inFlight.add(save);
  const done = () => inFlight.delete(save);
  save.then(done, done);
  return save;
}

/** Resolves once every save tracked so far has answered (a refused one included). */
export async function actionSavesSettled(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

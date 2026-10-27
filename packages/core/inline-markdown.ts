/**
 * Inline markdown's markup taken out, its words kept: images out, link and
 * wiki-link labels kept, HTML tags out. Emphasis and code marks are left to
 * the caller (the Inbox's `cleanInline` protects code spans around this; the
 * question parser's `normalizeQuestionText` drops the marks).
 *
 * Imports nothing, so core/question-block and core/inbox-folding can both use
 * it with no cycle (Pi vendors it beside question-block: apps/pi-extension/vendor.sh).
 *
 * Every pattern stops at the next opener (`[`, `(`, `<`), so a label of
 * thousands of `[`, `[[`, `![` or `<a` is read in linear time, not scanned to
 * the end from each one. Nested brackets never matched, so the result is the
 * same as the unbounded patterns'.
 */
export function stripInlineMarkup(text: string): string {
  return text
    .replace(/!\[[^\][]*\]\([^()]*\)/g, '')
    .replace(/\[([^\][]*)\]\([^()]*\)/g, '$1')
    .replace(/\[\[([^\][|]*)(?:\|([^\][]*))?\]\]/g, (_m, target: string, label?: string) => label ?? target)
    .replace(/<\/?[A-Za-z][^<>]*>/g, '');
}

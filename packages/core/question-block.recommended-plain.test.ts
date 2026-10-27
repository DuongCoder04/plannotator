/**
 * A `Recommended:` line naming a choice whose label is written as markdown
 * (`- [ ] [Pagefind](x.html)`): the line says `Pagefind`, the label's raw
 * text is `[Pagefind](x.html)`. Exact matching runs first; then the label's
 * plain words name it, only when exactly one choice has them.
 *
 * What regresses if this fails: the card shows no recommendation and the
 * line turns into a suggested free-text answer (and a `(Recommended)` marker
 * beside it is dropped with nothing marked), or two choices with the same
 * plain words get one picked at random.
 */
import { describe, expect, test } from "bun:test";
import { parseQuestionBlock, type ParsedQuestion } from "./question-block";

const block = (choices: string[], line: string) =>
  ["Which search should the docs use?", "", ...choices, "", line].join("\n");

const recommendedOf = (q: ParsedQuestion) => q.choices.filter((c) => c.recommended).map((c) => c.label);

describe("a Recommended: line names a choice by the plain words of its label", () => {
  test("a link label", () => {
    const q = parseQuestionBlock("question", block(["- [ ] [Pagefind](x.html) — static index", "- [ ] Algolia — hosted"], "Recommended: Pagefind"))!;
    expect(recommendedOf(q)).toEqual(["[Pagefind](x.html)"]);
    expect(q.suggestedText).toBeUndefined();
  });

  test("a link label with a (Recommended) marker: the line names it and the marker leaves the label", () => {
    const q = parseQuestionBlock("question", block(["- [ ] [Pagefind](x.html) (Recommended)", "- [ ] Algolia"], "Recommended: Pagefind"))!;
    expect(recommendedOf(q)).toEqual(["[Pagefind](x.html)"]);
    expect(q.suggestedText).toBeUndefined();
  });

  test("a code-span label", () => {
    const q = parseQuestionBlock("question", block(["- [ ] `pagefind` — static index", "- [ ] Algolia"], "Recommended: pagefind"))!;
    expect(recommendedOf(q)).toEqual(["`pagefind`"]);
  });

  test("a bold label", () => {
    const q = parseQuestionBlock("question", block(["- [ ] **Pagefind** — static index", "- [ ] Algolia"], "Recommended: Pagefind"))!;
    expect(recommendedOf(q)).toEqual(["**Pagefind**"]);
  });

  test("two choices with the same plain words: neither is named, the line stays a suggested answer as before", () => {
    const q = parseQuestionBlock("question", block(["- [ ] [Pagefind](a.html) — v1", "- [ ] [Pagefind](b.html) — v2"], "Recommended: Pagefind"))!;
    expect(recommendedOf(q)).toEqual([]);
    expect(q.suggestedText).toBe("Pagefind");
  });

  test("an exact match still wins over plain words", () => {
    const q = parseQuestionBlock("question", block(["- [ ] [Pagefind](x.html)", "- [ ] Pagefind"], "Recommended: Pagefind"))!;
    expect(recommendedOf(q)).toEqual(["Pagefind"]);
  });
});

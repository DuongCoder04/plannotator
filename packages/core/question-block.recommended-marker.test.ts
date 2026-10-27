/**
 * A recommendation written into a choice's own label (`- [ ] Foo
 * (Recommended) — why`), the way other tools teach it (Claude Code's
 * AskUserQuestion appends "(Recommended)" to the label), with no
 * `Recommended:` line.
 *
 * What regresses if this fails: the card shows "(Recommended)" as label text
 * with no Recommended tag, no Accept recommended and no "(your
 * recommendation)" in the answer; or the marker changes the question's key;
 * or an answer stored against the raw label stops selecting its choice; or a
 * block that has a `Recommended:` line reads differently than before.
 */
import { describe, expect, test } from "bun:test";
import {
  canonicalQuestionAnswer,
  formatQuestionAnswerLines,
  isRecommendedQuestionAnswer,
  parseQuestionBlock,
  recommendedQuestionAnswer,
  type ParsedQuestion,
  type QuestionAnswer,
} from "./question-block";

const block = (choices: string[], extra: string[] = []) =>
  ["Should a broken config block uninstall?", "", ...choices, ...extra].join("\n");

const OTHER = "- [ ] Block on any unreadable config — strictest";

const recommendedOf = (q: ParsedQuestion) => q.choices.filter((c) => c.recommended).map((c) => c.label);

const exported = (q: ParsedQuestion, answer: QuestionAnswer) =>
  formatQuestionAnswerLines(answer, { recommended: isRecommendedQuestionAnswer(answer, recommendedOf(q), q.suggestedText) }).trim();

describe("a recommendation marked in a choice label, with no Recommended: line", () => {
  const marked: [string, string, string | undefined][] = [
    ["- [ ] Only block on ours (recommended) — a stray file stays a warning", "Only block on ours", "a stray file stays a warning"],
    ["- [ ] Only block on ours (Recommended) — a stray file stays a warning", "Only block on ours", "a stray file stays a warning"],
    ["- [ ] Only block on ours [recommended]", "Only block on ours", undefined],
    ["- [ ] Only block on ours **(Recommended)**", "Only block on ours", undefined],
    ["- [ ] **Only block on ours (recommended)**", "**Only block on ours**", undefined],
    ["- [ ] Only block on ours — recommended", "Only block on ours", undefined],
    ["- [ ] Only block on ours — Recommended: a stray file stays a warning", "Only block on ours", "a stray file stays a warning"],
    ["- Only block on ours (Recommended) — a stray file stays a warning", "Only block on ours", "a stray file stays a warning"],
  ];
  for (const [line, label, description] of marked) {
    test(`${line}: the marker becomes the recommendation`, () => {
      const plain = line.startsWith("- [ ]") ? OTHER : "- Block on any unreadable config — strictest";
      const q = parseQuestionBlock("question", block([line, plain]))!;
      expect(q.choices[0]!.label).toBe(label);
      expect(q.choices[0]!.description).toBe(description);
      expect(q.choices[0]!.recommended).toBe(true);
      expect(q.choices[1]!.recommended).toBe(false);
      expect(q.suggestedText).toBeUndefined();
      // The key is kind + prompt: the marker never changes it.
      expect(q.key).toBe(parseQuestionBlock("question", block(["- [ ] Only block on ours", plain]))!.key);
    });
  }

  test("Accept recommended picks the choice, and the answer says it was the recommendation", () => {
    const q = parseQuestionBlock("question", block(["- [ ] Only block on ours (Recommended) — a stray file stays a warning", OTHER]))!;
    const answer = recommendedQuestionAnswer({ line: 1, question: q })!;
    expect(answer.selected).toEqual(["Only block on ours"]);
    expect(exported(q, answer)).toBe("Answer: Only block on ours (your recommendation)");
  });

  test("an answer stored against the raw label (an older build) still selects the choice", () => {
    const q = parseQuestionBlock("question", block(["- [ ] Only block on ours (Recommended) — a stray file stays a warning", OTHER]))!;
    const old: QuestionAnswer = { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Only block on ours (Recommended)"] };
    expect(canonicalQuestionAnswer(q, old).selected).toEqual(["Only block on ours"]);
  });

  test("pick any: every marked choice is recommended", () => {
    const q = parseQuestionBlock("question-multi", block(["- [ ] Search (recommended)", "- [ ] Replace", "- [ ] Rename (Recommended)"]))!;
    expect(q.choices.map((c) => c.label)).toEqual(["Search", "Replace", "Rename"]);
    expect(recommendedOf(q)).toEqual(["Search", "Rename"]);
  });

  test("pick one with two marked choices: no recommendation, labels shown as written", () => {
    const q = parseQuestionBlock("question", block(["- [ ] Only block on ours (recommended)", "- [ ] Block on any (recommended)"]))!;
    expect(q.choices.map((c) => c.label)).toEqual(["Only block on ours (recommended)", "Block on any (recommended)"]);
    expect(recommendedOf(q)).toEqual([]);
  });

  test("a label the marker would make a twin of another choice's keeps its marker, and is still recommended", () => {
    const q = parseQuestionBlock("question", block(["- [ ] Keep it (recommended)", "- [ ] Keep it"]))!;
    expect(q.choices.map((c) => c.label)).toEqual(["Keep it (recommended)", "Keep it"]);
    expect(recommendedOf(q)).toEqual(["Keep it (recommended)"]);
  });

  test("words that only mention recommending are not a marker", () => {
    const q = parseQuestionBlock(
      "question",
      block(["- [ ] Use the vendor's config — recommended by the vendor", "- [ ] Write our own (recommended settings) — more work", "- [ ] Recommended defaults"]),
    )!;
    expect(q.choices.map((c) => c.label)).toEqual(["Use the vendor's config", "Write our own (recommended settings)", "Recommended defaults"]);
    expect(q.choices[0]!.description).toBe("recommended by the vendor");
    expect(recommendedOf(q)).toEqual([]);
  });
});

describe("with a Recommended: line, nothing changes", () => {
  test("the line wins over a marker on another choice, and labels stay as written", () => {
    const q = parseQuestionBlock("question", block(["- [ ] Only block on ours (recommended)", OTHER], ["", "Recommended: Block on any unreadable config"]))!;
    expect(q.choices[0]!.label).toBe("Only block on ours (recommended)");
    expect(recommendedOf(q)).toEqual(["Block on any unreadable config"]);
  });

  test("a line naming the marked choice reads as it always did", () => {
    const q = parseQuestionBlock("question", block(["- [ ] Only block on ours (recommended)", OTHER], ["", "Recommended: Only block on ours"]))!;
    expect(q.choices[0]!.label).toBe("Only block on ours (recommended)");
    expect(recommendedOf(q)).toEqual(["Only block on ours (recommended)"]);
  });
});

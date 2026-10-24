/**
 * The owner's 2026-10-24 block in the Inbox: the server's question record and
 * the card read the same labels and the same recommendation, so the card's
 * Accept recommended (its recommended choice's label) is a pick the server
 * takes, not `422 "…" is not one of the question's choices`. The card reads
 * the body with `parseQuestionBlock`; the record comes from
 * `parseInboxQuestionBlocks`. On a real store in a temp dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { parseInboxQuestionBlocks } from "@plannotator/core/inbox-questions";
import { parseQuestionBlock, recommendedQuestionAnswer } from "@plannotator/core/question-block";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const INNER = [
  "What happens to a pin when you archive the thread?",
  "Recommended: Unpin it",
  '- Unpin it: the toast says "Archived · Unpinned", and Undo restores both',
  "- Keep it pinned",
  "Context: an archived thread gets nothing new, because the agent's next message starts a new thread.",
];
const BODY = ["Pins and archive:", "", ":::question", ...INNER, ":::"].join("\n");

describe("the owner's block in the Inbox", () => {
  test("the stored record and the card agree on labels, the recommendation and the context", () => {
    const [record] = parseInboxQuestionBlocks(BODY);
    const card = parseQuestionBlock("question", INNER.join("\n"), { decisionLines: false })!;
    expect(record!.key).toBe(card.key);
    expect(record!.parsed.choices.map((c) => c.label)).toEqual(card.choices.map((c) => c.label));
    expect(record!.parsed.choices.map((c) => c.recommended)).toEqual([true, false]);
    expect(record!.parsed.suggested_text).toBeNull();
    expect(record!.parsed.context).toBe(card.context);
    expect(record!.parsed.choices[1]!.label).toBe("Keep it pinned");
  });

  test("the card's Accept recommended is a pick the server takes, and Send carries it", () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-forgiving-"));
    roots.push(dir);
    const store = InboxStore.open(dir);
    const project = store.ensureProject({ name: "inbox-ui", root: "/work/inbox-ui" });
    const message = store.sendMessage({ project_id: project.id, author: AGENT, body: BODY }).message;
    const q = store.questionsOf(message.id)[0]!;
    const card = parseQuestionBlock("question", INNER.join("\n"), { decisionLines: false })!;
    const answer = recommendedQuestionAnswer({ line: 1, question: card })!;
    const [picked] = store.savePicks(message.id, [{ key: q.key, revision: 0, answer }]);
    expect(picked!.state).toBe("picked");
    expect(picked!.answer!.selected).toEqual(['Unpin it: the toast says "Archived · Unpinned", and Undo restores both']);
    const sent = store.sendReply(message.id, { idempotency_key: "k-1", questions: [{ key: q.key, revision: 1 }] });
    expect(sent.reply!.body).toContain("Unpin it: the toast says");
    expect(sent.reply!.body).toContain("(your recommendation)");
  });

  test("the choice the Context: line used to swallow is picked by its own label", () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-forgiving-"));
    roots.push(dir);
    const store = InboxStore.open(dir);
    const project = store.ensureProject({ name: "inbox-ui", root: "/work/inbox-ui" });
    const message = store.sendMessage({ project_id: project.id, author: AGENT, body: BODY }).message;
    const q = store.questionsOf(message.id)[0]!;
    const [picked] = store.savePicks(message.id, [{ key: q.key, revision: 0, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Keep it pinned"] } }]);
    expect(picked!.answer!.selected).toEqual(["Keep it pinned"]);
  });
});

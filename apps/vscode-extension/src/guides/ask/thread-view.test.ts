import { describe, expect, it } from "bun:test";
import type { AnswerRecord, AskAbout } from "./answers";
import type { AskRunState } from "./session";
import { THREAD_LINK_COMMANDS, commandLink, doneMarkdown, filesRead, introMarkdown, introSentence, modelEffort, threadLabel, threadWhere, workingMarkdown } from "./thread-view";

const lines: AskAbout = { kind: "selection", chapter: 1, chapterTitle: "Delivery loop", path: "src/webhooks/deliver.ts", side: "head", lines: { start: 25, end: 31 } };
const file: AskAbout = { kind: "file", chapter: 1, chapterTitle: "Delivery loop", path: "src/webhooks/deliver.ts", side: "head" };

/** The command and arguments of every `command:` link in a markdown body. */
function links(md: string): Array<{ text: string; command: string; args: unknown[] }> {
  return [...md.matchAll(/\[((?:\\.|[^\]\\])*)\]\(command:([^?\s]+)\?([^\s)]+)(?: "[^"]*")?\)/g)].map((m) => ({
    text: m[1].replace(/\\(.)/g, "$1"),
    command: m[2],
    args: JSON.parse(decodeURIComponent(m[3])),
  }));
}

function state(over: Partial<AskRunState> = {}): AskRunState {
  return { answerId: "ans-1", status: "working", startedAt: 1_000, activity: [], stream: "", pendingPermissions: [], autoApprove: false, offerAutoApprove: false, ...over };
}

function record(over: Partial<AnswerRecord> = {}): AnswerRecord {
  return { v: 1, id: "ans-1", guideId: "g", repoKey: "r", question: "Why?", about: lines, askedAt: 1_000, answeredAt: 7_000, status: "answered", title: "It returns a value", agent: { id: "claude", label: "Claude Code" }, seen: true, ...over } as AnswerRecord;
}

describe("the question box's words", () => {
  it("names the lines, the file or the chapter, and what goes with the question", () => {
    expect(threadLabel("Claude Code", lines, false)).toBe("Ask Claude Code · deliver.ts 25–31");
    expect(threadLabel("Claude Code", lines, true)).toBe("Claude Code · deliver.ts 25–31");
    expect(threadWhere({ ...lines, side: "base" })).toBe("deliver.ts 25–31 (old)");
    expect(threadWhere(file)).toBe("deliver.ts");
    expect(introSentence(lines)).toBe("Ask about **lines 25–31**. The lines, the file's diff, Chapter 2 and the guide go with it.");
    expect(introSentence({ ...lines, lines: { start: 9, end: 9 } })).toContain("**line 9**. The line,");
    expect(introSentence(file)).toContain("The file and its diff, Chapter 2 and the guide go with it.");
    expect(modelEffort({ model: { id: "s", label: "Sonnet" }, effort: { id: "low", label: "Low" } })).toBe("Sonnet · low");
  });

  it("offers each suggestion and earlier question as a link to its own command", () => {
    const md = introMarkdown({ threadId: "t1", about: lines, past: [{ id: "ans-9", question: "Does the worker count attempts twice?", when: "yesterday" }] });
    const found = links(md);
    expect(found.slice(0, 5).map((l) => [l.command, l.args])).toEqual([0, 1, 2, 3, 4].map((i) => [THREAD_LINK_COMMANDS.pick, ["t1", i]]));
    expect(found[0].text).toBe("Why did this change?");
    expect(found[5]).toEqual({ text: "Does the worker count attempts twice?", command: THREAD_LINK_COMMANDS.open, args: ["ans-9"] });
    expect(md).toContain("Asked before: ");
    expect(md).toContain("· yesterday");
  });

  it("keeps a question's own brackets and quotes inside its link", () => {
    const md = commandLink('What does `f(x)` do? [see "a"]', THREAD_LINK_COMMANDS.open, ["ans-1"], 'Open "it"');
    const [l] = links(md);
    expect(l.text).toBe('What does `f(x)` do? [see "a"]');
    expect(l.args).toEqual(["ans-1"]);
    expect(md).toContain('"Open  it "');
  });

  it("says a question was not asked, with a link to ask it now", () => {
    const md = introMarkdown({ threadId: "t1", about: lines, past: [], notAsked: { question: "Why?", reason: "Claude Code was answering “x”." } });
    expect(md).toContain("Not asked: “Why?”");
    expect(links(md).at(-1)).toEqual({ text: "Ask it now", command: THREAD_LINK_COMMANDS.again, args: ["t1"] });
  });

  it("shows the clock, the cost, the files read and Stop while the agent answers", () => {
    const s = state({
      cost: { amount: 0.012, currency: "USD" },
      activity: [
        { id: 1, at: 0, kind: "tool", title: "Read", locations: [{ path: "src/worker.ts" }] },
        { id: 2, at: 0, kind: "message", title: "x" },
        { id: 3, at: 0, kind: "tool", title: "Read", locations: [{ path: "src/webhooks/retryPolicy.ts" }, { path: "src/worker.ts" }] },
      ],
    });
    expect(filesRead(s)).toEqual(["retryPolicy.ts", "worker.ts"]);
    const md = workingMarkdown({ agentLabel: "Claude Code", answerId: "ans-1", state: s, now: 7_400 });
    expect(md.startsWith("$(loading~spin) **Asking Claude Code…** 0:06 · $0.01 · read retryPolicy.ts, worker.ts · ")).toBe(true);
    expect(links(md)).toEqual([{ text: "Stop", command: THREAD_LINK_COMMANDS.stop, args: ["ans-1"] }]);
    expect(workingMarkdown({ agentLabel: "Claude Code", answerId: "ans-1", state: state({ status: "starting" }), now: 1_000 })).toContain("**Starting Claude Code…** 0:00");
  });

  it("asks for the reader's OK when the agent waits on a permission", () => {
    const md = workingMarkdown({ agentLabel: "Codex", answerId: "ans-1", state: state({ pendingPermissions: [{ id: 3, title: "Run npm test", options: [] } as unknown as AskRunState["pendingPermissions"][number]] }), now: 2_000 });
    expect(md).toContain("**Codex needs your OK** · Run npm test");
    expect(links(md).map((l) => l.text)).toEqual(["Review", "Stop"]);
  });

  it("points to the answer once it ended, or says why there is none", () => {
    expect(doneMarkdown({ record: record(), opened: true })).toStartWith("$(check) **Answer opened beside the diff** · [Open](");
    expect(doneMarkdown({ record: record({ status: "text", title: undefined }), opened: false })).toStartWith("$(check) **Answer ready** · ");
    expect(doneMarkdown({ record: record({ status: "stopped" }), opened: true })).toContain("**Stopped.**");
    expect(doneMarkdown({ record: record({ status: "failed", statusMessage: "Out of credits" }), opened: true })).toContain("**No answer.** Out of credits");
    expect(links(doneMarkdown({ record: record(), opened: true }))).toEqual([{ text: "Open", command: THREAD_LINK_COMMANDS.open, args: ["ans-1"] }]);
    // An agent-written title (only in the link's tooltip) cannot add a link of its own.
    const evil = doneMarkdown({ record: record({ title: '[x](command:workbench.action.terminal.new) "' }), opened: true });
    expect(links(evil).map((l) => l.command)).toEqual([THREAD_LINK_COMMANDS.open]);
  });
});

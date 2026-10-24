import { describe, expect, it } from "bun:test";
import { changedPatchFiles, locateToken, splitHoverMarkdown } from "./reader-mapping";

const file = [
  "import { computeBackoff } from \"./retryPolicy\";",
  "",
  "export function deliver(job: Job) {",
  "  const delay = computeBackoff(job.attempt, policy);",
  "  return { kind: \"retry\", delayMs: delay };",
  "}",
];
const lineAt = (lines: string[]) => (n: number) => lines[n - 1];

describe("where a diff's token is in the file on disk", () => {
  it("is exactly where the diff says when the file has not changed", () => {
    expect(locateToken(lineAt(file), 4, 16, "computeBackoff")).toEqual({ line: 4, character: 16, stale: false });
  });

  it("finds it on the same line when the column moved, and says the file changed", () => {
    const edited = [...file];
    edited[3] = "  const nextDelay = computeBackoff(job.attempt, policy);";
    expect(locateToken(lineAt(edited), 4, 16, "computeBackoff")).toEqual({ line: 4, character: 20, stale: true });
  });

  it("finds it on the nearest line when lines were added above", () => {
    const edited = ["// a new comment", "// and another", ...file];
    expect(locateToken(lineAt(edited), 4, 44, "policy")).toEqual({ line: 6, character: 44, stale: true });
  });

  it("matches whole words only: `job` is not found inside `jobs`", () => {
    expect(locateToken(lineAt(["const jobs = 1;", "use(job);"]), 1, 6, "job")).toEqual({ line: 2, character: 4, stale: true });
  });

  it("is nothing when the token is gone, empty, or the line is out of range", () => {
    expect(locateToken(lineAt(file), 4, 16, "removedFunction")).toBeNull();
    expect(locateToken(lineAt(file), 4, 16, "")).toBeNull();
    expect(locateToken(lineAt(file), 0, 0, "deliver")).toBeNull();
  });
});

describe("the language server's hover as the card shows it", () => {
  it("splits signatures from the docs, in order, and drops command links and rules", () => {
    const md = "```typescript\nfunction computeBackoff(attempt: number, policy: RetryPolicy): number\n```\n---\nExponential backoff with full jitter. See [the policy](command:editor.action.revealDefinition).\n\n*@param* `attempt` — 1-based";
    expect(splitHoverMarkdown(md)).toEqual([
      { kind: "code", language: "typescript", text: "function computeBackoff(attempt: number, policy: RetryPolicy): number" },
      { kind: "markdown", text: "Exponential backoff with full jitter. See the policy.\n\n*@param* `attempt` — 1-based" },
    ]);
  });

  it("keeps a hover without code as markdown, and nothing for an empty one", () => {
    expect(splitHoverMarkdown("Just words")).toEqual([{ kind: "markdown", text: "Just words" }]);
    expect(splitHoverMarkdown("")).toEqual([]);
    expect(splitHoverMarkdown("```ts\n\n```")).toEqual([]);
  });
});

describe("files edited since the guide was written", () => {
  const patch = (path: string, line: string, index = "abc123..def456") => `diff --git a/${path} b/${path}\nindex ${index} 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n-old\n+${line}\n`;
  it("names the files whose diff on disk is not the guide's", () => {
    const guide = patch("a.ts", "new") + patch("b.ts", "new");
    const now = patch("a.ts", "new", "abc123..999999") + patch("b.ts", "newer");
    expect(changedPatchFiles(guide, now)).toEqual(["b.ts"]);
  });

  it("leaves out a file the fresh diff does not list (an untracked file the guide added)", () => {
    expect(changedPatchFiles(patch("a.ts", "new") + patch("c.ts", "x"), patch("a.ts", "new"))).toEqual([]);
  });
});

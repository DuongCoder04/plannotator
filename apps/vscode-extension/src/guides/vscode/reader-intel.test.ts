/**
 * The Guide tab's code intelligence on the vscode mock: which side a
 * definition is on (a removed line's definition is in the base revision, and
 * never opens on the head), only the guide's files are asked about, and a
 * definition in a changed file is revealed on its own side.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as vscode from "vscode";
import { ReaderModel, type ReaderSides } from "../reader-model";
import type { LoadedGuide } from "../store";
import { guideFileAt, readerDefinition, readerHover } from "./reader-intel";
import { baseUri, docSideOf, headUri } from "./uris";

const PATCH = [
  "diff --git a/src/deliver.ts b/src/deliver.ts",
  "--- a/src/deliver.ts",
  "+++ b/src/deliver.ts",
  "@@ -1,2 +1,2 @@",
  " import { retry } from './retry';",
  "-retry(oldPolicy);",
  "+retry(newPolicy);",
  "diff --git a/src/old-name.ts b/src/new-name.ts",
  "similarity index 100%",
  "rename from src/old-name.ts",
  "rename to src/new-name.ts",
  "",
].join("\n");

function model(): ReaderModel {
  const guide = {
    repoKey: "r",
    id: "g",
    rawPatch: PATCH,
    envelope: {
      version: 1, savedAt: 1, label: "local", title: "T", engine: "claude",
      guide: { title: "T", intent: "I", sections: [{ title: "C", overview: "", diffs: [{ file: "src/deliver.ts" }, { file: "src/new-name.ts" }] }] },
      reviewed: [false],
    },
    sidecar: { v: 1, fileTicks: ["src/deliver.ts", "../../etc/passwd", "src/not-in-guide.ts"], focus: {} },
  } as unknown as LoadedGuide;
  return new ReaderModel(guide);
}

const fsSides: ReaderSides = { gitRoot: "/repo", baseRev: "base1", head: { kind: "fs", root: "/repo" }, moved: false };
const revSides: ReaderSides = { gitRoot: "/repo", baseRev: "base1", head: { kind: "rev", rev: "head1" }, moved: false };

const docs = new Map<string, string[]>();
const answers = new Map<string, unknown>();
const calls: Array<{ command: string; uri: string }> = [];
const original = { exec: vscode.commands.executeCommand, open: (vscode.workspace as Record<string, unknown>).openTextDocument };

function install(): void {
  (vscode.commands as Record<string, unknown>).executeCommand = async (command: string, uri: vscode.Uri) => {
    calls.push({ command, uri: uri.toString() });
    return answers.get(`${command} ${uri.toString()}`);
  };
  (vscode.workspace as Record<string, unknown>).openTextDocument = async (uri: vscode.Uri) => {
    const lines = docs.get(uri.toString());
    if (!lines) throw new Error("no such document");
    return { lineCount: lines.length, lineAt: (n: number) => ({ text: lines[n] }) };
  };
}

afterEach(() => {
  (vscode.commands as Record<string, unknown>).executeCommand = original.exec;
  (vscode.workspace as Record<string, unknown>).openTextDocument = original.open;
  docs.clear();
  answers.clear();
  calls.length = 0;
});

describe("which version a document is", () => {
  it("the base revision's documents are the old side, for any file of the repository", () => {
    expect(docSideOf(fsSides, baseUri(fsSides, { path: "src/deliver.ts", status: "modified" }))).toEqual({ path: "src/deliver.ts", side: "base" });
    expect(docSideOf(fsSides, baseUri(fsSides, { path: "lib/elsewhere.ts", status: "modified" }))).toEqual({ path: "lib/elsewhere.ts", side: "base" });
    expect(docSideOf(fsSides, vscode.Uri.file("/repo/src/deliver.ts"))).toEqual({ path: "src/deliver.ts", side: "head" });
    // A head revision's virtual document is the head, not "outside".
    expect(docSideOf(revSides, headUri(revSides, { path: "src/deliver.ts", status: "modified" }))).toEqual({ path: "src/deliver.ts", side: "head" });
    expect(docSideOf(fsSides, vscode.Uri.file("/elsewhere/x.ts"))).toBeNull();
  });

  it("a definition on the old side of a changed file is that file's old side; a renamed file's old path maps to its new path", () => {
    const m = model();
    const ctx = { model: m, sides: fsSides };
    expect(guideFileAt({ path: "src/deliver.ts", side: "old" }, ctx)).toEqual({ path: "src/deliver.ts", side: "old" });
    expect(guideFileAt({ path: "src/old-name.ts", side: "old" }, ctx)).toEqual({ path: "src/new-name.ts", side: "old" });
    expect(guideFileAt({ path: "src/deliver.ts", side: "new" }, ctx)).toEqual({ path: "src/deliver.ts", side: "new" });
    expect(guideFileAt({ path: "lib/elsewhere.ts", side: "old" }, ctx)).toBeNull();
    expect(guideFileAt({ path: "src/deliver.ts", side: null }, ctx)).toBeNull();
  });
});

describe("definitions from a removed line", () => {
  it("are reported on the old side and revealed there, never as the head file", async () => {
    install();
    const m = model();
    const base = baseUri(fsSides, { path: "src/deliver.ts", status: "modified" });
    docs.set(base.toString(), ["import { retry } from './retry';", "retry(oldPolicy);"]);
    const defInBase = new vscode.Location(base, new vscode.Range(0, 9, 0, 14));
    answers.set(`vscode.executeDefinitionProvider ${base.toString()}`, [defInBase]);
    answers.set(`vscode.executeHoverProvider ${base.toString()}`, [{ contents: ["```ts\nfunction retry(): void\n```"] }]);
    const at = { path: "src/deliver.ts", side: "old" as const, line: 2, character: 0, token: "retry" };
    const hover = await readerHover(at, { model: m, sides: fsSides });
    expect(hover?.definition).toMatchObject({ path: "src/deliver.ts", side: "old", line: 1 });
    const def = await readerDefinition(at, { model: m, sides: fsSides });
    expect(def?.inGuide).toEqual({ path: "src/deliver.ts", side: "old" });
    expect(def?.uri.toString()).toBe(base.toString());
  });

  it("a definition in a head revision's virtual document of a changed file is revealed in the guide", async () => {
    install();
    const m = model();
    const head = headUri(revSides, { path: "src/deliver.ts", status: "modified" });
    docs.set(head.toString(), ["import { retry } from './retry';", "retry(newPolicy);"]);
    answers.set(`vscode.executeDefinitionProvider ${head.toString()}`, [new vscode.Location(head, new vscode.Range(1, 6, 1, 15))]);
    const def = await readerDefinition({ path: "src/deliver.ts", side: "new", line: 2, character: 6, token: "newPolicy" }, { model: m, sides: revSides });
    expect(def?.inGuide).toEqual({ path: "src/deliver.ts", side: "new" });
  });
});

describe("only the guide's files", () => {
  it("a position in a file the guide does not show asks the language server nothing", async () => {
    install();
    const m = model();
    expect(await readerHover({ path: "src/not-in-guide.ts", side: "new", line: 1, character: 0, token: "x" }, { model: m, sides: fsSides })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("file ticks are kept for the guide's files only", () => {
    const m = model();
    expect([...m.fileTicks]).toEqual(["src/deliver.ts"]);
    m.setFileReviewed("src/not-in-guide.ts", true);
    expect(m.fileTicks.has("src/not-in-guide.ts")).toBe(false);
  });
});

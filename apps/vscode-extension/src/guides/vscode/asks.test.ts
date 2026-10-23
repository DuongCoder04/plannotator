/**
 * GuideAsks on the vscode mock with the FAKE ACP agent (never a real one):
 * a second question while the first is getting ready is refused cleanly, and
 * a guide or answer deleted while it is being answered is not written back.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as vscode from "vscode";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CODE } from "../acp/agents";
import { answersPath, listAnswers } from "../ask/answers";
import { startRelayHost, type RelayHost } from "../mcp/relay-host";
import { ReaderModel } from "../reader-model";
import type { LoadedGuide } from "../store";
import { GuideAsks, type AsksHost } from "./asks";

const FAKE_AGENT = join(import.meta.dir, "..", "..", "..", "tests", "fake-acp-agent.ts");
const RELAY_SCRIPT = join(import.meta.dir, "..", "mcp", "relay-script.ts");
const GUIDE_ID = "1761200000000-retry-failed-webhook-deliveries";
const REPO_KEY = "github.com__northwind__checkout-service";

let work: string;
let relay: RelayHost;
let dataBefore: string | undefined;
const warnings: string[] = [];
const original = { warn: vscode.window.showWarningMessage, info: vscode.window.showInformationMessage };

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "pn-guides-asks-"));
  relay = await startRelayHost({ serverVersion: "test" });
  // The extension's `dist/guide-mcp.cjs`, here the relay script run by bun.
  mkdirSync(join(work, "ext", "dist"), { recursive: true });
  writeFileSync(join(work, "ext", "dist", "guide-mcp.cjs"), `require(${JSON.stringify(RELAY_SCRIPT)});\n`);
});

afterAll(async () => {
  await relay.close();
  rmSync(work, { recursive: true, force: true });
});

beforeEach(() => {
  dataBefore = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = mkdtempSync(join(work, "data-"));
  warnings.length = 0;
  (vscode.window as unknown as Record<string, unknown>).showWarningMessage = async (message: string) => {
    warnings.push(message);
    return undefined;
  };
  (vscode.window as unknown as Record<string, unknown>).showInformationMessage = async () => undefined;
});

afterEach(() => {
  if (dataBefore === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = dataBefore;
  (vscode.window as unknown as Record<string, unknown>).showWarningMessage = original.warn;
  (vscode.window as unknown as Record<string, unknown>).showInformationMessage = original.info;
});

function world(askTurns: unknown[][], options: { gate?: Promise<void> } = {}) {
  const root = mkdtempSync(join(work, "repo-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "deliver.ts"), "export function deliver() {\n  return 1;\n}\n");
  const scriptPath = join(root, "script.json");
  const logPath = join(root, "agent.log");
  writeFileSync(scriptPath, JSON.stringify({ steps: [], askTurns }));
  const rawPatch = "diff --git a/src/deliver.ts b/src/deliver.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/deliver.ts\n@@ -0,0 +1,3 @@\n+export function deliver() {\n+  return 1;\n+}\n";
  const guide: LoadedGuide = {
    repoKey: REPO_KEY,
    id: GUIDE_ID,
    rawPatch,
    envelope: {
      version: 1, savedAt: 1, label: "local", title: "Retry failed webhook deliveries", engine: "claude",
      guide: { title: "Retry failed webhook deliveries", intent: "Deliveries retry.", sections: [{ title: "The loop", overview: "It backs off.", diffs: [{ file: "src/deliver.ts", summary: "x" }] }] },
      reviewed: [false],
    } as unknown as LoadedGuide["envelope"],
    sidecar: { v: 1, fileTicks: [], focus: {}, agent: { id: CLAUDE_CODE.id, label: CLAUDE_CODE.label } },
  };
  const model = new ReaderModel(guide);
  const reader = { model, sides: { gitRoot: root, baseRev: "HEAD", head: { kind: "fs" as const, root }, moved: false } };
  const shown: unknown[] = [];
  const host: AsksHost = {
    context: { globalState: { get: () => undefined, update: async () => {} }, extensionUri: vscode.Uri.file(join(work, "ext")) } as unknown as vscode.ExtensionContext,
    version: "test",
    runner: async () => ({ code: 0, stdout: "9b07e4d\n", stderr: "" }),
    log: () => {},
    reader: () => reader,
    openGuide: async () => {},
    openLink: async () => {},
    relayHost: async () => relay,
    agentById: (id) => (id === CLAUDE_CODE.id ? CLAUDE_CODE : null),
    defaultChoice: () => ({ id: CLAUDE_CODE.id, label: CLAUDE_CODE.label }),
    ensureLaunch: async () => {
      await options.gate;
      return { ok: true as const, source: "path" as const, command: process.execPath, args: [FAKE_AGENT], env: { FAKE_ACP_SCRIPT: scriptPath, FAKE_ACP_LOG: logPath } };
    },
    pickModel: async () => null,
    notifyPermission: async () => null,
    autoApprove: () => false,
    approveAlways: () => {},
    signIn: async () => {},
    createPanel: () => ({
      panel: { title: "", viewColumn: 2, visible: true, reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }) } as unknown as vscode.WebviewPanel,
      host: { show: (s: unknown) => shown.push(s) } as unknown as import("./webview-host").WebviewHost,
    }),
    persists: () => true,
    updateChapterView: () => {},
    setAnswering: () => {},
  };
  const asks = new GuideAsks(host);
  const sidecarPath = join(process.env.PLANNOTATOR_DATA_DIR!, "guides", REPO_KEY, "vscode", `${GUIDE_ID}.json`);
  const about = { kind: "file" as const, chapter: 0, chapterTitle: "The loop", path: "src/deliver.ts", side: "head" as const };
  const ask = (q: string) => (asks as unknown as { ask(g: LoadedGuide, a: typeof about, q: string, o: object): Promise<void> }).ask(guide, about, q, {});
  return { asks, guide, ask, shown, sidecarPath, log: () => (existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
}

const answer = (title: string) => ({ mcp: { name: "show_answer", args: { title, html: "<p>ok</p>" } } });
const waitFor = async (check: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("asking from VS Code", () => {
  it("refuses a second question while the first is still getting ready, and leaves no stale record", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const w = world([[answer("One")]], { gate });
    const first = w.ask("Why did this change?");
    // The first is waiting on its launch (nothing saved yet); the second comes in now.
    await w.ask("What could break?");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("getting ready to answer another question");
    open();
    await first;
    await waitFor(() => listAnswers(REPO_KEY, GUIDE_ID).some((r) => r.status === "answered"));
    const all = listAnswers(REPO_KEY, GUIDE_ID);
    expect(all.map((r) => r.question)).toEqual(["Why did this change?"]);
    // The slot is free again: the next question goes through.
    await w.ask("And then?");
    expect(warnings).toHaveLength(1);
    await waitFor(() => listAnswers(REPO_KEY, GUIDE_ID).filter((r) => r.status === "answered").length === 2);
    w.asks.dispose();
  });

  it("does not write back an answer, or the sidecar, when the guide is deleted while it is being answered", async () => {
    const w = world([[{ say: "Thinking…" }, { sleep: 800 }, answer("Too late")]]);
    await w.ask("Why did this change?");
    await waitFor(() => w.log().some((e) => e.event === "prompt"));
    w.asks.onGuideDeleted(REPO_KEY, GUIDE_ID);
    expect(existsSync(answersPath(REPO_KEY, GUIDE_ID))).toBe(false);
    await new Promise((r) => setTimeout(r, 1500));
    expect(existsSync(answersPath(REPO_KEY, GUIDE_ID))).toBe(false);
    expect(existsSync(w.sidecarPath)).toBe(false);
    w.asks.dispose();
  });

  it("does not write back an answer deleted while it is being answered", async () => {
    const w = world([[{ say: "Thinking…" }, { sleep: 800 }, answer("Too late")]]);
    await w.ask("Why did this change?");
    await waitFor(() => w.log().some((e) => e.event === "prompt"));
    const [record] = listAnswers(REPO_KEY, GUIDE_ID);
    expect(record.status).toBe("stopped"); // an "answering" file reads as stopped
    await w.asks.menu(record.id, "delete");
    await new Promise((r) => setTimeout(r, 1500));
    expect(listAnswers(REPO_KEY, GUIDE_ID)).toEqual([]);
    expect(existsSync(join(answersPath(REPO_KEY, GUIDE_ID), `${record.id}.json`))).toBe(false);
    w.asks.dispose();
  });
});
